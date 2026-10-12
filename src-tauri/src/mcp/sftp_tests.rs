//! Exercise real MCP HTTP -> SSH -> SFTP against a synthetic in-memory server.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use russh::{
    server::{self, Session},
    Channel, ChannelId,
};
use russh_sftp::protocol::*;
use serde_json::{json, Value};
use tokio::{
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};

use super::{
    tests::{call, config, manager, rpc},
    McpConfig, McpManager, McpStatus,
};
use crate::{crypto::CryptoManager, execution::tests::Fixture};

#[derive(Clone)]
struct Node {
    data: Vec<u8>,
    mode: u32,
}
impl Node {
    fn attrs(&self) -> FileAttributes {
        FileAttributes {
            size: Some(self.data.len() as u64),
            permissions: Some(self.mode),
            ..FileAttributes::empty()
        }
    }
}

#[derive(Default)]
struct Fs {
    nodes: HashMap<String, Node>,
    calls: Vec<String>,
    stalled: bool,
    fail_close: bool,
}

struct SshServer {
    fs: Arc<Mutex<Fs>>,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
}

impl server::Handler for SshServer {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        Ok(if user == "tester" && password == "test-only-secret" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        _: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.channels.insert(channel.id(), channel);
        Ok(true)
    }
    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        assert_eq!(name, "sftp");
        session.channel_success(id)?;
        let channel = self.channels.remove(&id).unwrap();
        let handler = SftpServer {
            fs: self.fs.clone(),
            handles: HashMap::new(),
            directory_read: false,
        };
        russh_sftp::server::run(channel.into_stream(), handler).await;
        Ok(())
    }
}

struct SftpServer {
    fs: Arc<Mutex<Fs>>,
    handles: HashMap<String, (String, bool)>,
    directory_read: bool,
}

fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}

