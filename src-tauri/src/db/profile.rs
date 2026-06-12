use serde::{Deserialize, Serialize};

use crate::crypto::CryptoManager;
use crate::db::Database;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: i64,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>, // 복호화된 평문 (프론트엔드 전송 시)
    pub key_path: Option<String>,
    pub group_name: String,
    pub sort_order: i32,
    pub jump_host: Option<String>,
    pub agent_forward: bool,
    pub environment: String, // 'development' | 'staging' | 'production'
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateProfileRequest {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub group_name: Option<String>,
    pub jump_host: Option<String>,
    pub agent_forward: Option<bool>,
    pub environment: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    pub name: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub auth_type: Option<String>,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub group_name: Option<String>,
    pub jump_host: Option<String>,
    pub agent_forward: Option<bool>,
    pub environment: Option<String>,
}

impl Database {
    pub fn create_profile(
        &self,
        req: CreateProfileRequest,
        crypto: &CryptoManager,
    ) -> Result<Profile, String> {
        let encrypted_password = match &req.password {
            Some(pw) if !pw.is_empty() => Some(crypto.encrypt(pw)?),
            _ => None,
        };

        // jump_host JSON 은 비밀번호를 포함할 수 있으므로 password 와 동일하게 암호화 저장.
        let encrypted_jump_host = match &req.jump_host {
            Some(jh) if !jh.is_empty() => Some(crypto.encrypt(jh)?),
            _ => None,
        };

        let environment = req.environment.unwrap_or_else(|| "development".to_string());
        if !matches!(
            environment.as_str(),
            "development" | "staging" | "production"
        ) {
            return Err(format!("Invalid environment: {environment}"));
        }

        let conn = self.conn();
        conn.execute(
            "INSERT INTO profiles (name, host, port, username, auth_type, password, key_path, group_name, jump_host, agent_forward, environment)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                req.name,
                req.host,
                req.port,
                req.username,
                req.auth_type,
                encrypted_password,
                req.key_path,
                req.group_name.unwrap_or_default(),
                encrypted_jump_host,
                req.agent_forward.unwrap_or(false),
                environment,
            ],
        ).map_err(|e| format!("Failed to create profile: {e}"))?;

        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_profile(id, crypto)
    }

    pub fn get_profile(&self, id: i64, crypto: &CryptoManager) -> Result<Profile, String> {
        let conn = self.conn();
        conn.query_row(
            "SELECT id, name, host, port, username, auth_type, password, key_path, group_name, sort_order, jump_host, agent_forward, environment, created_at, updated_at
             FROM profiles WHERE id = ?1",
            [id],
            |row| {
                Ok(ProfileRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get(3)?,
                    username: row.get(4)?,
                    auth_type: row.get(5)?,
                    encrypted_password: row.get(6)?,
                    key_path: row.get(7)?,
                    group_name: row.get(8)?,
                    sort_order: row.get(9)?,
                    jump_host: row.get(10)?,
                    agent_forward: row.get(11)?,
                    environment: row.get(12)?,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                })
            },
        )
        .map_err(|e| format!("Profile not found: {e}"))
        .and_then(|row| row.into_profile(crypto))
    }

    pub fn list_profiles(&self, crypto: &CryptoManager) -> Result<Vec<Profile>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, host, port, username, auth_type, password, key_path, group_name, sort_order, jump_host, agent_forward, environment, created_at, updated_at
                 FROM profiles ORDER BY sort_order, name",
            )
            .map_err(|e| format!("Failed to prepare query: {e}"))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(ProfileRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get(3)?,
                    username: row.get(4)?,
                    auth_type: row.get(5)?,
                    encrypted_password: row.get(6)?,
                    key_path: row.get(7)?,
                    group_name: row.get(8)?,
                    sort_order: row.get(9)?,
                    jump_host: row.get(10)?,
                    agent_forward: row.get(11)?,
                    environment: row.get(12)?,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                })
            })
            .map_err(|e| format!("Failed to query profiles: {e}"))?;

        let mut profiles = Vec::new();
        for row in rows {
            let row = row.map_err(|e| format!("Failed to read row: {e}"))?;
            profiles.push(Profile {
                id: row.id,
                name: row.name,
                host: row.host,
                port: row.port,
                username: row.username,
                auth_type: row.auth_type,
                password: None,
                key_path: row.key_path,
                group_name: row.group_name,
                sort_order: row.sort_order,
                jump_host: sanitized_jump_host(row.jump_host.as_deref(), crypto),
                agent_forward: row.agent_forward,
                environment: row.environment,
                created_at: row.created_at,
                updated_at: row.updated_at,
            });
        }
        Ok(profiles)
    }

    pub fn update_profile(
        &self,
        id: i64,
        req: UpdateProfileRequest,
        crypto: &CryptoManager,
    ) -> Result<Profile, String> {
        // 기존 프로필 존재 확인
        self.get_profile(id, crypto)?;

        let conn = self.conn();
        let mut sets = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref name) = req.name {
            sets.push("name = ?");
            params.push(Box::new(name.clone()));
        }
        if let Some(ref host) = req.host {
            sets.push("host = ?");
            params.push(Box::new(host.clone()));
        }
        if let Some(port) = req.port {
            sets.push("port = ?");
            params.push(Box::new(port as i32));
        }
        if let Some(ref username) = req.username {
            sets.push("username = ?");
            params.push(Box::new(username.clone()));
        }
        if let Some(ref auth_type) = req.auth_type {
            sets.push("auth_type = ?");
            params.push(Box::new(auth_type.clone()));
        }
        if let Some(ref password) = req.password {
            sets.push("password = ?");
            if password.is_empty() {
                params.push(Box::new(None::<String>));
            } else {
                params.push(Box::new(crypto.encrypt(password)?));
            }
        }
        if let Some(ref key_path) = req.key_path {
            sets.push("key_path = ?");
            params.push(Box::new(key_path.clone()));
        }
        if let Some(ref group_name) = req.group_name {
            sets.push("group_name = ?");
            params.push(Box::new(group_name.clone()));
        }
        if let Some(ref jump_host) = req.jump_host {
            sets.push("jump_host = ?");
            if jump_host.is_empty() {
                // password 와 동일한 규칙: 빈 문자열 = 제거
                params.push(Box::new(None::<String>));
            } else {
                params.push(Box::new(crypto.encrypt(jump_host)?));
            }
        }
        if let Some(agent_forward) = req.agent_forward {
            sets.push("agent_forward = ?");
            params.push(Box::new(agent_forward));
        }
        if let Some(ref environment) = req.environment {
            if !matches!(
                environment.as_str(),
                "development" | "staging" | "production"
            ) {
                return Err(format!("Invalid environment: {environment}"));
            }
            sets.push("environment = ?");
            params.push(Box::new(environment.clone()));
        }

        if sets.is_empty() {
            drop(conn);
            return self.get_profile(id, crypto);
        }

        sets.push("updated_at = datetime('now')");
        params.push(Box::new(id));

        // 동적 파라미터 인덱스 생성
        let set_clause: String = sets
            .iter()
            .enumerate()
            .map(|(i, s)| {
                if s.contains('?') {
                    s.replace('?', &format!("?{}", i + 1))
                } else {
                    s.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(", ");

        let sql = format!(
            "UPDATE profiles SET {} WHERE id = ?{}",
            set_clause,
            params.len()
        );

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, param_refs.as_slice())
            .map_err(|e| format!("Failed to update profile: {e}"))?;

        drop(conn);
        self.get_profile(id, crypto)
    }

    /// 레거시 평문 jump_host 를 암호화 저장으로 일괄 전환. 앱 시작 시 1회 호출 (멱등).
    pub fn migrate_plaintext_jump_hosts(&self, crypto: &CryptoManager) -> Result<usize, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT id, jump_host FROM profiles WHERE jump_host IS NOT NULL AND jump_host != ''")
            .map_err(|e| format!("Failed to prepare jump_host migration query: {e}"))?;

        let rows: Vec<(i64, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("Failed to query jump_host rows: {e}"))?
            .collect::<Result<_, _>>()
            .map_err(|e| format!("Failed to read jump_host row: {e}"))?;
        drop(stmt);

        let mut migrated = 0;
        for (id, jh) in rows {
            if is_plaintext_jump_host(&jh) {
                let encrypted = crypto.encrypt(&jh)?;
                conn.execute(
                    "UPDATE profiles SET jump_host = ?1 WHERE id = ?2",
                    rusqlite::params![encrypted, id],
                )
                .map_err(|e| format!("Failed to encrypt jump_host for profile {id}: {e}"))?;
                migrated += 1;
            }
        }
        Ok(migrated)
    }

    pub fn delete_profile(&self, id: i64) -> Result<(), String> {
        let conn = self.conn();
        let affected = conn
            .execute("DELETE FROM profiles WHERE id = ?1", [id])
            .map_err(|e| format!("Failed to delete profile: {e}"))?;

        if affected == 0 {
            return Err("Profile not found".into());
        }
        Ok(())
    }
}

