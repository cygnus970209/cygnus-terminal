use crate::{iis, ssh::SshManager};
use tauri::State;

#[tauri::command]
pub async fn iis_overview(
    session_id: String,
    ssh_manager: State<'_, SshManager>,
) -> Result<iis::Overview, String> {
    iis::overview(&ssh_manager, &session_id).await
}

#[tauri::command]
pub async fn iis_site_log(
    session_id: String,
    site_id: u32,
    ssh_manager: State<'_, SshManager>,
) -> Result<iis::SiteLog, String> {
    iis::site_log(&ssh_manager, &session_id, site_id).await
}

#[tauri::command]
pub async fn windows_events(
    session_id: String,
    ssh_manager: State<'_, SshManager>,
) -> Result<iis::Events, String> {
    iis::events(&ssh_manager, &session_id).await
}