impl russh_sftp::server::Handler for SftpServer {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.fs.lock().unwrap().calls.push(format!("stat:{path}"));
        if self.fs.lock().unwrap().stalled {
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
        let path = if path == "/link" { "/hello" } else { &path };
        Ok(Attrs {
            id,
            attrs: self
                .fs
                .lock()
                .unwrap()
                .nodes
                .get(path)
                .ok_or(StatusCode::NoSuchFile)?
                .attrs(),
        })
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.fs.lock().unwrap().calls.push(format!("lstat:{path}"));
        if self.fs.lock().unwrap().stalled {
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
        Ok(Attrs {
            id,
            attrs: self
                .fs
                .lock()
                .unwrap()
                .nodes
                .get(&path)
                .ok_or(StatusCode::NoSuchFile)?
                .attrs(),
        })
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let mut fs = self.fs.lock().unwrap();
        fs.calls.push(format!("open:{path}"));
        if flags.contains(OpenFlags::EXCLUDE) && fs.nodes.contains_key(&path) {
            return Err(StatusCode::Failure);
        }
        let path = if path == "/link" {
            "/hello".to_string()
        } else {
            path
        };
        if flags.contains(OpenFlags::CREATE) {
            fs.nodes.entry(path.clone()).or_insert(Node {
                data: Vec::new(),
                mode: 0o100000 | attrs.permissions.unwrap_or(0o644),
            });
        }
        let node = fs.nodes.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
        if flags.contains(OpenFlags::TRUNCATE) {
            node.data.clear();
        }
        let handle = id.to_string();
        self.handles
            .insert(handle.clone(), (path, flags.contains(OpenFlags::WRITE)));
        Ok(Handle { id, handle })
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let (path, _) = self.handles.get(&handle).ok_or(StatusCode::Failure)?;
        Ok(Attrs {
            id,
            attrs: self.fs.lock().unwrap().nodes[path].attrs(),
        })
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let (path, _) = self.handles.get(&handle).ok_or(StatusCode::Failure)?;
        let fs = self.fs.lock().unwrap();
        let data = &fs.nodes[path].data;
        let offset = usize::try_from(offset).map_err(|_| StatusCode::Eof)?;
        if offset >= data.len() {
            return Err(StatusCode::Eof);
        }
        // Short packets deliberately exercise multi-read assembly.
        Ok(Data {
            id,
            data: data[offset..(offset + (len as usize).min(8192)).min(data.len())].to_vec(),
        })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let (path, writable) = self.handles.get(&handle).ok_or(StatusCode::Failure)?;
        if !writable {
            return Err(StatusCode::PermissionDenied);
        }
        let mut fs = self.fs.lock().unwrap();
        let target = &mut fs.nodes.get_mut(path).unwrap().data;
        let offset = offset as usize;
        target.resize(target.len().max(offset + data.len()), 0);
        target[offset..offset + data.len()].copy_from_slice(&data);
        Ok(ok(id))
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        if self.fs.lock().unwrap().fail_close {
            return Err(StatusCode::Failure);
        }
        Ok(ok(id))
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        if path != "/" && path != "." {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(Handle {
            id,
            handle: "dir".into(),
        })
    }
    async fn readdir(&mut self, id: u32, _: String) -> Result<Name, Self::Error> {
        if self.directory_read {
            return Err(StatusCode::Eof);
        }
        self.directory_read = true;
        let fs = self.fs.lock().unwrap();
        let mut files = vec![
            File::new(".", FileAttributes::empty()),
            File::new("..", FileAttributes::empty()),
        ];
        let mut paths: Vec<_> = fs.nodes.keys().filter(|p| p.as_str() != "/").collect();
        paths.sort();
        files.extend(
            paths
                .into_iter()
                .map(|p| File::new(p.trim_start_matches('/'), fs.nodes[p].attrs())),
        );
        Ok(Name { id, files })
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let mut fs = self.fs.lock().unwrap();
        if fs.nodes.contains_key(&path) {
            return Err(StatusCode::Failure);
        }
        fs.nodes.insert(
            path,
            Node {
                data: Vec::new(),
                mode: 0o040000 | attrs.permissions.unwrap_or(0o755),
            },
        );
        Ok(ok(id))
    }
    async fn rename(&mut self, id: u32, old: String, new: String) -> Result<Status, Self::Error> {
        let mut fs = self.fs.lock().unwrap();
        if fs.nodes.contains_key(&new) {
            return Err(StatusCode::Failure);
        }
        let node = fs.nodes.remove(&old).ok_or(StatusCode::NoSuchFile)?;
        fs.nodes.insert(new, node);
        Ok(ok(id))
    }
    async fn remove(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let mut fs = self.fs.lock().unwrap();
        if fs.nodes.get(&path).ok_or(StatusCode::NoSuchFile)?.mode & 0o170000 == 0o040000 {
            return Err(StatusCode::Failure);
        }
        fs.nodes.remove(&path);
        Ok(ok(id))
    }
    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let mut fs = self.fs.lock().unwrap();
        if fs.nodes.get(&path).ok_or(StatusCode::NoSuchFile)?.mode & 0o170000 != 0o040000
            || fs.nodes.keys().any(|p| p.starts_with(&format!("{path}/")))
        {
            return Err(StatusCode::Failure);
        }
        fs.nodes.remove(&path);
        Ok(ok(id))
    }
}

struct TestEnv {
    fixture: Fixture,
    fs: Arc<Mutex<Fs>>,
    server: JoinHandle<()>,
}
impl Drop for TestEnv {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl TestEnv {
    async fn new(trusted: bool) -> Self {
        let fixture = Fixture::new(true).await;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        if trusted {
            fixture
                .db
                .save_host_key(
                    "127.0.0.1",
                    port,
                    key.public_key().algorithm().as_str(),
                    &key.public_key().to_bytes().unwrap(),
                )
                .unwrap();
        }
        fixture
            .db
            .conn()
            .execute(
                "UPDATE profiles SET port=?1 WHERE id=?2",
                (port, fixture.profile_id),
            )
            .unwrap();
        let fs = Arc::new(Mutex::new(Fs::default()));
        for (path, data, mode) in [
            ("/", Vec::new(), 0o040700),
            ("/hello", "hello 한글".as_bytes().to_vec(), 0o100600),
            ("/binary", vec![0, 255, 128, 13, 10], 0o100600),
            ("/link", Vec::new(), 0o120777),
            ("/socket", Vec::new(), 0o140600),
            ("/large", vec![b'x'; 100000], 0o100600),
        ] {
            fs.lock()
                .unwrap()
                .nodes
                .insert(path.into(), Node { data, mode });
        }
        let state = fs.clone();
        let server = tokio::spawn(async move {
            let config = Arc::new(server::Config {
                keys: vec![key],
                auth_rejection_time: Duration::ZERO,
                auth_rejection_time_initial: Some(Duration::ZERO),
                ..Default::default()
            });
            let mut sessions = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let handler = SshServer { fs:state.clone(), channels:HashMap::new() };
                        let config = config.clone();
                        sessions.spawn(async move { if let Ok(session) = server::run_stream(config, stream, handler).await { let _ = session.await; } });
                    }
                    _ = sessions.join_next(), if !sessions.is_empty() => {}
                }
            }
        });
        Self {
            fixture,
            fs,
            server,
        }
    }
    fn config(&self, write: bool) -> McpConfig {
        McpConfig {
            allow_sftp_read: true,
            allow_sftp_write: write,
            ..config(&self.fixture, false)
        }
    }
    async fn call(&self, status: &McpStatus, tool: &str, mut args: Value) -> Value {
        args["profile_id"] = json!(self.fixture.profile_id);
        call(status, tool, args).await
    }
}

