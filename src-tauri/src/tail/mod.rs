use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::Mutex;

use crate::ssh::SshManager;

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum TailEvent {
    Line(TailLine),
    Error(String),
    Closed(String),
}

#[derive(Clone, Serialize)]
pub struct TailLine {
    pub tail_id: String,
    pub path: String,
    pub content: String,
}

struct TailTask {
    path: String,
    handle: tokio::task::JoinHandle<()>,
}

pub struct TailManager {
    tails: Arc<Mutex<HashMap<String, TailTask>>>,
}

impl TailManager {
    pub fn new() -> Self {
        Self {
            tails: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start(
        &self,
        tail_id: &str,
        path: &str,
        session_id: &str,
        ssh_manager: &SshManager,
        lines: u32,
        event_channel: Channel<TailEvent>,
    ) -> Result<(), String> {
        let ssh = ssh_manager.clone_inner();
        let tail_id_owned = tail_id.to_string();
        let path_owned = path.to_string();
        let session_id_owned = session_id.to_string();

        // SSH 채널 열고 tail -f 실행
        let sessions = ssh.lock().await;
        let session = sessions
            .get(&session_id_owned)
            .ok_or("SSH session not found")?;

        let mut channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Channel open failed: {e}"))?;

        let cmd = format!("tail -n {} -f {}", lines, path_owned);
        channel
            .exec(true, cmd.as_str())
            .await
            .map_err(|e| format!("Exec failed: {e}"))?;

        drop(sessions);

        let tid = tail_id_owned.clone();
        let p = path_owned.clone();

        let handle = tokio::spawn(async move {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        let content = String::from_utf8_lossy(&data).to_string();
                        let _ = event_channel.send(TailEvent::Line(TailLine {
                            tail_id: tid.clone(),
                            path: p.clone(),
                            content,
                        }));
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let content = String::from_utf8_lossy(&data).to_string();
                        let _ = event_channel.send(TailEvent::Error(content));
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        let _ = event_channel.send(TailEvent::Closed(tid.clone()));
                        break;
                    }
                    _ => {}
                }
            }
        });

        self.tails.lock().await.insert(
            tail_id.to_string(),
            TailTask {
                path: path_owned,
                handle,
            },
        );

        Ok(())
    }

    pub async fn stop(&self, tail_id: &str) -> Result<(), String> {
        if let Some(task) = self.tails.lock().await.remove(tail_id) {
            task.handle.abort();
        }
        Ok(())
    }

    pub async fn list(&self) -> Vec<(String, String)> {
        self.tails
            .lock()
            .await
            .iter()
            .map(|(id, t)| (id.clone(), t.path.clone()))
            .collect()
    }
}
