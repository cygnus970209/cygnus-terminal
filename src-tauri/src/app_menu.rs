use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

pub fn install(app: &AppHandle, language: &str) -> tauri::Result<()> {
    let ko = language == "ko";
    let text = |en, kr| if ko { kr } else { en };
    let item = |id, en, kr, shortcut: Option<&str>| {
        let mut builder = MenuItemBuilder::with_id(id, text(en, kr));
        if let Some(shortcut) = shortcut {
            builder = builder.accelerator(shortcut);
        }
        builder.build(app)
    };
    let preferences = item("preferences", "Settings…", "설정…", Some("CmdOrCtrl+,"))?;
    let updater = item(
        "updater-check",
        "Check for Updates…",
        "업데이트 확인…",
        None,
    )?;
    let app_menu = SubmenuBuilder::new(app, "Cygnus Terminal")
        .item(&preferences)
        .item(&updater)
        .separator();
    #[cfg(target_os = "macos")]
    let app_menu = app_menu
        .services_with_text(text("Services", "서비스"))
        .separator()
        .hide_with_text(text("Hide Cygnus Terminal", "Cygnus Terminal 가리기"))
        .hide_others_with_text(text("Hide Others", "기타 가리기"))
        .show_all_with_text(text("Show All", "모두 보기"))
        .separator();
    let app_menu = app_menu
        .quit_with_text(text("Quit Cygnus Terminal", "Cygnus Terminal 종료"))
        .build()?;
    let connections = SubmenuBuilder::new(app, text("Connection", "연결"))
        .item(&item(
            "new-ssh",
            "New SSH Connection…",
            "새 SSH 연결…",
            Some("CmdOrCtrl+N"),
        )?)
        .item(&item(
            "new-local",
            "New Local Shell",
            "새 로컬 셸",
            Some("CmdOrCtrl+T"),
        )?)
        .item(&item(
            "new-rdp",
            "New RDP Connection…",
            "새 RDP 연결…",
            None,
        )?)
        .item(&item(
            "new-telnet",
            "New Telnet Connection…",
            "새 Telnet 연결…",
            None,
        )?)
        .item(&item("new-winrm", "New WinRM Connection…", "새 WinRM 연결…", None)?)
        .item(&item(
            "new-serial",
            "New Serial Connection…",
            "새 시리얼 연결…",
            None,
        )?)
        .separator()
        .item(&item(
            "open-connections",
            "Saved Connections",
            "저장된 연결",
            None,
        )?)
        .build()?;
    // Keep native Edit actions: WKWebView needs these for text-field shortcuts.
    let edit = SubmenuBuilder::new(app, text("Edit", "편집"))
        .undo_with_text(text("Undo", "실행 취소"))
        .redo_with_text(text("Redo", "다시 실행"))
        .separator()
        .cut_with_text(text("Cut", "잘라내기"))
        .copy_with_text(text("Copy", "복사"))
        .paste_with_text(text("Paste", "붙여넣기"))
        .select_all_with_text(text("Select All", "모두 선택"))
        .build()?;
    let view = SubmenuBuilder::new(app, text("View", "보기"))
        .item(&item(
            "toggle-server-ctx",
            "Toggle Connections Sidebar",
            "연결 사이드바 표시/숨기기",
            Some("CmdOrCtrl+\\"),
        )?)
        .item(&item(
            "toggle-file-tree",
            "Toggle File Tree",
            "파일 트리 표시/숨기기",
            Some("CmdOrCtrl+Shift+\\"),
        )?)
        .separator()
        .item(&item(
            "toggle-monitor",
            "Monitor",
            "모니터",
            Some("CmdOrCtrl+1"),
        )?)
        .item(&item(
            "toggle-transfers",
            "Transfers",
            "전송",
            Some("CmdOrCtrl+2"),
        )?)
        .item(&item("toggle-logs", "Logs", "로그", Some("CmdOrCtrl+3"))?)
        .item(&item(
            "toggle-iis",
            "IIS & Windows Events (Beta)",
            "IIS 및 Windows 이벤트 (베타)",
            None,
        )?)
        .build()?;
    let tools = SubmenuBuilder::new(app, text("Tools", "도구"))
        .item(&item("open-sftp", "SFTP Files…", "SFTP 파일…", None)?)
        .item(&item("open-snippets", "Snippets…", "스니펫…", None)?)
        .item(&item("open-vault", "Vault…", "보관함…", None)?)
        .item(&item("open-mcp", "MCP Settings…", "MCP 설정…", None)?)
        .separator()
        // Cmd/Ctrl+K is handled in the webview capture listener, including IME.
        .item(&item(
            "open-palette",
            "Command Palette…",
            "명령 팔레트…",
            None,
        )?)
        .build()?;
    app.set_menu(
        MenuBuilder::new(app)
            .item(&app_menu)
            .item(&connections)
            .item(&edit)
            .item(&view)
            .item(&tools)
            .build()?,
    )?;
    Ok(())
}

#[tauri::command]
pub fn set_app_language(app: AppHandle, language: String) -> Result<(), String> {
    if !matches!(language.as_str(), "en" | "ko") {
        return Err("Unsupported language".into());
    }
    install(&app, &language).map_err(|error| error.to_string())
}

pub fn handle_event(app: &AppHandle, id: &str) {
    let recognized = matches!(
        id,
        "preferences"
            | "updater-check"
            | "toggle-server-ctx"
            | "toggle-file-tree"
            | "toggle-monitor"
            | "toggle-transfers"
            | "toggle-logs"
            | "toggle-iis"
            | "new-ssh"
            | "new-local"
            | "new-rdp"
            | "new-telnet"
            | "new-winrm"
            | "new-serial"
            | "open-connections"
            | "open-sftp"
            | "open-snippets"
            | "open-vault"
            | "open-mcp"
            | "open-palette"
    );
    if !recognized {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    match id {
        "preferences" => {
            let _ = app.emit_to("main", "open-settings", ());
        }
        "updater-check" => {
            let _ = app.emit_to("main", "updater-check", ());
        }
        "toggle-server-ctx" | "toggle-file-tree" => {
            let _ = app.emit_to("main", id, ());
        }
        "toggle-monitor" | "toggle-transfers" | "toggle-logs" | "toggle-iis" => {
            let _ = app.emit_to("main", "toggle-drawer", id.trim_start_matches("toggle-"));
        }
        _ => {
            let _ = app.emit_to("main", "app-menu-action", id);
        }
    }
}
