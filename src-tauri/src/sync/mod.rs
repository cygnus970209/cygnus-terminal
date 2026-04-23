use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tauri::ipc::Channel;

use crate::sftp::SftpManager;

/// 동기화에서 항상 제외할 이름. 사용자 의도와 거의 상관없는 시스템/VCS 메타데이터.
/// 일반 dotfile(`.env`, `.gitignore` 등)은 포함한다.
fn is_ignored_name(name: &str) -> bool {
    matches!(name, ".DS_Store" | ".git" | ".svn" | ".hg" | "Thumbs.db")
}

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalFile {
    pub size: u64,
    pub mtime: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteFile {
    pub size: u64,
    pub mtime: u64,
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
        if is_ignored_name(&name) {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| format!("{e}"))?;
        let relative = match path.strip_prefix(base) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue, // base 바깥 entry — 일어날 가능성 거의 없지만 방어적으로
        };

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
        if is_ignored_name(&entry.name) {
            continue;
        }
        // strip_prefix 가 실패하면 base 바깥 경로 — 조용히 건너뛴다. fallback 으로 entry.path
        // 전체를 넣으면 sync diff 가 범위 밖 파일까지 건드리는 사고가 난다.
        let prefix = if base.ends_with('/') {
            base.to_string()
        } else {
            format!("{}/", base)
        };
        let relative = match entry.path.strip_prefix(&prefix) {
            Some(r) => r.to_string(),
            None => continue,
        };

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

/// Pure diff 계산: 파일 목록만 받아 SyncPlan 을 만든다. I/O 없이 단위 테스트 가능.
pub(crate) fn compute_diff(
    local_files: &HashMap<String, LocalFile>,
    remote_files: &HashMap<String, RemoteFile>,
    direction: &str, // "upload" | "download" | "both"
) -> SyncPlan {
    let mut entries = Vec::new();
    let mut total_bytes = 0u64;

    if direction == "upload" || direction == "both" {
        // 로컬에만 있거나 로컬이 더 새로운 파일 → 업로드
        for (rel, local) in local_files {
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
        for (rel, remote) in remote_files {
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
                    // both 모드: 원격 mtime 이 더 새로우면 다운로드. size 가 같더라도
                    // 내용만 바뀐 케이스(한 글자 수정)를 놓치면 안 되기 때문에 size 조건 제거.
                    if direction == "both"
                        && (remote.mtime > local.mtime
                            || (remote.mtime == local.mtime && remote.size != local.size))
                    {
                        entries.push(SyncEntry {
                            relative_path: rel.clone(),
                            action: "download".into(),
                            size: remote.size,
                            reason: if remote.size != local.size {
                                "size_changed"
                            } else {
                                "modified"
                            }
                            .into(),
                        });
                        total_bytes += remote.size;
                    }
                }
            }
        }
    }

    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    SyncPlan {
        total_files: entries.len() as u32,
        total_bytes,
        entries,
    }
}