fn content(response: &Value) -> &Value {
    assert_ne!(response["result"]["isError"], true, "{response}");
    assert!(response.get("error").is_none(), "{response}");
    &response["result"]["structuredContent"]
}
fn error(response: &Value) {
    assert!(
        response.get("error").is_some() || response["result"]["isError"] == true,
        "{response}"
    );
}

#[tokio::test]
async fn sftp_permissions_default_off_and_are_enforced_beyond_tool_discovery() {
    let e = TestEnv::new(true).await;
    let old: McpConfig = serde_json::from_value(
        json!({"port":0,"profile_ids":[e.fixture.profile_id],"allow_execution":true}),
    )
    .unwrap();
    assert!(!old.allow_sftp_read && !old.allow_sftp_write);
    let m = manager(&e.fixture);
    assert!(m
        .start(McpConfig {
            allow_sftp_write: true,
            ..old.clone()
        })
        .await
        .is_err());
    m.start(old).await.unwrap();
    let handler = m.running.lock().await.as_ref().unwrap().handler.clone();
    assert!(handler
        .dispatch(
            "cygnus_sftp_read",
            json!({"profile_id":e.fixture.profile_id,"path":"/hello"})
        )
        .await
        .is_err());
    m.stop().await;
    let status = m.start(e.config(false)).await.unwrap();
    let tools = rpc(&status, "tools/list", json!({})).await;
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 6);
    let handler = m.running.lock().await.as_ref().unwrap().handler.clone();
    assert!(handler
        .dispatch(
            "cygnus_sftp_write",
            json!({"profile_id":e.fixture.profile_id,"path":"/new","content":"secret"})
        )
        .await
        .is_err());
    error(
        &call(
            &status,
            "cygnus_sftp_stat",
            json!({"profile_id":999999,"path":"/hello"}),
        )
        .await,
    );
    error(
        &e.call(&status, "cygnus_execute", json!({"command":"uname"}))
            .await,
    );
    assert!(e.fs.lock().unwrap().calls.is_empty());
    m.stop().await;
}

#[tokio::test]
async fn sftp_lists_stats_and_reads_bounded_text_and_binary_without_history() {
    let e = TestEnv::new(true).await;
    let m = manager(&e.fixture);
    let status = m.start(e.config(false)).await.unwrap();
    let response = e
        .call(&status, "cygnus_sftp_list", json!({"path":".","limit":2}))
        .await;
    assert_eq!(content(&response)["entries"].as_array().unwrap().len(), 2);
    assert_eq!(content(&response)["truncated"], true);
    let response = e
        .call(&status, "cygnus_sftp_list", json!({"path":"."}))
        .await;
    assert_eq!(content(&response)["truncated"], false);
    let response = e
        .call(&status, "cygnus_sftp_stat", json!({"path":"/link"}))
        .await;
    assert_eq!(content(&response)["metadata"]["type"], "symlink");
    let response = e
        .call(&status, "cygnus_sftp_read", json!({"path":"/link"}))
        .await;
    assert_eq!(content(&response)["content"], "hello 한글");
    assert_eq!(content(&response)["eof"], true);
    let response = e
        .call(
            &status,
            "cygnus_sftp_read",
            json!({"path":"/hello","max_bytes":8}),
        )
        .await;
    assert_eq!(content(&response)["content"], "hello ");
    assert_eq!(content(&response)["next_offset"], 6);
    let response = e
        .call(
            &status,
            "cygnus_sftp_read",
            json!({"path":"/hello","offset":6}),
        )
        .await;
    assert_eq!(content(&response)["content"], "한글");
    error(
        &e.call(&status, "cygnus_sftp_read", json!({"path":"/binary"}))
            .await,
    );
    let response = e
        .call(
            &status,
            "cygnus_sftp_read",
            json!({"path":"/binary","encoding":"base64"}),
        )
        .await;
    assert_eq!(
        content(&response)["content"],
        STANDARD.encode([0, 255, 128, 13, 10])
    );
    let response = e
        .call(
            &status,
            "cygnus_sftp_read",
            json!({"path":"/large","max_bytes":65536}),
        )
        .await;
    assert_eq!(content(&response)["bytes_read"], 65536);
    assert_eq!(content(&response)["eof"], false);
    error(
        &e.call(&status, "cygnus_sftp_read", json!({"path":"/socket"}))
            .await,
    );
    assert!(!e.fs.lock().unwrap().calls.contains(&"open:/socket".into()));
    assert!(e.fixture.manager.list(100, 0).await.unwrap().is_empty());
    assert!(e
        .fixture
        .db
        .search_command_history(e.fixture.profile_id, None, 100)
        .unwrap()
        .is_empty());
    m.stop().await;
}

