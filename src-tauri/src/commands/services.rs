use crate::forward::{ForwardManager, PortForward};
use crate::monitor::{MonitorManager, ServerStats};
use crate::sftp::{FileEntry, SftpManager};
use crate::ssh::SshManager;
use crate::tail::{TailEvent, TailManager};
use crate::serial::{SerialManager, SerialPortInfo};
use crate::sync::{self, SyncEvent, SyncPlan};
use crate::telnet::TelnetManager;
use crate::transfer::{TransferEvent, TransferJob, TransferManager};
use crate::watcher::{FileWatcherManager, WatchEvent};
use tauri::ipc::Channel;
use tauri::State;

// ── Telnet ──

#[tauri::command]
pub async fn create_telnet_session(
    host: String,
    port: u16,
    on_event: Channel<crate::pty::PtyEvent>,
    telnet_manager: State<'_, TelnetManager>,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    telnet_manager
        .connect(&session_id, &host, port, on_event)
        .await?;
    Ok(session_id)
}

#[tauri::command]
pub async fn write_telnet(
    session_id: String,
    data: String,
    telnet_manager: State<'_, TelnetManager>,
) -> Result<(), String> {
    telnet_manager
        .write_to_session(&session_id, data.as_bytes())
        .await
}

#[tauri::command]
pub async fn resize_telnet(
    session_id: String,
    cols: u16,
    rows: u16,
    telnet_manager: State<'_, TelnetManager>,
) -> Result<(), String> {
    telnet_manager
        .resize_session(&session_id, cols, rows)
        .await
}

#[tauri::command]
pub async fn close_telnet(
    session_id: String,
    telnet_manager: State<'_, TelnetManager>,
) -> Result<(), String> {
    telnet_manager.close_session(&session_id).await
}

// ── Serial ──

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    SerialManager::list_ports()
}

#[tauri::command]
pub async fn create_serial_session(
    port_name: String,
    baud_rate: u32,
    on_event: Channel<crate::pty::PtyEvent>,
    serial_manager: State<'_, SerialManager>,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    serial_manager
        .connect(&session_id, &port_name, baud_rate, on_event)
        .await?;
    Ok(session_id)
}

#[tauri::command]
pub async fn write_serial(
    session_id: String,
    data: String,
    serial_manager: State<'_, SerialManager>,
) -> Result<(), String> {
    serial_manager
        .write_to_session(&session_id, data.as_bytes())
        .await
}

#[tauri::command]
pub async fn close_serial(
    session_id: String,
    serial_manager: State<'_, SerialManager>,
) -> Result<(), String> {
    serial_manager.close_session(&session_id).await
}

// ── Local Files ──

#[tauri::command]
pub fn get_local_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Home directory not found".to_string())
}

/// Returns whether a local path is a directory. Used by the SFTP view to
/// decide between a single-file upload and a recursive folder walk when
/// files are dropped from outside the app (Finder / Explorer).
#[tauri::command]
pub fn is_local_dir(path: String) -> Result<bool, String> {
    std::fs::metadata(&path)
        .map(|m| m.is_dir())
        .map_err(|e| e.to_string())
}

