use super::*;
use crate::db::Database;
use crate::ssh::{SshManager, SshSession};
use russh::server::{self, Session};
use russh::{Channel, ChannelId};
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, OnceCell};
use tokio::task::{JoinHandle, JoinSet};

type Replies = HashMap<String, Reply>;

#[derive(Clone, Default)]
struct Reply {
    stdout: String,
    stderr: String,
    status: u32,
    hang: bool,
}

fn ok(output: &str) -> Reply {
    Reply {
        stdout: output.into(),
        ..Default::default()
    }
}

struct TestServer {
    replies: Arc<Replies>,
    commands: Arc<StdMutex<Vec<String>>>,
}

impl server::Handler for TestServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _: &str, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        _: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(command).into_owned();
        self.commands.lock().unwrap().push(command.clone());
        let reply = self.replies.get(&command).cloned().unwrap_or(Reply {
            status: 127,
            ..Default::default()
        });
        session.channel_success(channel)?;
        if reply.hang {
            return Ok(());
        }
        if !reply.stdout.is_empty() {
            session.data(channel, reply.stdout.into_bytes())?;
        }
        if !reply.stderr.is_empty() {
            session.extended_data(channel, 1, reply.stderr.into_bytes())?;
        }
        // EOF may arrive before status; EOF alone does not mean success.
        session.eof(channel)?;
        session.exit_status_request(channel, reply.status)?;
        session.close(channel)?;
        Ok(())
    }
}

struct Fixture {
    ssh: SshManager,
    port: u16,
    commands: Arc<StdMutex<Vec<String>>>,
    server: JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Fixture {
    async fn new(replies: Replies) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let db = Arc::new(Database::new_in_memory().unwrap());
        let public = key.public_key();
        db.save_host_key(
            "127.0.0.1",
            port,
            public.algorithm().as_str(),
            &public.to_bytes().unwrap(),
        )
        .unwrap();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let replies = Arc::new(replies);
        let commands = Arc::new(StdMutex::new(Vec::new()));
        let recorded = commands.clone();
        let server = tokio::spawn(async move {
            let mut sessions = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let config = config.clone();
                        let handler = TestServer { replies: replies.clone(), commands: recorded.clone() };
                        sessions.spawn(async move {
                            if let Ok(session) = server::run_stream(config, stream, handler).await { let _ = session.await; }
                        });
                    }
                    _ = sessions.join_next(), if !sessions.is_empty() => {}
                }
            }
        });
        let fixture = Self {
            ssh: SshManager::new(db),
            port,
            commands,
            server,
        };
        fixture
            .attach("test", EnvironmentHints::new(None, None).unwrap())
            .await;
        fixture
    }

    async fn attach(&self, id: &str, hints: EnvironmentHints) {
        let connection = self
            .ssh
            .connect_transport(
                None,
                "127.0.0.1",
                self.port,
                "test",
                "password",
                Some("test-only"),
                None,
                None,
            )
            .await
            .unwrap();
        let (cmd_tx, _) = mpsc::channel(1);
        self.ssh.sessions.lock().await.insert(
            id.into(),
            SshSession {
                cmd_tx,
                handle: Arc::new(connection.handle),
                _jump_handle: connection._jump_handle,
                cancellation: CancellationToken::new(),
                environment: Arc::new(OnceCell::new()),
                environment_hints: hints,
            },
        );
    }

    fn count(&self) -> usize {
        self.commands.lock().unwrap().len()
    }
}

fn linux() -> Replies {
    HashMap::from([
        (POSIX_PROBE.into(), ok("__CYGNUS_POSIX__:/bin/bash\n")),
        ("uname -s".into(), ok("Linux\n")),
        (
            TOOLS_PROBE.into(),
            ok("__CYGNUS_TAIL__\n__CYGNUS_JOURNAL__\n__CYGNUS_MONITOR__\n__CYGNUS_TOOLS_DONE__\n"),
        ),
    ])
}

#[tokio::test]
async fn linux_discovery_is_coalesced_and_cached_per_session() {
    let f = Fixture::new(linux()).await;
    let (a, b) = tokio::join!(
        f.ssh.server_environment("test"),
        f.ssh.server_environment("test")
    );
    for env in [
        a.unwrap(),
        b.unwrap(),
        f.ssh.server_environment("test").await.unwrap(),
    ] {
        assert_eq!(env.os, "linux");
        assert_eq!(env.shell, "posix");
        assert!(env.capabilities.monitor && env.capabilities.file_logs && env.capabilities.journal);
    }
    assert_eq!(f.count(), 3);
    f.ssh.close_session("test").await.unwrap();
    assert!(f.ssh.server_environment("test").await.is_err());
    f.attach("reconnected", EnvironmentHints::new(None, None).unwrap())
        .await;
    assert!(
        f.ssh
            .server_environment("reconnected")
            .await
            .unwrap()
            .capabilities
            .monitor
    );
    assert_eq!(f.count(), 6, "reconnecting must discover again");
}

