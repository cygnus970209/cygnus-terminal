use crate::db::Database;

pub enum HostKeyStatus {
    /// 이 호스트의 키가 DB에 저장되어 있고 일치함
    Trusted,
    /// 처음 보는 호스트
    Unknown,
    /// 호스트 키가 변경됨 (MITM 가능성)
    Changed { stored_key_type: String },
}

impl Database {
    pub fn check_host_key(
        &self,
        host: &str,
        port: u16,
        key_type: &str,
        host_key: &[u8],
    ) -> Result<HostKeyStatus, String> {
        let conn = self.conn();
        let result = conn.query_row(
            "SELECT key_type, host_key FROM known_hosts WHERE host = ?1 AND port = ?2",
            rusqlite::params![host, port],
            |row| {
                let stored_type: String = row.get(0)?;
                let stored_key: Vec<u8> = row.get(1)?;
                Ok((stored_type, stored_key))
            },
        );

        match result {
            Ok((stored_type, stored_key)) => {
                if stored_type == key_type && stored_key == host_key {
                    Ok(HostKeyStatus::Trusted)
                } else {
                    Ok(HostKeyStatus::Changed {
                        stored_key_type: stored_type,
                    })
                }
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(HostKeyStatus::Unknown),
            Err(e) => Err(format!("Failed to check known host: {e}")),
        }
    }

    pub fn save_host_key(
        &self,
        host: &str,
        port: u16,
        key_type: &str,
        host_key: &[u8],
    ) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO known_hosts (host, port, key_type, host_key)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(host, port) DO UPDATE SET key_type = ?3, host_key = ?4",
            rusqlite::params![host, port, key_type, host_key],
        )
        .map_err(|e| format!("Failed to save host key: {e}"))?;
        Ok(())
    }
}
