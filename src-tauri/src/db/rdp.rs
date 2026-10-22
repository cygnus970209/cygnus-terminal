//! RDP metadata and endpoint certificate pins. Neither table accepts credentials.
use super::Database;
use cygnus_rdp_protocol::ConnectConfig;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const MAX_PROFILES: usize = 200;

#[derive(Clone)]
pub struct Endpoint {
    host: String,
    port: u16,
}
impl Endpoint {
    pub fn new(config: &ConnectConfig) -> Result<Self, String> {
        config.validate()?;
        // Preserve trailing dots and aliases: never merge distinct DNS destinations.
        let host = config
            .host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| config.host.to_ascii_lowercase());
        Ok(Self {
            host,
            port: config.port,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileData {
    pub name: String,
    pub config: ConnectConfig,
}
impl ProfileData {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty()
            || self.name.len() > 256
            || self.name.chars().any(char::is_control)
        {
            return Err("Enter an RDP connection name of at most 256 bytes".into());
        }
        self.config.validate().map_err(Into::into)
    }
}

#[derive(Clone, Serialize)]
pub struct RdpProfile {
    pub id: i64,
    pub name: String,
    pub config: ConnectConfig,
}

pub(super) fn list(conn: &Connection) -> Result<Vec<RdpProfile>, String> {
    let mut stmt = conn.prepare("SELECT id,name,host,port,username,domain,width,height,desktop_scale_factor FROM rdp_profiles ORDER BY name COLLATE NOCASE,id")
        .map_err(|_| "Could not read saved RDP connections")?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RdpProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                config: ConnectConfig {
                    host: row.get(2)?,
                    port: row.get(3)?,
                    username: row.get(4)?,
                    domain: row.get(5)?,
                    width: row.get(6)?,
                    height: row.get(7)?,
                    desktop_scale_factor: row.get(8)?,
                },
            })
        })
        .map_err(|_| "Could not read saved RDP connections")?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Invalid saved RDP connection".into())
}

pub(super) fn insert(conn: &Connection, data: &ProfileData) -> Result<i64, String> {
    let count: u32 = conn
        .query_row("SELECT count(*) FROM rdp_profiles", [], |r| r.get(0))
        .map_err(|_| "Could not read saved RDP connections")?;
    if count as usize >= MAX_PROFILES {
        return Err("Up to 200 RDP connections can be saved".into());
    }
    let c = &data.config;
    conn.execute("INSERT INTO rdp_profiles(name,host,port,username,domain,width,height,desktop_scale_factor) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![data.name.trim(), c.host, c.port, c.username, c.domain, c.width, c.height, c.desktop_scale_factor])
        .map_err(|_| "Could not save RDP connection")?;
    Ok(conn.last_insert_rowid())
}

pub fn valid_fingerprint(value: &str) -> bool {
    value.len() == 95
        && value.as_bytes().iter().enumerate().all(|(i, b)| {
            if i % 3 == 2 {
                *b == b':'
            } else {
                b.is_ascii_digit() || (b'A'..=b'F').contains(b)
            }
        })
}

fn read_pin(conn: &Connection, endpoint: &Endpoint) -> Result<Option<String>, String> {
    let result: Option<String> = conn
        .query_row(
            "SELECT fingerprint FROM rdp_certificates WHERE host=?1 AND port=?2",
            params![endpoint.host, endpoint.port],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "Could not read saved RDP certificate")?;
    if result.as_ref().is_some_and(|pin| !valid_fingerprint(pin)) {
        return Err("Saved RDP certificate is invalid".into());
    }
    Ok(result)
}

impl Database {
    pub fn list_rdp_profiles(&self) -> Result<Vec<RdpProfile>, String> {
        list(&self.conn())
    }
    pub fn save_rdp_profile(
        &self,
        id: Option<i64>,
        data: ProfileData,
    ) -> Result<RdpProfile, String> {
        data.validate()?;
        let conn = self.conn();
        let id = if let Some(id) = id {
            let c = &data.config;
            let changed = conn.execute("UPDATE rdp_profiles SET name=?1,host=?2,port=?3,username=?4,domain=?5,width=?6,height=?7,desktop_scale_factor=?8 WHERE id=?9", params![data.name.trim(), c.host, c.port, c.username, c.domain, c.width, c.height, c.desktop_scale_factor, id])
                .map_err(|_| "Could not save RDP connection")?;
            if changed != 1 {
                return Err("Saved RDP connection no longer exists".into());
            }
            id
        } else {
            insert(&conn, &data)?
        };
        Ok(RdpProfile {
            id,
            name: data.name.trim().into(),
            config: data.config,
        })
    }
    pub fn delete_rdp_profile(&self, id: i64) -> Result<(), String> {
        self.conn()
            .execute("DELETE FROM rdp_profiles WHERE id=?1", [id])
            .map_err(|_| "Could not delete RDP connection")?;
        Ok(())
    }
    pub fn rdp_certificate(&self, endpoint: &Endpoint) -> Result<Option<String>, String> {
        read_pin(&self.conn(), endpoint)
    }
    /// Compare the live certificate and the displayed saved pin under one transaction.
    /// Even trust-once checks for concurrent changes; it never weakens an existing pin.
    pub fn approve_rdp_certificate(
        &self,
        endpoint: &Endpoint,
        presented: &str,
        expected: Option<&str>,
        remember: bool,
        accept_changed: bool,
    ) -> Result<(), String> {
        if !valid_fingerprint(presented) {
            return Err("Invalid RDP certificate fingerprint".into());
        }
        let mut guard = self.conn();
        let tx = guard
            .transaction()
            .map_err(|_| "Could not open certificate store")?;
        let saved = read_pin(&tx, endpoint)?;
        if saved.as_deref() != expected {
            return Err(
                "Saved RDP certificate changed in another connection. Reconnect to review it."
                    .into(),
            );
        }
        if saved.as_deref().is_some_and(|pin| pin != presented) && !accept_changed {
            return Err("Verify the changed RDP certificate before continuing".into());
        }
        if remember {
            tx.execute("INSERT INTO rdp_certificates(host,port,fingerprint) VALUES(?1,?2,?3) ON CONFLICT(host,port) DO UPDATE SET fingerprint=excluded.fingerprint", params![endpoint.host,endpoint.port,presented])
                .map_err(|_| "Could not save RDP certificate")?;
        }
        tx.commit()
            .map_err(|_| "Could not commit RDP certificate approval".into())
    }
    pub fn forget_rdp_certificate(
        &self,
        endpoint: &Endpoint,
        expected: &str,
    ) -> Result<(), String> {
        let changed = self
            .conn()
            .execute(
                "DELETE FROM rdp_certificates WHERE host=?1 AND port=?2 AND fingerprint=?3",
                params![endpoint.host, endpoint.port, expected],
            )
            .map_err(|_| "Could not forget RDP certificate")?;
        if changed != 1 {
            return Err("Saved RDP certificate changed. Reconnect to review it.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
