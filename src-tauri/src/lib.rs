mod commands;
mod pty;

use pty::PtyManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::create_pty_session,
            commands::write_pty,
            commands::resize_pty,
            commands::close_pty,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
