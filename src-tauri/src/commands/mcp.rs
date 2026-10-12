use crate::crypto::CryptoManager;
use crate::mcp::{McpConfig, McpManager, McpStatus};
use tauri::State;

#[tauri::command]
pub async fn mcp_start(
    config: McpConfig,
    manager: State<'_, McpManager>,
) -> Result<McpStatus, String> {
    manager.start(config).await
}

#[tauri::command]
pub async fn mcp_status(manager: State<'_, McpManager>) -> Result<McpStatus, String> {
    Ok(manager.status().await)
}

#[tauri::command]
pub async fn mcp_stop(manager: State<'_, McpManager>) -> Result<(), String> {
    manager.stop().await;
    Ok(())
}

/// secureInvoke requests the existing keychain consent flow before retrying this check.
#[tauri::command]
pub fn mcp_require_credentials(crypto: State<'_, CryptoManager>) -> Result<(), String> {
    crypto.require_unlocked()
}
