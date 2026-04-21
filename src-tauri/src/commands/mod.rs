use std::sync::Arc;

use crate::crypto::CryptoManager;
use crate::db::command_bookmark::{CommandBookmark, CreateCommandBookmarkRequest};
use crate::db::export::ExportData;
use crate::db::history::CommandHistoryEntry;
use crate::db::path_bookmark::{CreatePathBookmarkRequest, PathBookmark};
use crate::db::profile::{CreateProfileRequest, Profile, UpdateProfileRequest};
use crate::db::snippet::{CreateSnippetRequest, Snippet, UpdateSnippetRequest};
use crate::db::Database;
use crate::pty::{PtyEvent, PtyManager};
use crate::forward::{ForwardManager, PortForward};
use crate::monitor::{MonitorManager, ServerStats};
use crate::sftp::{FileEntry, SftpManager};
use crate::ssh::{JumpHostConfig, SshManager};
use crate::tail::{TailEvent, TailManager};
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

// ── Local PTY Commands ──

#[tauri::command]
pub fn create_pty_session(
    on_event: Channel<PtyEvent>,
    pty_manager: State<'_, PtyManager>,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    pty_manager.create_session(&session_id, on_event)?;
    Ok(session_id)
}

#[tauri::command]
pub fn write_pty(
    session_id: String,
    data: String,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.write_to_session(&session_id, &data)
}

#[tauri::command]
pub fn resize_pty(
    session_id: String,
    rows: u16,
    cols: u16,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.resize_session(&session_id, rows, cols)
}

#[tauri::command]
pub fn close_pty(session_id: String, pty_manager: State<'_, PtyManager>) -> Result<(), String> {
    pty_manager.close_session(&session_id)
}

// ── SSH Commands ──

#[tauri::command]
pub async fn create_ssh_session(
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    key_path: Option<String>,
    jump_host: Option<JumpHostConfig>,
    agent_forward: Option<bool>,
    on_event: Channel<PtyEvent>,
    ssh_manager: State<'_, SshManager>,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    ssh_manager
        .connect(
            &session_id,
            &host,
            port,
            &username,
            &auth_type,
            password.as_deref(),
            key_path.as_deref(),
            jump_host,
            agent_forward.unwrap_or(false),
            on_event,
        )
        .await?;
    Ok(session_id)
}

#[tauri::command]
pub async fn write_ssh(
    session_id: String,
    data: String,
    ssh_manager: State<'_, SshManager>,
) -> Result<(), String> {
    ssh_manager
        .write_to_session(&session_id, data.as_bytes())
        .await
}

#[tauri::command]
pub async fn resize_ssh(
    session_id: String,
    cols: u32,
    rows: u32,
    ssh_manager: State<'_, SshManager>,
) -> Result<(), String> {
    ssh_manager.resize_session(&session_id, cols, rows).await
}

#[tauri::command]
pub async fn close_ssh(
    session_id: String,
    ssh_manager: State<'_, SshManager>,
) -> Result<(), String> {
    ssh_manager.close_session(&session_id).await
}

// ── Profile Commands ──

