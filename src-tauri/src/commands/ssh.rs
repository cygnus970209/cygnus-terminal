use crate::pty::PtyEvent;
use crate::ssh::{JumpHostConfig, SshManager};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use uuid::Uuid;

// 인자 목록이 곧 IPC 페이로드 스키마 — 구조체로 묶으면 프론트 호출부 호환이 깨진다.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_ssh_session(
    app: AppHandle,
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
            app,
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

/// 프론트엔드가 host key 확인 다이얼로그에서 수락/거절한 결과를 반영.
/// 수락하면 연결이 진행되고, 거절하면 fail-closed 로 연결이 끊긴다.
#[tauri::command]
pub async fn ssh_host_key_respond(
    prompt_id: String,
    accept: bool,
    ssh_manager: State<'_, SshManager>,
) -> Result<(), String> {
    ssh_manager.resolve_host_key_prompt(&prompt_id, accept).await
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
