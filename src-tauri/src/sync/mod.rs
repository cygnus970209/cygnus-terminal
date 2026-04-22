use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tauri::ipc::Channel;

use crate::sftp::SftpManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncEntry {
    pub relative_path: String,
    pub action: String, // "upload" | "download" | "mkdir_remote" | "mkdir_local"
    pub size: u64,
    pub reason: String, // "new" | "modified" | "size_changed"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPlan {
    pub entries: Vec<SyncEntry>,
    pub total_bytes: u64,
    pub total_files: u32,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum SyncEvent {
    Progress { file: String, done: u32, total: u32 },
    Completed { uploaded: u32, downloaded: u32 },
    Error(String),
}

struct LocalFile {
    size: u64,
    mtime: u64,
}

struct RemoteFile {
    size: u64,
    mtime: u64,
}

/// 로컬 디렉토리를 재귀 탐색하여 상대 경로 → (size, mtime) 매핑
fn scan_local_dir(
    base: &Path,
    current: &Path,
) -> Result<HashMap<String, LocalFile>, String> {
    let mut result = HashMap::new();
    let entries = std::fs::read_dir(current)
        .map_err(|e| format!("Failed to read dir {}: {e}", current.display()))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| format!("{e}"))?;
        let relative = path
            .strip_prefix(base)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");

        if metadata.is_dir() {
            let sub = scan_local_dir(base, &path)?;
            result.extend(sub);
        } else {
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            result.insert(
                relative,
                LocalFile {
                    size: metadata.len(),
                    mtime,
                },
            );
        }
    }
    Ok(result)
}

/// 원격 디렉토리를 재귀 탐색
async fn scan_remote_dir(
    sftp: &SftpManager,
    sftp_id: &str,
    base: &str,
    current: &str,
) -> Result<HashMap<String, RemoteFile>, String> {
    let mut result = HashMap::new();
    let entries = sftp.list_dir(sftp_id, current).await?;

    for entry in entries {
        let relative = if base.ends_with('/') {
            entry.path.strip_prefix(base).unwrap_or(&entry.path)
        } else {
            entry
                .path
                .strip_prefix(&format!("{}/", base))
                .unwrap_or(&entry.path)
        }
        .to_string();

        if entry.is_dir {
            let sub = Box::pin(scan_remote_dir(sftp, sftp_id, base, &entry.path)).await?;
            result.extend(sub);
        } else {
            result.insert(
                relative,
                RemoteFile {
                    size: entry.size,
                    mtime: entry.modified.unwrap_or(0),
                },
            );
        }
    }
    Ok(result)
}

/// diff 계산: 어떤 파일을 어느 방향으로 전송해야 하는지
pub async fn compute_sync_plan(
    sftp: &SftpManager,
    sftp_id: &str,
    local_path: &str,
    remote_path: &str,
    direction: &str, // "upload" | "download" | "both"
) -> Result<SyncPlan, String> {
    let local_files = scan_local_dir(Path::new(local_path), Path::new(local_path))?;
    let remote_files = scan_remote_dir(sftp, sftp_id, remote_path, remote_path).await?;

    let mut entries = Vec::new();
    let mut total_bytes = 0u64;

    if direction == "upload" || direction == "both" {
        // 로컬에만 있거나 로컬이 더 새로운 파일 → 업로드
        for (rel, local) in &local_files {
            match remote_files.get(rel) {
                None => {
                    entries.push(SyncEntry {
                        relative_path: rel.clone(),
                        action: "upload".into(),
                        size: local.size,
                        reason: "new".into(),
                    });
                    total_bytes += local.size;
                }
                Some(remote) => {
                    if local.mtime > remote.mtime || local.size != remote.size {
                        entries.push(SyncEntry {
                            relative_path: rel.clone(),
                            action: "upload".into(),
                            size: local.size,
                            reason: if local.size != remote.size {
                                "size_changed"
                            } else {
                                "modified"
                            }
                            .into(),
                        });
                        total_bytes += local.size;
                    }
                }
            }
        }
    }

    if direction == "download" || direction == "both" {
        // 원격에만 있거나 원격이 더 새로운 파일 → 다운로드
        for (rel, remote) in &remote_files {
            match local_files.get(rel) {
                None => {
                    entries.push(SyncEntry {
                        relative_path: rel.clone(),
                        action: "download".into(),
                        size: remote.size,
                        reason: "new".into(),
                    });
                    total_bytes += remote.size;
                }
                Some(local) => {
                    if direction == "both" && remote.mtime > local.mtime && remote.size != local.size
                    {
                        // both 모드에서만: 원격이 더 새로우면 다운로드
                        entries.push(SyncEntry {
                            relative_path: rel.clone(),
                            action: "download".into(),
                            size: remote.size,
                            reason: "modified".into(),
                        });
                        total_bytes += remote.size;
                    }
                }
            }
        }
    }

    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    Ok(SyncPlan {
        total_files: entries.len() as u32,
        total_bytes,
        entries,
    })
}

/// 동기화 실행
pub async fn execute_sync(
    sftp: &SftpManager,
    sftp_id: &str,
    local_path: &str,
    remote_path: &str,
    plan: SyncPlan,
    event_channel: Channel<SyncEvent>,
) -> Result<(), String> {
    let total = plan.entries.len() as u32;
    let mut uploaded = 0u32;
    let mut downloaded = 0u32;

    for (i, entry) in plan.entries.iter().enumerate() {
        let local_file = format!("{}/{}", local_path, entry.relative_path);
        let remote_file = if remote_path.ends_with('/') {
            format!("{}{}", remote_path, entry.relative_path)
        } else {
            format!("{}/{}", remote_path, entry.relative_path)
        };

        let _ = event_channel.send(SyncEvent::Progress {
            file: entry.relative_path.clone(),
            done: i as u32,
            total,
        });

        match entry.action.as_str() {
            "upload" => {
                // 부모 디렉토리 생성
                if let Some(parent) = Path::new(&remote_file).parent() {
                    let parent_str = parent.to_string_lossy().to_string();
                    let _ = sftp.create_dir(sftp_id, &parent_str).await;
                }
                let data = std::fs::read(&local_file)
                    .map_err(|e| format!("Failed to read {}: {e}", local_file))?;
                sftp.write_file(sftp_id, &remote_file, &data).await?;
                uploaded += 1;
            }
            "download" => {
                // 부모 디렉토리 생성
                if let Some(parent) = Path::new(&local_file).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let data = sftp.read_file(sftp_id, &remote_file).await?;
                std::fs::write(&local_file, &data)
                    .map_err(|e| format!("Failed to write {}: {e}", local_file))?;
                downloaded += 1;
            }
            _ => {}
        }
    }

    let _ = event_channel.send(SyncEvent::Completed {
        uploaded,
        downloaded,
    });

    Ok(())
}
