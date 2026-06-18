mod commands;
pub mod crypto;
pub mod db;
pub mod forward;
pub mod monitor;
mod pty;
pub mod registry;
pub mod serial;
pub mod sftp;
pub mod ssh;
pub mod sync;
pub mod tail;
pub mod telnet;
pub mod transfer;
pub mod vault;
pub mod watcher;

use std::sync::Arc;

use crypto::CryptoManager;
use db::Database;
use forward::ForwardManager;
use monitor::MonitorManager;
use pty::PtyManager;
use sftp::SftpManager;
use ssh::SshManager;
use tail::TailManager;
use serial::SerialManager;
use telnet::TelnetManager;
use transfer::TransferManager;
use watcher::FileWatcherManager;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // updater + process 는 desktop 전용. 모바일 빌드에 포함 안 되게 cfg 가드.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "preferences" => {
                    let _ = app.emit("open-settings", ());
                }
                "toggle-server-ctx" => {
                    let _ = app.emit("toggle-server-ctx", ());
                }
                "toggle-file-tree" => {
                    let _ = app.emit("toggle-file-tree", ());
                }
                "toggle-monitor" => {
                    let _ = app.emit("toggle-drawer", "monitor");
                }
                "toggle-transfers" => {
                    let _ = app.emit("toggle-drawer", "transfers");
                }
                "toggle-logs" => {
                    let _ = app.emit("toggle-drawer", "logs");
                }
                "updater-check" => {
                    let _ = app.emit("updater-check", ());
                }
                _ => {}
            }
        })
        .setup(|app| {
            // 메뉴 설정
            let preferences = MenuItemBuilder::with_id("preferences", "Preferences")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let toggle_server_ctx = MenuItemBuilder::with_id(
                "toggle-server-ctx",
                "Toggle Server Context",
            )
            .accelerator("CmdOrCtrl+\\")
            .build(app)?;
            let toggle_file_tree = MenuItemBuilder::with_id(
                "toggle-file-tree",
                "Toggle File Tree",
            )
            .accelerator("CmdOrCtrl+Shift+\\")
            .build(app)?;
            let toggle_monitor =
                MenuItemBuilder::with_id("toggle-monitor", "Monitor")
                    .accelerator("CmdOrCtrl+1")
                    .build(app)?;
            let toggle_transfers =
                MenuItemBuilder::with_id("toggle-transfers", "Transfers")
                    .accelerator("CmdOrCtrl+2")
                    .build(app)?;
            let toggle_logs = MenuItemBuilder::with_id("toggle-logs", "Logs")
                .accelerator("CmdOrCtrl+3")
                .build(app)?;
            let updater_check =
                MenuItemBuilder::with_id("updater-check", "Check for Updates...")
                    .build(app)?;
            // macOS 웹뷰(WKWebView) 는 표준 Edit 메뉴의 copy:/paste:/selectAll: 액션을
            // 통해서만 input 에 clipboard 단축키를 연결한다. 커스텀 메뉴만 있으면
            // 모든 input 에서 ⌘C/V/A 가 죽는다. 표준 predefined item 으로 복구.
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view_submenu = SubmenuBuilder::new(app, "View")
                .item(&toggle_server_ctx)
                .item(&toggle_file_tree)
                .separator()
                .item(&toggle_monitor)
                .item(&toggle_transfers)
                .item(&toggle_logs)
                .separator()
                .item(&updater_check)
                .build()?;
            let menu = MenuBuilder::new(app)
                .item(&preferences)
                .item(&edit_submenu)
                .item(&view_submenu)
                .build()?;
            app.set_menu(menu)?;
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data directory");
            let database =
                Arc::new(Database::new(app_data_dir).expect("Failed to initialize database"));
            let crypto = CryptoManager::new().expect("Failed to initialize crypto manager");
            // 레거시 평문 jump_host → 암호화 저장 전환 (멱등). 실패해도 앱은 동작해야 하므로 로그만 남긴다.
            match database.migrate_plaintext_jump_hosts(&crypto) {
                Ok(n) if n > 0 => eprintln!("Encrypted {n} legacy plaintext jump_host entr(ies)"),
                Ok(_) => {}
                Err(e) => eprintln!("jump_host encryption migration failed: {e}"),
            }
            let ssh_manager = SshManager::new(Arc::clone(&database));
            app.manage(database);
            app.manage(crypto);
            app.manage(ssh_manager);
            app.manage(SftpManager::new());
            app.manage(MonitorManager::new());
            app.manage(ForwardManager::new());
            app.manage(TailManager::new());
            app.manage(SerialManager::new());
            app.manage(TelnetManager::new());
            app.manage(TransferManager::new());
            app.manage(FileWatcherManager::new());
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
            commands::ssh_host_key_respond,
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
            commands::get_local_home_dir,
            commands::list_local_dir,
            commands::is_local_dir,
            commands::local_exists,
            commands::drag_temp_path,
            commands::sftp_open,
            commands::sftp_list_dir,
            commands::sftp_get_home_dir,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_delete,
            commands::sftp_rename,
            commands::sftp_mkdir,
            commands::sftp_mkdir_p,
            commands::sftp_exists,
            commands::sftp_copy_between,
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
            commands::journal_start,
            commands::open_in_editor,
            commands::stop_file_watch,
            commands::sync_preview,
            commands::sync_execute,
            commands::list_serial_ports,
            commands::create_serial_session,
            commands::write_serial,
            commands::close_serial,
            commands::create_telnet_session,
            commands::write_telnet,
            commands::resize_telnet,
            commands::close_telnet,
            commands::sftp_transfer_upload,
            commands::sftp_transfer_download,
            commands::sftp_transfer_server_to_server,
            commands::sftp_transfer_cancel,
            commands::sftp_transfer_list,
            commands::sftp_transfer_clear_completed,
            commands::vault_create,
            commands::vault_list,
            commands::vault_get,
            commands::vault_update,
            commands::vault_delete,
            commands::vault_link_server,
            commands::vault_inject,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
