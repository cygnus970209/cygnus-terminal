use async_trait::async_trait;
use russh::client;
use ssh_key::public::PublicKey;
use russh::{ChannelMsg, Disconnect};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::{mpsc, Mutex};

use crate::pty::PtyEvent;

struct SshHandler;

#[async_trait]
impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO: Known hosts verification
        Ok(true)
    }
}

enum SshCommand {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub struct SshSession {
    cmd_tx: mpsc::Sender<SshCommand>,
    handle: client::Handle<SshHandler>,
}

pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, SshSession>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn connect(
        &self,
        session_id: &str,
        host: &str,
        port: u16,
        username: &str,
        auth_type: &str,
        password: Option<&str>,
        key_path: Option<&str>,
        channel: Channel<PtyEvent>,
    ) -> Result<(), String> {
        eprintln!("[SSH] Connecting to {}:{}", host, port);

        let config = Arc::new(client::Config {
            keepalive_interval: Some(std::time::Duration::from_secs(30)),
            ..Default::default()
        });

        let handler = SshHandler;

        let mut handle = client::connect(config, (host, port), handler)
            .await
            .map_err(|e| format!("Connection failed: {}", e))?;

        eprintln!("[SSH] Connected, authenticating as {}", username);

        // Authenticate
        let auth_result = match auth_type {
            "key" => {
                let key_path = key_path.ok_or("Key path required")?;
                let expanded = shellexpand::tilde(key_path).to_string();
                let key_pair = russh_keys::load_secret_key(&expanded, None)
                    .map_err(|e| format!("Failed to load key: {}", e))?;
                handle
                    .authenticate_publickey(username, Arc::new(key_pair))
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

        if !auth_result {
            return Err("Authentication failed".to_string());
        }

        eprintln!("[SSH] Authenticated, opening channel");

        let mut ssh_channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Channel open failed: {}", e))?;

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

        // Single task owns the channel: handles both reads and write commands
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

        let session = SshSession {
            cmd_tx,
            handle,
        };

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
