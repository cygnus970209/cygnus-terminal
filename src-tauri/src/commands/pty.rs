use crate::pty::{PtyEvent, PtyManager};
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

#[tauri::command]
pub fn create_pty_session(
    on_event: Channel<PtyEvent>,
    pty_manager: State<'_, PtyManager>,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    pty_manager.create_session(&session_id, on_event)?;
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
pub fn close_pty(session_id: String, pty_manager: State<'_, PtyManager>) -> Result<(), String> {
    pty_manager.close_session(&session_id)
}
