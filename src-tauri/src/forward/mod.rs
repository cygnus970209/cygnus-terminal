use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::ssh::SshManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForward {
    pub id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub status: String, // "active" | "stopped" | "error"
}

struct ForwardTask {
    info: PortForward,
    handle: tokio::task::JoinHandle<()>,
}

pub struct ForwardManager {
    forwards: Arc<Mutex<HashMap<String, ForwardTask>>>,
}

impl Default for ForwardManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ForwardManager {
    pub fn new() -> Self {
        Self {
            forwards: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn add(
        &self,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
        session_id: &str,
        ssh_manager: &SshManager,
    ) -> Result<PortForward, String> {
        let id = format!("fwd-{}-{}", local_port, remote_port);

        // 중복 체크
        if self.forwards.lock().await.contains_key(&id) {
            return Err(format!("Forward already exists: {id}"));
        }

        let listener = TcpListener::bind(format!("127.0.0.1:{}", local_port))
            .await
            .map_err(|e| format!("Failed to bind port {local_port}: {e}"))?;

        let info = PortForward {
            id: id.clone(),
            local_port,
            remote_host: remote_host.to_string(),
            remote_port,
            status: "active".to_string(),
        };

        let ssh = ssh_manager.clone_inner();
        let session_id = session_id.to_string();
        let remote_host = remote_host.to_string();
        let forwards = Arc::clone(&self.forwards);
        let fwd_id = id.clone();

        let handle = tokio::spawn(async move {
            loop {
                let (mut local_stream, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[Forward] Accept error: {}", e);
                        break;
                    }
                };

                let sessions = ssh.lock().await;
                let session = match sessions.get(&session_id) {
                    Some(s) => s,
                    None => {
                        eprintln!("[Forward] SSH session gone");
                        break;
                    }
                };

                let channel = match session
                    .handle
                    .channel_open_direct_tcpip(
                        &remote_host,
                        remote_port as u32,
                        "127.0.0.1",
                        local_port as u32,
                    )
                    .await
                {
                    Ok(ch) => ch,
                    Err(e) => {
                        eprintln!("[Forward] Channel open failed: {}", e);
                        continue;
                    }
                };
                drop(sessions);

                let mut stream = channel.into_stream();

                // 양방향 프록시
                tokio::spawn(async move {
                    let (mut local_r, mut local_w) = local_stream.split();
                    let (mut remote_r, mut remote_w) = tokio::io::split(&mut stream);

                    let c2s = tokio::io::copy(&mut local_r, &mut remote_w);
                    let s2c = tokio::io::copy(&mut remote_r, &mut local_w);

                    tokio::select! {
                        _ = c2s => {}
                        _ = s2c => {}
                    }
                });
            }

            // 종료 시 상태 업데이트
            if let Some(fwd) = forwards.lock().await.get_mut(&fwd_id) {
                fwd.info.status = "stopped".to_string();
            }
        });

        let task = ForwardTask {
            info: info.clone(),
            handle,
        };
        self.forwards.lock().await.insert(id, task);

        Ok(info)
    }

    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let mut forwards = self.forwards.lock().await;
        if let Some(task) = forwards.remove(id) {
            task.handle.abort();
            Ok(())
        } else {
            Err("Forward not found".into())
        }
    }

    pub async fn list(&self) -> Vec<PortForward> {
        self.forwards
            .lock()
            .await
            .values()
            .map(|t| t.info.clone())
            .collect()
    }
}
