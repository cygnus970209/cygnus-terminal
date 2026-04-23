use russh::client;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::{ChannelMsg, Disconnect};
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex};

use serde::Deserialize;

use crate::db::known_host::HostKeyStatus;
use crate::db::Database;
use crate::pty::PtyEvent;

/// 사용자가 host key 확인 다이얼로그를 수락/거절할 때까지 기다리는 최대 시간.
const HOST_KEY_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Deserialize)]
pub struct JumpHostConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
}

pub struct SshHandler {
    db: Arc<Database>,
    host: String,
    port: u16,
    app_handle: AppHandle,
    pending_prompts: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

/// OpenSSH 호환 `SHA256:<base64(NoPad)>` 포맷의 public key fingerprint.
fn compute_fingerprint(key: &russh::keys::PublicKey) -> String {
    key.fingerprint(russh::keys::HashAlg::Sha256).to_string()
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        let key_type = server_public_key.algorithm().as_str().to_string();
        let key_bytes_res = server_public_key.to_bytes();
        let fingerprint = compute_fingerprint(server_public_key);
        let db = Arc::clone(&self.db);
        let host = self.host.clone();
        let port = self.port;
        let app_handle = self.app_handle.clone();
        let pending = Arc::clone(&self.pending_prompts);

        async move {
            let key_data =
                key_bytes_res.map_err(|e| russh::Error::from(russh::keys::Error::from(e)))?;

            match db.check_host_key(&host, port, &key_type, &key_data) {
                Ok(HostKeyStatus::Trusted) => {
                    eprintln!("[SSH] Host key verified for {}:{}", host, port);
                    Ok(true)
                }
                Ok(HostKeyStatus::Unknown) => {
                    // MITM 방지: 처음 보는 호스트는 사용자 확인을 받아야 한다.
                    // 프론트에 prompt 이벤트를 보내고 응답을 oneshot 채널로 기다린다.
                    let prompt_id = uuid::Uuid::new_v4().to_string();
                    let (tx, rx) = oneshot::channel::<bool>();
                    pending.lock().await.insert(prompt_id.clone(), tx);

                    let payload = serde_json::json!({
                        "id": prompt_id,
                        "host": host,
                        "port": port,
                        "key_type": key_type,
                        "fingerprint": fingerprint,
                        "status": "unknown",
                    });
                    let _ = app_handle.emit("ssh-host-key-prompt", payload);

                    let accept =
                        match tokio::time::timeout(HOST_KEY_PROMPT_TIMEOUT, rx).await {
                            Ok(Ok(v)) => v,
                            _ => false, // timeout 또는 channel 닫힘 → 거부로 처리 (fail-closed)
                        };
                    // timeout 시에는 tx 가 pending 에 남아 있을 수 있으니 정리.
                    pending.lock().await.remove(&prompt_id);

                    if accept {
                        if let Err(e) = db.save_host_key(&host, port, &key_type, &key_data) {
                            eprintln!("[SSH] Warning: failed to save host key: {}", e);
                        }
                        eprintln!("[SSH] Host key accepted by user for {}:{}", host, port);
                        Ok(true)
                    } else {
                        let _ = app_handle.emit(
                            "ssh-host-key-rejected",
                            serde_json::json!({
                                "host": host,
                                "port": port,
                                "reason": "user_rejected_or_timeout",
                            }),
                        );
                        eprintln!("[SSH] Host key rejected/timed out for {}:{}", host, port);
                        Ok(false)
                    }
                }
                Ok(HostKeyStatus::Changed { stored_key_type }) => {
                    eprintln!(
                        "[SSH] WARNING: Host key CHANGED for {}:{} (was {}, now {})",
                        host, port, stored_key_type, key_type
                    );
                    let _ = app_handle.emit(
                        "ssh-host-key-rejected",
                        serde_json::json!({
                            "host": host,
                            "port": port,
                            "reason": "changed",
                            "stored_type": stored_key_type,
                            "new_type": key_type,
                            "new_fingerprint": fingerprint,
                        }),
                    );
                    Ok(false)
                }
                Err(e) => {
                    // DB 조회 실패를 "수락"으로 처리하면 MITM 가능. fail-closed.
                    eprintln!(
                        "[SSH] Error checking host key for {}:{}: {} (rejecting)",
                        host, port, e
                    );
                    let _ = app_handle.emit(
                        "ssh-host-key-rejected",
                        serde_json::json!({
                            "host": host,
                            "port": port,
                            "reason": "db_error",
                            "detail": e,
                        }),
                    );
                    Ok(false)
                }
            }
        }
    }
}

