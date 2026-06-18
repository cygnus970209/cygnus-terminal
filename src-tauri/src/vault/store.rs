use serde::{Deserialize, Serialize};

use crate::crypto::CryptoManager;
use crate::db::Database;

pub const KIND_PASSWORD: &str = "password";
pub const KIND_SSH_KEY: &str = "ssh-key";
pub const KIND_PASSPHRASE: &str = "passphrase";
pub const KIND_PAT_USERNAME: &str = "pat-username";
pub const KIND_PAT_PASSWORD: &str = "pat-password";

pub const SOURCE_CYGNUS: &str = "cygnus";
pub const SOURCE_OP: &str = "op";
pub const SOURCE_BW: &str = "bw";

const VALID_KINDS: [&str; 5] = [
    KIND_PASSWORD,
    KIND_SSH_KEY,
    KIND_PASSPHRASE,
    KIND_PAT_USERNAME,
    KIND_PAT_PASSWORD,
];
const VALID_SOURCES: [&str; 3] = [SOURCE_CYGNUS, SOURCE_OP, SOURCE_BW];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultItem {
    pub id: i64,
    pub label: String,
    pub kind: String,
    pub pair_id: Option<String>,
    pub source: String,
    pub source_ref: Option<String>,
    /// `true` if this item has an encrypted_value stored locally. The plaintext
    /// is never returned by list/get — only on explicit reveal/inject paths.
    pub has_value: bool,
    pub sensitive: bool,
    pub scope: Option<String>,
    pub server_ids: Vec<i64>,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateVaultItemRequest {
    pub label: String,
    pub kind: String,
    pub pair_id: Option<String>,
    /// Defaults to `cygnus` when omitted.
    pub source: Option<String>,
    pub source_ref: Option<String>,
    /// Plaintext, only for `cygnus` source. Encrypted with the master key on insert.
    pub value: Option<String>,
    pub sensitive: Option<bool>,
    pub scope: Option<String>,
    /// profiles.id list to immediately link this item to.
    pub server_ids: Option<Vec<i64>>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateVaultItemRequest {
    pub label: Option<String>,
    pub kind: Option<String>,
    pub pair_id: Option<String>,
    pub source: Option<String>,
    pub source_ref: Option<String>,
    /// New plaintext value; ignored unless source resolves to `cygnus`.
    /// Empty string clears the stored value.
    pub value: Option<String>,
    pub sensitive: Option<bool>,
    pub scope: Option<String>,
}

fn validate_kind(kind: &str) -> Result<(), String> {
    if VALID_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!("Invalid vault item kind: {kind}"))
    }
}

fn validate_source(source: &str) -> Result<(), String> {
    if VALID_SOURCES.contains(&source) {
        Ok(())
    } else {
        Err(format!("Invalid vault item source: {source}"))
    }
}

impl Database {
    pub fn create_vault_item(
        &self,
        req: CreateVaultItemRequest,
        crypto: &CryptoManager,
    ) -> Result<VaultItem, String> {
        validate_kind(&req.kind)?;
        let source = req
            .source
            .clone()
            .unwrap_or_else(|| SOURCE_CYGNUS.to_string());
        validate_source(&source)?;

        let encrypted_value = if source == SOURCE_CYGNUS {
            match req.value.as_deref() {
                Some(v) if !v.is_empty() => Some(crypto.encrypt(v)?),
                _ => None,
            }
        } else {
            None
        };

        let server_ids = req.server_ids.clone().unwrap_or_default();

        let conn = self.conn();
        conn.execute(
            "INSERT INTO vault_items (label, kind, pair_id, source, source_ref, encrypted_value, sensitive, scope)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                req.label,
                req.kind,
                req.pair_id,
                source,
                req.source_ref,
                encrypted_value,
                req.sensitive.unwrap_or(false),
                req.scope,
            ],
        )
        .map_err(|e| format!("Failed to create vault item: {e}"))?;

        let id = conn.last_insert_rowid();

        for server_id in &server_ids {
            conn.execute(
                "INSERT OR IGNORE INTO vault_server_map (vault_item_id, server_id) VALUES (?1, ?2)",
                rusqlite::params![id, server_id],
            )
            .map_err(|e| format!("Failed to link vault item to server {server_id}: {e}"))?;
        }
        drop(conn);