#[tokio::test]
async fn windows_shells_cannot_start_linux_monitor_or_logs() {
    for (command, output, shell) in [
        (POWERSHELL_PROBE, "__CYGNUS_PS__:5:Win32NT", "powershell"),
        (POWERSHELL_PROBE, "__CYGNUS_PS__:7:Win32NT", "pwsh"),
        (CMD_PROBE, "__CYGNUS_CMD__:Windows_NT", "cmd"),
    ] {
        let f = Fixture::new(HashMap::from([(command.into(), ok(output))])).await;
        let env = f.ssh.server_environment("test").await.unwrap();
        assert_eq!(env.os, "windows");
        assert_eq!(env.shell, shell);
        let count = f.count();
        assert!(crate::monitor::MonitorManager::new()
            .start("monitor", "test", &f.ssh)
            .await
            .is_err());
        let tails = crate::tail::TailManager::new();
        assert!(tails
            .start(
                "tail",
                "/var/log/test",
                "test",
                &f.ssh,
                50,
                tauri::ipc::Channel::new(|_| Ok(()))
            )
            .await
            .is_err());
        assert!(tails
            .start_journal(
                "journal",
                "-f",
                "test",
                &f.ssh,
                tauri::ipc::Channel::new(|_| Ok(()))
            )
            .await
            .is_err());
        assert_eq!(f.count(), count, "blocked providers must send no commands");
        assert!(!f.commands.lock().unwrap().iter().any(|s| s == TOOLS_PROBE));
    }
}

#[tokio::test]
async fn other_posix_and_missing_tools_have_independent_capabilities() {
    let mut replies = linux();
    replies.insert("uname -s".into(), ok("Darwin\n"));
    let f = Fixture::new(replies).await;
    let env = f.ssh.server_environment("test").await.unwrap();
    assert_eq!(env.os, "other");
    assert!(env.capabilities.file_logs);
    assert!(!env.capabilities.monitor && !env.capabilities.journal);
    let mut replies = linux();
    replies.insert(
        TOOLS_PROBE.into(),
        ok("__CYGNUS_TAIL__\n__CYGNUS_TOOLS_DONE__"),
    );
    let f = Fixture::new(replies).await;
    let env = f.ssh.server_environment("test").await.unwrap();
    assert!(env.capabilities.file_logs);
    assert!(!env.capabilities.monitor && !env.capabilities.journal);
}

#[tokio::test]
async fn manual_hints_never_grant_unverified_or_conflicting_capabilities() {
    let f = Fixture::new(linux()).await;
    f.attach(
        "conflict",
        EnvironmentHints::new(Some("windows".into()), Some("powershell".into())).unwrap(),
    )
    .await;
    let env = f.ssh.server_environment("conflict").await.unwrap();
    assert_eq!(env.os, "windows");
    assert_eq!(env.detected_os.as_deref(), Some("linux"));
    assert!(!env.capabilities.monitor && !env.capabilities.file_logs && !env.capabilities.journal);
    assert!(env.notice.unwrap().contains("differs"));
    assert_eq!(
        f.count(),
        2,
        "conflicting hints must not run the tools probe"
    );
    let f = Fixture::new(HashMap::new()).await;
    f.attach(
        "hint",
        EnvironmentHints::new(Some("linux".into()), Some("posix".into())).unwrap(),
    )
    .await;
    let env = f.ssh.server_environment("hint").await.unwrap();
    assert_eq!(env.os, "linux");
    assert_eq!(env.detected_os, None);
    assert!(env.require(ServerCapability::Monitor).is_err());
}

