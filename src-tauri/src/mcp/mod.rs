//! Opt-in, loopback-only MCP adapter. Tokens and grants exist only for this app run.
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
}

struct Running {
    endpoint: String,
    token: Arc<Zeroizing<String>>,
    config: McpConfig,
    handler: CygnusMcp,
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
}

#[derive(Clone)]
struct Auth {
    token: Arc<Zeroizing<String>>,
    shutdown: CancellationToken,
    requests: Arc<Semaphore>,
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
    if request
        .headers()
        .get_all(header::AUTHORIZATION)
        .iter()
        .count()
        != 1
        || !provided.is_some_and(|value| bool::from(value.as_bytes().ct_eq(auth.token.as_bytes())))
    {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer realm=\"cygnus\"")],
        )
            .into_response();
    }
    let Ok(_permit) = auth.requests.try_acquire() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    tokio::select! {
        biased;
        _ = auth.shutdown.cancelled() => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        response = next.run(request) => response,
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
        let handler = CygnusMcp {
            backend: self.backend.clone(),
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
        };
        let shutdown = CancellationToken::new();
        let service_config = StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .with_allowed_hosts([format!("127.0.0.1:{port}"), format!("localhost:{port}")])
            // Native local clients only. Any browser Origin is rejected; no CORS exposure.
            .enforce_origin_validation()
            .with_max_request_body_bytes(128 * 1024)
            .with_cancellation_token(shutdown.child_token());
        let service_handler = handler.clone();
        let service = StreamableHttpService::new(
            move || Ok(service_handler.clone()),
            Arc::new(LocalSessionManager::default()),
            service_config,
        );
        let router =
            Router::new()
                .route_service("/mcp", service)
                .layer(middleware::from_fn_with_state(
                    Auth {
                        token: token.clone(),
                        shutdown: shutdown.clone(),
                        requests: Arc::new(Semaphore::new(32)),
                    },
                    authenticate,
                ));
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
            endpoint: format!("http://127.0.0.1:{port}/mcp"),
            token,
            config,
            handler,
            shutdown,
            task,
        });
        Ok(Self::status_of(running.as_ref()))
    }

    pub async fn status(&self) -> McpStatus {
        Self::status_of(self.running.lock().await.as_ref())
    }

    fn status_of(running: Option<&Running>) -> McpStatus {
        match running {
            Some(server) => McpStatus {
                running: !server.task.is_finished(),
                endpoint: Some(server.endpoint.clone()),
                token: Some(server.token.to_string()),
                config: Some(server.config.clone()),
            },
            None => McpStatus::default(),
        }
    }

    pub async fn stop(&self) {
        let mut running = self.running.lock().await;
        if let Some(mut server) = running.take() {
            server.shutdown.cancel();
            server.handler.revoke().await;
            let _ = tokio::time::timeout(Duration::from_secs(2), &mut server.task).await;
            // Accepted streams observe shutdown independently of the listener task.
            // Drop also aborts the listener if its grace period elapsed.
        }
    }
}

#[cfg(test)]
mod sftp_tests;
#[cfg(test)]
mod tests;
