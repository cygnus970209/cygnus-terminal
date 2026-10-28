use crate::{
    crypto::CryptoManager,
    db::{
        winrm::{ProfileData, WinrmProfile},
        Database,
    },
    winrm::{Config, Output, WinrmManager},
};
use std::sync::Arc;
use tauri::State;
use zeroize::Zeroizing;

#[tauri::command]
pub fn winrm_list_profiles(db: State<'_, Arc<Database>>) -> Result<Vec<WinrmProfile>, String> {
    db.list_winrm_profiles()
}
#[tauri::command]
pub fn winrm_save_profile(
    id: Option<i64>,
    data: ProfileData,
    password: Option<String>,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<WinrmProfile, String> {
    db.save_winrm_profile(id, data, password.map(Zeroizing::new), &crypto)
}
#[tauri::command]
pub fn winrm_delete_profile(id: i64, db: State<'_, Arc<Database>>) -> Result<(), String> {
    db.delete_winrm_profile(id)
}
#[tauri::command]
pub async fn winrm_connect(
    session_id: String,
    profile_id: Option<i64>,
    config: Config,
    password: Option<String>,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
    manager: State<'_, WinrmManager>,
) -> Result<(), String> {
    let password = password.map(Zeroizing::new);
    let (config, password) = if let Some(id) = profile_id {
        db.winrm_credentials(id, &config, password, &crypto)?
    } else {
        (
            config,
            password.ok_or("Enter a password for this Windows account")?,
        )
    };
    manager.connect(session_id, config, password).await
}
#[tauri::command]
pub async fn winrm_execute(
    session_id: String,
    script: String,
    manager: State<'_, WinrmManager>,
) -> Result<Output, String> {
    manager.run(&session_id, &script).await
}
#[tauri::command]
pub async fn winrm_cancel(
    session_id: String,
    manager: State<'_, WinrmManager>,
) -> Result<(), String> {
    manager.cancel(&session_id).await;
    Ok(())
}
#[tauri::command]
pub async fn winrm_close(
    session_id: String,
    manager: State<'_, WinrmManager>,
) -> Result<(), String> {
    manager.close(&session_id).await;
    Ok(())
}
