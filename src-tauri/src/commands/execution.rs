use crate::crypto::CryptoManager;
use crate::execution::terminal::TerminalEvent;
use crate::execution::{ExecutionJob, ExecutionManager, ExecutionSummary, StartExecutionRequest};
use crate::ssh::SshManager;
use std::sync::Arc;
use tauri::State;
use tauri::{ipc::Channel, WebviewWindow};

fn require_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("MCP terminals are available only in the main window".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn execution_terminal_list(
    window: WebviewWindow,
    execution: State<'_, ExecutionManager>,
) -> Result<Vec<ExecutionSummary>, String> {
    require_main_window(&window)?;
    Ok(execution.active_terminals().await)
}

#[tauri::command]
pub async fn execution_terminal_attach(
    window: WebviewWindow,
    job_id: String,
    on_event: Channel<TerminalEvent>,
    execution: State<'_, ExecutionManager>,
) -> Result<(), String> {
    require_main_window(&window)?;
    execution
        .attach_terminal(
            &job_id,
            Arc::new(move |event| {
                on_event
                    .send(event)
                    .map_err(|_| "Terminal monitor disconnected".into())
            }),
        )
        .await
}

#[tauri::command]
pub async fn execution_terminal_input(
    window: WebviewWindow,
    job_id: String,
    data: String,
    execution: State<'_, ExecutionManager>,
) -> Result<(), String> {
    let data = zeroize::Zeroizing::new(data.into_bytes());
    require_main_window(&window)?;
    execution.terminal_input(&job_id, data).await
}

#[tauri::command]
pub async fn execution_terminal_resize(
    window: WebviewWindow,
    job_id: String,
    cols: u32,
    rows: u32,
    execution: State<'_, ExecutionManager>,
) -> Result<(), String> {
    require_main_window(&window)?;
    execution.terminal_resize(&job_id, cols, rows).await
}

#[tauri::command]
pub async fn execution_start(
    req: StartExecutionRequest,
    execution: State<'_, ExecutionManager>,
    crypto: State<'_, CryptoManager>,
    ssh: State<'_, SshManager>,
) -> Result<String, String> {
    execution.start(req, &crypto, ssh.inner().clone()).await
}

#[tauri::command]
pub async fn execution_get(
    job_id: String,
    execution: State<'_, ExecutionManager>,
) -> Result<ExecutionJob, String> {
    execution.get(&job_id).await.map_err(Into::into)
}

#[tauri::command]
pub fn execution_history_settings(
    execution: State<'_, ExecutionManager>,
) -> Result<crate::execution::history::HistorySettings, String> {
    execution.history_settings()
}

#[tauri::command]
pub async fn execution_history_update(
    settings: crate::execution::history::HistorySettings,
    execution: State<'_, ExecutionManager>,
) -> Result<(), String> {
    execution.set_history_settings(settings).await
}

#[tauri::command]
pub async fn execution_history_clear(execution: State<'_, ExecutionManager>) -> Result<(), String> {
    execution.clear_history().await
}

#[tauri::command]
pub async fn execution_list(
    limit: Option<u32>,
    offset: Option<u32>,
    execution: State<'_, ExecutionManager>,
) -> Result<Vec<ExecutionSummary>, String> {
    execution
        .list(limit.unwrap_or(50), offset.unwrap_or(0))
        .await
}

#[tauri::command]
pub async fn execution_cancel(
    job_id: String,
    execution: State<'_, ExecutionManager>,
) -> Result<(), String> {
    execution.cancel(&job_id).await
}
