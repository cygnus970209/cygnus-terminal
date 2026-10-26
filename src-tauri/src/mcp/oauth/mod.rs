//! Local OAuth authorization-code + S256 PKCE flow. Human consent is desktop IPC only.
//! Browser routes can request and observe authorization, never approve it.
mod http;
mod store;
#[cfg(test)]
mod tests;

use super::*;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use store::{Client, Grant, Stored};
use url::Url;

const APPROVAL_TTL: u64 = 300;
const CODE_TTL: u64 = 60;
const ACCESS_TTL: u64 = 900;
const REFRESH_TTL: u64 = 90 * 24 * 60 * 60;
const SCOPE: &str = "cygnus";

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}
fn hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}
fn equal(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

#[derive(Clone, Serialize)]
pub struct Approval {
    pub id: String,
    pub client_name: String,
    pub redirect_uri: String,
    pub verification_code: String,
    pub expires_at: u64,
    pub profile_ids: Vec<i64>,
    pub allow_execution: bool,
    pub allow_sftp_read: bool,
    pub allow_sftp_write: bool,
}

#[derive(Serialize)]
pub struct AuthorizedClient {
    pub id: String,
    pub name: String,
    pub approved_at: u64,
    pub expires_at: u64,
    pub profile_ids: Vec<i64>,
    pub allow_execution: bool,
    pub allow_sftp_read: bool,
    pub allow_sftp_write: bool,
}

pub type Notifier = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

struct Pending {
    approval: Approval,
    client: Client,
    redirect_uri: String,
    state: Option<String>,
    challenge: String,
    decision: Option<bool>,
}
struct Code {
    pending: Pending,
    expires_at: u64,
}
struct AccessToken {
    grant_id: String,
    expires_at: u64,
}
struct GrantRuntime {
    handler: CygnusMcp,
    router: Router,
    shutdown: CancellationToken,
}
struct Inner {
    stored: Stored,
    pending: HashMap<String, Pending>,
    codes: HashMap<String, Code>,
    tokens: HashMap<String, AccessToken>,
    runtimes: HashMap<String, GrantRuntime>,
    rates: HashMap<&'static str, Vec<u64>>,
}

pub(super) struct OAuth {
    backend: Backend,
    config: McpConfig,
    port: u16,
    pub(super) origin: String,
    resource: String,
    shutdown: CancellationToken,
    notify: Option<Notifier>,
    requests: Semaphore,
    inner: Mutex<Inner>,
}

impl OAuth {
    pub fn new(
        backend: Backend,
        config: McpConfig,
        port: u16,
        shutdown: CancellationToken,
        notify: Option<Notifier>,
    ) -> Result<Arc<Self>, String> {
        let mut stored = store::load(&backend.db)?;
        stored.grants.retain(|g| g.expires_at > now());
        stored.clients.retain(|c| {
            c.ever_approved
                || c.created_at + 3600 > now()
                || stored.grants.iter().any(|g| g.client_id == c.id)
        });
        // Cursor desktop's dynamic registration also advertises a cloud callback.
        // A public, pre-registered desktop ID keeps this integration on loopback.
        if !stored
            .clients
            .iter()
            .any(|c| c.id == "cygnus-cursor-desktop")
        {
            stored.clients.push(Client {
                id: "cygnus-cursor-desktop".into(),
                name: "Cursor desktop".into(),
                redirect_uris: vec!["http://localhost:8787/callback".into()],
                created_at: now(),
                ever_approved: true,
            });
        }
        let mut saved_config = config.clone();
        saved_config.port = port;
        stored.last_config = Some(saved_config);
        store::save(&backend.db, &stored)?;
        // HTTP clients normalize the default port out of URLs and Host headers.
        let origin = if port == 80 {
            "http://127.0.0.1".to_owned()
        } else {
            format!("http://127.0.0.1:{port}")
        };
        Ok(Arc::new(Self {
            backend,
            config,
            port,
            resource: format!("{origin}/mcp"),
            origin,
            shutdown,
            notify,
            requests: Semaphore::new(16),
            inner: Mutex::new(Inner {
                stored,
                pending: HashMap::new(),
                codes: HashMap::new(),
                tokens: HashMap::new(),
                runtimes: HashMap::new(),
                rates: HashMap::new(),
            }),
        }))
    }

    pub async fn approvals(&self) -> Vec<Approval> {
        let mut inner = self.inner.lock().await;
        inner.clean();
        let mut result: Vec<_> = inner
            .pending
            .values()
            .filter(|p| p.decision.is_none())
            .map(|p| p.approval.clone())
            .collect();
        result.sort_by_key(|p| p.expires_at);
        result
    }

    pub async fn respond(&self, id: &str, accept: bool) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        inner.clean();
        if self.shutdown.is_cancelled() {
            return Err("MCP has stopped".into());
        }
        let pending = inner
            .pending
            .values_mut()
            .find(|p| p.approval.id == id && p.decision.is_none())
            .ok_or("This authorization request has expired or was already handled")?;
        pending.decision = Some(accept);
        Ok(())
    }

    pub async fn clients(&self) -> Vec<AuthorizedClient> {
        self.inner
            .lock()
            .await
            .stored
            .grants
            .iter()
            .filter(|g| g.expires_at > now())
            .map(Grant::summary)
            .collect()
    }

    pub async fn revoke(&self, id: &str) -> Result<(), String> {
        let runtime = {
            let mut inner = self.inner.lock().await;
            let mut next = inner.stored.clone();
            next.grants.retain(|g| g.id != id);
            store::save(&self.backend.db, &next)?;
            inner.stored = next;
            inner.tokens.retain(|_, t| t.grant_id != id);
            inner.runtimes.remove(id)
        };
        if let Some(runtime) = runtime {
            runtime.shutdown.cancel();
            runtime.handler.revoke().await;
        }
        Ok(())
    }

    pub async fn stop(&self) {
        let runtimes = {
            let mut inner = self.inner.lock().await;
            inner.pending.clear();
            inner.codes.clear();
            inner.tokens.clear();
            inner.runtimes.drain().map(|(_, r)| r).collect::<Vec<_>>()
        };
        for runtime in runtimes {
            runtime.shutdown.cancel();
            runtime.handler.revoke().await;
        }
    }

    pub async fn authorized_router(&self, token: &str) -> Option<Router> {
        let mut inner = self.inner.lock().await;
        inner.clean();
        let grant_id = inner.tokens.get(&hash(token))?.grant_id.clone();
        let grant = inner
            .stored
            .grants
            .iter()
            .find(|g| g.id == grant_id && g.expires_at > now() && g.resource == self.resource)?
            .clone();
        let runtime = inner.runtimes.entry(grant_id).or_insert_with(|| {
            // A saved approval is an upper bound: changing Settings cannot expand it.
            let mut config = grant.config;
            config
                .profile_ids
                .retain(|id| self.config.profile_ids.contains(id));
            config.allow_execution &= self.config.allow_execution;
            config.allow_sftp_read &= self.config.allow_sftp_read;
            config.allow_sftp_write &= self.config.allow_sftp_write;
            let handler = make_handler(self.backend.clone(), &config);
            let shutdown = self.shutdown.child_token();
            let router = mcp_router(handler.clone(), self.port, shutdown.clone());
            GrantRuntime {
                handler,
                router,
                shutdown,
            }
        });
        Some(runtime.router.clone())
    }

    pub fn routes(self: &Arc<Self>) -> Router {
        http::routes(self.clone())
    }
}

impl Inner {
    fn clean(&mut self) {
        let time = now();
        self.pending.retain(|_, p| p.approval.expires_at > time);
        self.codes.retain(|_, c| c.expires_at > time);
        self.tokens.retain(|_, t| t.expires_at > time);
    }
    fn rate(&mut self, key: &'static str, limit: usize) -> bool {
        let times = self.rates.entry(key).or_default();
        times.retain(|t| *t + 60 > now());
        if times.len() >= limit {
            return false;
        }
        times.push(now());
        true
    }
}

pub(super) fn saved_config(db: &Database) -> Option<McpConfig> {
    store::load(db).ok()?.last_config
}
pub(super) fn saved_clients(db: &Database) -> Result<Vec<AuthorizedClient>, String> {
    Ok(store::load(db)?
        .grants
        .iter()
        .filter(|g| g.expires_at > now())
        .map(Grant::summary)
        .collect())
}
pub(super) fn revoke_saved(db: &Database, id: &str) -> Result<(), String> {
    let mut stored = store::load(db)?;
    stored.grants.retain(|g| g.id != id);
    store::save(db, &stored)
}
