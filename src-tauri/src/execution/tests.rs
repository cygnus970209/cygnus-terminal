use super::*;
use crate::db::profile::CreateProfileRequest;
use russh::server::{self, Session};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};

#[derive(Default)]
struct TestServer {
    waiting_for_stdin: bool,
    allow_pty: bool,
    has_pty: bool,
    interactive: bool,
}

impl server::Handler for TestServer {
    type Error = russh::Error;

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.has_pty = self.allow_pty;
        if self.allow_pty {
            session.channel_success(channel)?;
        } else {
            session.channel_failure(channel)?;
        }
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.interactive {
            // Deliberately echo human input, including secrets, on both output streams.
            session.data(channel, data.to_vec())?;
            session.extended_data(channel, 1, data.to_vec())?;
            if data.starts_with(b"signal-private-") {
                session.exit_signal_request(
                    channel,
                    Sig::Custom(String::from_utf8_lossy(data).into_owned()),
                    false,
                    "private failure text",
                    "en",
                )?;
            } else {
                session.exit_status_request(channel, 0)?;
            }
            session.eof(channel)?;
            session.close(channel)?;
        }
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.interactive {
            session.data(channel, format!("size:{cols}x{rows}\n").into_bytes())?;
        }
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<server::Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        _: &mut Session,
    ) -> Result<bool, Self::Error> {
        let mut socket = tokio::net::TcpStream::connect((host, port as u16)).await?;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut socket).await;
        });
        Ok(true)
    }

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
        if command == b"reject" {
            session.channel_failure(channel)?;
            session.close(channel)?;
            return Ok(());
        }
        session.channel_success(channel)?;
        match command {
            b"interactive" => {
                assert!(
                    self.has_pty,
                    "interactive commands must have an accepted PTY"
                );
                self.interactive = true;
                session.data(channel, b"Password: ".to_vec())?;
                return Ok(());
            }
            b"signal" => {
                session.exit_signal_request(channel, Sig::TERM, false, "terminated", "en")?;
                session.close(channel)?;
                return Ok(());
            }
            b"hang" => {
                session.data(channel, b"started".to_vec())?;
                return Ok(());
            }
            b"stdin_eof" => {
                self.waiting_for_stdin = true;
                return Ok(());
            }
            b"overflow" => {
                session.data(channel, vec![b'x'; 8192])?;
            }
            b"utf8" => {
                let bytes = "서버 결과".as_bytes();
                session.data(channel, bytes[..1].to_vec())?;
                session.data(channel, bytes[1..5].to_vec())?;
                session.data(channel, bytes[5..].to_vec())?;
            }
            _ => {
                session.data(channel, b"hello\n".to_vec())?;
                session.extended_data(channel, 1, b"diagnostic\n".to_vec())?;
            }
        }
        session.eof(channel)?;
        if command != b"missing_exit" {
            // Explicitly exercise EOF-before-exit-status ordering.
            session.exit_status_request(channel, if command == b"nonzero" { 7 } else { 0 })?;
        }
        session.close(channel)?;
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.waiting_for_stdin {
            session.data(channel, b"stdin closed".to_vec())?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
        }
        Ok(())
    }
}

pub(crate) struct Fixture {
    pub(crate) db: Arc<Database>,
    pub(crate) crypto: CryptoManager,
    pub(crate) manager: ExecutionManager,
    pub(crate) ssh: SshManager,
    pub(crate) profile_id: i64,
    server: JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Fixture {
    pub(crate) async fn new(trusted: bool) -> Self {
        Self::with_pty(trusted, true).await
    }

    async fn with_pty(trusted: bool, allow_pty: bool) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let db = Arc::new(Database::new_in_memory().unwrap());
        if trusted {
            let public = key.public_key();
            db.save_host_key(
                "127.0.0.1",
                port,
                public.algorithm().as_str(),
                &public.to_bytes().unwrap(),
            )
            .unwrap();
        }
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let server = tokio::spawn(async move {
            let mut sessions = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let config = config.clone();
                        sessions.spawn(async move {
                            if let Ok(session) = server::run_stream(config, stream, TestServer { allow_pty, ..Default::default() }).await {
                                let _ = session.await;
                            }
                        });
                    }
                    _ = sessions.join_next(), if !sessions.is_empty() => {}
                }
            }
        });
        let crypto = CryptoManager::new_random();
        let profile = db
            .create_profile(
                CreateProfileRequest {
                    protocol: Some("ssh".into()),
                    baud_rate: None,
                    name: "Execution fixture".into(),
                    host: "127.0.0.1".into(),
                    port,
                    username: "tester".into(),
                    auth_type: "password".into(),
                    password: Some("test-only-secret".into()),
                    key_path: None,
                    group_name: None,
                    jump_host: None,
                    agent_forward: None,
                    environment: None,
                },
                &crypto,
            )
            .unwrap();
        let manager = ExecutionManager::new(db.clone()).unwrap();
        let ssh = SshManager::new(db.clone());
        Self {
            db,
            crypto,
            manager,
            ssh,
            profile_id: profile.id,
            server,
        }
    }

    fn request(&self, command: &str) -> StartExecutionRequest {
        StartExecutionRequest {
            profile_id: self.profile_id,
            command: command.into(),
            timeout_seconds: Some(5),
            output_limit_bytes: None,
        }
    }

    pub(crate) async fn start(&self, command: &str) -> String {
        self.manager
            .start(self.request(command), &self.crypto, self.ssh.clone())
            .await
            .unwrap()
    }

    pub(crate) async fn finished(&self, id: &str) -> ExecutionJob {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let job = self.manager.get(id).await.unwrap();
                if job.summary.status.is_terminal() {
                    return job;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("job should finish")
    }

    pub(crate) async fn has_output(&self, id: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.manager.get(id).await.unwrap().stdout.is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("job should produce output");
    }
}