        self.get_vault_item(id)
    }

    pub fn get_vault_item(&self, id: i64) -> Result<VaultItem, String> {
        let conn = self.conn();
        let row = conn
            .query_row(
                "SELECT id, label, kind, pair_id, source, source_ref, encrypted_value, sensitive, scope, created_at, last_used_at
                 FROM vault_items WHERE id = ?1",
                [id],
                row_to_vault_item_row,
            )
            .map_err(|e| format!("Vault item not found: {e}"))?;

        let server_ids = self.list_vault_servers(id, &conn)?;
        Ok(row.into_vault_item(server_ids))
    }

    pub fn list_vault_items(&self) -> Result<Vec<VaultItem>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, label, kind, pair_id, source, source_ref, encrypted_value, sensitive, scope, created_at, last_used_at
                 FROM vault_items
                 ORDER BY (last_used_at IS NULL), last_used_at DESC, id DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {e}"))?;

        let rows = stmt
            .query_map([], row_to_vault_item_row)
            .map_err(|e| format!("Failed to query vault items: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read row: {e}"))?;

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let server_ids = self.list_vault_servers(row.id, &conn)?;
            out.push(row.into_vault_item(server_ids));
        }
        Ok(out)
    }

    pub fn update_vault_item(
        &self,
        id: i64,
        req: UpdateVaultItemRequest,
        crypto: &CryptoManager,
    ) -> Result<VaultItem, String> {
        // 기존 항목의 effective source를 결정하기 위해 한 번 읽음
        let existing = self.get_vault_item(id)?;
        let effective_source = req
            .source
            .clone()
            .unwrap_or_else(|| existing.source.clone());
        if let Some(ref s) = req.source {
            validate_source(s)?;
        }
        if let Some(ref kind) = req.kind {
            validate_kind(kind)?;
        }

        let conn = self.conn();
        let mut sets = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref label) = req.label {
            sets.push("label = ?");
            params.push(Box::new(label.clone()));
        }
        if let Some(ref kind) = req.kind {
            sets.push("kind = ?");
            params.push(Box::new(kind.clone()));
        }
        if let Some(ref pair_id) = req.pair_id {
            sets.push("pair_id = ?");
            params.push(Box::new(pair_id.clone()));
        }
        if let Some(ref source) = req.source {
            sets.push("source = ?");
            params.push(Box::new(source.clone()));
        }
        if let Some(ref source_ref) = req.source_ref {
            sets.push("source_ref = ?");
            params.push(Box::new(source_ref.clone()));
        }
        if let Some(ref value) = req.value {
            // 외부 source 항목에 평문이 들어오는 건 거부
            if effective_source != SOURCE_CYGNUS && !value.is_empty() {
                return Err(format!(
                    "Cannot store plaintext on external source '{effective_source}'"
                ));
            }
            sets.push("encrypted_value = ?");
            if value.is_empty() {
                params.push(Box::new(None::<String>));
            } else {
                params.push(Box::new(crypto.encrypt(value)?));
            }
        }
        if let Some(sensitive) = req.sensitive {
            sets.push("sensitive = ?");
            params.push(Box::new(sensitive));
        }
        if let Some(ref scope) = req.scope {
            sets.push("scope = ?");
            params.push(Box::new(scope.clone()));
        }

        if sets.is_empty() {
            drop(conn);
            return self.get_vault_item(id);
        }

        params.push(Box::new(id));
        let set_clause: String = sets
            .iter()
            .enumerate()
            .map(|(i, s)| s.replace('?', &format!("?{}", i + 1)))
            .collect::<Vec<_>>()
            .join(", ");

        let sql = format!(
            "UPDATE vault_items SET {} WHERE id = ?{}",
            set_clause,
            params.len()
        );

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, param_refs.as_slice())
            .map_err(|e| format!("Failed to update vault item: {e}"))?;

        drop(conn);
        self.get_vault_item(id)
    }

    pub fn delete_vault_item(&self, id: i64) -> Result<(), String> {
        let conn = self.conn();
        let affected = conn
            .execute("DELETE FROM vault_items WHERE id = ?1", [id])
            .map_err(|e| format!("Failed to delete vault item: {e}"))?;
        if affected == 0 {
            return Err("Vault item not found".into());
        }
        Ok(())
    }

    pub fn link_vault_servers(
        &self,
        vault_item_id: i64,
        server_ids: Vec<i64>,
    ) -> Result<VaultItem, String> {
        let conn = self.conn();
        // 기존 매핑 비우고 다시 채움 (idempotent)
        conn.execute(
            "DELETE FROM vault_server_map WHERE vault_item_id = ?1",
            [vault_item_id],
        )
        .map_err(|e| format!("Failed to clear vault server map: {e}"))?;

        for sid in &server_ids {
            conn.execute(
                "INSERT OR IGNORE INTO vault_server_map (vault_item_id, server_id) VALUES (?1, ?2)",
                rusqlite::params![vault_item_id, sid],
            )
            .map_err(|e| format!("Failed to link vault item: {e}"))?;
        }
        drop(conn);

        self.get_vault_item(vault_item_id)
    }

    /// 항목의 평문 secret을 복호화해 반환하고 `last_used_at`을 갱신한다.
    /// reveal/inject 경로 전용 — list/get은 절대 평문을 반환하지 않는다.
    /// 로컬 암호화 저장(`cygnus` source)만 지원하며, 값이 없거나 외부 소스면 에러.
    pub fn reveal_vault_secret(
        &self,
        id: i64,
        crypto: &CryptoManager,
    ) -> Result<String, String> {
        let conn = self.conn();
        let (source, encrypted) = conn
            .query_row(
                "SELECT source, encrypted_value FROM vault_items WHERE id = ?1",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .map_err(|e| format!("Vault item not found: {e}"))?;

        if source != SOURCE_CYGNUS {
            return Err(format!(
                "Cannot reveal secret for external source '{source}'"
            ));
        }
        let encrypted = encrypted
            .filter(|s| !s.is_empty())
            .ok_or("Vault item has no stored value")?;
        let secret = crypto.decrypt(&encrypted)?;

        conn.execute(
            "UPDATE vault_items SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?1",
            [id],
        )
        .map_err(|e| format!("Failed to update last_used_at: {e}"))?;

        Ok(secret)
    }

    fn list_vault_servers(
        &self,
        vault_item_id: i64,
        conn: &std::sync::MutexGuard<'_, rusqlite::Connection>,
    ) -> Result<Vec<i64>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT server_id FROM vault_server_map WHERE vault_item_id = ?1 ORDER BY server_id",
            )
            .map_err(|e| format!("Failed to prepare server map query: {e}"))?;
        let rows = stmt
            .query_map([vault_item_id], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("Failed to query vault server map: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read row: {e}"))?;
        Ok(rows)
    }
}

