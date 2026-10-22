use crate::rdp::RdpManager;
use cygnus_rdp_protocol::{ConnectConfig, Event, Input};
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
    events: Channel<Event>,
) -> Result<String, String> {
    main_window(&window)?;
    manager.open(config, Arc::new(move |event| events.send(event).is_ok()))
}
#[tauri::command]
pub fn rdp_authenticate(
    window: WebviewWindow,
    manager: State<'_, RdpManager>,
    session_id: String,
    fingerprint: String,
    password: String,
) -> Result<(), String> {
    main_window(&window)?;
    manager.authenticate(&session_id, fingerprint, password)
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
pub async fn rdp_frame(
    window: WebviewWindow,
    manager: State<'_, RdpManager>,
    session_id: String,
) -> Result<Response, String> {
    main_window(&window)?;
    manager.frame(&session_id).await.map(Response::new)
}
#[tauri::command]
pub fn rdp_close(
    window: WebviewWindow,
    manager: State<'_, RdpManager>,
    session_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    manager.close(&session_id);
    Ok(())
}