#[tokio::test]
async fn exec_captures_streams_exit_after_eof_and_persists_without_credentials() {
    let f = Fixture::new(true).await;
    f.manager
        .set_history_settings(HistorySettings {
            enabled: true,
            retention_days: 7,
        })
        .await
        .unwrap();
    let id = f.start("success").await;
    let job = f.finished(&id).await;
    assert_eq!(job.summary.status, ExecutionStatus::Succeeded);
    assert_eq!(job.stdout, "hello\n");
    assert_eq!(job.stderr, "diagnostic\n");
    assert_eq!(job.summary.exit_code, Some(0));
    assert!(!job.summary.remote_outcome_unknown);
    assert!(job.summary.duration_ms.is_some());
    assert!(
        f.ssh.clone_inner().lock().await.is_empty(),
        "must not create a terminal session"
    );
    let persisted = f.db.get_execution_job(&id).unwrap();
    assert_eq!(persisted.stdout, job.stdout);
    assert!(!serde_json::to_string(&persisted)
        .unwrap()
        .contains("test-only-secret"));
    let restored = ExecutionManager::new(f.db.clone()).unwrap();
    assert_eq!(
        restored.get(&id).await.unwrap().summary.status,
        ExecutionStatus::Succeeded
    );
    assert_eq!(restored.list(50, 0).await.unwrap()[0].id, id);
    assert!(restored.list(50, 1).await.unwrap().is_empty());
    restored.cancel(&id).await.unwrap();
    assert_eq!(
        restored.get(&id).await.unwrap().summary.status,
        ExecutionStatus::Succeeded
    );
}

#[tokio::test]
async fn nonzero_missing_exit_and_rejected_exec_have_distinct_results() {
    let f = Fixture::new(true).await;
    for (command, code, unknown) in [
        ("nonzero", Some(7), false),
        ("missing_exit", None, true),
        ("reject", None, false),
    ] {
        let id = f.start(command).await;
        let job = f.finished(&id).await;
        assert_eq!(job.summary.status, ExecutionStatus::Failed, "{command}");
        assert_eq!(job.summary.exit_code, code, "{command}");
        assert_eq!(job.summary.remote_outcome_unknown, unknown, "{command}");
    }
}

#[tokio::test]
async fn stdin_is_closed_and_utf8_survives_packet_boundaries() {
    let f = Fixture::new(true).await;
    for (command, expected) in [("stdin_eof", "stdin closed"), ("utf8", "서버 결과")] {
        let id = f.start(command).await;
        let job = f.finished(&id).await;
        assert_eq!(job.summary.status, ExecutionStatus::Succeeded);
        assert_eq!(job.stdout, expected);
    }
}

#[tokio::test]
async fn output_limit_drains_to_exit_without_growing_memory() {
    let f = Fixture::new(true).await;
    let mut req = f.request("overflow");
    req.output_limit_bytes = Some(7);
    let id = f
        .manager
        .start(req, &f.crypto, f.ssh.clone())
        .await
        .unwrap();
    let job = f.finished(&id).await;
    assert_eq!(job.stdout, "xxxxxxx");
    assert!(job.summary.output_truncated);
    assert_eq!(job.summary.status, ExecutionStatus::Succeeded);
    assert_eq!(job.summary.exit_code, Some(0));
}

