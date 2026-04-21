use crate::pty::PtyEvent;
use crate::ssh::{JumpHostConfig, SshManager};
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

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
