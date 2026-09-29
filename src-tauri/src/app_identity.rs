//! Compatibility with installations published under the former bundle identifier.
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

pub const APP_ID: &str = "io.github.cygnus970209.cygnus-terminal";
pub const LEGACY_APP_ID: &str = "com.intocns.cygnus-terminal";

/// Snapshot the old database only when the new installation has no database.
/// SQLite's backup API includes committed WAL data. Never move/delete the original
/// or replace an existing destination, including when two processes start together.
pub fn migrate_database(new_directory: &Path) -> Result<bool, String> {
    if new_directory.file_name().and_then(|n| n.to_str()) != Some(APP_ID) {
        return Err("Unexpected application data directory".into());
    }
    let parent = new_directory
        .parent()
        .ok_or("Application data directory has no parent")?;
    let destination = new_directory.join("cygnus.db");
    if destination
        .try_exists()
        .map_err(|e| format!("Cannot inspect application data: {e}"))?
    {
        return Ok(false);
    }
    let source = parent.join(LEGACY_APP_ID).join("cygnus.db");
    if !source
        .try_exists()
        .map_err(|e| format!("Cannot inspect legacy data: {e}"))?
    {
        return Ok(false);
    }
    std::fs::create_dir_all(new_directory)
        .map_err(|e| format!("Cannot create application data directory: {e}"))?;
    let temporary = new_directory.join(format!(".migration-{}.db", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&temporary)
            .map_err(|e| format!("Cannot stage legacy database: {e}"))?;
        let source = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Cannot read legacy database: {e}"))?;
        source
            .backup(rusqlite::MAIN_DB, &temporary, None)
            .map_err(|e| format!("Cannot migrate legacy database: {e}"))?;
        let snapshot = Connection::open(&temporary).map_err(|e| e.to_string())?;
        snapshot
            .execute_batch("PRAGMA journal_mode=DELETE;")
            .map_err(|e| e.to_string())?;
        let check: String = snapshot
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if check != "ok" {
            return Err("Legacy database integrity check failed".into());
        }
        snapshot.close().map_err(|(_, e)| e.to_string())?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&temporary)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        match std::fs::hard_link(&temporary, &destination) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(format!(
                "Cannot publish migrated database; original data is unchanged: {e}"
            )),
        }
    })();
    let _ = std::fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{crypto::CryptoManager, db::Database};
    struct Sandbox(std::path::PathBuf);
    impl Sandbox {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("cygnus-identity-{}", uuid::Uuid::new_v4())))
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn configuration_and_windows_upgrade_identity_are_consistent() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APP_ID);
        assert_eq!(
            config["bundle"]["windows"]["wix"]["upgradeCode"],
            "3932911e-9221-53e9-b993-8ea8b956da4f"
        );
    }
    #[test]
    fn snapshot_preserves_wal_profiles_vault_and_bookmarks_without_touching_source() {
        let sandbox = Sandbox::new();
        let old_dir = sandbox.0.join(LEGACY_APP_ID);
        let new_dir = sandbox.0.join(APP_ID);
        let old = Database::new(old_dir.clone()).unwrap();
        old.conn()
            .execute_batch("PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        let crypto = CryptoManager::new_random();
        assert!(!old.has_encrypted_credentials().unwrap());
        let profile = old.create_profile(serde_json::from_value(serde_json::json!({
            "name":"Production", "host":"example.org", "port":22, "username":"deploy", "auth_type":"password", "password":"stored-secret"
        })).unwrap(), &crypto).unwrap();
        let vault = old.create_vault_item(serde_json::from_value(serde_json::json!({
            "label":"Sudo", "kind":"password", "value":"vault-secret", "server_ids":[profile.id]
        })).unwrap(), &crypto).unwrap();
        old.conn()
            .execute(
                "INSERT INTO command_bookmarks(profile_id, command) VALUES (?1, 'uptime')",
                [profile.id],
            )
            .unwrap();
        assert!(old.has_encrypted_credentials().unwrap());
        assert!(old_dir.join("cygnus.db-wal").exists());
        assert!(migrate_database(&new_dir).unwrap());
        let new = Database::new(new_dir.clone()).unwrap();
        assert!(new.has_encrypted_credentials().unwrap());
        assert_eq!(
            new.get_profile(profile.id, &crypto)
                .unwrap()
                .password
                .as_deref(),
            Some("stored-secret")
        );
        assert_eq!(
            new.reveal_vault_secret(vault.id, &crypto).unwrap(),
            "vault-secret"
        );
        assert_eq!(
            new.get_vault_item(vault.id).unwrap().server_ids,
            vec![profile.id]
        );
        assert_eq!(new.list_command_bookmarks(profile.id).unwrap().len(), 1);
        new.conn()
            .execute(
                "UPDATE profiles SET name='Edited' WHERE id=?1",
                [profile.id],
            )
            .unwrap();
        assert!(!migrate_database(&new_dir).unwrap());
        assert_eq!(new.get_profile(profile.id, &crypto).unwrap().name, "Edited");
        assert_eq!(
            old.get_profile(profile.id, &crypto).unwrap().name,
            "Production"
        );
    }
    #[test]
    fn fresh_install_and_corrupt_source_do_not_create_empty_replacement() {
        let sandbox = Sandbox::new();
        let target = sandbox.0.join(APP_ID);
        assert!(!migrate_database(&target).unwrap());
        let legacy = sandbox.0.join(LEGACY_APP_ID);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("cygnus.db"), "not a database").unwrap();
        assert!(migrate_database(&target).is_err());
        assert!(!target.join("cygnus.db").exists());
    }
}
