//! Profile-based, non-interactive SSH jobs shared by future UI and MCP adapters.
//! No PTY, terminal tab, or frontend event channel is required.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use russh::{ChannelMsg, Sig};
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Mutex};
use zeroize::Zeroize;

use crate::crypto::CryptoManager;
use crate::db::profile::Profile;
use crate::db::Database;
use crate::ssh::{JumpHostConfig, SshManager};

const MAX_ACTIVE_JOBS: usize = 16;
const DEFAULT_OUTPUT_LIMIT: usize = 1024 * 1024;
const MAX_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
pub struct StartExecutionRequest {
    pub profile_id: i64,
    pub command: String,
    /// Total budget for connection, authentication, channel opening and execution.
    pub timeout_seconds: Option<u64>,
    /// Combined stdout/stderr byte budget. Excess is drained but not retained.
    pub output_limit_bytes: Option<usize>,
}

impl StartExecutionRequest {
    fn validate(&self) -> Result<(), String> {
        if self.profile_id <= 0 {
            return Err("A saved SSH profile is required".into());
        }
        if self.command.trim().is_empty()
            || self.command.contains('\0')
            || self.command.len() > 65536
        {
            return Err("Command must contain 1–65536 bytes and no NUL characters".into());
        }
        if !(1..=3600).contains(&self.timeout_seconds.unwrap_or(120)) {
            return Err("timeout_seconds must be between 1 and 3600".into());
        }
        if !(1..=MAX_OUTPUT_LIMIT)
            .contains(&self.output_limit_bytes.unwrap_or(DEFAULT_OUTPUT_LIMIT))
        {
            return Err("output_limit_bytes must be between 1 and 4194304".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Connecting,
    Running,
    Cancelling,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    Interrupted,
}

impl ExecutionStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Connecting | Self::Running | Self::Cancelling)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecutionSummary {
    pub id: String,
    pub profile_id: i64,
    // Snapshot keeps history meaningful if the profile is edited or deleted.
    pub profile_name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub environment: String,
    pub command: String,
    pub timeout_seconds: u64,
    pub output_limit_bytes: usize,
    pub status: ExecutionStatus,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub exit_code: Option<u32>,
    pub exit_signal: Option<String>,
    pub output_truncated: bool,
    /// True once exec may have reached the server, until an exit result is received.
    /// Cancellation/timeout is not proof that the remote process has stopped.
    pub remote_outcome_unknown: bool,
    pub error: Option<String>,
    pub persistence_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecutionJob {
    #[serde(flatten)]
    pub summary: ExecutionSummary,
    pub stdout: String,
    pub stderr: String,
}

struct JobState {
    summary: ExecutionSummary,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl JobState {
    fn snapshot(&self) -> ExecutionJob {
        // Decode the accumulated bytes, not individual SSH packets: UTF-8 may span packets.
        ExecutionJob {
            summary: self.summary.clone(),
            stdout: String::from_utf8_lossy(&self.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&self.stderr).into_owned(),
        }
    }

    fn append(&mut self, data: &[u8], stderr: bool) {
        let available = self
            .summary
            .output_limit_bytes
            .saturating_sub(self.stdout.len() + self.stderr.len());
        let count = data.len().min(available);
        self.summary.output_truncated |= count < data.len();
        let output = if stderr {
            &mut self.stderr
        } else {
            &mut self.stdout
        };
        output.extend_from_slice(&data[..count]);
    }
}

struct ActiveJob {
    state: Arc<Mutex<JobState>>,
    cancel: watch::Sender<bool>,
}

/// Resolved secrets live only for connection/authentication, never in job records.
struct Target {
    profile: Profile,
    jump: Option<JumpHostConfig>,
}

impl Target {
    fn resolve(db: &Database, crypto: &CryptoManager, profile_id: i64) -> Result<Self, String> {
        let mut target = Self {
            profile: db.get_profile(profile_id, crypto)?,
            jump: None,
        };
        if target.profile.protocol != "ssh" {
            return Err("Execution jobs support SSH profiles only".into());
        }
        target.jump = target
            .profile
            .jump_host
            .as_deref()
            .filter(|raw| !raw.is_empty())
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| "Invalid jump host configuration".to_string())?;
        Ok(target)
    }
}

impl Drop for Target {
    fn drop(&mut self) {
        if let Some(value) = &mut self.profile.password {
            value.zeroize();
        }
        if let Some(value) = &mut self.profile.jump_host {
            value.zeroize();
        }
        if let Some(value) = self.jump.as_mut().and_then(|jump| jump.password.as_mut()) {
            value.zeroize();
        }
    }
}

#[derive(Clone)]
pub struct ExecutionManager {
    db: Arc<Database>,
    active: Arc<Mutex<HashMap<String, ActiveJob>>>,
}

impl ExecutionManager {
    /// Called once at application startup. Never automatically replay interrupted commands.
    pub fn new(db: Arc<Database>) -> Result<Self, String> {
        db.recover_execution_jobs()?;
        Ok(Self {
            db,
            active: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn start(
        &self,
        req: StartExecutionRequest,
        crypto: &CryptoManager,
        ssh: SshManager,
    ) -> Result<String, String> {
        req.validate()?;
        // Resolve before creating a job: KEYCHAIN_CONSENT_REQUIRED can safely retry submission.
        let target = Target::resolve(&self.db, crypto, req.profile_id)?;
        let mut active = self.active.lock().await;
        if active.len() >= MAX_ACTIVE_JOBS {
            return Err("Too many active execution jobs (maximum 16)".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let state = Arc::new(Mutex::new(JobState {
            summary: ExecutionSummary {
                id: id.clone(),
                profile_id: req.profile_id,
                profile_name: target.profile.name.clone(),
                host: target.profile.host.clone(),
                port: target.profile.port,
                username: target.profile.username.clone(),
                environment: target.profile.environment.clone(),
                command: req.command,
                timeout_seconds: req.timeout_seconds.unwrap_or(120),
                output_limit_bytes: req.output_limit_bytes.unwrap_or(DEFAULT_OUTPUT_LIMIT),
                status: ExecutionStatus::Connecting,
                started_at: Utc::now().to_rfc3339(),
                finished_at: None,
                duration_ms: None,
                exit_code: None,
                exit_signal: None,
                output_truncated: false,
                remote_outcome_unknown: false,
                error: None,
                persistence_error: None,
            },
            stdout: Vec::new(),
            stderr: Vec::new(),
        }));
        self.db.save_execution_job(&state.lock().await.snapshot())?;
        let (cancel, receiver) = watch::channel(false);
        active.insert(
            id.clone(),
            ActiveJob {
                state: state.clone(),
                cancel,
            },
        );
        let manager = self.clone();
        tokio::spawn(async move {
            manager.run(state, target, ssh, receiver).await;
        });
        Ok(id)
    }

    pub async fn get(&self, id: &str) -> Result<ExecutionJob, String> {
        let active = self.active.lock().await;
        if let Some(job) = active.get(id) {
            return Ok(job.state.lock().await.snapshot());
        }
        self.db.get_execution_job(id)
    }

    /// Recent jobs, without output bodies. Active jobs retain their persisted ordering.
    pub async fn list(&self, limit: u32, offset: u32) -> Result<Vec<ExecutionSummary>, String> {
        let active = self.active.lock().await;
        let mut jobs = self.db.list_execution_jobs(limit.clamp(1, 100), offset)?;
        for summary in &mut jobs {
            if let Some(job) = active.get(&summary.id) {
                *summary = job.state.lock().await.summary.clone();
            }
        }
        Ok(jobs)
    }

    pub async fn get_summary(&self, id: &str) -> Result<ExecutionSummary, String> {
        let active = self.active.lock().await;
        if let Some(job) = active.get(id) {
            return Ok(job.state.lock().await.summary.clone());
        }
        self.db.get_execution_summary(id)
    }

    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        let active = self.active.lock().await;
        if let Some(job) = active.get(id) {
            let mut state = job.state.lock().await;
            if !state.summary.status.is_terminal() {
                state.summary.status = ExecutionStatus::Cancelling;
                job.cancel.send_replace(true);
            }
            return Ok(());
        }
        // Cancellation of an already completed job is an idempotent no-op.
        self.db.get_execution_summary(id).map(|_| ())
    }

    async fn run(
        &self,
        state: Arc<Mutex<JobState>>,
        target: Target,
        ssh: SshManager,
        mut cancel: watch::Receiver<bool>,
    ) {
        let started = Instant::now();
        let timeout = Duration::from_secs(state.lock().await.summary.timeout_seconds);
        // Held outside the selected future so timeout/cancel can still close the channel.
        let mut channel = None;
        let mut connection = None;
        let cancellation = cancel.clone();
        let operation = async {
            connection = Some(
                ssh.connect_transport(
                    None,
                    &target.profile.host,
                    target.profile.port,
                    &target.profile.username,
                    &target.profile.auth_type,
                    target.profile.password.as_deref(),
                    target.profile.key_path.as_deref(),
                    target.jump.as_ref(),
                )
                .await?,
            );
            drop(target);
            channel = Some(
                connection
                    .as_ref()
                    .expect("connected")
                    .handle
                    .channel_open_session()
                    .await
                    .map_err(|e| format!("Channel open failed: {e}"))?,
            );
            let channel = channel.as_mut().expect("opened channel");
            let command = {
                let mut state = state.lock().await;
                if *cancellation.borrow() {
                    return Err("Execution cancelled before dispatch".to_string());
                }
                state.summary.status = ExecutionStatus::Running;
                // Persist uncertainty BEFORE sending exec, including the crash window.
                state.summary.remote_outcome_unknown = true;
                if let Err(error) = self.db.save_execution_job(&state.snapshot()) {
                    state.summary.remote_outcome_unknown = false;
                    return Err(error);
                }
                state.summary.command.clone()
            };
            channel
                .exec(true, command.as_bytes())
                .await
                .map_err(|e| format!("Exec request failed: {e}"))?;
            // No interactive stdin in this API. Commands like `cat` must receive EOF.
            channel
                .eof()
                .await
                .map_err(|e| format!("Stdin close failed: {e}"))?;
            while let Some(msg) = channel.wait().await {
                let mut state = state.lock().await;
                match msg {
                    ChannelMsg::Data { data } => state.append(&data, false),
                    ChannelMsg::ExtendedData { data, ext: 1 } => state.append(&data, true),
                    ChannelMsg::ExitStatus { exit_status } => {
                        state.summary.exit_code = Some(exit_status);
                        state.summary.remote_outcome_unknown = false;
                    }
                    ChannelMsg::ExitSignal { signal_name, .. } => {
                        state.summary.exit_signal = Some(format!("{signal_name:?}"));
                        state.summary.remote_outcome_unknown = false;
                    }
                    ChannelMsg::Failure => {
                        state.summary.remote_outcome_unknown = false;
                        return Err("Server rejected the exec request".into());
                    }
                    // EOF ends output, not the job: exit-status may follow it.
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            let state = state.lock().await;
            match (state.summary.exit_code, state.summary.exit_signal.as_ref()) {
                (Some(0), None) => Ok(()),
                (Some(code), _) => Err(format!("Command exited with status {code}")),
                (_, Some(signal)) => Err(format!("Command terminated by signal {signal}")),
                _ => Err(
                    "SSH channel closed without an exit result; remote outcome is unknown".into(),
                ),
            }
        };
        let outcome = tokio::select! {
            biased;
            _ = async { if !*cancel.borrow() { let _ = cancel.changed().await; } } =>
                (ExecutionStatus::Cancelled, Some("Cancellation requested; remote termination is not confirmed".into())),
            _ = tokio::time::sleep(timeout) =>
                (ExecutionStatus::TimedOut, Some("Execution deadline exceeded".into())),
            result = operation => match result {
                Ok(()) => (ExecutionStatus::Succeeded, None),
                Err(error) => (ExecutionStatus::Failed, Some(error)),
            },
        };
        if let Some(channel) = channel {
            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                if matches!(
                    outcome.0,
                    ExecutionStatus::Cancelled | ExecutionStatus::TimedOut
                ) {
                    let _ = channel.signal(Sig::TERM).await;
                }
                let _ = channel.close().await;
            })
            .await;
        }
        drop(connection);
        let snapshot = {
            let mut state = state.lock().await;
            state.summary.status = outcome.0;
            state.summary.error = outcome.1;
            state.summary.finished_at = Some(Utc::now().to_rfc3339());
            state.summary.duration_ms = Some(started.elapsed().as_millis() as u64);
            state.snapshot()
        };
        match self.db.save_execution_job(&snapshot) {
            Ok(()) => {
                self.active.lock().await.remove(&snapshot.summary.id);
            }
            Err(error) => {
                // Keep the final result queryable in memory if disk writes fail.
                state.lock().await.summary.persistence_error = Some(error);
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
