use crate::db::Database;

struct Migration {
    version: u32,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: "
            -- 서버 프로필
            CREATE TABLE profiles (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                host        TEXT NOT NULL,
                port        INTEGER NOT NULL DEFAULT 22,
                username    TEXT NOT NULL,
                auth_type   TEXT NOT NULL CHECK(auth_type IN ('password', 'key')),
                password    BLOB,
                key_path    TEXT,
                group_name  TEXT DEFAULT '',
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- 커맨드 히스토리 (서버별 분리)
            CREATE TABLE command_history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id  INTEGER NOT NULL,
                command     TEXT NOT NULL,
                executed_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
            );

            -- 경로 북마크 (서버별 분리)
            CREATE TABLE path_bookmarks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id  INTEGER NOT NULL,
                path        TEXT NOT NULL,
                label       TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
                UNIQUE(profile_id, path)
            );

            -- Known Hosts
            CREATE TABLE known_hosts (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                host            TEXT NOT NULL,
                port            INTEGER NOT NULL DEFAULT 22,
                key_type        TEXT NOT NULL,
                host_key        BLOB NOT NULL,
                first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(host, port)
            );

            -- 인덱스
            CREATE INDEX idx_command_history_profile ON command_history(profile_id, executed_at DESC);
            CREATE INDEX idx_path_bookmarks_profile ON path_bookmarks(profile_id);
        ",
    },
];

impl Database {
    pub(crate) fn run_migrations(&self) -> Result<(), String> {
        let conn = self.conn();

        // schema_version 테이블 생성 (없으면)
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY
            );",
        )
        .map_err(|e| format!("Failed to create schema_version table: {e}"))?;

        let current_version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to get schema version: {e}"))?;

        for migration in MIGRATIONS {
            if migration.version > current_version {
                conn.execute_batch(migration.sql)
                    .map_err(|e| format!("Migration v{} failed: {e}", migration.version))?;

                conn.execute(
                    "INSERT INTO schema_version (version) VALUES (?1)",
                    [migration.version],
                )
                .map_err(|e| format!("Failed to record migration v{}: {e}", migration.version))?;
            }
        }

        Ok(())
    }
}