#[tokio::test]
async fn cancellation_and_timeout_do_not_claim_remote_termination() {
    let f = Fixture::new(true).await;
    let id = f.start("hang").await;
    f.has_output(&id).await;
    // A blocked job must not block another connection or terminal registry access.
    let other = f.start("success").await;
    assert_eq!(
        f.finished(&other).await.summary.status,
        ExecutionStatus::Succeeded
    );
    f.manager.cancel(&id).await.unwrap();
    let job = f.finished(&id).await;
    assert_eq!(job.summary.status, ExecutionStatus::Cancelled);
    assert!(job.summary.remote_outcome_unknown);
    assert_eq!(job.stdout, "started");
    let mut req = f.request("hang");
    req.timeout_seconds = Some(1);
    let id = f
        .manager
        .start(req, &f.crypto, f.ssh.clone())
        .await
        .unwrap();
    let job = f.finished(&id).await;
    assert_eq!(job.summary.status, ExecutionStatus::TimedOut);
    assert!(job.summary.remote_outcome_unknown);
}

#[tokio::test]
async fn cancellation_before_dispatch_and_unknown_host_do_not_execute() {
    let f = Fixture::new(true).await;
    let id = f.start("success").await;
    f.manager.cancel(&id).await.unwrap();
    let job = f.finished(&id).await;
    assert_eq!(job.summary.status, ExecutionStatus::Cancelled);
    assert!(!job.summary.remote_outcome_unknown);
    let untrusted = Fixture::new(false).await;
    let id = untrusted.start("success").await;
    let job = untrusted.finished(&id).await;
    assert_eq!(job.summary.status, ExecutionStatus::Failed);
    assert!(!job.summary.remote_outcome_unknown);
    assert!(job.stdout.is_empty());
    assert_eq!(
        untrusted
            .db
            .conn()
            .query_row("SELECT COUNT(*) FROM known_hosts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn validation_and_keychain_consent_happen_before_job_creation() {
    let f = Fixture::new(true).await;
    let mut invalid = f.request("success");
    invalid.timeout_seconds = Some(0);
    assert!(f
        .manager
        .start(invalid, &f.crypto, f.ssh.clone())
        .await
        .is_err());
    assert!(f
        .manager
        .start(f.request("\0"), &f.crypto, f.ssh.clone())
        .await
        .is_err());
    assert_eq!(
        f.manager
            .start(f.request("success"), &CryptoManager::new(), f.ssh.clone())
            .await
            .unwrap_err(),
        "KEYCHAIN_CONSENT_REQUIRED"
    );
    f.db.conn()
        .execute("UPDATE profiles SET protocol='telnet'", [])
        .unwrap();
    assert!(f
        .manager
        .start(f.request("success"), &f.crypto, f.ssh.clone())
        .await
        .unwrap_err()
        .contains("SSH profiles only"));
    assert!(f.manager.list(50, 0).await.unwrap().is_empty());
}

#[tokio::test]
async fn startup_marks_unfinished_jobs_interrupted_without_replaying() {
    let f = Fixture::new(true).await;
    f.manager
        .set_history_settings(HistorySettings {
            enabled: true,
            retention_days: 7,
        })
        .await
        .unwrap();
    let id = f.start("success").await;
    let mut job = f.finished(&id).await;
    job.summary.status = ExecutionStatus::Running;
    job.summary.exit_code = None;
    job.summary.remote_outcome_unknown = true;
    job.summary.finished_at = None;
    job.summary.duration_ms = None;
    f.db.save_execution_job(&job).unwrap();
    let recovered = ExecutionManager::new(f.db.clone()).unwrap();
    let job = recovered.get(&id).await.unwrap();
    assert_eq!(job.summary.status, ExecutionStatus::Interrupted);
    assert!(job.summary.remote_outcome_unknown);
    assert!(job.summary.finished_at.is_some());
    assert!(recovered.active.lock().await.is_empty());
    // A profile deletion must not erase the execution history snapshot.
    f.db.delete_profile(f.profile_id).unwrap();
    assert_eq!(
        recovered.get(&id).await.unwrap().summary.profile_name,
        "Execution fixture"
    );
}

#[tokio::test]
async fn jump_host_connection_is_kept_alive_for_the_job() {
    let target = Fixture::new(true).await;
    let jump = Fixture::new(true).await;
    let jump_profile = jump.db.get_profile(jump.profile_id, &jump.crypto).unwrap();
    let jump_key: Vec<u8> = jump
        .db
        .conn()
        .query_row("SELECT host_key FROM known_hosts", [], |row| row.get(0))
        .unwrap();
    target
        .db
        .save_host_key("127.0.0.1", jump_profile.port, "ssh-ed25519", &jump_key)
        .unwrap();
    let config = serde_json::json!({
        "host": "127.0.0.1", "port": jump_profile.port, "username": "tester",
        "auth_type": "password", "password": "test-only-secret", "key_path": null,
    });
    let encrypted = target.crypto.encrypt(&config.to_string()).unwrap();
    target
        .db
        .conn()
        .execute("UPDATE profiles SET jump_host=?1", [encrypted])
        .unwrap();
    let id = target.start("success").await;
    let job = target.finished(&id).await;
    assert_eq!(job.summary.status, ExecutionStatus::Succeeded);
    assert_eq!(job.stdout, "hello\n");
    assert!(!serde_json::to_string(&job)
        .unwrap()
        .contains("test-only-secret"));
}

#[tokio::test]
async fn changed_host_key_and_failed_auth_never_dispatch_commands() {
    let f = Fixture::new(true).await;
    f.db.conn()
        .execute("UPDATE known_hosts SET host_key=x'0000'", [])
        .unwrap();
    let id = f.start("success").await;
    let job = f.finished(&id).await;
    assert_eq!(job.summary.status, ExecutionStatus::Failed);
    assert!(!job.summary.remote_outcome_unknown);
    assert!(job.stdout.is_empty());

    let f = Fixture::new(true).await;
    let encrypted = f.crypto.encrypt("incorrect-password").unwrap();
    f.db.conn()
        .execute("UPDATE profiles SET password=?1", [encrypted])
        .unwrap();
    let id = f.start("success").await;
    let job = f.finished(&id).await;
    assert_eq!(job.summary.status, ExecutionStatus::Failed);
    assert!(!job.summary.remote_outcome_unknown);
    assert!(job.stdout.is_empty());
}

#[tokio::test]
async fn remote_exit_signal_is_a_confirmed_failure() {
    let f = Fixture::new(true).await;
    let id = f.start("signal").await;
    let job = f.finished(&id).await;
    assert_eq!(job.summary.status, ExecutionStatus::Failed);
    assert_eq!(job.summary.exit_signal.as_deref(), Some("TERM"));
    assert!(!job.summary.remote_outcome_unknown);
}

#[tokio::test]
async fn timeout_covers_a_server_that_never_sends_an_ssh_greeting() {
    let f = Fixture::new(true).await;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    f.db.conn()
        .execute("UPDATE profiles SET port=?1", [port])
        .unwrap();
    let mut req = f.request("success");
    req.timeout_seconds = Some(1);
    let id = f
        .manager
        .start(req, &f.crypto, f.ssh.clone())
        .await
        .unwrap();
    let job = f.finished(&id).await;
    assert_eq!(job.summary.status, ExecutionStatus::TimedOut);
    assert!(!job.summary.remote_outcome_unknown);
}

async fn stalled_key_exchange_closes_transport(via_jump: bool, cancel: bool) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let f = Fixture::new(true).await;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let jump = if via_jump {
        let profile = f.db.get_profile(f.profile_id, &f.crypto).unwrap();
        let config = serde_json::json!({
            "host": profile.host, "port": profile.port, "username": profile.username,
            "auth_type": "password", "password": "test-only-secret", "key_path": null,
        });
        Some(f.crypto.encrypt(&config.to_string()).unwrap())
    } else {
        None
    };
    f.db.conn()
        .execute(
            "UPDATE profiles SET port=?1,jump_host=?2",
            rusqlite::params![port, jump],
        )
        .unwrap();
    let mut req = f.request("must not execute");
    req.timeout_seconds = Some(if cancel { 5 } else { 1 });
    let id = f
        .manager
        .start(req, &f.crypto, f.ssh.clone())
        .await
        .unwrap();

    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut banner = Vec::new();
        loop {
            let byte = socket.read_u8().await.unwrap();
            banner.push(byte);
            assert!(banner.len() <= 1024);
            if byte == b'\n' {
                break;
            }
        }
        socket
            .write_all(b"SSH-2.0-stalled_kex_fixture\r\n")
            .await
            .unwrap();
        let packet_len = socket.read_u32().await.unwrap() as usize;
        assert!((2..=65536).contains(&packet_len));
        let mut packet = vec![0; packet_len];
        socket.read_exact(&mut packet).await.unwrap();
        assert_eq!(
            packet[1], 20,
            "wait for SSH_MSG_KEXINIT, after russh spawns its session"
        );
    })
    .await
    .unwrap();
    if cancel {
        f.manager.cancel(&id).await.unwrap();
    }
    let job = f.finished(&id).await;
    assert_eq!(
        job.summary.status,
        if cancel {
            ExecutionStatus::Cancelled
        } else {
            ExecutionStatus::TimedOut
        }
    );
    assert!(!job.summary.remote_outcome_unknown);
    assert!(job.stdout.is_empty());
    let mut remaining = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut remaining))
        .await
        .expect("terminal job must close the stalled handshake transport");
    if let Err(error) = closed {
        assert!(
            matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
            ),
            "{error}"
        );
    }
}

