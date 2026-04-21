mod commands;
pub mod crypto;
pub mod db;
pub mod forward;
pub mod monitor;
mod pty;
pub mod sftp;
pub mod ssh;
pub mod tail;
pub mod transfer;

use std::sync::Arc;

use crypto::CryptoManager;
use db::Database;
use forward::ForwardManager;
use monitor::MonitorManager;
use pty::PtyManager;
use sftp::SftpManager;
use ssh::SshManager;
use tail::TailManager;
use transfer::TransferManager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_menu_event(|app, event| {
            if event.id() == "preferences" {
                let _ = app.emit("open-settings", ());
            }
        })
        .setup(|app| {
            // 메뉴 설정
            let preferences = MenuItemBuilder::with_id("preferences", "Preferences")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&preferences)
                .build()?;
            app.set_menu(menu)?;
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
            app.manage(SftpManager::new());
            app.manage(MonitorManager::new());
            app.manage(ForwardManager::new());
            app.manage(TailManager::new());
            app.manage(TransferManager::new());
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
            commands::search_command_history,
            commands::save_command_history,
            commands::delete_command_history,
            commands::create_command_bookmark,
            commands::list_command_bookmarks,
            commands::delete_command_bookmark,
            commands::create_path_bookmark,
            commands::list_path_bookmarks,
            commands::delete_path_bookmark,
            commands::sftp_open,
            commands::sftp_list_dir,
            commands::sftp_get_home_dir,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_delete,
            commands::sftp_rename,
            commands::sftp_mkdir,
            commands::sftp_upload_bytes,
            commands::sftp_close,
            commands::monitor_start,
            commands::monitor_stop,
            commands::monitor_get_stats,
            commands::forward_add,
            commands::forward_remove,
            commands::forward_list,
            commands::export_data,
            commands::import_data,
            commands::export_to_file,
            commands::import_from_file,
            commands::create_snippet,
            commands::list_snippets,
            commands::update_snippet,
            commands::delete_snippet,
            commands::tail_start,
            commands::tail_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
