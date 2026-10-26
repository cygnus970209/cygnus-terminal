use crate::crypto::CryptoManager;
use crate::mcp::{McpConfig, McpManager, McpStatus};
use tauri::{State, WebviewWindow};

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("MCP authorization is available only in the main window".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_start(
    window: WebviewWindow,
    config: McpConfig,
    manager: State<'_, McpManager>,
) -> Result<McpStatus, String> {
    main_window(&window)?;
    manager.start(config).await
}

#[tauri::command]
pub async fn mcp_status(
    window: WebviewWindow,
    manager: State<'_, McpManager>,
) -> Result<McpStatus, String> {
    main_window(&window)?;
    Ok(manager.status().await)
}

#[tauri::command]
pub async fn mcp_stop(window: WebviewWindow, manager: State<'_, McpManager>) -> Result<(), String> {
    main_window(&window)?;
    manager.stop().await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_oauth_approvals(
    window: WebviewWindow,
    manager: State<'_, McpManager>,
) -> Result<Vec<crate::mcp::oauth::Approval>, String> {
    main_window(&window)?;
    Ok(manager.oauth_approvals().await)
}
#[tauri::command]
pub async fn mcp_oauth_respond(
    window: WebviewWindow,
    manager: State<'_, McpManager>,
    id: String,
    accept: bool,
) -> Result<(), String> {
    main_window(&window)?;
    manager.oauth_respond(&id, accept).await
}
#[tauri::command]
pub async fn mcp_oauth_clients(
    window: WebviewWindow,
    manager: State<'_, McpManager>,
) -> Result<Vec<crate::mcp::oauth::AuthorizedClient>, String> {
    main_window(&window)?;
    manager.oauth_clients().await
}
#[tauri::command]
pub async fn mcp_oauth_revoke(
    window: WebviewWindow,
    manager: State<'_, McpManager>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    manager.oauth_revoke(&id).await
}

/// secureInvoke requests the existing keychain consent flow before retrying this check.
#[tauri::command]
pub fn mcp_require_credentials(crypto: State<'_, CryptoManager>) -> Result<(), String> {
    crypto.require_unlocked()
}
