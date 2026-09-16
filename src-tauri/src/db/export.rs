use serde::{Deserialize, Serialize};

use crate::crypto::CryptoManager;
use crate::db::Database;

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportData {
    pub version: u32,
    pub profiles: Vec<ExportProfile>,
    pub command_bookmarks: Vec<ExportCommandBookmark>,
    pub path_bookmarks: Vec<ExportPathBookmark>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportProfile {
    #[serde(default = "default_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub baud_rate: Option<u32>,
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
            .prepare("SELECT name, host, port, username, auth_type, key_path, group_name, protocol, baud_rate FROM profiles ORDER BY sort_order, name")
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
            version: 2,
            profiles,
            command_bookmarks,
            path_bookmarks,
        })
    }

    pub fn import_data(&self, data: ExportData, _crypto: &CryptoManager) -> Result<u32, String> {
        if data.version > 2 {
            return Err("Unsupported backup version".into());
        }
        for profile in &data.profiles {
            super::profile::validate_transport(
                &profile.protocol,
                &profile.host,
                profile.port,
                profile.baud_rate,
            )?;
        }
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
                "INSERT INTO profiles (name, host, port, username, auth_type, key_path, group_name, protocol, baud_rate)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
                ],
            )
            .map_err(|e| format!("Failed to import profile: {e}"))?;
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
        assert_eq!(backup.version, 2);
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
            .any(|p| p.protocol == "ssh" && p.name == "old"));
        assert!(profiles
            .iter()
            .any(|p| p.protocol == "serial" && p.baud_rate == Some(9600)));
        assert!(profiles
            .iter()
            .any(|p| p.protocol == "serial" && p.baud_rate == Some(115200)));
    }
}