#[tokio::test]
async fn timeout_during_key_exchange_closes_transport() {
    stalled_key_exchange_closes_transport(false, false).await;
}

#[tokio::test]
async fn cancellation_during_key_exchange_closes_transport() {
    stalled_key_exchange_closes_transport(false, true).await;
}

#[tokio::test]
async fn timeout_during_jump_target_key_exchange_closes_transport() {
    stalled_key_exchange_closes_transport(true, false).await;
}

#[tokio::test]
async fn cancellation_during_jump_target_key_exchange_closes_transport() {
    stalled_key_exchange_closes_transport(true, true).await;
}

#[tokio::test]
async fn record_write_failure_prevents_dispatch_and_keeps_the_result_queryable() {
    let f = Fixture::new(true).await;
    f.manager
        .set_history_settings(HistorySettings {
            enabled: true,
            retention_days: 7,
        })
        .await
        .unwrap();
    f.db.conn().execute_batch("CREATE TRIGGER fail_execution_updates BEFORE UPDATE ON execution_jobs BEGIN SELECT RAISE(FAIL, 'simulated disk failure'); END;").unwrap();
    let id = f.start("success").await;
    let job = f.finished(&id).await;
    assert_eq!(job.summary.status, ExecutionStatus::Failed);
    assert!(!job.summary.remote_outcome_unknown);
    assert!(job.stdout.is_empty());
    assert!(job
        .summary
        .persistence_error
        .as_deref()
        .unwrap()
        .contains("simulated disk failure"));
    assert_eq!(
        f.manager.list(50, 0).await.unwrap()[0].status,
        ExecutionStatus::Failed
    );
}

