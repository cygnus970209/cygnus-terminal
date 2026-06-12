use crate::db::Database;

struct Migration {
    version: u32,
    sql: &'static str,
}

/// 마이그레이션 목록 기준 최신 스키마 버전.
pub fn latest_version() -> u32 {
    MIGRATIONS.last().map(|m| m.version).unwrap_or(0)
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
    Migration {
        version: 2,
        sql: "
            -- 커맨드 북마크 (서버별)
            CREATE TABLE command_bookmarks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id  INTEGER NOT NULL,
                command     TEXT NOT NULL,
                label       TEXT,
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
            );

            CREATE INDEX idx_command_bookmarks_profile ON command_bookmarks(profile_id, sort_order);
        ",
    },
    Migration {
        version: 3,
        sql: "
            -- Jump Host 설정 (JSON으로 저장)
            ALTER TABLE profiles ADD COLUMN jump_host TEXT;
        ",
    },
    Migration {
        version: 4,
        sql: "
            -- 글로벌 스니펫 라이브러리
            CREATE TABLE snippets (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT NOT NULL,
                command     TEXT NOT NULL,
                category    TEXT NOT NULL DEFAULT '',
                description TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX idx_snippets_category ON snippets(category, title);
        ",
    },
    Migration {
        version: 5,
        sql: "
            ALTER TABLE profiles ADD COLUMN agent_forward INTEGER NOT NULL DEFAULT 0;
        ",
    },
    Migration {
        version: 6,
        sql: "
            -- 서버 환경 분류 (sensitive gate 계산용)
            ALTER TABLE profiles
                ADD COLUMN environment TEXT NOT NULL DEFAULT 'development'
                    CHECK (environment IN ('development', 'staging', 'production'));

            -- Vault 자격증명 항목
            CREATE TABLE vault_items (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                label           TEXT NOT NULL,
                kind            TEXT NOT NULL CHECK (kind IN
                    ('password', 'ssh-key', 'passphrase', 'pat-username', 'pat-password')),
                pair_id         TEXT,
                source          TEXT NOT NULL DEFAULT 'cygnus' CHECK (source IN ('cygnus', 'op', 'bw')),
                source_ref      TEXT,
                encrypted_value BLOB,
                sensitive       INTEGER NOT NULL DEFAULT 0,
                scope           TEXT,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                last_used_at    TEXT
            );

            -- Vault item ↔ Profile(server) 매핑
            CREATE TABLE vault_server_map (
                vault_item_id INTEGER NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
                server_id     INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                PRIMARY KEY (vault_item_id, server_id)
            );

            CREATE INDEX idx_vault_items_kind_recent
                ON vault_items(kind, last_used_at DESC);
            CREATE INDEX idx_vault_server_map_server
                ON vault_server_map(server_id);
            CREATE INDEX idx_vault_items_pair
                ON vault_items(pair_id) WHERE pair_id IS NOT NULL;
        ",
    },
];

impl Database {
    pub fn run_migrations(&self) -> Result<(), String> {
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
