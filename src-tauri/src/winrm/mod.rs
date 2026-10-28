//! WinRM command sessions. Each execution has its own non-interactive PowerShell process.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use winrm_rs::{AuthMethod, WinrmClient, WinrmConfig, WinrmCredentials};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Https,
    Http,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Authentication {
    Ntlm,
    Basic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub domain: String,
    pub transport: Transport,
    pub authentication: Authentication,
    #[serde(default)]
    pub certificate_pin: String,
}
impl Config {
    pub fn validate(&self) -> Result<(), String> {
        // Accept a bare DNS name, IPv4 or IPv6 address, never URL user info or paths.
        let host = self.host.trim_matches(['[', ']']);
        let ip = host.parse::<std::net::IpAddr>().is_ok();
        if self.host.is_empty()
            || self.host.len() > 253
            || self.host.trim() != self.host
            || (!ip
                && (self.host.contains([':', '[', ']'])
                    || !self
                        .host
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')))
            || self.port == 0
        {
            return Err("Enter a host name or IP address and a port between 1 and 65535".into());
        }
        if self.username.trim().is_empty()
            || self.username.len() > 256
            || self.domain.len() > 256
            || self
                .username
                .chars()
                .chain(self.domain.chars())
                .any(char::is_control)
        {
            return Err("Enter a valid Windows account and domain".into());
        }
        if self.username.contains('\\') {
            return Err("Enter the domain separately from the username".into());
        }
        if self.transport == Transport::Http && self.authentication == Authentication::Basic {
            return Err("Basic authentication requires HTTPS".into());
        }
        if !self.certificate_pin.is_empty() {
            let pin = self.certificate_pin.replace(':', "");
            if self.transport != Transport::Https
                || pin.len() != 64
                || !pin.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("Enter a SHA-256 certificate fingerprint for HTTPS".into());
            }
        }
        Ok(())
    }
    pub fn same_account(&self, other: &Self) -> bool {
        self.host == other.host
            && self.port == other.port
            && self.username == other.username
            && self.domain == other.domain
            && self.transport == other.transport
    }
    fn endpoint_host(&self) -> String {
        let host = self.host.trim_matches(['[', ']']);
        match host.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V6(ip)) => format!("[{ip}]"),
            Ok(ip) => ip.to_string(),
            Err(_) => self.host.clone(),
        }
    }
    fn client(&self, password: &str) -> Result<WinrmClient, String> {
        self.validate()?;
        let config = WinrmConfig {
            port: Some(self.port),
            use_tls: self.transport == Transport::Https,
            auth_method: match self.authentication {
                Authentication::Ntlm => AuthMethod::Ntlm,
                Authentication::Basic => AuthMethod::Basic,
            },
            connect_timeout_secs: 10,
            operation_timeout_secs: 20,
            max_output_bytes: Some(1024 * 1024),
            max_retries: 0,
            idle_timeout_secs: Some(60),
            ..WinrmConfig::default()
        };
        let mut builder = WinrmClient::builder(config)
            .platform_roots(true)
            .credentials(WinrmCredentials::new(
                &self.username,
                password,
                &self.domain,
            ));
        if !self.certificate_pin.is_empty() {
            builder = builder.pin_server_certificate_sha256(&self.certificate_pin);
        }
        builder.build().map_err(|e| e.to_string())
    }
}

#[derive(Debug, Serialize)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}
struct Session {
    client: WinrmClient,
    host: String,
    closed: CancellationToken,
    ready: AtomicBool,
    running: Mutex<Option<CancellationToken>>,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}
#[derive(Default)]
pub struct WinrmManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}
impl Drop for WinrmManager {
    fn drop(&mut self) {
        for session in self.sessions.get_mut().values() {
            session.closed.cancel();
        }
    }
}

async fn execute(
    session: &Session,
    script: &str,
    token: CancellationToken,
    seconds: u64,
) -> Result<Output, String> {
    let future = session
        .client
        .run_powershell_with_cancel(&session.host, script, token.clone());
    tokio::pin!(future);
    let result = tokio::select! {
        result = &mut future => result.map_err(|e| e.to_string()),
        _ = tokio::time::sleep(Duration::from_secs(seconds)) => {
            token.cancel();
            // Let the library terminate the remote command and delete its shell.
            let _ = future.await;
            Err("WinRM operation timed out".into())
        }
    }?;
    Ok(Output {
        stdout: String::from_utf8_lossy(&result.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&result.stderr).into_owned(),
        exit_code: result.exit_code,
    })
}
impl WinrmManager {
    pub async fn connect(
        &self,
        id: String,
        config: Config,
        password: Zeroizing<String>,
    ) -> Result<(), String> {
        if uuid::Uuid::parse_str(&id).is_err() {
            return Err("Invalid WinRM session ID".into());
        }
        if password.is_empty() {
            return Err("Enter a password for this Windows account".into());
        }
        let session = Arc::new(Session {
            client: config.client(&password)?,
            host: config.endpoint_host(),
            closed: CancellationToken::new(),
            ready: AtomicBool::new(false),
            running: Mutex::new(None),
        });
        {
            let mut sessions = self.sessions.lock().await;
            if sessions.len() >= 16 {
                return Err("Up to 16 WinRM sessions can be open".into());
            }
            if sessions.contains_key(&id) {
                return Err("WinRM session already exists".into());
            }
            sessions.insert(id.clone(), session.clone());
        }
        let result = execute(
            &session,
            "$PSVersionTable.PSVersion.ToString()",
            session.closed.child_token(),
            30,
        )
        .await
        .and_then(|output| {
            if output.exit_code == 0 {
                Ok(())
            } else {
                Err("Could not start remote PowerShell".into())
            }
        });
        if result.is_err() || session.closed.is_cancelled() {
            self.sessions.lock().await.remove(&id);
            return result.and(Err("WinRM connection cancelled".into()));
        }
        session.ready.store(true, Ordering::Release);
        Ok(())
    }
    pub async fn run(&self, id: &str, script: &str) -> Result<Output, String> {
        if script.trim().is_empty() || script.len() > 16 * 1024 {
            return Err("Enter a PowerShell script of at most 16 KiB".into());
        }
        let session = self
            .sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or("WinRM session is closed")?;
        let token = session.closed.child_token();
        {
            let mut running = session.running.lock().await;
            if !session.ready.load(Ordering::Acquire) || session.closed.is_cancelled() {
                return Err("WinRM session is not connected".into());
            }
            if running.is_some() {
                return Err("A WinRM command is already running".into());
            }
            *running = Some(token.clone());
        }
        let result = execute(&session, script, token, 300).await;
        *session.running.lock().await = None;
        result
    }
    pub async fn cancel(&self, id: &str) {
        let session = self.sessions.lock().await.get(id).cloned();
        if let Some(session) = session {
            if let Some(token) = session.running.lock().await.as_ref() {
                token.cancel();
            }
        }
    }
    pub async fn close(&self, id: &str) {
        if let Some(session) = self.sessions.lock().await.remove(id) {
            session.closed.cancel();
        }
    }
}

#[cfg(test)]
mod tests;
