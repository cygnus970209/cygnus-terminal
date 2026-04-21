use std::sync::Arc;

use crate::crypto::CryptoManager;
use crate::db::profile::{CreateProfileRequest, Profile, UpdateProfileRequest};
use crate::db::Database;
use crate::pty::{PtyEvent, PtyManager};
use crate::ssh::SshManager;
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