#[tokio::test]
async fn capacity_is_bounded_and_cancellation_releases_slots() {
    let f = Fixture::new(true).await;
    let mut ids = Vec::new();
    for _ in 0..MAX_ACTIVE_JOBS {
        ids.push(f.start("hang").await);
    }
    assert!(f
        .manager
        .start(f.request("success"), &f.crypto, f.ssh.clone())
        .await
        .unwrap_err()
        .contains("Too many active"));
    for id in &ids {
        f.manager.cancel(id).await.unwrap();
    }
    for id in &ids {
        assert_eq!(
            f.finished(id).await.summary.status,
            ExecutionStatus::Cancelled
        );
    }
    let id = f.start("success").await;
    assert_eq!(
        f.finished(&id).await.summary.status,
        ExecutionStatus::Succeeded
    );
}

#[tokio::test]
async fn stdout_and_stderr_share_the_output_budget() {
    let f = Fixture::new(true).await;
    let mut req = f.request("success");
    req.output_limit_bytes = Some(8);
    let id = f
        .manager
        .start(req, &f.crypto, f.ssh.clone())
        .await
        .unwrap();
    let job = f.finished(&id).await;
    assert_eq!(job.stdout, "hello\n");
    assert_eq!(job.stderr, "di");
    assert!(job.summary.output_truncated);
    assert_eq!(job.summary.status, ExecutionStatus::Succeeded);
}

#[tokio::test]
async fn summary_queries_and_completed_cancellation_do_not_load_output_records() {
    let f = Fixture::new(true).await;
    f.manager
        .set_history_settings(HistorySettings {
            enabled: true,
            retention_days: 7,
        })
        .await
        .unwrap();
    let id = f.start("success").await;
    f.finished(&id).await;
    // The large output document need not be read to list or cancel a completed job.
    f.db.conn()
        .execute(
            "UPDATE execution_jobs SET record='unreadable output' WHERE id=?1",
            [&id],
        )
        .unwrap();
    assert_eq!(
        f.manager.get_summary(&id).await.unwrap().status,
        ExecutionStatus::Succeeded
    );
    f.manager.cancel(&id).await.unwrap();
}

#[tokio::test]
async fn history_is_off_by_default_and_temporary_results_expire() {
    let f = Fixture::new(true).await;
    assert_eq!(
        f.manager.history_settings().unwrap(),
        HistorySettings {
            enabled: false,
            retention_days: 7
        }
    );
    let id = f.start("hang").await;
    f.has_output(&id).await;
    assert!(matches!(
        f.db.get_execution_job(&id),
        Err(LookupError::NotFound)
    ));
    f.manager.cancel(&id).await.unwrap();
    let job = f.finished(&id).await;
    assert!(job.summary.remote_outcome_unknown);
    assert!(matches!(
        f.db.get_execution_job(&id),
        Err(LookupError::NotFound)
    ));
    let restarted = ExecutionManager::new(f.db.clone()).unwrap();
    assert!(matches!(
        restarted.get(&id).await,
        Err(LookupError::NotFound)
    ));
    history::tests::expire(&mut *f.manager.completed.lock().await, &id);
    assert!(matches!(
        f.manager.get(&id).await,
        Err(LookupError::NotFound)
    ));
    assert!(f.manager.list(50, 0).await.unwrap().is_empty());
}