/// Return whether a local path (file or directory) exists. Used by the download
/// conflict flow so the frontend can decide between Replace / Keep-Both / Skip.
#[tauri::command]
pub fn local_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Return a temp path under cygnus-drag-out/ where SFTP files can be staged before
/// being picked up by a system drag. The directory is created on demand. macOS
/// cleans temp dir across reboots, so leftover files don't accumulate long.
///
/// SECURITY: file_name 은 악의적 SFTP 서버가 정할 수 있는 값이다 (디렉토리 엔트리명).
/// `..` 이나 구분자 포함 시 temp dir 밖으로 나가는 path traversal 이 가능하므로 차단.
#[tauri::command]
pub fn drag_temp_path(file_name: String) -> Result<String, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
        || trimmed == "."
        || trimmed == ".."
    {
        return Err("Invalid file name".into());
    }
    let dir = std::env::temp_dir().join("cygnus-drag-out");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp dir: {e}"))?;
    let target = dir.join(trimmed);
    // 결과 경로가 실제로 dir 아래에 있는지 최종 검증 (symlink/상대경로 혼합 방지).
    let parent = target.parent().ok_or("Invalid target path")?;
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| format!("Failed to resolve parent: {e}"))?;
    let dir_canon = dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve temp dir: {e}"))?;
    if !parent_canon.starts_with(&dir_canon) {
        return Err("Path traversal rejected".into());
    }
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_local_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = std::fs::read_dir(&path)
        .map_err(|e| format!("Failed to read directory: {e}"))?;

    let mut result = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // 숨김 파일 제외
        }
        let metadata = entry.metadata().map_err(|e| format!("{e}"))?;
        let file_path = entry.path().to_string_lossy().to_string();
        let is_dir = metadata.is_dir();
        let size = if is_dir { 0 } else { metadata.len() };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        result.push(FileEntry {
            name,
            path: file_path,
            is_dir,
            size,
            modified,
            permissions: None,
        });
    }

    result.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

// ── SFTP ──

#[tauri::command]
pub async fn sftp_open(
    session_id: String,
    ssh_manager: State<'_, SshManager>,
    sftp_manager: State<'_, SftpManager>,
) -> Result<String, String> {
    let sftp_id = format!("sftp-{}", session_id);

    // 이미 열려있으면 재사용
    if sftp_manager.exists(&sftp_id).await {
        return Ok(sftp_id);
    }

    let sftp_session = ssh_manager.open_sftp_channel(&session_id).await?;
    sftp_manager.open(&sftp_id, sftp_session).await?;
    Ok(sftp_id)
}