#[tokio::test]
async fn malformed_or_failed_probes_fail_closed_without_exposing_output() {
    for reply in [
        ok("__CYGNUS_POSIX__:"),
        Reply {
            stdout: "__CYGNUS_POSIX__:bash".into(),
            status: 1,
            ..Default::default()
        },
        Reply {
            stderr: "__CYGNUS_POSIX__:bash".into(),
            ..Default::default()
        },
        ok(&"private-output".repeat(1000)),
    ] {
        let f = Fixture::new(HashMap::from([(POSIX_PROBE.into(), reply)])).await;
        let env = f.ssh.server_environment("test").await.unwrap();
        assert_eq!(env.os, "unknown");
        assert_eq!(env.detected_shell, None);
        assert!(
            !env.capabilities.monitor && !env.capabilities.file_logs && !env.capabilities.journal
        );
        assert!(!serde_json::to_string(&env)
            .unwrap()
            .contains("private-output"));
    }
}

#[tokio::test]
async fn close_cancels_discovery_without_holding_the_session_lock() {
    let f = Fixture::new(HashMap::from([(
        POSIX_PROBE.into(),
        Reply {
            hang: true,
            ..Default::default()
        },
    )]))
    .await;
    let ssh = f.ssh.clone();
    let pending = tokio::spawn(async move { ssh.server_environment("test").await });
    tokio::time::timeout(Duration::from_secs(1), async {
        while f.count() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_millis(250), f.ssh.command_connection("test"))
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), f.ssh.close_session("test"))
        .await
        .unwrap()
        .unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .unwrap()
        .unwrap()
        .is_err());
}

#[tokio::test]
async fn command_reader_bounds_time_and_both_output_streams() {
    let f = Fixture::new(HashMap::from([
        (
            "hang".into(),
            Reply {
                hang: true,
                ..Default::default()
            },
        ),
        (
            "stderr".into(),
            Reply {
                stderr: "x".repeat(9000),
                ..Default::default()
            },
        ),
        ("ok".into(), ok("done")),
    ]))
    .await;
    let (handle, cancel) = f.ssh.command_connection("test").await.unwrap();
    let result = read_command(
        handle.clone(),
        &cancel,
        "hang",
        Duration::from_millis(50),
        100,
    )
    .await;
    assert!(result.unwrap_err().contains("timed out"));
    assert!(read_command(
        handle.clone(),
        &cancel,
        "stderr",
        Duration::from_secs(1),
        100
    )
    .await
    .unwrap_err()
    .contains("limit"));
    assert_eq!(
        read_command(handle.clone(), &cancel, "ok", Duration::from_secs(1), 100)
            .await
            .unwrap(),
        "done"
    );
    cancel.cancel();
    let count = f.count();
    assert!(
        read_command(handle, &cancel, "ok", Duration::from_secs(1), 100)
            .await
            .is_err()
    );
    assert_eq!(f.count(), count);
}

#[test]
fn parsers_reject_unknown_shells_and_unexpanded_markers() {
    assert!(posix_shell("__CYGNUS_POSIX__:-bash"));
    assert!(!posix_shell("__CYGNUS_POSIX__:$0"));
    assert!(!posix_shell("__CYGNUS_POSIX__:fish"));
    assert_eq!(unix_os("Linux\nerror"), None);
    assert_eq!(unix_os("MINGW64_NT-10.0").as_deref(), Some("windows"));
    assert_eq!(powershell("__CYGNUS_PS__:7:Unix"), Some(("unix", "pwsh")));
    assert_eq!(powershell("__CYGNUS_PS__:0:Win32NT"), None);
    assert!(EnvironmentHints::new(Some("linux;uname".into()), None).is_err());
}

fn ps_frame(value: serde_json::Value) -> Reply {
    use base64::Engine;
    ok(&format!(
        "__CYGNUS_JSON__:{}\r\n",
        base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&value).unwrap())
    ))
}

fn windows_replies(shell: &str, engine: crate::ssh::powershell::PowerShellEngine) -> Replies {
    use crate::ssh::powershell::{command, PowerShellEngine, Query};
    let (probe, output) = match shell {
        "powershell" => (POWERSHELL_PROBE, "__CYGNUS_PS__:5:Win32NT"),
        "pwsh" => (POWERSHELL_PROBE, "__CYGNUS_PS__:7:Win32NT"),
        _ => (CMD_PROBE, "__CYGNUS_CMD__:Windows_NT"),
    };
    let version = if engine == PowerShellEngine::PowerShell {
        "5.1.20348.1"
    } else {
        "7.5.1"
    };
    HashMap::from([
        (probe.into(), ok(output)),
        (
            command(engine, Query::Probe),
            ps_frame(serde_json::json!({"schema":1,"os":"Win32NT","version":version,"cim":true})),
        ),
        (
            command(engine, Query::Snapshot),
            ps_frame(serde_json::json!({
                "schema":1,"cpu":[{"load":35,"logical":8}],"memory":{"total_kib":1000,"free_kib":400},
                "disks":[{"name":"C:","total_bytes":2000,"free_bytes":1200}],"uptime_seconds":7200,
                "processes":[{"pid":42,"name":"서버.exe","memory_bytes":100}]
            })),
        ),
    ])
}

