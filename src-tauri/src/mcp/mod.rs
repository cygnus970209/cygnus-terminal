//! Opt-in, loopback-only MCP adapter with desktop-approved OAuth and legacy tokens.
pub mod oauth;
mod sftp;
mod sftp_stream;
mod tools;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::serve::Listener;
use axum::Router;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, RwLock, Semaphore};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use zeroize::Zeroizing;

use crate::cancellable_io::CancellableIo;
use crate::crypto::CryptoManager;
use crate::db::Database;
use crate::execution::ExecutionManager;
use crate::ssh::SshManager;
use tools::{Access, Backend, CygnusMcp};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct McpConfig {
    /// Zero selects an unused port; the settings UI defaults to 38473.
    pub port: u16,
    pub profile_ids: Vec<i64>,
    pub allow_execution: bool,
    #[serde(default)]
    pub allow_sftp_read: bool,
    #[serde(default)]
    pub allow_sftp_write: bool,
    /// Explicit acknowledgement of the security/privacy notice for this activation.
    #[serde(default)]
    pub acknowledge_risks: bool,
}

#[derive(Clone, Default, Serialize)]
pub struct McpStatus {
    pub running: bool,
    pub endpoint: Option<String>,
    // Returned only over trusted desktop IPC, never through MCP or logs.
    pub token: Option<String>,
    pub config: Option<McpConfig>,
    pub saved_config: Option<McpConfig>,
}

struct Running {
    endpoint: String,
    token: Arc<Zeroizing<String>>,
    config: McpConfig,
    handler: CygnusMcp,
    oauth: Arc<oauth::OAuth>,
    shutdown: CancellationToken,
    task: JoinHandle<()>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.shutdown.cancel();
        self.handler.access.sftp_cancel.cancel();
        self.task.abort();
    }
}

pub struct McpManager {
    backend: Backend,
    running: Mutex<Option<Running>>,
    oauth_notifier: Option<oauth::Notifier>,
}

#[derive(Clone)]
struct Auth {
    token: Arc<Zeroizing<String>>,
    shutdown: CancellationToken,
    requests: Arc<Semaphore>,
    oauth: Arc<oauth::OAuth>,
}

/// Axum's connection tasks outlive the listener task. Propagate shutdown to
/// accepted sockets too, including clients that have not finished HTTP headers.
struct McpListener {
    inner: TcpListener,
    shutdown: CancellationToken,
}

impl Listener for McpListener {
    type Io = CancellableIo<tokio::net::TcpStream>;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (stream, address) = Listener::accept(&mut self.inner).await;
        (CancellableIo::new(stream, self.shutdown.clone()), address)
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

async fn authenticate(State(auth): State<Auth>, request: Request, next: Next) -> Response {
    if auth.shutdown.is_cancelled() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let provided = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let unique_header = request
        .headers()
        .get_all(header::AUTHORIZATION)
        .iter()
        .count()
        == 1;
    let legacy = unique_header
        && provided.is_some_and(|value| bool::from(value.as_bytes().ct_eq(auth.token.as_bytes())));
    let oauth_router = if unique_header && !legacy {
        match provided {
            Some(value) if value.len() <= 256 => auth.oauth.authorized_router(value).await,
            _ => None,
        }
    } else {
        None
    };
    if !legacy && oauth_router.is_none() {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, format!("Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\", scope=\"cygnus\"", auth.oauth.origin))],
        )
            .into_response();
    }
    let Ok(_permit) = auth.requests.try_acquire() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    tokio::select! {
        biased;
        _ = auth.shutdown.cancelled() => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        response = async {
            match oauth_router {
                Some(router) => router.oneshot(request).await.expect("infallible router"),
                None => next.run(request).await,
            }
        } => response,
    }
}

impl McpManager {
    pub fn new(
        db: Arc<Database>,
        crypto: CryptoManager,
        execution: ExecutionManager,
        ssh: SshManager,
    ) -> Self {
        Self {
            backend: Backend {
                db,
                crypto,
                execution,
                ssh,
            },
            running: Mutex::new(None),
            oauth_notifier: None,
        }
    }

    pub fn with_oauth_notifier(
        mut self,
        notify: impl Fn() -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        self.oauth_notifier = Some(Arc::new(notify));
        self
    }

    pub async fn oauth_approvals(&self) -> Vec<oauth::Approval> {
        match self.running.lock().await.as_ref() {
            Some(server) => server.oauth.approvals().await,
            None => Vec::new(),
        }
    }
    pub async fn oauth_respond(&self, id: &str, accept: bool) -> Result<(), String> {
        let running = self.running.lock().await;
        running
            .as_ref()
            .ok_or("MCP is stopped")?
            .oauth
            .respond(id, accept)
            .await
    }
    pub async fn oauth_clients(&self) -> Result<Vec<oauth::AuthorizedClient>, String> {
        match self.running.lock().await.as_ref() {
            Some(server) => Ok(server.oauth.clients().await),
            None => oauth::saved_clients(&self.backend.db),
        }
    }
    pub async fn oauth_revoke(&self, id: &str) -> Result<(), String> {
        match self.running.lock().await.as_ref() {
            Some(server) => server.oauth.revoke(id).await,
            None => oauth::revoke_saved(&self.backend.db, id),
        }
    }