#[tauri::command]
pub fn create_profile(
    req: CreateProfileRequest,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<Profile, String> {
    db.create_profile(req, &crypto)
}

#[tauri::command]
pub fn list_profiles(
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<Vec<Profile>, String> {
    db.list_profiles(&crypto)
}

#[tauri::command]
pub fn get_profile(
    id: i64,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<Profile, String> {
    db.get_profile(id, &crypto)
}

#[tauri::command]
pub fn update_profile(
    id: i64,
    req: UpdateProfileRequest,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<Profile, String> {
    db.update_profile(id, req, &crypto)
}

#[tauri::command]
pub fn delete_profile(id: i64, db: State<'_, Arc<Database>>) -> Result<(), String> {
    db.delete_profile(id)
}

// ── History Commands ──

#[tauri::command]
pub fn search_command_history(
    profile_id: i64,
    query: Option<String>,
    limit: Option<u32>,
    db: State<'_, Arc<Database>>,
) -> Result<Vec<CommandHistoryEntry>, String> {
    db.search_command_history(profile_id, query.as_deref(), limit.unwrap_or(100))
}

#[tauri::command]
pub fn delete_command_history(
    id: i64,
    db: State<'_, Arc<Database>>,
) -> Result<(), String> {
    db.delete_command_history(id)
}

#[tauri::command]
pub fn save_command_history(
    profile_id: i64,
    command: String,
    db: State<'_, Arc<Database>>,
) -> Result<(), String> {
    db.add_command_history(profile_id, &command)
}

// ── Command Bookmark Commands ──

#[tauri::command]
pub fn create_command_bookmark(
    req: CreateCommandBookmarkRequest,
    db: State<'_, Arc<Database>>,
) -> Result<CommandBookmark, String> {
    db.create_command_bookmark(req)
}

#[tauri::command]
pub fn list_command_bookmarks(
    profile_id: i64,
    db: State<'_, Arc<Database>>,
) -> Result<Vec<CommandBookmark>, String> {
    db.list_command_bookmarks(profile_id)
}

#[tauri::command]
pub fn delete_command_bookmark(
    id: i64,
    db: State<'_, Arc<Database>>,
) -> Result<(), String> {
    db.delete_command_bookmark(id)
}

// ── Path Bookmark Commands ──

#[tauri::command]
pub fn create_path_bookmark(
    req: CreatePathBookmarkRequest,
    db: State<'_, Arc<Database>>,
) -> Result<PathBookmark, String> {
    db.create_path_bookmark(req)
}

#[tauri::command]
pub fn list_path_bookmarks(
    profile_id: i64,
    db: State<'_, Arc<Database>>,
) -> Result<Vec<PathBookmark>, String> {
    db.list_path_bookmarks(profile_id)
}

#[tauri::command]
pub fn delete_path_bookmark(
    id: i64,
    db: State<'_, Arc<Database>>,
) -> Result<(), String> {
    db.delete_path_bookmark(id)
}

// ── SFTP Commands ──

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
    std::fs::write(&local_path, &data)
        .map_err(|e| format!("Failed to write local file: {e}"))
}

#[tauri::command]
pub async fn sftp_upload(
    sftp_id: String,
    remote_path: String,
    local_path: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<(), String> {
    let data = std::fs::read(&local_path)
        .map_err(|e| format!("Failed to read local file: {e}"))?;
    sftp_manager.write_file(&sftp_id, &remote_path, &data).await
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
    sftp_manager.write_file(&sftp_id, &remote_path, &data).await
}

#[tauri::command]
pub async fn sftp_close(
    sftp_id: String,
    sftp_manager: State<'_, SftpManager>,
) -> Result<(), String> {
    sftp_manager.close(&sftp_id).await;
    Ok(())
}

// ── Monitor Commands ──

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

// ── Port Forward Commands ──

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
        .add(local_port, &remote_host, remote_port, &session_id, &ssh_manager)
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

// ── Export/Import Commands ──

#[tauri::command]
pub fn export_data(
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<ExportData, String> {
    db.export_data(&crypto)
}

#[tauri::command]
pub fn import_data(
    data: ExportData,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<u32, String> {
    db.import_data(data, &crypto)
}

#[tauri::command]
pub fn export_to_file(
    path: String,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<(), String> {
    let data = db.export_data(&crypto)?;
    let json = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Serialization failed: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write file: {e}"))
}

#[tauri::command]
pub fn import_from_file(
    path: String,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<u32, String> {
    let json = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file: {e}"))?;
    let data: ExportData = serde_json::from_str(&json)
        .map_err(|e| format!("Invalid JSON: {e}"))?;
    db.import_data(data, &crypto)
}

// ── Snippet Commands ──

#[tauri::command]
pub fn create_snippet(
    req: CreateSnippetRequest,
    db: State<'_, Arc<Database>>,
) -> Result<Snippet, String> {
    db.create_snippet(req)
}

#[tauri::command]
pub fn list_snippets(
    query: Option<String>,
    db: State<'_, Arc<Database>>,
) -> Result<Vec<Snippet>, String> {
    db.list_snippets(query.as_deref())
}

#[tauri::command]
pub fn update_snippet(
    id: i64,
    req: UpdateSnippetRequest,
    db: State<'_, Arc<Database>>,
) -> Result<Snippet, String> {
    db.update_snippet(id, req)
}

#[tauri::command]
pub fn delete_snippet(
    id: i64,
    db: State<'_, Arc<Database>>,
) -> Result<(), String> {
    db.delete_snippet(id)
}

// ── Tail Commands ──

#[tauri::command]
pub async fn tail_start(
    session_id: String,
    path: String,
    lines: Option<u32>,
    on_event: Channel<TailEvent>,
    ssh_manager: State<'_, SshManager>,
    tail_manager: State<'_, TailManager>,
) -> Result<String, String> {
    let tail_id = format!("tail-{}-{}", session_id.chars().take(8).collect::<String>(), path.replace('/', "_"));
    tail_manager
        .start(&tail_id, &path, &session_id, &ssh_manager, lines.unwrap_or(50), on_event)
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
