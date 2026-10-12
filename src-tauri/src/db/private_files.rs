//! Unix permissions are set before SQLite can create a journal. On Windows,
//! files inherit the per-user application-data directory's ACL.
use std::path::Path;

pub(super) fn prepare(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)
            .map_err(|e| format!("Cannot create private data directory: {e}"))?;
        let metadata = std::fs::symlink_metadata(directory).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Application data directory must be a real directory".into());
        }
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Cannot protect data directory: {e}"))?;
        for name in [
            "cygnus.db",
            "cygnus.db-wal",
            "cygnus.db-shm",
            "cygnus.db-journal",
        ] {
            let path = directory.join(name);
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    if !metadata.is_file() || metadata.file_type().is_symlink() {
                        return Err(format!("Database path must be a regular file: {name}"));
                    }
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                        .map_err(|e| format!("Cannot protect {name}: {e}"))?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if name == "cygnus.db" {
                        std::fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .mode(0o600)
                            .open(&path)
                            .map_err(|e| format!("Cannot create private database: {e}"))?;
                    }
                }
                Err(e) => return Err(format!("Cannot inspect {name}: {e}")),
            }
        }
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(directory).map_err(|e| format!("Cannot create data directory: {e}"))?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn database_and_live_sidecars_are_private_on_create_and_reopen() {
        let directory =
            std::env::temp_dir().join(format!("cygnus-private-{}", uuid::Uuid::new_v4()));
        let db = Database::new(directory.clone()).unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&directory), 0o700);
        for name in ["cygnus.db", "cygnus.db-wal", "cygnus.db-shm"] {
            assert_eq!(mode(&directory.join(name)), 0o600, "{name}");
        }
        drop(db);
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(
            directory.join("cygnus.db"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        for name in ["cygnus.db-wal", "cygnus.db-shm", "cygnus.db-journal"] {
            std::fs::write(directory.join(name), []).unwrap();
            std::fs::set_permissions(directory.join(name), std::fs::Permissions::from_mode(0o644))
                .unwrap();
        }
        prepare(&directory).unwrap();
        assert_eq!(mode(&directory), 0o700);
        for name in [
            "cygnus.db",
            "cygnus.db-wal",
            "cygnus.db-shm",
            "cygnus.db-journal",
        ] {
            assert_eq!(mode(&directory.join(name)), 0o600, "{name}");
        }
        let db = Database::new(directory.clone()).unwrap();
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn database_symlinks_are_rejected_without_changing_their_target() {
        let directory = std::env::temp_dir().join(format!("cygnus-link-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let target = directory.join("untouched");
        std::fs::write(&target, b"not a database").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        symlink(&target, directory.join("cygnus.db")).unwrap();
        assert!(Database::new(directory.clone()).is_err());
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"not a database");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