#[tokio::test]
async fn disabling_then_reenabling_does_not_restore_inflight_history() {
    let f = Fixture::new(true).await;
    let on = HistorySettings {
        enabled: true,
        retention_days: 7,
    };
    f.manager.set_history_settings(on).await.unwrap();
    let id = f.start("hang").await;
    f.has_output(&id).await;
    assert!(f.db.get_execution_job(&id).is_ok());
    f.manager
        .set_history_settings(HistorySettings {
            enabled: false,
            ..on
        })
        .await
        .unwrap();
    f.manager.set_history_settings(on).await.unwrap();
    f.manager.cancel(&id).await.unwrap();
    f.finished(&id).await;
    assert!(matches!(
        f.db.get_execution_job(&id),
        Err(LookupError::NotFound)
    ));
    let next = f.start("success").await;
    f.finished(&next).await;
    assert!(f.db.get_execution_job(&next).is_ok());
}

#[tokio::test]
async fn clearing_history_preserves_live_jobs_without_recreating_disk_records() {
    let f = Fixture::new(true).await;
    let memory = f.start("success").await;
    f.finished(&memory).await;
    f.manager
        .set_history_settings(HistorySettings {
            enabled: true,
            retention_days: 7,
        })
        .await
        .unwrap();
    let disk = f.start("success").await;
    f.finished(&disk).await;
    let running = f.start("hang").await;
    f.has_output(&running).await;
    f.manager.clear_history().await.unwrap();
    assert!(matches!(
        f.manager.get(&memory).await,
        Err(LookupError::NotFound)
    ));
    assert!(matches!(
        f.manager.get(&disk).await,
        Err(LookupError::NotFound)
    ));
    assert_eq!(f.manager.list(50, 0).await.unwrap().len(), 1);
    assert!(f.manager.history_settings().unwrap().enabled);
    f.manager.cancel(&running).await.unwrap();
    f.finished(&running).await;
    assert!(matches!(
        f.db.get_execution_job(&running),
        Err(LookupError::NotFound)
    ));
    f.manager.clear_history().await.unwrap();
    assert!(f.manager.list(50, 0).await.unwrap().is_empty());
}

#[tokio::test]
async fn retention_hides_expired_results_and_cleanup_keeps_active_jobs() {
    let f = Fixture::new(true).await;
    f.manager
        .set_history_settings(HistorySettings {
            enabled: true,
            retention_days: 30,
        })
        .await
        .unwrap();
    let old = f.start("success").await;
    f.finished(&old).await;
    let recent = f.start("success").await;
    f.finished(&recent).await;
    let running = f.start("hang").await;
    f.has_output(&running).await;
    f.db.conn()
        .execute(
            "UPDATE execution_jobs SET created_at=datetime('now','-10 days') WHERE id IN (?1,?2)",
            rusqlite::params![old, running],
        )
        .unwrap();
    f.manager
        .set_history_settings(HistorySettings {
            enabled: true,
            retention_days: 7,
        })
        .await
        .unwrap();
    assert!(matches!(
        f.manager.get(&old).await,
        Err(LookupError::NotFound)
    ));
    assert!(f.manager.get(&recent).await.is_ok());
    assert!(f.db.get_execution_job(&running).is_ok());
    // Results also become invisible before the next periodic sweep runs.
    f.db.conn()
        .execute(
            "UPDATE execution_jobs SET created_at=datetime('now','-10 days') WHERE id=?1",
            [&recent],
        )
        .unwrap();
    assert!(matches!(
        f.manager.get_summary(&recent).await,
        Err(LookupError::NotFound)
    ));
    f.manager.maintain_history().await.unwrap();
    assert_eq!(
        f.db.conn()
            .query_row("SELECT count(*) FROM execution_jobs", [], |row| row
                .get::<_, u32>(0))
            .unwrap(),
        1
    );
    // Restore the artificial age so the completion helper can still retrieve it.
    f.db.conn()
        .execute(
            "UPDATE execution_jobs SET created_at=?1 WHERE id=?2",
            rusqlite::params![Utc::now().to_rfc3339(), running],
        )
        .unwrap();
    f.manager.cancel(&running).await.unwrap();
    f.finished(&running).await;
}

#[tokio::test]
async fn invalid_history_settings_leave_existing_policy_unchanged() {
    let f = Fixture::new(true).await;
    let settings = f.manager.history_settings().unwrap();
    for days in [0, 366, u32::MAX] {
        assert!(f
            .manager
            .set_history_settings(HistorySettings {
                enabled: true,
                retention_days: days
            })
            .await
            .is_err());
        assert_eq!(f.manager.history_settings().unwrap(), settings);
    }
}

