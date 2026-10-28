use serde::{Deserialize, Serialize};

use crate::crypto::CryptoManager;
use crate::db::Database;

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportData {
    pub version: u32,
    pub profiles: Vec<ExportProfile>,
    #[serde(default)]
    pub rdp_profiles: Vec<super::rdp::ProfileData>,
    #[serde(default)]
    pub winrm_profiles: Vec<super::winrm::ProfileData>,
    pub command_bookmarks: Vec<ExportCommandBookmark>,
    pub path_bookmarks: Vec<ExportPathBookmark>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportProfile {
    #[serde(default = "default_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub baud_rate: Option<u32>,
    #[serde(default = "default_auto")]
    pub target_os: String,
    #[serde(default = "default_auto")]
    pub remote_shell: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub key_path: Option<String>,
    pub group_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportCommandBookmark {
    pub profile_name: String,
    pub command: String,
    pub label: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportPathBookmark {
    pub profile_name: String,
    pub path: String,
    pub label: Option<String>,
}

impl Database {
    pub fn export_data(&self, _crypto: &CryptoManager) -> Result<ExportData, String> {
        let conn = self.conn();

        // Profiles (비밀번호 제외)
        let mut stmt = conn
            .prepare("SELECT name, host, port, username, auth_type, key_path, group_name, protocol, baud_rate, target_os, remote_shell FROM profiles ORDER BY sort_order, name")
            .map_err(|e| format!("Failed to query profiles: {e}"))?;
        let profiles: Vec<ExportProfile> = stmt
            .query_map([], |row| {
                Ok(ExportProfile {
                    name: row.get(0)?,
                    host: row.get(1)?,
                    port: row.get(2)?,
                    username: row.get(3)?,
                    auth_type: row.get(4)?,
                    key_path: row.get(5)?,
                    group_name: row.get(6)?,
                    protocol: row.get(7)?,
                    baud_rate: row.get(8)?,
                    target_os: row.get(9)?,
                    remote_shell: row.get(10)?,
                })
            })
            .map_err(|e| format!("Export query failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Export query failed: {e}"))?;

        // Command bookmarks (profile_name으로 조인)
        let mut stmt = conn
            .prepare(
                "SELECT p.name, cb.command, cb.label
                 FROM command_bookmarks cb
                 JOIN profiles p ON p.id = cb.profile_id
                 ORDER BY p.name, cb.sort_order",
            )
            .map_err(|e| format!("Export query failed: {e}"))?;
        let command_bookmarks: Vec<ExportCommandBookmark> = stmt
            .query_map([], |row| {
                Ok(ExportCommandBookmark {
                    profile_name: row.get(0)?,
                    command: row.get(1)?,
                    label: row.get(2)?,
                })
            })
            .map_err(|e| format!("Export query failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Export query failed: {e}"))?;

        // Path bookmarks
        let mut stmt = conn
            .prepare(
                "SELECT p.name, pb.path, pb.label
                 FROM path_bookmarks pb
                 JOIN profiles p ON p.id = pb.profile_id
                 ORDER BY p.name, pb.created_at",
            )
            .map_err(|e| format!("Export query failed: {e}"))?;
        let path_bookmarks: Vec<ExportPathBookmark> = stmt
            .query_map([], |row| {
                Ok(ExportPathBookmark {
                    profile_name: row.get(0)?,
                    path: row.get(1)?,
                    label: row.get(2)?,
                })
            })
            .map_err(|e| format!("Export query failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Export query failed: {e}"))?;

        Ok(ExportData {
            version: 6,
            winrm_profiles: super::winrm::list(&conn)?.into_iter().map(|p| {
                let mut data = p.data;
                // Trust is configured locally, never transferred through a backup.
                data.config.certificate_pin.clear();
                data
            }).collect(),
            rdp_profiles: super::rdp::list(&conn)?
                .into_iter()
                .map(|p| super::rdp::ProfileData {
                    name: p.name,
                    config: p.config,
                })
                .collect(),
            profiles,
            command_bookmarks,
            path_bookmarks,
        })
    }

    pub fn import_data(&self, data: ExportData, _crypto: &CryptoManager) -> Result<u32, String> {
        if data.version > 6 || (data.version < 4 && !data.rdp_profiles.is_empty())
            || (data.version < 6 && !data.winrm_profiles.is_empty()) {
            return Err("Unsupported backup version".into());
        }
        for profile in &data.profiles {
            super::profile::validate_transport(
                &profile.protocol,
                &profile.host,
                profile.port,
                profile.baud_rate,
            )?;
            super::profile::validate_server_environment(&profile.target_os, &profile.remote_shell)?;
        }
        if data.rdp_profiles.len() > super::rdp::MAX_PROFILES {
            return Err("Backup contains too many RDP connections".into());
        }
        for profile in &data.rdp_profiles {
            profile.validate()?;
        }
        if data.winrm_profiles.len() > 200 { return Err("Backup contains too many WinRM connections".into()); }
        for profile in &data.winrm_profiles { profile.validate()?; }
        let mut guard = self.conn();
        let conn = guard
            .transaction()
            .map_err(|e| format!("Failed to start import: {e}"))?;
        let mut imported = 0u32;

        for profile in &data.profiles {
            // 중복 체크 (host + port + username)
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM profiles WHERE host = ?1 AND port = ?2 AND username = ?3 AND protocol = ?4 AND COALESCE(baud_rate, 0) = ?5",
                    rusqlite::params![profile.host, profile.port, profile.username, profile.protocol, if profile.protocol == "serial" { profile.baud_rate.unwrap_or(115200) } else { 0 }],
                    |row| row.get(0),
                )
                .unwrap_or(true);

            if exists {
                continue;
            }

            conn.execute(
                "INSERT INTO profiles (name, host, port, username, auth_type, key_path, group_name, protocol, baud_rate, target_os, remote_shell)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                rusqlite::params![
                    profile.name,
                    profile.host,
                    profile.port,
                    profile.username,
                    profile.auth_type,
                    profile.key_path,
                    profile.group_name,
                    profile.protocol,
                    if profile.protocol == "serial" { Some(profile.baud_rate.unwrap_or(115200)) } else { None },
                    profile.target_os,
                    profile.remote_shell,
                ],
            )
            .map_err(|e| format!("Failed to import profile: {e}"))?;
            imported += 1;
        }

        // RDP metadata is imported without credentials or certificate trust.
        for profile in &data.rdp_profiles {
            let c = &profile.config;
            let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM rdp_profiles WHERE host=?1 AND port=?2 AND username=?3 AND domain=?4)", rusqlite::params![c.host,c.port,c.username,c.domain], |r| r.get(0))
                .map_err(|_| "Could not inspect saved RDP connections")?;
            if !exists {
                super::rdp::insert(&conn, profile)?;
                imported += 1;
            }
        }

        let mut saved_winrm = super::winrm::list(&conn)?;
        for profile in &data.winrm_profiles {
            let mut profile = profile.clone();
            profile.config.certificate_pin.clear();
            if saved_winrm.iter().any(|p| p.data.config.same_account(&profile.config)
                && p.data.config.authentication == profile.config.authentication) { continue; }
            let id = super::winrm::insert(&conn, &profile, None)?;
            saved_winrm.push(super::winrm::WinrmProfile { id, data: profile, has_password: false });
            imported += 1;
        }

        // profile_name → id 매핑
        let profile_map: std::collections::HashMap<String, i64> = {
            let mut stmt = conn
                .prepare("SELECT id, name FROM profiles")
                .map_err(|e| format!("Export query failed: {e}"))?;
            let rows: Vec<(String, i64)> = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(1)?, row.get::<_, i64>(0)?))
                })
                .map_err(|e| format!("Export query failed: {e}"))?
                .filter_map(|r| r.ok())
                .collect();
            rows.into_iter().collect()
        };

        for cb in &data.command_bookmarks {
            if let Some(&pid) = profile_map.get(&cb.profile_name) {
                let _ = conn.execute(
                    "INSERT INTO command_bookmarks (profile_id, command, label) VALUES (?1, ?2, ?3)",
                    rusqlite::params![pid, cb.command, cb.label],
                );
                imported += 1;
            }
        }

        for pb in &data.path_bookmarks {
            if let Some(&pid) = profile_map.get(&pb.profile_name) {
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO path_bookmarks (profile_id, path, label) VALUES (?1, ?2, ?3)",
                    rusqlite::params![pid, pb.path, pb.label],
                );
                imported += 1;
            }
        }

        conn.commit()
            .map_err(|e| format!("Failed to commit import: {e}"))?;
        Ok(imported)
    }
}