/// diff 계산 + I/O: 스캔 후 compute_diff 로 위임.
pub async fn compute_sync_plan(
    sftp: &SftpManager,
    sftp_id: &str,
    local_path: &str,
    remote_path: &str,
    direction: &str,
) -> Result<SyncPlan, String> {
    let local_files = scan_local_dir(Path::new(local_path), Path::new(local_path))?;
    let remote_files = scan_remote_dir(sftp, sftp_id, remote_path, remote_path).await?;
    Ok(compute_diff(&local_files, &remote_files, direction))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn lf(size: u64, mtime: u64) -> LocalFile {
        LocalFile { size, mtime }
    }
    fn rf(size: u64, mtime: u64) -> RemoteFile {
        RemoteFile { size, mtime }
    }

    fn local_map(items: &[(&str, u64, u64)]) -> HashMap<String, LocalFile> {
        items
            .iter()
            .map(|(k, s, m)| (k.to_string(), lf(*s, *m)))
            .collect()
    }
    fn remote_map(items: &[(&str, u64, u64)]) -> HashMap<String, RemoteFile> {
        items
            .iter()
            .map(|(k, s, m)| (k.to_string(), rf(*s, *m)))
            .collect()
    }

    fn actions(plan: &SyncPlan) -> Vec<(String, String, String)> {
        plan.entries
            .iter()
            .map(|e| (e.relative_path.clone(), e.action.clone(), e.reason.clone()))
            .collect()
    }

    // ── is_ignored_name ───────────────────────────────────────────

    #[test]
    fn ignored_names_matches_system_metadata() {
        assert!(is_ignored_name(".DS_Store"));
        assert!(is_ignored_name(".git"));
        assert!(is_ignored_name(".svn"));
        assert!(is_ignored_name(".hg"));
        assert!(is_ignored_name("Thumbs.db"));
    }

    #[test]
    fn ignored_names_does_not_match_regular_dotfiles() {
        // 이전 버그 수정 리그레션: .env / .gitignore 는 사용자 파일. 무차별 스킵 금지.
        assert!(!is_ignored_name(".env"));
        assert!(!is_ignored_name(".gitignore"));
        assert!(!is_ignored_name(".bashrc"));
        assert!(!is_ignored_name(".github"));
    }

    // ── compute_diff: upload ────────────────────────────────────

    #[test]
    fn upload_new_file() {
        let local = local_map(&[("foo.txt", 100, 1000)]);
        let remote = remote_map(&[]);
        let plan = compute_diff(&local, &remote, "upload");
        assert_eq!(
            actions(&plan),
            vec![("foo.txt".into(), "upload".into(), "new".into())]
        );
        assert_eq!(plan.total_bytes, 100);
        assert_eq!(plan.total_files, 1);
    }

    #[test]
    fn upload_skips_identical_file() {
        // 같은 size, 같은 mtime → 동기화 불필요
        let local = local_map(&[("foo.txt", 100, 1000)]);
        let remote = remote_map(&[("foo.txt", 100, 1000)]);
        let plan = compute_diff(&local, &remote, "upload");
        assert_eq!(plan.entries.len(), 0);
    }

    #[test]
    fn upload_detects_size_change() {
        let local = local_map(&[("foo.txt", 150, 1000)]);
        let remote = remote_map(&[("foo.txt", 100, 1000)]);
        let plan = compute_diff(&local, &remote, "upload");
        assert_eq!(
            actions(&plan),
            vec![("foo.txt".into(), "upload".into(), "size_changed".into())]
        );
    }

    #[test]
    fn upload_detects_mtime_newer() {
        // size 동일, local mtime 더 새로움 → 업로드 (내용만 바뀐 케이스)
        let local = local_map(&[("foo.txt", 100, 2000)]);
        let remote = remote_map(&[("foo.txt", 100, 1000)]);
        let plan = compute_diff(&local, &remote, "upload");
        assert_eq!(
            actions(&plan),
            vec![("foo.txt".into(), "upload".into(), "modified".into())]
        );
    }

    #[test]
    fn upload_ignores_remote_only_files() {
        // upload 모드: 원격에만 있는 파일은 건드리지 않는다
        let local = local_map(&[]);
        let remote = remote_map(&[("foo.txt", 100, 1000)]);
        let plan = compute_diff(&local, &remote, "upload");
        assert_eq!(plan.entries.len(), 0);
    }

    // ── compute_diff: download ──────────────────────────────────

    #[test]
    fn download_new_file() {
        let local = local_map(&[]);
        let remote = remote_map(&[("foo.txt", 100, 1000)]);
        let plan = compute_diff(&local, &remote, "download");
        assert_eq!(
            actions(&plan),
            vec![("foo.txt".into(), "download".into(), "new".into())]
        );
    }

    #[test]
    fn download_ignores_existing_local_in_download_only_mode() {
        // download 모드 (both 아님): 로컬에 이미 있으면 건드리지 않음.
        // "원격 최신" 판정은 both 에서만.
        let local = local_map(&[("foo.txt", 100, 1000)]);
        let remote = remote_map(&[("foo.txt", 200, 2000)]);
        let plan = compute_diff(&local, &remote, "download");
        assert_eq!(plan.entries.len(), 0);
    }

    // ── compute_diff: both (bidirectional) ──────────────────────

    #[test]
    fn both_content_only_change_downloads_regression() {
        // 이전 버그: remote.mtime > local.mtime AND remote.size != local.size.
        // 수정 후: size 가 같더라도 remote 가 더 새로우면 다운로드.
        let local = local_map(&[("foo.txt", 100, 1000)]);
        let remote = remote_map(&[("foo.txt", 100, 2000)]);
        let plan = compute_diff(&local, &remote, "both");
        let downloads: Vec<_> = plan
            .entries
            .iter()
            .filter(|e| e.action == "download")
            .collect();
        assert_eq!(downloads.len(), 1);
        assert_eq!(downloads[0].reason, "modified");
    }

    #[test]
    fn both_same_mtime_size_diff_downloads() {
        // mtime 동일인데 size 다름 → 역시 내용 변경. 다운로드 필요.
        let local = local_map(&[("foo.txt", 100, 1000)]);
        let remote = remote_map(&[("foo.txt", 150, 1000)]);
        let plan = compute_diff(&local, &remote, "both");
        // upload 쪽에서도 size 다르면 올림 — 둘 다 후보지만 실제는 diff 반환 결과로.
        // 최소 download entry 1개 존재 확인.
        let has_download = plan.entries.iter().any(|e| e.action == "download");
        assert!(has_download);
    }

    #[test]
    fn both_remote_older_does_not_download() {
        // 원격이 더 오래됨 → 다운로드 안 함. upload 쪽에서 올림.
        let local = local_map(&[("foo.txt", 100, 2000)]);
        let remote = remote_map(&[("foo.txt", 100, 1000)]);
        let plan = compute_diff(&local, &remote, "both");
        let downloads: Vec<_> = plan
            .entries
            .iter()
            .filter(|e| e.action == "download")
            .collect();
        assert_eq!(downloads.len(), 0);
        let uploads: Vec<_> = plan
            .entries
            .iter()
            .filter(|e| e.action == "upload")
            .collect();
        assert_eq!(uploads.len(), 1);
    }

    // ── compute_diff: misc ──────────────────────────────────────

    #[test]
    fn entries_sorted_by_path() {
        let local = local_map(&[("b.txt", 1, 1), ("a.txt", 1, 1), ("c.txt", 1, 1)]);
        let remote = remote_map(&[]);
        let plan = compute_diff(&local, &remote, "upload");
        let paths: Vec<_> = plan.entries.iter().map(|e| e.relative_path.clone()).collect();
        assert_eq!(paths, vec!["a.txt", "b.txt", "c.txt"]);
    }

    #[test]
    fn total_bytes_accumulates() {
        let local = local_map(&[("a.txt", 100, 1), ("b.txt", 200, 1)]);
        let remote = remote_map(&[]);
        let plan = compute_diff(&local, &remote, "upload");
        assert_eq!(plan.total_bytes, 300);
        assert_eq!(plan.total_files, 2);
    }

    #[test]
    fn unknown_direction_yields_empty() {
        let local = local_map(&[("foo.txt", 100, 1000)]);
        let remote = remote_map(&[]);
        let plan = compute_diff(&local, &remote, "nonsense");
        assert_eq!(plan.entries.len(), 0);
    }
}