#[tokio::test]
async fn temporary_results_are_bounded_by_count_and_bytes() {
    let f = Fixture::new(true).await;
    let id = f.start("success").await;
    let job = f.finished(&id).await;
    let mut cache = ResultCache::default();
    for i in 0..40 {
        let mut copy = job.clone();
        copy.summary.id = i.to_string();
        cache.insert(copy);
    }
    assert_eq!(cache.jobs.len(), 32);
    assert!(!cache.jobs.contains_key("0"));
    for i in 40..72 {
        let mut copy = job.clone();
        copy.summary.id = i.to_string();
        copy.stdout = "x".repeat(3 * 1024 * 1024);
        cache.insert(copy);
    }
    assert!(
        cache
            .jobs
            .values()
            .map(|entry| entry.job.stdout.len())
            .sum::<usize>()
            < 64 * 1024 * 1024
    );
    assert!(cache.jobs.len() < 32);
    assert!(cache.jobs.contains_key("71"));
}

#[tokio::test]
async fn pagination_merges_disk_memory_and_running_jobs_without_gaps() {
    let f = Fixture::new(true).await;
    let memory = f.start("hang").await;
    f.has_output(&memory).await;
    f.manager
        .set_history_settings(HistorySettings {
            enabled: true,
            retention_days: 7,
        })
        .await
        .unwrap();
    for _ in 0..4 {
        let id = f.start("success").await;
        f.finished(&id).await;
    }
    let running = f.start("hang").await;
    f.has_output(&running).await;
    f.manager.cancel(&memory).await.unwrap();
    f.finished(&memory).await;
    let all = f.manager.list(100, 0).await.unwrap();
    assert_eq!(all.len(), 6);
    for (i, expected) in all.iter().enumerate() {
        let page = f.manager.list(1, i as u32).await.unwrap();
        assert_eq!(page[0].id, expected.id);
    }
    assert!(f.manager.list(1, u32::MAX).await.unwrap().is_empty());
    f.manager.cancel(&running).await.unwrap();
    f.finished(&running).await;
}

#[tokio::test]
async fn interactive_jobs_require_a_monitor_and_wait_before_connecting() {
    let f = Fixture::new(true).await;
    assert!(f
        .manager
        .start_interactive(f.request("success"), &f.crypto, f.ssh.clone())
        .await
        .is_err());
    let manager = f.manager.clone().with_terminal_notifier(|_| Ok(()));
    let id = manager
        .start_interactive(f.request("success"), &f.crypto, f.ssh.clone())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    let pending = manager.get(&id).await.unwrap();
    assert_eq!(pending.summary.status, ExecutionStatus::Connecting);
    assert!(!pending.summary.remote_outcome_unknown);
    assert!(pending.stdout.is_empty());
    assert_eq!(manager.active_terminals().await.len(), 1);
    assert!(manager
        .attach_terminal(&id, Arc::new(|_| Err("UI failed".into())))
        .await
        .is_err());
    manager.cancel(&id).await.unwrap();
    let cancelled = f.finished(&id).await;
    assert_eq!(cancelled.summary.status, ExecutionStatus::Cancelled);
    assert!(!cancelled.summary.remote_outcome_unknown);
    assert!(manager.active_terminals().await.is_empty());

    let mut request = f.request("success");
    request.timeout_seconds = Some(1);
    let id = manager
        .start_interactive(request, &f.crypto, f.ssh.clone())
        .await
        .unwrap();
    let timed_out = f.finished(&id).await;
    assert_eq!(timed_out.summary.status, ExecutionStatus::TimedOut);
    assert!(!timed_out.summary.remote_outcome_unknown);
}

