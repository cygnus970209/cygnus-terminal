use crate::pty::PtyManager;
use crate::ssh::SshManager;
use tauri::{AppHandle, State};
use uuid::Uuid;

// ── Local PTY Commands ──

#[tauri::command]
pub fn create_pty_session(
    app_handle: AppHandle,
    pty_manager: State<'_, PtyManager>,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    pty_manager.create_session(&session_id, app_handle)?;
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
pub fn close_pty(
    session_id: String,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
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
    app_handle: AppHandle,
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
            app_handle,
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
