use super::Database;
use crate::{crypto::CryptoManager, winrm::Config};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileData {
    pub name: String,
    pub group_name: String,
    pub config: Config,
}
impl ProfileData {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty()
            || self.name.len() > 256
            || self.group_name.len() > 256
            || self
                .name
                .chars()
                .chain(self.group_name.chars())
                .any(char::is_control)
        {
            return Err("Enter a connection name and group of at most 256 bytes".into());
        }
        self.config.validate()
    }
}
#[derive(Clone, Serialize)]
pub struct WinrmProfile {
    pub id: i64,
    #[serde(flatten)]
    pub data: ProfileData,
    pub has_password: bool,
}
pub(super) fn list(conn: &Connection) -> Result<Vec<WinrmProfile>, String> {
    let mut stmt = conn.prepare("SELECT id,name,group_name,config,password IS NOT NULL FROM winrm_profiles ORDER BY name COLLATE NOCASE,id").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, bool>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (id, name, group_name, config, has_password) = row.map_err(|e| e.to_string())?;
        Ok(WinrmProfile {
            id,
            data: ProfileData {
                name,
                group_name,
                config: serde_json::from_str(&config)
                    .map_err(|_| "Invalid saved WinRM configuration")?,
            },
            has_password,
        })
    })
    .collect()
}
pub(super) fn insert(
    conn: &Connection,
    data: &ProfileData,
    password: Option<&str>,
) -> Result<i64, String> {
    data.validate()?;
    let count: u32 = conn
        .query_row("SELECT COUNT(*) FROM winrm_profiles", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count >= 200 {
        return Err("Up to 200 WinRM connections can be saved".into());
    }
    conn.execute(
        "INSERT INTO winrm_profiles(name,group_name,config,password) VALUES(?1,?2,?3,?4)",
        params![
            data.name.trim(),
            data.group_name.trim(),
            serde_json::to_string(&data.config).map_err(|e| e.to_string())?,
            password
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}
impl Database {
    pub fn list_winrm_profiles(&self) -> Result<Vec<WinrmProfile>, String> {
        list(&self.conn())
    }
    /// None preserves an existing secret only when the endpoint and account are unchanged.
    /// An explicit empty password removes it. Lists and backups never decrypt passwords.
    pub fn save_winrm_profile(
        &self,
        id: Option<i64>,
        data: ProfileData,
        password: Option<Zeroizing<String>>,
        crypto: &CryptoManager,
    ) -> Result<WinrmProfile, String> {
        data.validate()?;
        let encrypted = password
            .as_ref()
            .filter(|p| !p.is_empty())
            .map(|p| crypto.encrypt(p))
            .transpose()?;
        let conn = self.conn();
        let id = if let Some(id) = id {
            let old: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT config,password FROM winrm_profiles WHERE id=?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let (config, old_password) = old.ok_or("Saved WinRM connection no longer exists")?;
            let config: Config =
                serde_json::from_str(&config).map_err(|_| "Invalid saved WinRM configuration")?;
            let secret = if password.is_none() && config.same_account(&data.config) {
                old_password
            } else {
                encrypted
            };
            conn.execute(
                "UPDATE winrm_profiles SET name=?1,group_name=?2,config=?3,password=?4 WHERE id=?5",
                params![
                    data.name.trim(),
                    data.group_name.trim(),
                    serde_json::to_string(&data.config).map_err(|e| e.to_string())?,
                    secret,
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
            id
        } else {
            insert(&conn, &data, encrypted.as_deref())?
        };
        list(&conn)?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("Could not read saved WinRM connection".into())
    }
    pub fn winrm_credentials(
        &self,
        id: i64,
        displayed_config: &Config,
        password: Option<Zeroizing<String>>,
        crypto: &CryptoManager,
    ) -> Result<(Config, Zeroizing<String>), String> {
        let (config, encrypted): (String, Option<String>) = self
            .conn()
            .query_row(
                "SELECT config,password FROM winrm_profiles WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| "Saved WinRM connection no longer exists")?;
        let config: Config =
            serde_json::from_str(&config).map_err(|_| "Invalid saved WinRM configuration")?;
        config.validate()?;
        // An already open tab must never silently reconnect to an edited destination.
        // Check before decrypting or using either stored or one-time credentials.
        if &config != displayed_config {
            return Err("This WinRM connection has changed. Close this tab and reopen the saved connection.".into());
        }
        let password = match password {
            Some(password) => password,
            None => Zeroizing::new(
                crypto.decrypt(&encrypted.ok_or("Enter a password for this Windows account")?)?,
            ),
        };
        Ok((config, password))
    }
    pub fn delete_winrm_profile(&self, id: i64) -> Result<(), String> {
        self.conn()
            .execute("DELETE FROM winrm_profiles WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
