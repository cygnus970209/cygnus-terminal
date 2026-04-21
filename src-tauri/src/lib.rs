mod commands;
mod crypto;
mod db;
mod pty;
mod ssh;

use std::sync::Arc;

use crypto::CryptoManager;
use db::Database;
use pty::PtyManager;
use ssh::SshManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data directory");
            let database =
                Arc::new(Database::new(app_data_dir).expect("Failed to initialize database"));
            let crypto = CryptoManager::new().expect("Failed to initialize crypto manager");
            let ssh_manager = SshManager::new(Arc::clone(&database));
            app.manage(database);
            app.manage(crypto);
            app.manage(ssh_manager);
            Ok(())
        })
        .manage(PtyManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::create_pty_session,
            commands::write_pty,
            commands::resize_pty,
            commands::close_pty,
            commands::create_ssh_session,
            commands::write_ssh,
            commands::resize_ssh,
            commands::close_ssh,
            commands::create_profile,
            commands::list_profiles,
            commands::get_profile,
            commands::update_profile,
            commands::delete_profile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