/// DB에서 읽은 raw 데이터 (비밀번호 암호화 상태)
struct ProfileRow {
    id: i64,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    encrypted_password: Option<String>,
    key_path: Option<String>,
    group_name: String,
    sort_order: i32,
    jump_host: Option<String>,
    agent_forward: bool,
    environment: String,
    created_at: String,
    updated_at: String,
}

impl ProfileRow {
    fn into_profile(self, crypto: &CryptoManager) -> Result<Profile, String> {
        let password = match self.encrypted_password {
            Some(ref enc) if !enc.is_empty() => Some(crypto.decrypt(enc)?),
            _ => None,
        };

        let jump_host = match self.jump_host {
            Some(ref jh) if !jh.is_empty() => {
                if is_plaintext_jump_host(jh) {
                    // 마이그레이션 전 레거시 평문 — 그대로 반환 (앱 시작 시 암호화 마이그레이션됨)
                    Some(jh.clone())
                } else {
                    Some(crypto.decrypt(jh)?)
                }
            }
            _ => None,
        };

        Ok(Profile {
            id: self.id,
            name: self.name,
            host: self.host,
            port: self.port,
            username: self.username,
            auth_type: self.auth_type,
            password,
            key_path: self.key_path,
            group_name: self.group_name,
            sort_order: self.sort_order,
            jump_host,
            agent_forward: self.agent_forward,
            environment: self.environment,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

/// 암호문은 base64(nonce+ciphertext)라 `{` 로 시작할 수 없다 — 평문 JSON 과 구분 가능.
fn is_plaintext_jump_host(value: &str) -> bool {
    value.trim_start().starts_with('{')
}

/// 목록 조회용 jump_host — 복호화 후 JSON 에서 password 필드를 제거해 반환.
/// 목록에서는 jump host 의 호스트/포트/사용자명만 필요하고 비밀번호는 노출하지 않는다.
fn sanitized_jump_host(raw: Option<&str>, crypto: &CryptoManager) -> Option<String> {
    let raw = raw.filter(|s| !s.is_empty())?;
    let plain = if is_plaintext_jump_host(raw) {
        raw.to_string()
    } else {
        crypto.decrypt(raw).ok()?
    };
    let mut value: serde_json::Value = serde_json::from_str(&plain).ok()?;
    if let Some(obj) = value.as_object_mut() {
        obj.remove("password");
    }
    serde_json::to_string(&value).ok()
}