#[tokio::test]
async fn manual_input_and_echoed_secrets_stay_in_local_terminal_even_with_history_enabled() {
    let f = Fixture::new(true).await;
    f.manager
        .set_history_settings(HistorySettings {
            enabled: true,
            retention_days: 7,
        })
        .await
        .unwrap();
    let manager = f.manager.clone().with_terminal_notifier(|_| Ok(()));
    let id = manager
        .start_interactive(f.request("interactive"), &f.crypto, f.ssh.clone())
        .await
        .unwrap();
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = events.clone();
    manager
        .attach_terminal(
            &id,
            Arc::new(move |event| {
                captured.lock().unwrap().push(event);
                Ok(())
            }),
        )
        .await
        .unwrap();
    f.has_output(&id).await;
    manager.terminal_resize(&id, 123, 42).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !manager
            .get(&id)
            .await
            .unwrap()
            .stdout
            .contains("size:123x42")
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(manager.terminal_resize(&id, 0, 42).await.is_err());
    assert!(manager
        .terminal_input(&id, zeroize::Zeroizing::new(vec![b'x'; 65537]))
        .await
        .is_err());
    assert!(!manager.get(&id).await.unwrap().summary.output_withheld);
    manager
        .terminal_input(
            &id,
            zeroize::Zeroizing::new(b"private-human-password\r".to_vec()),
        )
        .await
        .unwrap();
    let result = f.finished(&id).await;
    assert_eq!(result.summary.status, ExecutionStatus::Succeeded);
    assert!(result.summary.interactive && result.summary.output_withheld);
    assert!(result.stdout.contains("Password:"));
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("private-human-password"));
    let disk = f.db.get_execution_job(&id).unwrap();
    assert!(disk.summary.output_withheld);
    assert!(!serde_json::to_string(&disk)
        .unwrap()
        .contains("private-human-password"));
    let events = events.lock().unwrap();
    assert!(matches!(events.first(), Some(TerminalEvent::Snapshot(_))));
    let local: Vec<u8> = events
        .iter()
        .filter_map(|event| match event {
            TerminalEvent::Output(bytes) => Some(bytes.as_slice()),
            _ => None,
        })
        .flatten()
        .copied()
        .collect();
    assert!(String::from_utf8_lossy(&local).contains("private-human-password"));
    assert!(
        matches!(events.last(), Some(TerminalEvent::Status(summary)) if summary.status == ExecutionStatus::Succeeded)
    );
}

#[tokio::test]
async fn refused_pty_and_lost_monitor_do_not_silently_execute_in_background() {
    let f = Fixture::with_pty(true, false).await;
    let manager = f.manager.clone().with_terminal_notifier(|_| Ok(()));
    let id = manager
        .start_interactive(f.request("success"), &f.crypto, f.ssh.clone())
        .await
        .unwrap();
    manager
        .attach_terminal(&id, Arc::new(|_| Ok(())))
        .await
        .unwrap();
    let result = f.finished(&id).await;
    assert_eq!(result.summary.status, ExecutionStatus::Failed);
    assert!(result.summary.error.unwrap().contains("PTY"));
    assert!(!result.summary.remote_outcome_unknown);
    assert!(result.stdout.is_empty());

    let f = Fixture::new(true).await;
    let manager = f
        .manager
        .clone()
        .with_terminal_notifier(|_| Err("window unavailable".into()));
    assert!(manager
        .start_interactive(f.request("success"), &f.crypto, f.ssh.clone())
        .await
        .is_err());
    assert!(manager.active_terminals().await.is_empty());
    let manager = f.manager.clone().with_terminal_notifier(|_| Ok(()));
    let id = manager
        .start_interactive(f.request("hang"), &f.crypto, f.ssh.clone())
        .await
        .unwrap();
    manager
        .attach_terminal(
            &id,
            Arc::new(|event| {
                if matches!(event, TerminalEvent::Output(_)) {
                    Err("monitor disconnected".into())
                } else {
                    Ok(())
                }
            }),
        )
        .await
        .unwrap();
    let result = f.finished(&id).await;
    assert_eq!(result.summary.status, ExecutionStatus::Failed);
    assert!(result
        .summary
        .error
        .unwrap()
        .contains("monitor disconnected"));
    assert!(result.summary.remote_outcome_unknown);
    assert!(result.stdout.is_empty());
}

#[tokio::test]
async fn server_failure_metadata_cannot_echo_manual_input_into_mcp_results() {
    let f = Fixture::new(true).await;
    let manager = f.manager.clone().with_terminal_notifier(|_| Ok(()));
    let id = manager
        .start_interactive(f.request("interactive"), &f.crypto, f.ssh.clone())
        .await
        .unwrap();
    manager
        .attach_terminal(&id, Arc::new(|_| Ok(())))
        .await
        .unwrap();
    f.has_output(&id).await;
    manager
        .terminal_input(
            &id,
            zeroize::Zeroizing::new(b"signal-private-password".to_vec()),
        )
        .await
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let job = manager.get(&id).await.unwrap();
            assert!(!serde_json::to_string(&job)
                .unwrap()
                .contains("signal-private-password"));
            if job.summary.status.is_terminal() {
                break job;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(result.summary.status, ExecutionStatus::Failed);
    assert_eq!(
        result.summary.exit_signal.as_deref(),
        Some("withheld after local input")
    );
    assert!(result
        .summary
        .error
        .unwrap()
        .contains("details are withheld"));
    assert!(matches!(
        f.db.get_execution_job(&id),
        Err(LookupError::NotFound)
    ));
}