enum SshCommand {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub struct SshSession {
    cmd_tx: mpsc::Sender<SshCommand>,
    pub(crate) handle: client::Handle<SshHandler>,
}

pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, SshSession>>>,
    db: Arc<Database>,
    /// Host key 확인 prompt 대기열. `check_server_key` 에서 Unknown 인 경우
    /// 여기에 oneshot 을 등록해 두고 프론트가 `ssh_host_key_respond` 로 응답할 때까지 대기.
    pending_prompts: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

impl SshManager {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            db,
            pending_prompts: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 프론트엔드가 host key prompt 에 응답할 때 호출.
    /// 해당 id 의 기다리던 연결이 수락/거절 결과로 풀린다.
    pub async fn resolve_host_key_prompt(&self, id: &str, accept: bool) -> Result<(), String> {
        let mut pending = self.pending_prompts.lock().await;
        match pending.remove(id) {
            Some(tx) => {
                let _ = tx.send(accept);
                Ok(())
            }
            None => Err(format!("Prompt not found or already answered: {id}")),
        }
    }

    fn make_config() -> Arc<client::Config> {
        Arc::new(client::Config {
            keepalive_interval: Some(std::time::Duration::from_secs(30)),
            preferred: russh::Preferred {
                key: Cow::Borrowed(&[
                    russh::keys::Algorithm::Ed25519,
                    russh::keys::Algorithm::Ecdsa {
                        curve: russh::keys::EcdsaCurve::NistP256,
                    },
                    russh::keys::Algorithm::Ecdsa {
                        curve: russh::keys::EcdsaCurve::NistP384,
                    },
                    russh::keys::Algorithm::Ecdsa {
                        curve: russh::keys::EcdsaCurve::NistP521,
                    },
                    russh::keys::Algorithm::Rsa {
                        hash: Some(russh::keys::HashAlg::Sha256),
                    },
                    russh::keys::Algorithm::Rsa {
                        hash: Some(russh::keys::HashAlg::Sha512),
                    },
                ]),
                ..russh::Preferred::DEFAULT
            },
            ..Default::default()
        })
    }

    async fn authenticate(
        handle: &mut client::Handle<SshHandler>,
        username: &str,
        auth_type: &str,
        password: Option<&str>,
        key_path: Option<&str>,
    ) -> Result<(), String> {
        let auth_result = match auth_type {
            "key" => {
                let key_path = key_path.ok_or("Key path required")?;
                let expanded = shellexpand::tilde(key_path).to_string();
                let key_pair = russh::keys::load_secret_key(&expanded, None)
                    .map_err(|e| format!("Failed to load key '{}': {}", expanded, e))?;
                let hash_alg = if key_pair.algorithm().is_rsa() {
                    Some(russh::keys::HashAlg::Sha256)
                } else {
                    None
                };
                let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg);
                handle
                    .authenticate_publickey(username, key_with_alg)
                    .await
                    .map_err(|e| format!("Auth failed: {}", e))?
            }
            _ => {
                let pwd = password.unwrap_or("");
                handle
                    .authenticate_password(username, pwd)
                    .await
                    .map_err(|e| format!("Auth failed: {}", e))?
            }
        };

        if !auth_result.success() {
            return Err("Authentication failed".to_string());
        }
        Ok(())
    }

