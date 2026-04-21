use serde::{Deserialize, Serialize};

use crate::db::Database;

#[derive(Debug, Clone, Serialize)]
pub struct Snippet {
    pub id: i64,
    pub title: String,
    pub command: String,
    pub category: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateSnippetRequest {
    pub title: String,
    pub command: String,
    pub category: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSnippetRequest {
    pub title: Option<String>,
    pub command: Option<String>,
    pub category: Option<String>,
    pub description: Option<String>,
}

impl Database {
    pub fn create_snippet(&self, req: CreateSnippetRequest) -> Result<Snippet, String> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO snippets (title, command, category, description) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                req.title,
                req.command,
                req.category.unwrap_or_default(),
                req.description,
            ],
        )
        .map_err(|e| format!("Failed to create snippet: {e}"))?;

        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_snippet(id)
    }

    pub fn get_snippet(&self, id: i64) -> Result<Snippet, String> {
        let conn = self.conn();
        conn.query_row(
            "SELECT id, title, command, category, description, created_at, updated_at
             FROM snippets WHERE id = ?1",
            [id],
            |row| {
                Ok(Snippet {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    command: row.get(2)?,
                    category: row.get(3)?,
                    description: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .map_err(|e| format!("Snippet not found: {e}"))
    }

    pub fn list_snippets(&self, query: Option<&str>) -> Result<Vec<Snippet>, String> {
        let conn = self.conn();

        let (sql, params): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = match query {
            Some(q) if !q.is_empty() => (
                "SELECT id, title, command, category, description, created_at, updated_at
                 FROM snippets
                 WHERE title LIKE ?1 OR command LIKE ?1 OR category LIKE ?1
                 ORDER BY category, title",
                vec![Box::new(format!("%{q}%"))],
            ),
            _ => (
                "SELECT id, title, command, category, description, created_at, updated_at
                 FROM snippets ORDER BY category, title",
                vec![],
            ),
        };

        let mut stmt = conn.prepare(sql).map_err(|e| format!("{e}"))?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();

        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                Ok(Snippet {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    command: row.get(2)?,
                    category: row.get(3)?,
                    description: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(|e| format!("{e}"))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("{e}"))
    }

    pub fn update_snippet(&self, id: i64, req: UpdateSnippetRequest) -> Result<Snippet, String> {
        let conn = self.conn();
        let mut sets = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref title) = req.title {
            sets.push("title = ?");
            params.push(Box::new(title.clone()));
        }
        if let Some(ref command) = req.command {
            sets.push("command = ?");
            params.push(Box::new(command.clone()));
        }
        if let Some(ref category) = req.category {
            sets.push("category = ?");
            params.push(Box::new(category.clone()));
        }
        if let Some(ref description) = req.description {
            sets.push("description = ?");
            params.push(Box::new(description.clone()));
        }

        if sets.is_empty() {
            drop(conn);
            return self.get_snippet(id);
        }

        sets.push("updated_at = datetime('now')");
        params.push(Box::new(id));

        let set_clause: String = sets
            .iter()
            .enumerate()
            .map(|(i, s)| {
                if s.contains('?') {
                    s.replace('?', &format!("?{}", i + 1))
                } else {
                    s.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(", ");

        let sql = format!(
            "UPDATE snippets SET {} WHERE id = ?{}",
            set_clause,
            params.len()
        );

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, param_refs.as_slice())
            .map_err(|e| format!("Failed to update snippet: {e}"))?;

        drop(conn);
        self.get_snippet(id)
    }

    pub fn delete_snippet(&self, id: i64) -> Result<(), String> {
        let conn = self.conn();
        let affected = conn
            .execute("DELETE FROM snippets WHERE id = ?1", [id])
            .map_err(|e| format!("Failed to delete snippet: {e}"))?;
        if affected == 0 {
            return Err("Snippet not found".into());
        }
        Ok(())
    }
}