#[tokio::test]
async fn sftp_writes_require_explicit_overwrite_and_mutations_are_non_recursive() {
    let e = TestEnv::new(true).await;
    let m = manager(&e.fixture);
    let status = m.start(e.config(true)).await.unwrap();
    assert_eq!(
        rpc(&status, "tools/list", json!({})).await["result"]["tools"]
            .as_array()
            .unwrap()
            .len(),
        10
    );
    let response = e
        .call(
            &status,
            "cygnus_sftp_write",
            json!({"path":"/new","content":"hello 한글"}),
        )
        .await;
    assert_eq!(content(&response)["bytes_written"], 12);
    assert_eq!(e.fs.lock().unwrap().nodes["/new"].mode, 0o100600);
    error(
        &e.call(
            &status,
            "cygnus_sftp_write",
            json!({"path":"/new","content":"clobber"}),
        )
        .await,
    );
    assert_eq!(
        e.fs.lock().unwrap().nodes["/new"].data,
        "hello 한글".as_bytes()
    );
    content(
        &e.call(
            &status,
            "cygnus_sftp_write",
            json!({"path":"/new","content":"AAECA/8=","encoding":"base64","overwrite":true}),
        )
        .await,
    );
    assert_eq!(
        e.fs.lock().unwrap().nodes["/new"].data,
        vec![0, 1, 2, 3, 255]
    );
    error(
        &e.call(
            &status,
            "cygnus_sftp_write",
            json!({"path":"/link","content":"oops","overwrite":true}),
        )
        .await,
    );
    assert_eq!(
        e.fs.lock().unwrap().nodes["/hello"].data,
        "hello 한글".as_bytes()
    );
    content(
        &e.call(&status, "cygnus_sftp_mkdir", json!({"path":"/folder"}))
            .await,
    );
    assert_eq!(e.fs.lock().unwrap().nodes["/folder"].mode, 0o040700);
    error(
        &e.call(
            &status,
            "cygnus_sftp_rename",
            json!({"old_path":"/new","new_path":"/hello"}),
        )
        .await,
    );
    content(
        &e.call(
            &status,
            "cygnus_sftp_rename",
            json!({"old_path":"/new","new_path":"/folder/file"}),
        )
        .await,
    );
    error(
        &e.call(
            &status,
            "cygnus_sftp_remove",
            json!({"path":"/folder","directory":true}),
        )
        .await,
    );
    content(
        &e.call(
            &status,
            "cygnus_sftp_remove",
            json!({"path":"/folder/file"}),
        )
        .await,
    );
    content(
        &e.call(
            &status,
            "cygnus_sftp_remove",
            json!({"path":"/folder","directory":true}),
        )
        .await,
    );
    assert!(!e.fs.lock().unwrap().nodes.contains_key("/folder"));
    // Paths containing shell syntax are sent literally through SFTP.
    content(
        &e.call(
            &status,
            "cygnus_sftp_write",
            json!({"path":"/$(touch hacked);' file","content":""}),
        )
        .await,
    );
    assert!(e
        .fs
        .lock()
        .unwrap()
        .nodes
        .contains_key("/$(touch hacked);' file"));
    m.stop().await;
}

#[tokio::test]
async fn sftp_invalid_inputs_are_rejected_before_any_remote_request() {
    let e = TestEnv::new(true).await;
    let m = manager(&e.fixture);
    let status = m.start(e.config(true)).await.unwrap();
    for (tool, args) in [
        ("cygnus_sftp_stat", json!({"path":""})),
        ("cygnus_sftp_stat", json!({"path":"/a\u{0000}b"})),
        ("cygnus_sftp_stat", json!({"path":"a".repeat(4097)})),
        (
            "cygnus_sftp_read",
            json!({"path":"/hello","max_bytes":65537}),
        ),
        (
            "cygnus_sftp_read",
            json!({"path":"/hello","offset":u64::MAX}),
        ),
        (
            "cygnus_sftp_read",
            json!({"path":"/hello","local_path":"/private"}),
        ),
        ("cygnus_sftp_list", json!({"path":"/","limit":501})),
        (
            "cygnus_sftp_write",
            json!({"path":"/new","content":"x".repeat(65537)}),
        ),
        (
            "cygnus_sftp_write",
            json!({"path":"/new","content":"not base64!","encoding":"base64"}),
        ),
        ("cygnus_sftp_remove", json!({"path":"/","recursive":true})),
    ] {
        error(&e.call(&status, tool, args).await);
    }
    assert!(e.fs.lock().unwrap().calls.is_empty());
    m.stop().await;
}