#[tokio::test]
async fn verified_windows_runtimes_route_monitoring_to_powershell_only() {
    use crate::ssh::powershell::{command, PowerShellEngine, Query};
    for (shell, engine) in [
        ("powershell", PowerShellEngine::PowerShell),
        ("pwsh", PowerShellEngine::Pwsh),
        ("cmd", PowerShellEngine::PowerShell),
        ("cmd", PowerShellEngine::Pwsh),
    ] {
        let f = Fixture::new(windows_replies(shell, engine)).await;
        let env = f.ssh.server_environment("test").await.unwrap();
        assert!(env.capabilities.monitor);
        assert!(!env.capabilities.file_logs && !env.capabilities.journal);
        assert_eq!(env.powershell.unwrap().engine, engine);
        let manager = crate::monitor::MonitorManager::new();
        manager.start("windows", "test", &f.ssh).await.unwrap();
        let stats = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match manager.get_stats("windows").await.unwrap() {
                    Some(stats) => break stats,
                    None => tokio::task::yield_now().await,
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(stats.platform, "windows");
        assert_eq!(stats.cpu_usage, Some(35.0));
        assert_eq!(
            stats.windows.unwrap().processes.unwrap()[0].name,
            "서버.exe"
        );
        let commands = f.commands.lock().unwrap().clone();
        assert!(commands.contains(&command(engine, Query::Snapshot)));
        assert!(!commands
            .iter()
            .any(|s| s.contains("/proc/stat") || s.contains("journalctl") || s == "uname -s"));
        manager.stop("windows").await;
        assert!(manager.get_stats("windows").await.is_err());
    }
}

#[tokio::test]
async fn unsupported_runtime_or_missing_cim_never_grants_monitoring() {
    use crate::ssh::powershell::{command, PowerShellEngine, Query};
    for (version, os, cim) in [
        ("5.0", "Win32NT", true),
        ("5.1", "Unix", true),
        ("5.1", "Win32NT", false),
    ] {
        let mut replies = windows_replies("cmd", PowerShellEngine::PowerShell);
        replies.insert(
            command(PowerShellEngine::PowerShell, Query::Probe),
            ps_frame(serde_json::json!({"schema":1,"version":version,"os":os,"cim":cim})),
        );
        let f = Fixture::new(replies).await;
        assert!(
            !f.ssh
                .server_environment("test")
                .await
                .unwrap()
                .capabilities
                .monitor
        );
        assert!(crate::monitor::MonitorManager::new()
            .start("blocked", "test", &f.ssh)
            .await
            .is_err());
        assert!(!f
            .commands
            .lock()
            .unwrap()
            .contains(&command(PowerShellEngine::PowerShell, Query::Snapshot)));
    }
}

#[tokio::test]
async fn closing_windows_session_cancels_an_inflight_snapshot() {
    use crate::ssh::powershell::{command, PowerShellEngine, Query};
    let snapshot = command(PowerShellEngine::PowerShell, Query::Snapshot);
    let mut replies = windows_replies("cmd", PowerShellEngine::PowerShell);
    replies.insert(
        snapshot.clone(),
        Reply {
            hang: true,
            ..Default::default()
        },
    );
    let f = Fixture::new(replies).await;
    let manager = crate::monitor::MonitorManager::new();
    manager.start("hanging", "test", &f.ssh).await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while !f.commands.lock().unwrap().contains(&snapshot) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        manager.get_stats("hanging").await.unwrap().is_none(),
        "pending is not a healthy zero or an error"
    );
    f.ssh.close_session("test").await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if manager.get_stats("hanging").await.is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    manager.stop("hanging").await;
}

#[tokio::test]
async fn conflicting_windows_hints_cannot_invoke_powershell_provider() {
    use crate::ssh::powershell::PowerShellEngine;
    let f = Fixture::new(windows_replies("cmd", PowerShellEngine::PowerShell)).await;
    f.attach(
        "conflict",
        EnvironmentHints::new(Some("linux".into()), None).unwrap(),
    )
    .await;
    let env = f.ssh.server_environment("conflict").await.unwrap();
    assert!(!env.capabilities.monitor);
    assert!(env.powershell.is_none());
    assert!(!f
        .commands
        .lock()
        .unwrap()
        .iter()
        .any(|s| s.contains("-EncodedCommand")));
}

