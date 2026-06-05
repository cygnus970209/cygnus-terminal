use std::sync::Arc;

use crate::crypto::CryptoManager;
use crate::db::Database;
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
