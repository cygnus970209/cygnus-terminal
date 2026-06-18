use std::sync::Arc;

use crate::crypto::CryptoManager;
use crate::db::Database;
use crate::ssh::SshManager;
use crate::vault::store::{CreateVaultItemRequest, UpdateVaultItemRequest, VaultItem};
use tauri::State;

#[tauri::command]
pub fn vault_create(
    req: CreateVaultItemRequest,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<VaultItem, String> {
    db.create_vault_item(req, &crypto)
}

#[tauri::command]
pub fn vault_list(db: State<'_, Arc<Database>>) -> Result<Vec<VaultItem>, String> {
    db.list_vault_items()
}

#[tauri::command]
pub fn vault_get(id: i64, db: State<'_, Arc<Database>>) -> Result<VaultItem, String> {
    db.get_vault_item(id)
}

#[tauri::command]
pub fn vault_update(
    id: i64,
    req: UpdateVaultItemRequest,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<VaultItem, String> {
    db.update_vault_item(id, req, &crypto)
}

#[tauri::command]
pub fn vault_delete(id: i64, db: State<'_, Arc<Database>>) -> Result<(), String> {
    db.delete_vault_item(id)
}

#[tauri::command]
pub fn vault_link_server(
    vault_item_id: i64,
    server_ids: Vec<i64>,
    db: State<'_, Arc<Database>>,
) -> Result<VaultItem, String> {
    db.link_vault_servers(vault_item_id, server_ids)
}

/// 볼트 항목을 복호화해 열린 SSH 세션의 채널 stdin에 주입한다.
/// 평문은 백엔드를 벗어나지 않는다 — 복호화→주입이 한 호출 안에서 끝나
/// 프론트엔드 메모리에 비밀번호가 노출되지 않는다.
/// `append_newline`이 true(기본)면 `\r`를 붙여 프롬프트를 바로 제출한다.
#[tauri::command]
pub async fn vault_inject(
    session_id: String,
    vault_item_id: i64,
    append_newline: Option<bool>,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
    ssh_manager: State<'_, SshManager>,
) -> Result<(), String> {
    // 동기 복호화 — conn 락은 이 호출이 끝나며 해제되고, 평문만 들고 나온다.
    let secret = db.reveal_vault_secret(vault_item_id, &crypto)?;
    let payload = if append_newline.unwrap_or(true) {
        format!("{secret}\r")
    } else {
        secret
    };
    ssh_manager
        .write_to_session(&session_id, payload.as_bytes())
        .await
}