    pub async fn connect(
        &self,
        app: AppHandle,
        session_id: &str,
        host: &str,
        port: u16,
        username: &str,
        auth_type: &str,
        password: Option<&str>,
        key_path: Option<&str>,
        jump_host: Option<JumpHostConfig>,
        agent_forward: bool,
        channel: Channel<PtyEvent>,
    ) -> Result<(), String> {
        let config = Self::make_config();

        // Jump Host 경유 또는 직접 연결
        let mut handle = if let Some(ref jump) = jump_host {
            eprintln!("[SSH] Connecting via jump host {}:{}", jump.host, jump.port);

            // 1. Jump Host에 연결
            let jump_handler = SshHandler {
                db: Arc::clone(&self.db),
                host: jump.host.clone(),
                port: jump.port,
                app_handle: app.clone(),
                pending_prompts: Arc::clone(&self.pending_prompts),
            };
            let mut jump_handle =
                client::connect(config.clone(), (&*jump.host, jump.port), jump_handler)
                    .await
                    .map_err(|e| format!("Jump host connection failed: {}", e))?;

            // 2. Jump Host 인증
            Self::authenticate(
                &mut jump_handle,
                &jump.username,
                &jump.auth_type,
                jump.password.as_deref(),
                jump.key_path.as_deref(),
            )
            .await
            .map_err(|e| format!("Jump host auth failed: {}", e))?;

            eprintln!("[SSH] Jump host authenticated, tunneling to {}:{}", host, port);

            // 3. Jump Host를 통해 최종 서버로 터널 생성
            let tunnel_channel = jump_handle
                .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| format!("Tunnel creation failed: {}", e))?;

            let stream = tunnel_channel.into_stream();

            // 4. 터널 위에서 최종 서버에 SSH 연결
            let target_handler = SshHandler {
                db: Arc::clone(&self.db),
                host: host.to_string(),
                port,
                app_handle: app.clone(),
                pending_prompts: Arc::clone(&self.pending_prompts),
            };
            client::connect_stream(config, stream, target_handler)
                .await
                .map_err(|e| format!("Connection through tunnel failed: {}", e))?
        } else {
            eprintln!("[SSH] Connecting to {}:{}", host, port);
            let handler = SshHandler {
                db: Arc::clone(&self.db),
                host: host.to_string(),
                port,
                app_handle: app.clone(),
                pending_prompts: Arc::clone(&self.pending_prompts),
            };
            client::connect(config, (host, port), handler)
                .await
                .map_err(|e| format!("Connection failed: {}", e))?
        };

        eprintln!("[SSH] Connected, authenticating as {}", username);
        Self::authenticate(&mut handle, username, auth_type, password, key_path).await?;

        eprintln!("[SSH] Authenticated, opening channel");

        let mut ssh_channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Channel open failed: {}", e))?;

        if agent_forward {
            ssh_channel
                .agent_forward(true)
                .await
                .map_err(|e| format!("Agent forward request failed: {}", e))?;
            eprintln!("[SSH] Agent forwarding enabled");
        }

        ssh_channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .map_err(|e| format!("PTY request failed: {}", e))?;

        ssh_channel
            .request_shell(false)
            .await
            .map_err(|e| format!("Shell request failed: {}", e))?;

        eprintln!("[SSH] Shell opened, starting I/O loop");

        let (cmd_tx, mut cmd_rx) = mpsc::channel::<SshCommand>(256);

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(SshCommand::Data(data)) => {
                                if ssh_channel.data(Cursor::new(data)).await.is_err() {
                                    let _ = channel.send(PtyEvent::Exit(()));
                                    break;
                                }
                            }
                            Some(SshCommand::Resize(cols, rows)) => {
                                let _ = ssh_channel.window_change(cols, rows, 0, 0).await;
                            }
                            Some(SshCommand::Close) | None => {
                                let _ = ssh_channel.eof().await;
                                break;
                            }
                        }
                    }
                    msg = ssh_channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                let text = String::from_utf8_lossy(&data).to_string();
                                if channel.send(PtyEvent::Output(text)).is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                let text = String::from_utf8_lossy(&data).to_string();
                                if channel.send(PtyEvent::Output(text)).is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                let _ = channel.send(PtyEvent::Exit(()));
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }
        });

        let session = SshSession { cmd_tx, handle };

        self.sessions
            .lock()
            .await
            .insert(session_id.to_string(), session);

        Ok(())
    }

    pub async fn write_to_session(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(session_id) {
            session
                .cmd_tx
                .send(SshCommand::Data(data.to_vec()))
                .await
                .map_err(|e| format!("Send error: {}", e))?;
            Ok(())
        } else {
            Err(format!("Session not found: {}", session_id))
        }
    }

    pub async fn resize_session(
        &self,
        session_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(session_id) {
            session
                .cmd_tx
                .send(SshCommand::Resize(cols, rows))
                .await
                .map_err(|e| format!("Send error: {}", e))?;
            Ok(())
        } else {
            Err(format!("Session not found: {}", session_id))
        }
    }

    pub fn clone_inner(&self) -> Arc<Mutex<HashMap<String, SshSession>>> {
        Arc::clone(&self.sessions)
    }

    pub async fn open_sftp_channel(
        &self,
        session_id: &str,
    ) -> Result<russh_sftp::client::SftpSession, String> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;

        let channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open SFTP channel: {e}"))?;

        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("Failed to request SFTP subsystem: {e}"))?;

        russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("Failed to init SFTP session: {e}"))
    }

    pub async fn close_session(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.remove(session_id) {
            let _ = session.cmd_tx.send(SshCommand::Close).await;
            let _ = session
                .handle
                .disconnect(Disconnect::ByApplication, "Closed by user", "en")
                .await;
        }
        Ok(())
    }
}