fn default_protocol() -> String {
    "ssh".into()
}

fn default_auto() -> String {
    "auto".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_backups_and_mixed_protocol_roundtrip() {
        let crypto = CryptoManager::new_random();
        let db = Database::new_in_memory().unwrap();
        let old = serde_json::json!({"version":1,"profiles":[{"name":"old","host":"host.test","port":22,"username":"root","auth_type":"key","key_path":null,"group_name":""}],"command_bookmarks":[],"path_bookmarks":[]});
        db.import_data(serde_json::from_value(old).unwrap(), &crypto)
            .unwrap();
        for (protocol, baud) in [
            ("telnet", None),
            ("serial", Some(9600)),
            ("serial", Some(115200)),
        ] {
            let req = serde_json::from_value(serde_json::json!({"protocol":protocol,"baud_rate":baud,"name":protocol,"host":"same-endpoint","port":23,"username":"","auth_type":"password"})).unwrap();
            db.create_profile(req, &crypto).unwrap();
        }
        let backup = db.export_data(&crypto).unwrap();
        assert_eq!(backup.version, 6);
        let json = serde_json::to_string(&backup).unwrap();
        let target = Database::new_in_memory().unwrap();
        assert_eq!(
            target
                .import_data(serde_json::from_str(&json).unwrap(), &crypto)
                .unwrap(),
            4
        );
        assert_eq!(
            target
                .import_data(serde_json::from_str(&json).unwrap(), &crypto)
                .unwrap(),
            0
        );
        let profiles = target.list_profiles(&crypto).unwrap();
        assert!(profiles
            .iter()
            .all(|p| p.target_os == "auto" && p.remote_shell == "auto"));
        assert!(profiles
            .iter()
            .any(|p| p.protocol == "ssh" && p.name == "old"));
        assert!(profiles
            .iter()
            .any(|p| p.protocol == "serial" && p.baud_rate == Some(9600)));
        assert!(profiles
            .iter()
            .any(|p| p.protocol == "serial" && p.baud_rate == Some(115200)));
    }

    #[test]
    fn environment_backup_roundtrip_omits_secrets_and_preserves_existing_profiles() {
        let crypto = CryptoManager::new_random();
        let db = Database::new_in_memory().unwrap();
        let req = serde_json::from_value(serde_json::json!({"name":"IIS", "host":"iis.test", "port":22, "username":"admin", "auth_type":"password", "password":"private-server-secret", "jump_host":"private-jump-secret", "target_os":"windows", "remote_shell":"powershell"})).unwrap();
        let original = db.create_profile(req, &crypto).unwrap();
        let json = serde_json::to_string(&db.export_data(&crypto).unwrap()).unwrap();
        assert!(!json.contains("private-"));
        let target = Database::new_in_memory().unwrap();
        target
            .import_data(serde_json::from_str(&json).unwrap(), &crypto)
            .unwrap();
        let imported = target.list_profile_summaries().unwrap().remove(0);
        assert_eq!(
            (imported.target_os.as_str(), imported.remote_shell.as_str()),
            ("windows", "powershell")
        );
        assert!(target
            .get_profile(imported.id, &crypto)
            .unwrap()
            .password
            .is_none());
        let update = serde_json::from_value(serde_json::json!({"remote_shell":"cmd"})).unwrap();
        db.update_profile(original.id, update, &crypto).unwrap();
        assert_eq!(
            db.import_data(serde_json::from_str(&json).unwrap(), &crypto)
                .unwrap(),
            0
        );
        let existing = db.get_profile(original.id, &crypto).unwrap();
        assert_eq!(existing.remote_shell, "cmd");
        assert_eq!(existing.password.as_deref(), Some("private-server-secret"));
    }

    #[test]
    fn version_two_backups_default_to_unspecified_environment() {
        let crypto = CryptoManager::new_random();
        let db = Database::new_in_memory().unwrap();
        let backup = serde_json::json!({"version":2,"profiles":[{"protocol":"ssh","name":"legacy","host":"old.test","port":22,"username":"u","auth_type":"password","group_name":""}],"command_bookmarks":[],"path_bookmarks":[]});
        db.import_data(serde_json::from_value(backup).unwrap(), &crypto)
            .unwrap();
        let profile = db.list_profile_summaries().unwrap().remove(0);
        assert_eq!(
            (profile.target_os.as_str(), profile.remote_shell.as_str()),
            ("auto", "auto")
        );
    }

    #[test]
    fn invalid_environment_aborts_the_entire_import() {
        let crypto = CryptoManager::new_random();
        let db = Database::new_in_memory().unwrap();
        for field in ["target_os", "remote_shell"] {
            let valid = serde_json::json!({"name":"valid", "host":"valid.test", "port":22, "username":"u", "auth_type":"password", "group_name":"", "target_os":"windows", "remote_shell":"cmd"});
            let mut invalid = valid.clone();
            invalid["host"] = "invalid.test".into();
            invalid[field] = "invalid; Get-Content secret".into();
            let backup = serde_json::json!({"version":3,"profiles":[valid,invalid],"command_bookmarks":[],"path_bookmarks":[]});
            assert!(db
                .import_data(serde_json::from_value(backup).unwrap(), &crypto)
                .is_err());
            assert!(db.list_profile_summaries().unwrap().is_empty());
        }
    }
}
