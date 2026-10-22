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
    Migration {
        version: 7,
        sql: "ALTER TABLE profiles ADD COLUMN protocol TEXT NOT NULL DEFAULT 'ssh' CHECK(protocol IN ('ssh', 'telnet', 'serial'));
            ALTER TABLE profiles ADD COLUMN baud_rate INTEGER CHECK(baud_rate > 0 AND baud_rate <= 4294967295);",
    },
    Migration {
        version: 8,
        sql: "CREATE TABLE execution_jobs (
            id TEXT PRIMARY KEY,
            profile_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL,
            record TEXT NOT NULL,
            summary TEXT NOT NULL
        );
        CREATE INDEX idx_execution_jobs_created ON execution_jobs(created_at DESC, id DESC);",
    },
    Migration {
        version: 9,
        sql: "CREATE TABLE execution_history_settings (
            id INTEGER PRIMARY KEY CHECK(id=1),
            enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
            retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 365)
        );
        -- Preserve an existing user's history preference on upgrade.
        INSERT INTO execution_history_settings VALUES(1, EXISTS(SELECT 1 FROM execution_jobs), 7);",
    },
    Migration {
        version: 10,
        sql: "ALTER TABLE profiles ADD COLUMN target_os TEXT NOT NULL DEFAULT 'auto'
                CHECK(target_os IN ('auto', 'linux', 'windows', 'other'));
            ALTER TABLE profiles ADD COLUMN remote_shell TEXT NOT NULL DEFAULT 'auto'
                CHECK(remote_shell IN ('auto', 'posix', 'powershell', 'pwsh', 'cmd'));",
    },
    Migration {
        version: 11,
        sql: "
            CREATE TABLE rdp_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256),
                host TEXT NOT NULL CHECK(length(host) BETWEEN 1 AND 253),
                port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
                username TEXT NOT NULL CHECK(length(username) BETWEEN 1 AND 256),
                domain TEXT NOT NULL DEFAULT '' CHECK(length(domain) <= 256),
                width INTEGER NOT NULL CHECK(width BETWEEN 640 AND 1920),
                height INTEGER NOT NULL CHECK(height BETWEEN 480 AND 1080)
            );
            CREATE TABLE rdp_certificates (
                host TEXT NOT NULL,
                port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
                fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 95),
                PRIMARY KEY(host, port)
            );
        ",
    },
    Migration {
        version: 12,
        sql: "ALTER TABLE rdp_profiles ADD COLUMN desktop_scale_factor INTEGER NOT NULL DEFAULT 0
            CHECK(desktop_scale_factor = 0 OR desktop_scale_factor BETWEEN 100 AND 500);",
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
                let tx = conn
                    .unchecked_transaction()
                    .map_err(|e| format!("Failed to start migration: {e}"))?;
                tx.execute_batch(migration.sql)
                    .map_err(|e| format!("Migration v{} failed: {e}", migration.version))?;

                tx.execute(
                    "INSERT INTO schema_version (version) VALUES (?1)",
                    [migration.version],
                )
                .map_err(|e| format!("Failed to record migration v{}: {e}", migration.version))?;
                tx.commit()
                    .map_err(|e| format!("Failed to commit migration: {e}"))?;
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rdp_dpi_upgrade_preserves_existing_profile_and_certificate() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS.iter().filter(|m| m.version <= 11) {
            conn.execute_batch(migration.sql).unwrap();
        }
        conn.execute_batch("CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES(11);
            INSERT INTO rdp_profiles VALUES(42,'desktop','host.test',3389,'user','DOMAIN',1280,720);").unwrap();
        let pin = ["AB"; 32].join(":");
        conn.execute(
            "INSERT INTO rdp_certificates VALUES('host.test',3389,?1)",
            [&pin],
        )
        .unwrap();
        let db = Database {
            conn: std::sync::Mutex::new(conn),
        };
        db.run_migrations().unwrap();
        db.run_migrations().unwrap();
        let profile = db.list_rdp_profiles().unwrap().remove(0);
        assert_eq!(profile.id, 42);
        assert_eq!(profile.config.desktop_scale_factor, 0);
        assert_eq!(profile.config.domain, "DOMAIN");
        let endpoint = super::super::rdp::Endpoint::new(&profile.config).unwrap();
        assert_eq!(db.rdp_certificate(&endpoint).unwrap(), Some(pin));
        assert!(db
            .conn()
            .execute("UPDATE rdp_profiles SET desktop_scale_factor=501", [])
            .is_err());
    }

    #[test]
    fn server_environment_upgrade_keeps_profile_identity_and_related_records() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS.iter().filter(|m| m.version <= 9) {
            conn.execute_batch(migration.sql).unwrap();
        }
        conn.execute_batch("CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES(9);
            INSERT INTO profiles(id,name,host,port,username,auth_type,password,jump_host,environment) VALUES(42,'existing','host.test',22,'user','password','encrypted-password','encrypted-jump','production');
            INSERT INTO command_history(profile_id,command) VALUES(42,'Get-Service');
            INSERT INTO path_bookmarks(profile_id,path) VALUES(42,'C:\\inetpub');
            INSERT INTO vault_items(id,label,kind,encrypted_value) VALUES(7,'test','password','encrypted-vault');
            INSERT INTO vault_server_map(vault_item_id,server_id) VALUES(7,42);").unwrap();
        let db = Database {
            conn: std::sync::Mutex::new(conn),
        };
        db.run_migrations().unwrap();
        db.run_migrations().unwrap();
        let summary = db.list_profile_summaries().unwrap().remove(0);
        assert_eq!(summary.id, 42);
        assert_eq!(summary.environment, "production");
        assert_eq!(
            (summary.target_os.as_str(), summary.remote_shell.as_str()),
            ("auto", "auto")
        );
        let conn = db.conn();
        let secrets: (String, String) = conn
            .query_row(
                "SELECT password, jump_host FROM profiles WHERE id=42",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            secrets,
            ("encrypted-password".into(), "encrypted-jump".into())
        );
        for query in [
            "SELECT count(*) FROM command_history WHERE profile_id=42",
            "SELECT count(*) FROM path_bookmarks WHERE profile_id=42",
            "SELECT count(*) FROM vault_server_map WHERE server_id=42",
        ] {
            assert_eq!(
                conn.query_row(query, [], |r| r.get::<_, u32>(0)).unwrap(),
                1
            );
        }
        assert!(conn
            .execute("UPDATE profiles SET target_os='invalid' WHERE id=42", [])
            .is_err());
        assert!(conn
            .execute("UPDATE profiles SET remote_shell='invalid' WHERE id=42", [])
            .is_err());
    }

    #[test]
    fn existing_execution_history_enables_bounded_retention_on_upgrade() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS.iter().filter(|m| m.version <= 8) {
            conn.execute_batch(migration.sql).unwrap();
        }
        conn.execute_batch("CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES(8);
            INSERT INTO execution_jobs VALUES('legacy',1,datetime('now'),'succeeded','record','summary');").unwrap();
        let db = Database {
            conn: std::sync::Mutex::new(conn),
        };
        db.run_migrations().unwrap();
        assert_eq!(
            db.execution_history_settings().unwrap(),
            crate::execution::history::HistorySettings {
                enabled: true,
                retention_days: 7
            }
        );
        assert_eq!(
            db.conn()
                .query_row("SELECT count(*) FROM execution_jobs", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            1
        );
        db.set_execution_history_settings(crate::execution::history::HistorySettings {
            enabled: false,
            retention_days: 3,
        })
        .unwrap();
        db.run_migrations().unwrap();
        assert!(!db.execution_history_settings().unwrap().enabled);
    }

    #[test]
    fn legacy_profiles_keep_identity_and_default_to_ssh() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS.iter().filter(|m| m.version <= 6) {
            conn.execute_batch(migration.sql).unwrap();
        }
        conn.execute_batch("CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES(6);
            INSERT INTO profiles(id,name,host,port,username,auth_type,password) VALUES(42,'legacy','example.test',22,'root','password','existing-encrypted-value');").unwrap();
        let db = Database {
            conn: std::sync::Mutex::new(conn),
        };
        db.run_migrations().unwrap();
        db.run_migrations().unwrap();
        let value: (i64, String, String) = db
            .conn()
            .query_row("SELECT id, protocol, password FROM profiles", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(value, (42, "ssh".into(), "existing-encrypted-value".into()));
    }
}
