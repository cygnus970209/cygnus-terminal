pub mod command_bookmark;
pub mod export;
pub mod history;
pub mod known_host;
pub mod migration;
pub mod path_bookmark;
pub mod profile;
pub mod snippet;

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// 데이터베이스 초기화. app_data_dir 아래에 cygnus.db 파일 생성.
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create data directory: {e}"))?;

        let db_path = app_data_dir.join("cygnus.db");
        let conn =
            Connection::open(&db_path).map_err(|e| format!("Failed to open database: {e}"))?;

        // WAL 모드 + foreign keys 활성화
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| format!("Failed to set pragmas: {e}"))?;

        let db = Self {
            conn: Mutex::new(conn),
        };

        // 마이그레이션 실행
        db.run_migrations()?;

        Ok(db)
    }

    #[doc(hidden)]
    pub fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Failed to open in-memory database: {e}"))?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("Failed to set pragmas: {e}"))?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.run_migrations()?;
        Ok(db)
    }

    /// Avoid silently generating a different master key when encrypted data exists.
    pub fn has_encrypted_credentials(&self) -> Result<bool, String> {
        self.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM profiles WHERE length(password) > 0 OR (length(jump_host) > 0 AND substr(ltrim(jump_host), 1, 1) != '{')) OR EXISTS(SELECT 1 FROM vault_items WHERE length(encrypted_value) > 0)",
            [], |row| row.get(0),
        ).map_err(|e| format!("Cannot inspect encrypted credentials: {e}"))
    }

    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("Database mutex poisoned")
    }
}
