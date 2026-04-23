use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

use crate::sftp::SftpManager;

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum WatchEvent {
    Uploading(String),  // file name
    Uploaded(String),   // file name
    Error(String),
}

struct WatchEntry {
    local_path: PathBuf,
    remote_path: String,
    sftp_id: String,
    _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
}

pub struct FileWatcherManager {
    watches: Arc<Mutex<HashMap<String, WatchEntry>>>,
}

impl FileWatcherManager {
    pub fn new() -> Self {
        Self {
            watches: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 파일 다운로드 → 로컬 에디터 열기 → 변경 감지 시 자동 업로드
    ///
    /// 파일 열기는 `tauri-plugin-opener` 를 통한다. 내부적으로 플랫폼별 native API
    /// (macOS `open`, Linux `xdg-open`, Windows `ShellExecuteW`) 를 호출해 **shell 을 통하지 않는다**.
    /// 예전에 Windows 에서 `cmd /C start "" <path>` 로 열었을 때 원격 서버가 임의로 정한
    /// 파일명에 `&` / `"` / `^` 같은 cmd 메타문자가 섞이면 command injection 가능성이 있었음 — 이 경로로 차단.
    pub async fn open_in_editor(
        &self,
        app: &AppHandle,
        sftp_id: &str,
        remote_path: &str,
        sftp_manager: &SftpManager,
        event_channel: Channel<WatchEvent>,
    ) -> Result<String, String> {
        // 1. temp 디렉토리에 다운로드
        let file_name = Path::new(remote_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());

        let temp_dir = std::env::temp_dir()
            .join("cygnus-edit")
            .join(sftp_id);
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to create temp dir: {e}"))?;

        let local_path = temp_dir.join(&file_name);

        let data = sftp_manager.read_file(sftp_id, remote_path).await?;
        std::fs::write(&local_path, &data)
            .map_err(|e| format!("Failed to write temp file: {e}"))?;

        // 2. 기본 에디터로 열기 (shell 경유하지 않는 native API)
        app.opener()
            .open_path(local_path.to_string_lossy().to_string(), None::<&str>)
            .map_err(|e| format!("Failed to open editor: {e}"))?;

        // 3. file watcher 시작 (500ms debounce)
        let watch_id = format!("watch-{}-{}", sftp_id, file_name);
        let sftp_id_owned = sftp_id.to_string();
        let remote_path_owned = remote_path.to_string();
        let local_path_clone = local_path.clone();
        let file_name_clone = file_name.clone();

        // SftpManager의 sessions를 공유하기 위해 sftp_manager의 내부 참조를 가져옴
        let sftp_sessions = sftp_manager.clone_sessions();

        let mut debouncer = new_debouncer(
            Duration::from_millis(500),
            move |events: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
                let Ok(events) = events else { return };
                let has_change = events.iter().any(|e| {
                    matches!(e.kind, DebouncedEventKind::Any)
                        && e.path == local_path_clone
                });
                if !has_change {
                    return;
                }

                let sftp_id = sftp_id_owned.clone();
                let remote_path = remote_path_owned.clone();
                let local_path = local_path_clone.clone();
                let file_name = file_name_clone.clone();
                let event_channel = event_channel.clone();
                let sessions = Arc::clone(&sftp_sessions);

                tokio::spawn(async move {
                    let _ = event_channel.send(WatchEvent::Uploading(file_name.clone()));

                    let data = match std::fs::read(&local_path) {
                        Ok(d) => d,
                        Err(e) => {
                            let _ = event_channel.send(WatchEvent::Error(format!("Read failed: {e}")));
                            return;
                        }
                    };

                    let sessions_lock = sessions.lock().await;
                    if let Some(sftp) = sessions_lock.get(&sftp_id) {
                        match sftp.write(&remote_path, &data).await {
                            Ok(_) => {
                                let _ = event_channel.send(WatchEvent::Uploaded(file_name));
                            }
                            Err(e) => {
                                let _ = event_channel.send(WatchEvent::Error(format!("Upload failed: {e}")));
                            }
                        }
                    } else {
                        let _ = event_channel.send(WatchEvent::Error("SFTP session disconnected".into()));
                    }
                });
            },
        )
        .map_err(|e| format!("Failed to create file watcher: {e}"))?;

        debouncer
            .watcher()
            .watch(local_path.as_ref(), notify::RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch file: {e}"))?;

        let entry = WatchEntry {
            local_path,
            remote_path: remote_path.to_string(),
            sftp_id: sftp_id.to_string(),
            _debouncer: debouncer,
        };

        self.watches.lock().await.insert(watch_id.clone(), entry);

        Ok(watch_id)
    }

    pub async fn stop_watch(&self, watch_id: &str) {
        self.watches.lock().await.remove(watch_id);
    }

    pub async fn stop_all_for_sftp(&self, sftp_id: &str) {
        let mut watches = self.watches.lock().await;
        watches.retain(|_, entry| entry.sftp_id != sftp_id);
    }

    pub async fn list_watches(&self) -> Vec<(String, String, String)> {
        self.watches
            .lock()
            .await
            .iter()
            .map(|(id, e)| {
                (
                    id.clone(),
                    e.local_path.to_string_lossy().to_string(),
                    e.remote_path.clone(),
                )
            })
            .collect()
    }
}
