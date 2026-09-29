use crate::{
    crypto::CryptoManager,
    db::{export::ExportData, Database},
    migration::{iterm_profiles, termius, Candidate, SshConfig},
};
use serde::{Deserialize, Serialize};
use std::{
    hash::{Hash, Hasher},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::State;

const MAX_BYTES: u64 = 4 * 1024 * 1024;
#[derive(Serialize)]
pub struct Source {
    kind: String,
    path: String,
    name: String,
}
#[derive(Serialize)]
pub struct Preview {
    groups: Vec<String>,
    candidates: Vec<Candidate>,
    fingerprint: String,
}
#[derive(Deserialize)]
pub struct MigrationSelection {
    kind: String,
    path: String,
    fingerprint: String,
    indices: Vec<usize>,
    #[serde(default)]
    group_overrides: std::collections::BTreeMap<usize, String>,
}

#[tauri::command]
pub fn detect_migration_sources() -> Vec<Source> {
    let Some(home) = dirs::home_dir() else {
        return vec![];
    };
    let mut paths = vec![("ssh", home.join(".ssh/config"), "SSH config".to_string())];
    for path in termius::sources(&home) {
        paths.push(("termius", path, "Termius local connections".into()));
    }
    if cfg!(target_os = "macos") {
        paths.push((
            "iterm",
            home.join("Library/Preferences/com.googlecode.iterm2.plist"),
            "iTerm2 profiles".into(),
        ));
        if let Ok(entries) =
            std::fs::read_dir(home.join("Library/Application Support/iTerm2/DynamicProfiles"))
        {
            let mut files: Vec<_> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect();
            files.sort();
            for path in files.into_iter().take(100) {
                let name = format!(
                    "iTerm2 · {}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                );
                paths.push(("iterm", path, name));
            }
        }
    }
    paths
        .into_iter()
        .filter(|(kind, p, _)| {
            if *kind == "termius" {
                p.is_dir()
            } else {
                p.is_file()
            }
        })
        .map(|(kind, path, name)| Source {
            kind: kind.into(),
            path: path.to_string_lossy().into(),
            name,
        })
        .collect()
}
fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open configuration: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err("Choose a configuration file smaller than 4 MB".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Configuration exceeds 4 MB".into());
    }
    Ok(bytes)
}
fn parse_source(kind: &str, path: &Path) -> Result<Vec<Candidate>, String> {
    if kind == "termius" {
        return termius::read_profiles(path);
    }
    let bytes = read_file(path)?;
    let mut candidates = match kind {
        "ssh" => {
            let config = SshConfig::parse(
                std::str::from_utf8(&bytes).map_err(|_| "SSH config must be UTF-8")?,
            );
            let rows = config.profiles();
            if rows.is_empty() && !config.diagnostics().is_empty() {
                return Err(config.diagnostics().join("; "));
            }
            rows
        }
        "iterm" => {
            let value: serde_json::Value = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(_) => {
                    let plist = plist::Value::from_reader(std::io::Cursor::new(bytes))
                        .map_err(|_| "Invalid iTerm2 JSON or plist")?;
                    serde_json::to_value(plist).map_err(|_| "Cannot convert iTerm2 plist")?
                }
            };
            let config = dirs::home_dir().map(|p| p.join(".ssh/config"));
            let ssh = match config.filter(|p| p.exists()) {
                Some(path) => SshConfig::parse(
                    &String::from_utf8(read_file(&path)?)
                        .map_err(|_| "SSH config must be UTF-8")?,
                ),
                None => SshConfig::default(),
            };
            iterm_profiles(value, &ssh)?
        }
        _ => return Err("Unsupported migration source".into()),
    };
    if candidates.len() > 5000 {
        return Err("Import at most 5,000 profiles at a time".into());
    }
    for c in &mut candidates {
        if let Some(key) = &c.profile.key_path {
            let expanded: PathBuf = shellexpand::tilde(key).as_ref().into();
            if !expanded.is_absolute() {
                c.warnings.push(
                    "Relative SSH key path — choose a key in Edit connection before connecting"
                        .into(),
                );
            } else if !expanded.is_file() {
                c.warnings
                    .push("SSH key file not found — choose a key before connecting".into());
            }
        }
    }
    Ok(candidates)
}
#[cfg(test)]
fn preview(
    kind: &str,
    path: &Path,
    db: &Database,
    crypto: &CryptoManager,
) -> Result<Preview, String> {
    build_preview(parse_source(kind, path)?, db, crypto)
}
fn build_preview(
    mut candidates: Vec<Candidate>,
    db: &Database,
    crypto: &CryptoManager,
) -> Result<Preview, String> {
    let existing = db.export_data(crypto)?;
    let groups: std::collections::BTreeSet<_> = existing
        .profiles
        .iter()
        .chain(candidates.iter().map(|c| &c.profile))
        .map(|p| p.group_name.clone())
        .filter(|g| !g.trim().is_empty())
        .collect();
    let mut seen: std::collections::HashSet<_> = existing
        .profiles
        .iter()
        .filter(|p| p.protocol == "ssh")
        .map(|p| (p.host.clone(), p.port, p.username.clone()))
        .collect();
    for c in &mut candidates {
        // A blocked row must not hide a later usable profile for the same endpoint.
        if !c.blocked {
            c.duplicate = !seen.insert((
                c.profile.host.clone(),
                c.profile.port,
                c.profile.username.clone(),
            ));
        }
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_vec(&candidates)
        .map_err(|e| e.to_string())?
        .hash(&mut hasher);
    Ok(Preview {
        groups: groups.into_iter().collect(),
        candidates,
        fingerprint: format!("{:x}", hasher.finish()),
    })
}
#[tauri::command]
pub async fn preview_migration(
    kind: String,
    path: String,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<Preview, String> {
    let candidates =
        tauri::async_runtime::spawn_blocking(move || parse_source(&kind, Path::new(&path)))
            .await
            .map_err(|_| "Connection preview could not finish")??;
    build_preview(candidates, &db, &crypto)
}
#[tauri::command]
pub async fn import_migration(
    selection: MigrationSelection,
    db: State<'_, Arc<Database>>,
    crypto: State<'_, CryptoManager>,
) -> Result<u32, String> {
    let kind = selection.kind.clone();
    let path = selection.path.clone();
    let candidates =
        tauri::async_runtime::spawn_blocking(move || parse_source(&kind, Path::new(&path)))
            .await
            .map_err(|_| "Connection import could not finish")??;
    let preview = build_preview(candidates, &db, &crypto)?;
    save_preview(selection, preview, &db, &crypto)
}
#[cfg(test)]
fn save_selection(
    selection: MigrationSelection,
    db: &Database,
    crypto: &CryptoManager,
) -> Result<u32, String> {
    let preview = preview(&selection.kind, Path::new(&selection.path), db, crypto)?;
    save_preview(selection, preview, db, crypto)
}
fn save_preview(
    selection: MigrationSelection,
    preview: Preview,
    db: &Database,
    crypto: &CryptoManager,
) -> Result<u32, String> {
    if preview.fingerprint != selection.fingerprint {
        return Err("Source or saved connections changed. Preview again before importing.".into());
    }
    let indices: std::collections::HashSet<_> = selection.indices.into_iter().collect();
    if indices.is_empty()
        || indices.iter().any(|i| {
            preview
                .candidates
                .get(*i)
                .is_none_or(|c| c.blocked || c.duplicate)
        })
    {
        return Err("Select available profiles to import".into());
    }
    let profiles = preview
        .candidates
        .into_iter()
        .enumerate()
        .filter(|(i, _)| indices.contains(i))
        .map(|(i, mut c)| {
            if let Some(group) = selection.group_overrides.get(&i) {
                c.profile.group_name = group.clone();
            }
            c.profile
        })
        .collect();
    db.import_data(
        ExportData {
            version: 2,
            profiles,
            command_bookmarks: vec![],
            path_bookmarks: vec![],
        },
        crypto,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(bytes: &[u8]) -> Self {
            let path =
                std::env::temp_dir().join(format!("cygnus-migration-{}", uuid::Uuid::new_v4()));
            std::fs::write(&path, bytes).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    #[test]
    fn preview_is_read_only_and_save_is_selected_idempotent_and_stale_safe() {
        let fixture = Fixture::new(b"Host api alias\nHostName api.example\nUser deploy\nHost other\nHostName other.example\nUser root");
        let db = Database::new_in_memory().unwrap();
        let crypto = CryptoManager::new_random();
        let p = preview("ssh", &fixture.0, &db, &crypto).unwrap();
        assert_eq!(p.candidates.len(), 3);
        assert!(p.candidates[1].duplicate);
        assert!(db.list_profiles(&crypto).unwrap().is_empty());
        let selection = |fingerprint: String, indices| MigrationSelection {
            group_overrides: Default::default(),
            kind: "ssh".into(),
            path: fixture.0.to_string_lossy().into(),
            fingerprint,
            indices,
        };
        assert!(save_selection(selection(p.fingerprint.clone(), vec![1]), &db, &crypto).is_err());
        assert_eq!(
            save_selection(selection(p.fingerprint.clone(), vec![0]), &db, &crypto).unwrap(),
            1
        );
        assert_eq!(db.list_profiles(&crypto).unwrap().len(), 1);
        assert!(save_selection(selection(p.fingerprint, vec![0]), &db, &crypto).is_err());
        let p = preview("ssh", &fixture.0, &db, &crypto).unwrap();
        assert!(p.candidates[0].duplicate);
        std::fs::write(&fixture.0, "Host changed").unwrap();
        assert!(save_selection(selection(p.fingerprint, vec![2]), &db, &crypto).is_err());
        assert_eq!(db.list_profiles(&crypto).unwrap().len(), 1);
    }
    #[test]
    fn json_xml_and_binary_plist_convert_to_same_profiles() {
        let value = serde_json::json!({"New Bookmarks":[{"Name":"Demo","Command":"ssh root@example.org","Custom Command":"Yes"}]});
        let data = serde_json::to_vec(&value).unwrap();
        let plist_value = plist::to_value(&value).unwrap();
        let mut xml = vec![];
        plist_value.to_writer_xml(&mut xml).unwrap();
        let mut binary = vec![];
        plist_value.to_writer_binary(&mut binary).unwrap();
        // Test conversion independently of the user's ~/.ssh/config.
        for bytes in [data, xml, binary] {
            let fixture = Fixture::new(&bytes);
            let data = read_file(&fixture.0).unwrap();
            let json = serde_json::from_slice(&data).unwrap_or_else(|_| {
                serde_json::to_value(plist::Value::from_reader(std::io::Cursor::new(data)).unwrap())
                    .unwrap()
            });
            let rows = iterm_profiles(json, &SshConfig::default()).unwrap();
            assert_eq!(rows[0].profile.host, "example.org");
            assert!(!rows[0].blocked);
        }
    }
    #[test]
    fn relative_key_paths_can_be_imported_for_later_editing_and_duplicates_are_skipped() {
        let fixture = Fixture::new(
            b"Host server alias\nHostName example.org\nUser deploy\nIdentityFile keys/deploy.pem",
        );
        let db = Database::new_in_memory().unwrap();
        let crypto = CryptoManager::new_random();
        let p = preview("ssh", &fixture.0, &db, &crypto).unwrap();
        assert!(!p.candidates[0].blocked);
        assert!(!p.candidates[0].duplicate);
        assert!(p.candidates[0]
            .warnings
            .iter()
            .any(|w| w.contains("Relative SSH key path")));
        assert!(p.candidates[1].duplicate);
        assert_eq!(
            save_selection(
                MigrationSelection {
                    group_overrides: Default::default(),
                    kind: "ssh".into(),
                    path: fixture.0.to_string_lossy().into(),
                    fingerprint: p.fingerprint,
                    indices: vec![0],
                },
                &db,
                &crypto
            )
            .unwrap(),
            1
        );
        let saved = db.list_profiles(&crypto).unwrap();
        assert_eq!(saved[0].host, "example.org");
        assert_eq!(saved[0].auth_type, "key");
        assert_eq!(saved[0].key_path.as_deref(), Some("keys/deploy.pem"));
        assert!(preview("ssh", &fixture.0, &db, &crypto)
            .unwrap()
            .candidates
            .iter()
            .all(|c| c.duplicate));
    }
    #[test]
    fn source_errors_are_actionable_and_blocked_rows_cannot_save() {
        let fixture = Fixture::new(b"Include config.d/*");
        assert!(parse_source("ssh", &fixture.0)
            .err()
            .unwrap()
            .contains("include"));
        std::fs::write(&fixture.0, "Host private\nProxyJump gateway").unwrap();
        let db = Database::new_in_memory().unwrap();
        let crypto = CryptoManager::new_random();
        let p = preview("ssh", &fixture.0, &db, &crypto).unwrap();
        assert!(save_selection(
            MigrationSelection {
                group_overrides: Default::default(),
                kind: "ssh".into(),
                path: fixture.0.to_string_lossy().into(),
                fingerprint: p.fingerprint,
                indices: vec![0]
            },
            &db,
            &crypto
        )
        .is_err());
        assert!(db.list_profiles(&crypto).unwrap().is_empty());
        assert!(read_file(&std::env::temp_dir()).is_err());
    }
}

#[cfg(test)]
mod group_tests {
    use super::*;
    #[test]
    fn selected_groups_override_source_and_support_ungrouped() {
        let path =
            std::env::temp_dir().join(format!("cygnus-group-import-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "Host api worker untouched\nUser deploy").unwrap();
        let db = Database::new_in_memory().unwrap();
        let crypto = CryptoManager::new_random();
        let p = preview("ssh", &path, &db, &crypto).unwrap();
        assert!(p.groups.contains(&"Imported".to_string()));
        let request = serde_json::from_value(serde_json::json!({
            "kind":"ssh", "path":path.to_string_lossy(), "fingerprint":p.fingerprint,
            "indices":[0,1,2], "group_overrides":{"0":"운영", "1":""}
        }))
        .unwrap();
        assert_eq!(save_selection(request, &db, &crypto).unwrap(), 3);
        let saved = db.list_profiles(&crypto).unwrap();
        for (name, expected) in [("api", "운영"), ("worker", ""), ("untouched", "Imported")] {
            assert_eq!(
                saved.iter().find(|p| p.name == name).unwrap().group_name,
                expected
            );
        }
        let p = preview("ssh", &path, &db, &crypto).unwrap();
        assert!(p.groups.contains(&"운영".to_string()));
        assert!(p.candidates.iter().all(|c| c.duplicate));
        std::fs::remove_file(path).unwrap();
    }
}
