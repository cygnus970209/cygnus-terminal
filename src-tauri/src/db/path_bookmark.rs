use serde::{Deserialize, Serialize};

use crate::db::Database;

#[derive(Debug, Clone, Serialize)]
pub struct PathBookmark {
    pub id: i64,
    pub profile_id: i64,
    pub path: String,
    pub label: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreatePathBookmarkRequest {
    pub profile_id: i64,
    pub path: String,
    pub label: Option<String>,
}

impl Database {
    pub fn create_path_bookmark(
        &self,
        req: CreatePathBookmarkRequest,
    ) -> Result<PathBookmark, String> {
        let conn = self.conn();
        conn.execute(
            "INSERT OR IGNORE INTO path_bookmarks (profile_id, path, label) VALUES (?1, ?2, ?3)",
            rusqlite::params![req.profile_id, req.path, req.label],
        )
        .map_err(|e| format!("Failed to create path bookmark: {e}"))?;

        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_path_bookmark(id)
    }

    pub fn get_path_bookmark(&self, id: i64) -> Result<PathBookmark, String> {
        let conn = self.conn();
        conn.query_row(
            "SELECT id, profile_id, path, label, created_at
             FROM path_bookmarks WHERE id = ?1",
            [id],
            |row| {
                Ok(PathBookmark {
                    id: row.get(0)?,
                    profile_id: row.get(1)?,
                    path: row.get(2)?,
                    label: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .map_err(|e| format!("Path bookmark not found: {e}"))
    }

    pub fn list_path_bookmarks(
        &self,
        profile_id: i64,
    ) -> Result<Vec<PathBookmark>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, path, label, created_at
                 FROM path_bookmarks WHERE profile_id = ?1
                 ORDER BY created_at",
            )
            .map_err(|e| format!("Failed to prepare query: {e}"))?;

        let rows = stmt
            .query_map([profile_id], |row| {
                Ok(PathBookmark {
                    id: row.get(0)?,
                    profile_id: row.get(1)?,
                    path: row.get(2)?,
                    label: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| format!("Failed to query path bookmarks: {e}"))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read row: {e}"))
    }

    pub fn delete_path_bookmark(&self, id: i64) -> Result<(), String> {
        let conn = self.conn();
        let affected = conn
            .execute("DELETE FROM path_bookmarks WHERE id = ?1", [id])
            .map_err(|e| format!("Failed to delete path bookmark: {e}"))?;

        if affected == 0 {
            return Err("Path bookmark not found".into());
        }
        Ok(())
    }
}
