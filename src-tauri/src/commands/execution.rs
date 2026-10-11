use crate::crypto::CryptoManager;
use crate::execution::{ExecutionJob, ExecutionManager, ExecutionSummary, StartExecutionRequest};
use crate::ssh::SshManager;
use tauri::State;

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
    execution.get(&job_id).await
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