#[tauri::command]
pub async fn sftp_list_dir(
    sftp_id: String,
    path: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<Vec<FileEntry>, String> {
    sftp_manager.list_dir(&sftp_id, &path).await
}

#[tauri::command]
pub async fn sftp_get_home_dir(
    sftp_id: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<String, String> {
    sftp_manager.get_home_dir(&sftp_id).await
}

#[tauri::command]
pub async fn sftp_download(
    sftp_id: String,
    remote_path: String,
    local_path: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<(), String> {
    let data = sftp_manager.read_file(&sftp_id, &remote_path).await?;
    std::fs::write(&local_path, &data).map_err(|e| format!("Failed to write local file: {e}"))
}

#[tauri::command]
pub async fn sftp_upload(
    sftp_id: String,
    remote_path: String,
    local_path: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<(), String> {
    let data =
        std::fs::read(&local_path).map_err(|e| format!("Failed to read local file: {e}"))?;
    sftp_manager
        .write_file(&sftp_id, &remote_path, &data)
        .await
}

#[tauri::command]
pub async fn sftp_delete(
    sftp_id: String,
    path: String,
    is_dir: bool,
    sftp_manager: State<'_, SftpManager>,
) -> Result<(), String> {
    sftp_manager.delete(&sftp_id, &path, is_dir).await
}

#[tauri::command]
pub async fn sftp_rename(
    sftp_id: String,
    old_path: String,
    new_path: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<(), String> {
    sftp_manager.rename(&sftp_id, &old_path, &new_path).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    sftp_id: String,
    path: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<(), String> {
    sftp_manager.create_dir(&sftp_id, &path).await
}

/// Check whether a remote path exists. Used by the upload conflict flow
/// so the frontend can decide between Replace / Keep-Both / Skip.
#[tauri::command]
pub async fn sftp_exists(
    sftp_id: String,
    path: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<bool, String> {
    // file_size 호출은 metadata 조회. 있으면 Ok, 없으면 Err.
    match sftp_manager.file_size(&sftp_id, &path).await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Recursively create all intermediate directories (like `mkdir -p`).
/// Ignores errors on directories that already exist.
#[tauri::command]
pub async fn sftp_mkdir_p(
    sftp_id: String,
    path: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<(), String> {
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut current = String::new();
    for part in parts {
        current.push('/');
        current.push_str(part);
        let _ = sftp_manager.create_dir(&sftp_id, &current).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_copy_between(
    src_sftp_id: String,
    src_path: String,
    dst_sftp_id: String,
    dst_path: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<u64, String> {
    sftp_manager
        .copy_between(&src_sftp_id, &src_path, &dst_sftp_id, &dst_path)
        .await
}

#[tauri::command]
pub async fn sftp_upload_bytes(
    sftp_id: String,
    remote_path: String,
    data: Vec<u8>,
    sftp_manager: State<'_, SftpManager>,
) -> Result<(), String> {
    sftp_manager
        .write_file(&sftp_id, &remote_path, &data)
        .await
}

#[tauri::command]
pub async fn sftp_close(
    sftp_id: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<(), String> {
    sftp_manager.close(&sftp_id).await;
    Ok(())
}

// ── Monitor ──

#[tauri::command]
pub async fn monitor_start(
    session_id: String,
    ssh_manager: State<'_, SshManager>,
    monitor_manager: State<'_, MonitorManager>,
) -> Result<String, String> {
    let monitor_id = format!("mon-{}", session_id);
    monitor_manager
        .start(&monitor_id, &session_id, &ssh_manager)
        .await?;
    Ok(monitor_id)
}

#[tauri::command]
pub async fn monitor_stop(
    monitor_id: String,
    monitor_manager: State<'_, MonitorManager>,
) -> Result<(), String> {
    monitor_manager.stop(&monitor_id).await;
    Ok(())
}

#[tauri::command]
pub async fn monitor_get_stats(
    monitor_id: String,
    monitor_manager: State<'_, MonitorManager>,
) -> Result<ServerStats, String> {
    monitor_manager.get_stats(&monitor_id).await
}

// ── Port Forward ──

#[tauri::command]
pub async fn forward_add(
    session_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    ssh_manager: State<'_, SshManager>,
    forward_manager: State<'_, ForwardManager>,
) -> Result<PortForward, String> {
    forward_manager
        .add(
            local_port,
            &remote_host,
            remote_port,
            &session_id,
            &ssh_manager,
        )
        .await
}

#[tauri::command]
pub async fn forward_remove(
    id: String,
    forward_manager: State<'_, ForwardManager>,
) -> Result<(), String> {
    forward_manager.remove(&id).await
}

#[tauri::command]
pub async fn forward_list(
    forward_manager: State<'_, ForwardManager>,
) -> Result<Vec<PortForward>, String> {
    Ok(forward_manager.list().await)
}

// ── Tail ──

#[tauri::command]
pub async fn tail_start(
    session_id: String,
    path: String,
    lines: Option<u32>,
    on_event: Channel<TailEvent>,
    ssh_manager: State<'_, SshManager>,
    tail_manager: State<'_, TailManager>,
) -> Result<String, String> {
    let tail_id = format!(
        "tail-{}-{}",
        session_id.chars().take(8).collect::<String>(),
        path.replace('/', "_")
    );
    tail_manager
        .start(
            &tail_id,
            &path,
            &session_id,
            &ssh_manager,
            lines.unwrap_or(50),
            on_event,
        )
        .await?;
    Ok(tail_id)
}

#[tauri::command]
pub async fn tail_stop(
    tail_id: String,
    tail_manager: State<'_, TailManager>,
) -> Result<(), String> {
    tail_manager.stop(&tail_id).await
}

#[tauri::command]
pub async fn journal_start(
    session_id: String,
    args: String,
    on_event: Channel<TailEvent>,
    ssh_manager: State<'_, SshManager>,
    tail_manager: State<'_, TailManager>,
) -> Result<String, String> {
    // 같은 세션의 같은 args 를 두 번 시작해도 별 stream 으로 나뉘게 timestamp 추가.
    let tail_id = format!(
        "journal-{}-{}",
        session_id.chars().take(8).collect::<String>(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    tail_manager
        .start_journal(&tail_id, &args, &session_id, &ssh_manager, on_event)
        .await?;
    Ok(tail_id)
}

// ── File Watcher (Edit & Auto-Upload) ──

#[tauri::command]
pub async fn open_in_editor(
    app: tauri::AppHandle,
    sftp_id: String,
    remote_path: String,
    on_event: Channel<WatchEvent>,
    sftp_manager: State<'_, SftpManager>,
    watcher_manager: State<'_, FileWatcherManager>,
) -> Result<String, String> {
    watcher_manager
        .open_in_editor(&app, &sftp_id, &remote_path, &sftp_manager, on_event)
        .await
}

#[tauri::command]
pub async fn stop_file_watch(
    watch_id: String,
    watcher_manager: State<'_, FileWatcherManager>,
) -> Result<(), String> {
    watcher_manager.stop_watch(&watch_id).await;
    Ok(())
}

// ── Folder Sync ──

#[tauri::command]
pub async fn sync_preview(
    sftp_id: String,
    local_path: String,
    remote_path: String,
    direction: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<SyncPlan, String> {
    sync::compute_sync_plan(&sftp_manager, &sftp_id, &local_path, &remote_path, &direction).await
}

#[tauri::command]
pub async fn sync_execute(
    sftp_id: String,
    local_path: String,
    remote_path: String,
    plan: SyncPlan,
    on_event: Channel<SyncEvent>,
    sftp_manager: State<'_, SftpManager>,
) -> Result<(), String> {
    sync::execute_sync(&sftp_manager, &sftp_id, &local_path, &remote_path, plan, on_event).await
}

// ── Transfer Queue ──

#[tauri::command]
pub async fn sftp_transfer_upload(
    sftp_id: String,
    local_path: String,
    remote_path: String,
    on_event: Channel<TransferEvent>,
    sftp_manager: State<'_, SftpManager>,
    transfer_manager: State<'_, TransferManager>,
) -> Result<String, String> {
    transfer_manager
        .enqueue_upload(&sftp_id, &local_path, &remote_path, &sftp_manager, on_event)
        .await
}

#[tauri::command]
pub async fn sftp_transfer_download(
    sftp_id: String,
    remote_path: String,
    local_path: String,
    on_event: Channel<TransferEvent>,
    sftp_manager: State<'_, SftpManager>,
    transfer_manager: State<'_, TransferManager>,
) -> Result<String, String> {
    transfer_manager
        .enqueue_download(&sftp_id, &remote_path, &local_path, &sftp_manager, on_event)
        .await
}

#[tauri::command]
pub async fn sftp_transfer_server_to_server(
    src_sftp_id: String,
    src_path: String,
    dst_sftp_id: String,
    dst_path: String,
    on_event: Channel<TransferEvent>,
    sftp_manager: State<'_, SftpManager>,
    transfer_manager: State<'_, TransferManager>,
) -> Result<String, String> {
    transfer_manager
        .enqueue_server_to_server(
            &src_sftp_id,
            &src_path,
            &dst_sftp_id,
            &dst_path,
            &sftp_manager,
            on_event,
        )
        .await
}

#[tauri::command]
pub async fn sftp_transfer_cancel(
    job_id: String,
    transfer_manager: State<'_, TransferManager>,
) -> Result<(), String> {
    transfer_manager.cancel_job(&job_id).await
}

#[tauri::command]
pub async fn sftp_transfer_list(
    transfer_manager: State<'_, TransferManager>,
) -> Result<Vec<TransferJob>, String> {
    Ok(transfer_manager.list_jobs().await)
}

#[tauri::command]
pub async fn sftp_transfer_clear_completed(
    transfer_manager: State<'_, TransferManager>,
) -> Result<(), String> {
    transfer_manager.clear_completed().await;
    Ok(())
}
