use crate::db::{
    rdp::{ProfileData, RdpProfile},
    Database,
};
use crate::rdp::{CertificateApproval, RdpManager, SessionEvent};
use cygnus_rdp_protocol::{ConnectConfig, DesktopSize, Input};
use std::sync::Arc;
use tauri::{
    ipc::{Channel, Response},
    State, WebviewWindow,
};

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("RDP is available only in the main application window".into());
    }
    Ok(())
}
#[tauri::command]
pub fn rdp_connect(
    window: WebviewWindow,
    manager: State<'_, RdpManager>,
    config: ConnectConfig,
    events: Channel<SessionEvent>,
) -> Result<String, String> {
    main_window(&window)?;
    manager.open(config, Arc::new(move |event| events.send(event).is_ok()))
}
#[tauri::command]
pub fn rdp_authenticate(
    window: WebviewWindow,
    manager: State<'_, RdpManager>,
    session_id: String,
    approval: CertificateApproval,
) -> Result<(), String> {
    main_window(&window)?;
    manager.authenticate(&session_id, approval)
}
#[tauri::command]
pub fn rdp_input(
    window: WebviewWindow,
    manager: State<'_, RdpManager>,
    session_id: String,
    events: Vec<Input>,
) -> Result<(), String> {
    main_window(&window)?;
    manager.input(&session_id, events)
}
#[tauri::command]
pub fn rdp_resize(
    window: WebviewWindow,
    manager: State<'_, RdpManager>,
    session_id: String,
    size: DesktopSize,
) -> Result<(), String> {
    main_window(&window)?;
    manager.resize(&session_id, size)
}
#[tauri::command]
pub async fn rdp_frame(
    window: WebviewWindow,
    manager: State<'_, RdpManager>,
    session_id: String,
) -> Result<Response, String> {
    main_window(&window)?;
    manager.frame(&session_id).await.map(Response::new)
}
#[tauri::command]
pub async fn rdp_close(
    window: WebviewWindow,
    manager: State<'_, RdpManager>,
    session_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    manager.close_and_wait(&session_id).await
}

#[tauri::command]
pub fn rdp_forget_certificate(
    window: WebviewWindow,
    manager: State<'_, RdpManager>,
    session_id: String,
    expected_fingerprint: String,
) -> Result<(), String> {
    main_window(&window)?;
    manager.forget_certificate(&session_id, &expected_fingerprint)
}
#[tauri::command]
pub fn rdp_list_profiles(
    window: WebviewWindow,
    db: State<'_, Arc<Database>>,
) -> Result<Vec<RdpProfile>, String> {
    main_window(&window)?;
    db.list_rdp_profiles()
}
#[tauri::command]
pub fn rdp_save_profile(
    window: WebviewWindow,
    db: State<'_, Arc<Database>>,
    id: Option<i64>,
    data: ProfileData,
) -> Result<RdpProfile, String> {
    main_window(&window)?;
    db.save_rdp_profile(id, data)
}
#[tauri::command]
pub fn rdp_delete_profile(
    window: WebviewWindow,
    db: State<'_, Arc<Database>>,
    id: i64,
) -> Result<(), String> {
    main_window(&window)?;
    db.delete_rdp_profile(id)
}
