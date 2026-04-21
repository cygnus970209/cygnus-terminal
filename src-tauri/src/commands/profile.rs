use std::sync::Arc;

use crate::crypto::CryptoManager;
use crate::db::command_bookmark::{CommandBookmark, CreateCommandBookmarkRequest};
use crate::db::export::ExportData;
use crate::db::history::CommandHistoryEntry;
use crate::db::path_bookmark::{CreatePathBookmarkRequest, PathBookmark};
use crate::db::profile::{CreateProfileRequest, Profile, UpdateProfileRequest};
use crate::db::snippet::{CreateSnippetRequest, Snippet, UpdateSnippetRequest};
use crate::db::Database;
use tauri::State;

// ── Profile ──

#[tauri::command]
pub fn create_profile(
    req: CreateProfileRequest,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<Profile, String> {
    db.create_profile(req, &crypto)
}

#[tauri::command]
pub fn list_profiles(
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<Vec<Profile>, String> {
    db.list_profiles(&crypto)
}

#[tauri::command]
pub fn get_profile(
    id: i64,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<Profile, String> {
    db.get_profile(id, &crypto)
}

#[tauri::command]
pub fn update_profile(
    id: i64,
    req: UpdateProfileRequest,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<Profile, String> {
    db.update_profile(id, req, &crypto)
}

#[tauri::command]
pub fn delete_profile(id: i64, db: State<'_, Arc<Database>>) -> Result<(), String> {
    db.delete_profile(id)
}

// ── History ──

#[tauri::command]
pub fn search_command_history(
    profile_id: i64,
    query: Option<String>,
    limit: Option<u32>,
    db: State<'_, Arc<Database>>,
) -> Result<Vec<CommandHistoryEntry>, String> {
    db.search_command_history(profile_id, query.as_deref(), limit.unwrap_or(100))
}

#[tauri::command]
pub fn delete_command_history(id: i64, db: State<'_, Arc<Database>>) -> Result<(), String> {
    db.delete_command_history(id)
}

#[tauri::command]
pub fn save_command_history(
    profile_id: i64,
    command: String,
    db: State<'_, Arc<Database>>,
) -> Result<(), String> {
    db.add_command_history(profile_id, &command)
}

// ── Command Bookmarks ──

#[tauri::command]
pub fn create_command_bookmark(
    req: CreateCommandBookmarkRequest,
    db: State<'_, Arc<Database>>,
) -> Result<CommandBookmark, String> {
    db.create_command_bookmark(req)
}

#[tauri::command]
pub fn list_command_bookmarks(
    profile_id: i64,
    db: State<'_, Arc<Database>>,
) -> Result<Vec<CommandBookmark>, String> {
    db.list_command_bookmarks(profile_id)
}

#[tauri::command]
pub fn delete_command_bookmark(id: i64, db: State<'_, Arc<Database>>) -> Result<(), String> {
    db.delete_command_bookmark(id)
}

// ── Path Bookmarks ──

#[tauri::command]
pub fn create_path_bookmark(
    req: CreatePathBookmarkRequest,
    db: State<'_, Arc<Database>>,
) -> Result<PathBookmark, String> {
    db.create_path_bookmark(req)
}

#[tauri::command]
pub fn list_path_bookmarks(
    profile_id: i64,
    db: State<'_, Arc<Database>>,
) -> Result<Vec<PathBookmark>, String> {
    db.list_path_bookmarks(profile_id)
}

#[tauri::command]
pub fn delete_path_bookmark(id: i64, db: State<'_, Arc<Database>>) -> Result<(), String> {
    db.delete_path_bookmark(id)
}

// ── Snippets ──

#[tauri::command]
pub fn create_snippet(
    req: CreateSnippetRequest,
    db: State<'_, Arc<Database>>,
) -> Result<Snippet, String> {
    db.create_snippet(req)
}

#[tauri::command]
pub fn list_snippets(
    query: Option<String>,
    db: State<'_, Arc<Database>>,
) -> Result<Vec<Snippet>, String> {
    db.list_snippets(query.as_deref())
}

#[tauri::command]
pub fn update_snippet(
    id: i64,
    req: UpdateSnippetRequest,
    db: State<'_, Arc<Database>>,
) -> Result<Snippet, String> {
    db.update_snippet(id, req)
}

#[tauri::command]
pub fn delete_snippet(id: i64, db: State<'_, Arc<Database>>) -> Result<(), String> {
    db.delete_snippet(id)
}

// ── Export/Import ──

#[tauri::command]
pub fn export_data(
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<ExportData, String> {
    db.export_data(&crypto)
}

#[tauri::command]
pub fn import_data(
    data: ExportData,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<u32, String> {
    db.import_data(data, &crypto)
}

#[tauri::command]
pub fn export_to_file(
    path: String,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<(), String> {
    let data = db.export_data(&crypto)?;
    let json =
        serde_json::to_string_pretty(&data).map_err(|e| format!("Serialization failed: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write file: {e}"))
}

#[tauri::command]
pub fn import_from_file(
    path: String,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<u32, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {e}"))?;
    let data: ExportData =
        serde_json::from_str(&json).map_err(|e| format!("Invalid JSON: {e}"))?;
    db.import_data(data, &crypto)
}