#[tokio::test]
async fn sftp_requires_trusted_hosts_and_unlocked_credentials() {
    let e = TestEnv::new(false).await;
    let m = manager(&e.fixture);
    let status = m.start(e.config(false)).await.unwrap();
    error(
        &e.call(&status, "cygnus_sftp_read", json!({"path":"/hello"}))
            .await,
    );
    assert!(e.fs.lock().unwrap().calls.is_empty());
    m.stop().await;

    let e = TestEnv::new(true).await;
    let f = &e.fixture;
    let m = McpManager::new(
        f.db.clone(),
        CryptoManager::new(),
        f.manager.clone(),
        f.ssh.clone(),
    );
    let status = m.start(e.config(false)).await.unwrap();
    let response = e
        .call(&status, "cygnus_sftp_read", json!({"path":"/hello"}))
        .await;
    error(&response);
    assert!(response.to_string().contains("Unlock saved credentials"));
    assert!(e.fs.lock().unwrap().calls.is_empty());
    m.stop().await;
}

#[tokio::test]
async fn sftp_close_failure_does_not_report_write_success() {
    let e = TestEnv::new(true).await;
    let m = manager(&e.fixture);
    let status = m.start(e.config(true)).await.unwrap();
    e.fs.lock().unwrap().fail_close = true;
    let response = e
        .call(
            &status,
            "cygnus_sftp_write",
            json!({"path":"/new","content":"may be saved"}),
        )
        .await;
    error(&response);
    assert!(response.to_string().contains("do not automatically retry"));
    assert_eq!(e.fs.lock().unwrap().nodes["/new"].data, b"may be saved");
    m.stop().await;
}

#[tokio::test]
async fn sftp_stop_wakes_stalled_calls_and_enforces_concurrency_limit() {
    let e = TestEnv::new(true).await;
    let m = manager(&e.fixture);
    m.start(e.config(false)).await.unwrap();
    e.fs.lock().unwrap().stalled = true;
    let handler = m.running.lock().await.as_ref().unwrap().handler.clone();
    let mut requests = JoinSet::new();
    for _ in 0..4 {
        let h = handler.clone();
        let id = e.fixture.profile_id;
        requests.spawn(async move {
            h.dispatch("cygnus_sftp_stat", json!({"profile_id":id,"path":"/hello"}))
                .await
        });
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while e.fs.lock().unwrap().calls.len() < 4 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(handler
        .dispatch(
            "cygnus_sftp_stat",
            json!({"profile_id":e.fixture.profile_id,"path":"/hello"})
        )
        .await
        .unwrap_err()
        .contains("maximum 4"));
    tokio::time::timeout(Duration::from_secs(3), m.stop())
        .await
        .expect("stop must wake SFTP before acquiring grant write lock");
    while let Some(result) = requests.join_next().await {
        assert!(result.unwrap().unwrap_err().contains("MCP stopped"));
    }
    assert!(handler
        .dispatch(
            "cygnus_sftp_stat",
            json!({"profile_id":e.fixture.profile_id,"path":"/hello"})
        )
        .await
        .unwrap_err()
        .contains("stopped"));
    assert_eq!(handler.access.sftp_slots.available_permits(), 4);
}

#[tokio::test]
async fn sftp_manager_drop_also_cancels_inflight_requests() {
    let e = TestEnv::new(true).await;
    let m = manager(&e.fixture);
    m.start(e.config(false)).await.unwrap();
    e.fs.lock().unwrap().stalled = true;
    let handler = m.running.lock().await.as_ref().unwrap().handler.clone();
    let id = e.fixture.profile_id;
    let request = tokio::spawn(async move {
        handler
            .dispatch("cygnus_sftp_stat", json!({"profile_id":id,"path":"/hello"}))
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while e.fs.lock().unwrap().calls.is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    drop(m);
    let result = tokio::time::timeout(Duration::from_secs(3), request)
        .await
        .unwrap()
        .unwrap();
    assert!(result.unwrap_err().contains("MCP stopped"));
}
