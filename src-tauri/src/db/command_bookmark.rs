use serde::{Deserialize, Serialize};

use crate::db::Database;

#[derive(Debug, Clone, Serialize)]
pub struct CommandBookmark {
    pub id: i64,
    pub profile_id: i64,
    pub command: String,
    pub label: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateCommandBookmarkRequest {
    pub profile_id: i64,
    pub command: String,
    pub label: Option<String>,
}

impl Database {
    pub fn create_command_bookmark(
        &self,
        req: CreateCommandBookmarkRequest,
    ) -> Result<CommandBookmark, String> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO command_bookmarks (profile_id, command, label) VALUES (?1, ?2, ?3)",
            rusqlite::params![req.profile_id, req.command, req.label],
        )
        .map_err(|e| format!("Failed to create command bookmark: {e}"))?;

        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_command_bookmark(id)
    }

    pub fn get_command_bookmark(&self, id: i64) -> Result<CommandBookmark, String> {
        let conn = self.conn();
        conn.query_row(
            "SELECT id, profile_id, command, label, sort_order, created_at
             FROM command_bookmarks WHERE id = ?1",
            [id],
            |row| {
                Ok(CommandBookmark {
                    id: row.get(0)?,
                    profile_id: row.get(1)?,
                    command: row.get(2)?,
                    label: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )
        .map_err(|e| format!("Command bookmark not found: {e}"))
    }

    pub fn list_command_bookmarks(
        &self,
        profile_id: i64,
    ) -> Result<Vec<CommandBookmark>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, command, label, sort_order, created_at
                 FROM command_bookmarks WHERE profile_id = ?1
                 ORDER BY sort_order, created_at",
            )
            .map_err(|e| format!("Failed to prepare query: {e}"))?;

        let rows = stmt
            .query_map([profile_id], |row| {
                Ok(CommandBookmark {
                    id: row.get(0)?,
                    profile_id: row.get(1)?,
                    command: row.get(2)?,
                    label: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| format!("Failed to query bookmarks: {e}"))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read row: {e}"))
    }

    pub fn delete_command_bookmark(&self, id: i64) -> Result<(), String> {
        let conn = self.conn();
        let affected = conn
            .execute("DELETE FROM command_bookmarks WHERE id = ?1", [id])
            .map_err(|e| format!("Failed to delete command bookmark: {e}"))?;

        if affected == 0 {
            return Err("Command bookmark not found".into());
        }
        Ok(())
    }
}