struct VaultItemRow {
    id: i64,
    label: String,
    kind: String,
    pair_id: Option<String>,
    source: String,
    source_ref: Option<String>,
    encrypted_value: Option<String>,
    sensitive: bool,
    scope: Option<String>,
    created_at: String,
    last_used_at: Option<String>,
}

impl VaultItemRow {
    fn into_vault_item(self, server_ids: Vec<i64>) -> VaultItem {
        VaultItem {
            id: self.id,
            label: self.label,
            kind: self.kind,
            pair_id: self.pair_id,
            source: self.source,
            source_ref: self.source_ref,
            has_value: self
                .encrypted_value
                .as_ref()
                .map(|s| !s.is_empty())
                .unwrap_or(false),
            sensitive: self.sensitive,
            scope: self.scope,
            server_ids,
            created_at: self.created_at,
            last_used_at: self.last_used_at,
        }
    }
}

fn row_to_vault_item_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<VaultItemRow> {
    Ok(VaultItemRow {
        id: row.get(0)?,
        label: row.get(1)?,
        kind: row.get(2)?,
        pair_id: row.get(3)?,
        source: row.get(4)?,
        source_ref: row.get(5)?,
        encrypted_value: row.get(6)?,
        sensitive: row.get(7)?,
        scope: row.get(8)?,
        created_at: row.get(9)?,
        last_used_at: row.get(10)?,
    })
}
