mod commands;
mod pty;
mod ssh;

use pty::PtyManager;
use ssh::SshManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::new())
        .manage(SshManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::create_pty_session,
            commands::write_pty,
            commands::resize_pty,
            commands::close_pty,
            commands::create_ssh_session,
            commands::write_ssh,
            commands::resize_ssh,
            commands::close_ssh,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