    pub async fn start(&self, mut config: McpConfig) -> Result<McpStatus, String> {
        let mut running = self.running.lock().await;
        if running.is_some() {
            return Err("MCP is already running. Stop it before changing access.".into());
        }
        if !config.acknowledge_risks {
            return Err("Review and accept the security and privacy notice in Cygnus Settings > MCP before starting.".into());
        }
        if config.allow_sftp_write && !config.allow_sftp_read {
            return Err("SFTP file changes require SFTP read access".into());
        }
        config.profile_ids.sort_unstable();
        config.profile_ids.dedup();
        if config.profile_ids.is_empty() {
            return Err("Select at least one SSH profile to share".into());
        }
        let profiles = self.backend.db.list_profile_summaries()?;
        if config
            .profile_ids
            .iter()
            .any(|id| !profiles.iter().any(|p| p.id == *id && p.protocol == "ssh"))
        {
            return Err("Only existing SSH profiles may be shared".into());
        }
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port))
            .await
            .map_err(|e| format!("Cannot start local MCP server: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let token = Arc::new(Zeroizing::new(
            URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>()),
        ));
        let handler = make_handler(self.backend.clone(), &config);
        let shutdown = CancellationToken::new();
        let oauth = oauth::OAuth::new(
            self.backend.clone(),
            config.clone(),
            port,
            shutdown.clone(),
            self.oauth_notifier.clone(),
        )?;
        let router = mcp_router(handler.clone(), port, shutdown.clone())
            .layer(middleware::from_fn_with_state(
                Auth {
                    token: token.clone(),
                    shutdown: shutdown.clone(),
                    requests: Arc::new(Semaphore::new(32)),
                    oauth: oauth.clone(),
                },
                authenticate,
            ))
            .merge(oauth.routes());
        let signal = shutdown.clone();
        let listener = McpListener {
            inner: listener,
            shutdown: shutdown.clone(),
        };
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(signal.cancelled_owned())
                .await;
        });
        *running = Some(Running {
            endpoint: format!("{}/mcp", oauth.origin),
            token,
            config,
            handler,
            oauth,
            shutdown,
            task,
        });
        Ok(self.status_of(running.as_ref()))
    }

    pub async fn status(&self) -> McpStatus {
        self.status_of(self.running.lock().await.as_ref())
    }

    fn status_of(&self, running: Option<&Running>) -> McpStatus {
        match running {
            Some(server) => McpStatus {
                running: !server.task.is_finished(),
                endpoint: Some(server.endpoint.clone()),
                token: Some(server.token.to_string()),
                config: Some(server.config.clone()),
                saved_config: oauth::saved_config(&self.backend.db),
            },
            None => McpStatus {
                saved_config: oauth::saved_config(&self.backend.db),
                ..McpStatus::default()
            },
        }
    }

    pub async fn stop(&self) {
        let mut running = self.running.lock().await;
        if let Some(mut server) = running.take() {
            server.shutdown.cancel();
            server.handler.revoke().await;
            server.oauth.stop().await;
            let _ = tokio::time::timeout(Duration::from_secs(2), &mut server.task).await;
            // Accepted streams observe shutdown independently of the listener task.
            // Drop also aborts the listener if its grace period elapsed.
        }
    }
}

fn make_handler(backend: Backend, config: &McpConfig) -> CygnusMcp {
    CygnusMcp {
        backend,
        access: Arc::new(Access {
            enabled: RwLock::new(true),
            profile_ids: config.profile_ids.iter().copied().collect::<HashSet<_>>(),
            allow_execution: config.allow_execution,
            allow_sftp_read: config.allow_sftp_read,
            allow_sftp_write: config.allow_sftp_write,
            sftp_cancel: CancellationToken::new(),
            sftp_slots: Semaphore::new(4),
            jobs: Mutex::new(Vec::new()),
        }),
    }
}

fn mcp_router(handler: CygnusMcp, port: u16, shutdown: CancellationToken) -> Router {
    let mut hosts = vec![format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    if port == 80 {
        hosts.extend(["127.0.0.1".into(), "localhost".into()]);
    }
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_allowed_hosts(hosts)
        .enforce_origin_validation()
        .with_max_request_body_bytes(128 * 1024)
        .with_cancellation_token(shutdown);
    let router = Router::new().route_service(
        "/mcp",
        StreamableHttpService::new(
            move || Ok(handler.clone()),
            Arc::new(LocalSessionManager::default()),
            config,
        ),
    );
    if port == 80 {
        // rmcp interprets a portless allowed host as any port. Keep the default
        // HTTP case exact while accepting both valid Host representations.
        router.layer(middleware::from_fn(default_http_host))
    } else {
        router
    }
}

async fn default_http_host(request: Request, next: Next) -> Response {
    match request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
    {
        Some("127.0.0.1" | "127.0.0.1:80" | "localhost" | "localhost:80") => {
            next.run(request).await
        }
        _ => StatusCode::FORBIDDEN.into_response(),
    }
}

#[cfg(test)]
mod sftp_tests;
#[cfg(test)]
mod tests;
