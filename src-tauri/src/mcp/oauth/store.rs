use super::*;
use rusqlite::OptionalExtension;

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct Stored {
    pub clients: Vec<Client>,
    pub grants: Vec<Grant>,
    pub last_config: Option<McpConfig>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Client {
    pub id: String,
    pub name: String,
    pub redirect_uris: Vec<String>,
    pub created_at: u64,
    #[serde(default)]
    pub ever_approved: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Grant {
    pub id: String,
    pub client_id: String,
    pub client_name: String,
    pub resource: String,
    pub config: McpConfig,
    pub approved_at: u64,
    pub expires_at: u64,
    // Only SHA-256 hashes of random 256-bit refresh tokens are persisted.
    // Raw access/refresh tokens and authorization codes never enter the database.
    pub refresh_hash: String,
    pub used_refresh_hashes: Vec<String>,
}

pub(super) fn load(db: &Database) -> Result<Stored, String> {
    let raw: Option<String> = db
        .conn()
        .query_row("SELECT value FROM mcp_oauth_state WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|_| "Cannot load MCP authorizations")?;
    match raw {
        Some(raw) => serde_json::from_str(&raw)
            .map_err(|_| "Cannot read MCP authorizations; access remains disabled".into()),
        None => Ok(Stored::default()),
    }
}

pub(super) fn save(db: &Database, value: &Stored) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|_| "Cannot encode MCP authorizations")?;
    db.conn().execute("INSERT INTO mcp_oauth_state(id,value) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value", [json])
        .map_err(|_| "Cannot save MCP authorizations")?;
    Ok(())
}

impl Grant {
    pub fn summary(&self) -> AuthorizedClient {
        AuthorizedClient {
            id: self.id.clone(),
            name: self.client_name.clone(),
            approved_at: self.approved_at,
            expires_at: self.expires_at,
            profile_ids: self.config.profile_ids.clone(),
            allow_execution: self.config.allow_execution,
            allow_sftp_read: self.config.allow_sftp_read,
            allow_sftp_write: self.config.allow_sftp_write,
        }
    }
}
