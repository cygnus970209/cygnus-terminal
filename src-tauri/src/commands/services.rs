use crate::forward::{ForwardManager, PortForward};
use crate::monitor::{MonitorManager, ServerStats};
use crate::sftp::{FileEntry, SftpManager};
use crate::ssh::SshManager;
use crate::tail::{TailEvent, TailManager};
use tauri::ipc::Channel;
use tauri::State;

// ── SFTP ──

#[tauri::command]
pub async fn sftp_open(
    session_id: String,
    ssh_manager: State<'_, SshManager>,
    sftp_manager: State<'_, SftpManager>,
) -> Result<String, String> {
    let sftp_session = ssh_manager.open_sftp_channel(&session_id).await?;
    let sftp_id = format!("sftp-{}", session_id);
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