#[tokio::test]
async fn iis_queries_use_verified_powershell_even_without_cim() {
    use crate::ssh::powershell::{command, PowerShellEngine, Query};
    for (shell, engine, version) in [
        ("cmd", PowerShellEngine::PowerShell, "5.1"),
        ("pwsh", PowerShellEngine::Pwsh, "7.5"),
    ] {
        let mut replies = windows_replies(shell, engine);
        replies.insert(
            command(engine, Query::Probe),
            ps_frame(serde_json::json!({"schema":1,"version":version,"os":"Win32NT","cim":false})),
        );
        replies.insert(command(engine, Query::IisOverview), ps_frame(serde_json::json!({"schema":1,"status":"available","sites":[],"pools":null,"truncated":false})));
        replies.insert(command(engine, Query::IisLog {site_id: 42}), ps_frame(serde_json::json!({"schema":1,"site_id":42,"status":"no_logs","file":null,"lines":[],"truncated":false})));
        replies.insert(command(engine, Query::WindowsEvents), ps_frame(serde_json::json!({"schema":1,"logs":[{"name":"Application","events":[]},{"name":"System","events":null}]})));
        let f = Fixture::new(replies).await;
        assert!(
            !f.ssh
                .server_environment("test")
                .await
                .unwrap()
                .capabilities
                .monitor
        );
        assert!(crate::iis::overview(&f.ssh, "test")
            .await
            .unwrap()
            .sites
            .unwrap()
            .is_empty());
        assert_eq!(
            crate::iis::site_log(&f.ssh, "test", 42)
                .await
                .unwrap()
                .status,
            crate::iis::LogStatus::NoLogs
        );
        assert!(crate::iis::events(&f.ssh, "test").await.unwrap().logs[1]
            .events
            .is_none());
        assert!(!f
            .commands
            .lock()
            .unwrap()
            .contains(&command(engine, Query::Snapshot)));
    }
}

#[tokio::test]
async fn iis_rejects_unverified_hosts_conflicts_and_zero_id_before_query() {
    use crate::ssh::powershell::PowerShellEngine;
    let f = Fixture::new(HashMap::new()).await;
    assert!(crate::iis::site_log(&f.ssh, "test", 0).await.is_err());
    assert!(f.commands.lock().unwrap().is_empty());
    assert!(crate::iis::overview(&f.ssh, "test").await.is_err());
    assert!(!f
        .commands
        .lock()
        .unwrap()
        .iter()
        .any(|s| s.contains("-EncodedCommand")));
    let f = Fixture::new(windows_replies("cmd", PowerShellEngine::PowerShell)).await;
    f.attach(
        "conflict",
        EnvironmentHints::new(Some("linux".into()), None).unwrap(),
    )
    .await;
    assert!(crate::iis::events(&f.ssh, "conflict").await.is_err());
    assert!(!f
        .commands
        .lock()
        .unwrap()
        .iter()
        .any(|s| s.contains("-EncodedCommand")));
}

#[tokio::test]
async fn iis_rejects_remote_schema_errors_without_exposing_the_payload() {
    use crate::ssh::powershell::{command, PowerShellEngine, Query};
    let engine = PowerShellEngine::PowerShell;
    let mut replies = windows_replies("cmd", engine);
    replies.insert(command(engine, Query::IisOverview), ps_frame(serde_json::json!({"schema":1,"status":"available","sites":[],"pools":[],"truncated":false,"password":"PRIVATE"})));
    let f = Fixture::new(replies).await;
    let error = crate::iis::overview(&f.ssh, "test").await.unwrap_err();
    assert!(!error.contains("PRIVATE"));
}

#[tokio::test]
async fn closing_session_cancels_an_inflight_iis_query() {
    use crate::ssh::powershell::{command, PowerShellEngine, Query};
    let engine = PowerShellEngine::PowerShell;
    let query = command(engine, Query::IisOverview);
    let mut replies = windows_replies("cmd", engine);
    replies.insert(
        query.clone(),
        Reply {
            hang: true,
            ..Default::default()
        },
    );
    let f = Fixture::new(replies).await;
    let ssh = f.ssh.clone();
    let task = tokio::spawn(async move { crate::iis::overview(&ssh, "test").await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while !f.commands.lock().unwrap().contains(&query) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    f.ssh.close_session("test").await.unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap()
        .is_err());
}
