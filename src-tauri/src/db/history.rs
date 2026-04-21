use serde::Serialize;

use crate::db::Database;

#[derive(Debug, Clone, Serialize)]
pub struct CommandHistoryEntry {
    pub id: i64,
    pub profile_id: i64,
    pub command: String,
    pub executed_at: String,
}

impl Database {
    pub fn add_command_history(
        &self,
        profile_id: i64,
        command: &str,
    ) -> Result<(), String> {
        let command = command.trim();
        if command.is_empty() {
            return Ok(());
        }

        let conn = self.conn();

        // 직전 명령과 동일하면 저장하지 않음 (연속 중복 방지)
        let is_dup: bool = conn
            .query_row(
                "SELECT command = ?2 FROM command_history
                 WHERE profile_id = ?1
                 ORDER BY executed_at DESC LIMIT 1",
                rusqlite::params![profile_id, command],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if is_dup {
            return Ok(());
        }

        conn.execute(
            "INSERT INTO command_history (profile_id, command) VALUES (?1, ?2)",
            rusqlite::params![profile_id, command],
        )
        .map_err(|e| format!("Failed to save command history: {e}"))?;
        Ok(())
    }

    pub fn search_command_history(
        &self,
        profile_id: i64,
        query: Option<&str>,
        limit: u32,
    ) -> Result<Vec<CommandHistoryEntry>, String> {
        let conn = self.conn();

        let (sql, params): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = match query {
            Some(q) if !q.is_empty() => (
                "SELECT id, profile_id, command, executed_at
                 FROM command_history
                 WHERE profile_id = ?1 AND command LIKE ?2
                 ORDER BY executed_at DESC LIMIT ?3",
                vec![
                    Box::new(profile_id),
                    Box::new(format!("%{q}%")),
                    Box::new(limit),
                ],
            ),
            _ => (
                "SELECT id, profile_id, command, executed_at
                 FROM command_history
                 WHERE profile_id = ?1
                 ORDER BY executed_at DESC LIMIT ?2",
                vec![Box::new(profile_id), Box::new(limit)],
            ),
        };

        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| format!("Failed to prepare query: {e}"))?;

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();

        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                Ok(CommandHistoryEntry {
                    id: row.get(0)?,
                    profile_id: row.get(1)?,
                    command: row.get(2)?,
                    executed_at: row.get(3)?,
                })
            })
            .map_err(|e| format!("Failed to query history: {e}"))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read row: {e}"))
    }

    pub fn delete_command_history(&self, id: i64) -> Result<(), String> {
        let conn = self.conn();
        let affected = conn
            .execute("DELETE FROM command_history WHERE id = ?1", [id])
            .map_err(|e| format!("Failed to delete history entry: {e}"))?;
        if affected == 0 {
            return Err("History entry not found".into());
        }
        Ok(())
    }
}
