//! Profile-based SSH jobs. MCP jobs require an attached local PTY monitor.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use russh::{ChannelMsg, Sig};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch, Mutex};

use crate::crypto::CryptoManager;
use crate::db::Database;
use crate::ssh::{target::ProfileTarget, SshManager};
pub mod history;
pub mod terminal;
use history::{HistorySettings, LookupError, ResultCache};
use terminal::{TerminalControl, TerminalEvent, TerminalSink};

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
    #[serde(default)]
    pub interactive: bool,
    /// After human input, subsequent output is delivered only to the local terminal.
    #[serde(default)]
    pub output_withheld: bool,
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
    persist_history: bool,
    summary: ExecutionSummary,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    terminal: Option<TerminalSink>,
}

impl JobState {
    fn persist(&self, db: &Database) -> Result<bool, String> {
        if self.persist_history {
            db.save_execution_job(&self.snapshot())
        } else {
            Ok(false)
        }
    }
    fn snapshot(&self) -> ExecutionJob {
        // Decode the accumulated bytes, not individual SSH packets: UTF-8 may span packets.
        ExecutionJob {
            summary: self.summary.clone(),
            stdout: String::from_utf8_lossy(&self.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&self.stderr).into_owned(),
        }
    }

    fn append(&mut self, data: &[u8], stderr: bool) -> Result<(), String> {
        if self.summary.interactive {
            self.send_terminal(TerminalEvent::Output(data.to_vec()))?;
        }
        if self.summary.output_withheld {
            return Ok(());
        }
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
        Ok(())
    }
}

struct ActiveJob {
    state: Arc<Mutex<JobState>>,
    cancel: watch::Sender<bool>,
    input: Option<mpsc::Sender<TerminalControl>>,
    ready: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct ExecutionManager {
    db: Arc<Database>,
    active: Arc<Mutex<HashMap<String, ActiveJob>>>,
    completed: Arc<Mutex<ResultCache>>,
    terminal_notifier: Option<Arc<dyn Fn(ExecutionSummary) -> Result<(), String> + Send + Sync>>,
}

impl ExecutionManager {
    /// Called once at application startup. Never automatically replay interrupted commands.
    pub fn new(db: Arc<Database>) -> Result<Self, String> {
        db.recover_execution_jobs()?;
        db.prune_execution_history()?;
        Ok(Self {
            db,
            active: Arc::new(Mutex::new(HashMap::new())),
            completed: Arc::new(Mutex::new(ResultCache::default())),
            terminal_notifier: None,
        })
    }

    pub async fn start(
        &self,
        req: StartExecutionRequest,
        crypto: &CryptoManager,
        ssh: SshManager,
    ) -> Result<String, String> {
        self.start_job(req, crypto, ssh, false).await
    }

    pub async fn start_interactive(
        &self,
        req: StartExecutionRequest,
        crypto: &CryptoManager,
        ssh: SshManager,
    ) -> Result<String, String> {
        if self.terminal_notifier.is_none() {
            return Err("The Cygnus terminal monitor is unavailable".into());
        }
        self.start_job(req, crypto, ssh, true).await
    }

    async fn start_job(
        &self,
        req: StartExecutionRequest,
        crypto: &CryptoManager,
        ssh: SshManager,
        interactive: bool,
    ) -> Result<String, String> {
        req.validate()?;
        // Resolve before creating a job: KEYCHAIN_CONSENT_REQUIRED can safely retry submission.
        let target = ProfileTarget::resolve(&self.db, crypto, req.profile_id)?;
        let mut active = self.active.lock().await;
        if active.len() >= MAX_ACTIVE_JOBS {
            return Err("Too many active execution jobs (maximum 16)".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let state = Arc::new(Mutex::new(JobState {
            persist_history: self.db.execution_history_settings()?.enabled,
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
                interactive,
                output_withheld: false,
                remote_outcome_unknown: false,
                error: None,
                persistence_error: None,
            },
            stdout: Vec::new(),
            stderr: Vec::new(),
            terminal: None,
        }));
        state.lock().await.persist(&self.db)?;
        let (cancel, receiver) = watch::channel(false);
        let (ready, readiness) = watch::channel(false);
        let (input, controls) = mpsc::channel(32);
        active.insert(
            id.clone(),
            ActiveJob {
                state: state.clone(),
                cancel,
                input: interactive.then_some(input),
                ready,
            },
        );
        drop(active);
        if interactive {
            let summary = state.lock().await.summary.clone();
            if let Err(error) = self.terminal_notifier.as_ref().expect("monitor checked")(summary) {
                // No network activity has started. Retain an explicit failure for local history.
                let mut active = self.active.lock().await;
                let mut state = state.lock().await;
                state.summary.status = ExecutionStatus::Failed;
                state.summary.error = Some("Unable to open the local terminal monitor".into());
                state.summary.finished_at = Some(Utc::now().to_rfc3339());
                if !state.persist(&self.db).unwrap_or(false) {
                    self.completed.lock().await.insert(state.snapshot());
                }
                active.remove(&id);
                return Err(error);
            }
        }
        let manager = self.clone();
        tokio::spawn(async move {
            manager
                .run(state, target, ssh, receiver, readiness, controls)
                .await;
        });
        Ok(id)
    }

    pub async fn get(&self, id: &str) -> Result<ExecutionJob, LookupError> {
        let active = self.active.lock().await;
        if let Some(job) = active.get(id) {
            return Ok(job.state.lock().await.snapshot());
        }
        let mut completed = self.completed.lock().await;
        completed.prune();
        if let Some(entry) = completed.jobs.get(id) {
            return Ok(entry.job.clone());
        }
        self.db.get_execution_job(id)
    }

    /// Merge live and retained results before pagination, without loading disk output.
    pub async fn list(&self, limit: u32, offset: u32) -> Result<Vec<ExecutionSummary>, String> {
        let active = self.active.lock().await;
        let mut completed = self.completed.lock().await;
        completed.prune();
        let mut jobs: Vec<_> = completed
            .jobs
            .values()
            .map(|entry| entry.job.summary.clone())
            .collect();
        for job in active.values() {
            jobs.push(job.state.lock().await.summary.clone());
        }
        let ids: Vec<_> = jobs.iter().map(|job| job.id.clone()).collect();
        let limit = limit.clamp(1, 100);
        let disk_offset = offset.saturating_sub(ids.len() as u32);
        jobs.extend(
            self.db
                .list_execution_jobs(limit + ids.len() as u32, disk_offset, &ids)?,
        );
        jobs.sort_by(|a, b| b.started_at.cmp(&a.started_at).then(b.id.cmp(&a.id)));
        Ok(jobs
            .into_iter()
            .skip((offset - disk_offset) as usize)
            .take(limit as usize)
            .collect())
    }

    pub async fn get_summary(&self, id: &str) -> Result<ExecutionSummary, LookupError> {
        let active = self.active.lock().await;
        if let Some(job) = active.get(id) {
            return Ok(job.state.lock().await.summary.clone());
        }
        let mut completed = self.completed.lock().await;
        completed.prune();
        if let Some(entry) = completed.jobs.get(id) {
            return Ok(entry.job.summary.clone());
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
                let _ = state.send_terminal(TerminalEvent::Status(state.summary.clone()));
            }
            return Ok(());
        }
        // Cancellation of an already completed job is an idempotent no-op.
        let mut completed = self.completed.lock().await;
        completed.prune();
        if completed.jobs.contains_key(id) {
            return Ok(());
        }
        self.db
            .get_execution_summary(id)
            .map(|_| ())
            .map_err(Into::into)
    }

    pub fn history_settings(&self) -> Result<HistorySettings, String> {
        self.db.execution_history_settings()
    }

    pub async fn set_history_settings(&self, settings: HistorySettings) -> Result<(), String> {
        settings.validate()?;
        let mut active = self.active.lock().await;
        if !settings.enabled {
            Self::forget_recording(&mut active).await;
            self.completed.lock().await.jobs.clear();
        }
        self.db.set_execution_history_settings(settings)
    }

    pub async fn clear_history(&self) -> Result<(), String> {
        let mut active = self.active.lock().await;
        Self::forget_recording(&mut active).await;
        self.completed.lock().await.jobs.clear();
        self.db.clear_execution_history()
    }

    async fn forget_recording(active: &mut HashMap<String, ActiveJob>) {
        let mut finished = Vec::new();
        for (id, job) in active.iter() {
            let mut state = job.state.lock().await;
            state.persist_history = false;
            if state.summary.status.is_terminal() {
                finished.push(id.clone());
            }
        }
        for id in finished {
            active.remove(&id);
        }
    }

    /// Invoked every minute while the app runs; reads also hide expired records.
    pub async fn maintain_history(&self) -> Result<(), String> {
        let _active = self.active.lock().await;
        self.completed.lock().await.prune();
        self.db.prune_execution_history()
    }

    async fn run(
        &self,
        state: Arc<Mutex<JobState>>,
        target: ProfileTarget,
        ssh: SshManager,
        mut cancel: watch::Receiver<bool>,
        mut ready: watch::Receiver<bool>,
        mut controls: mpsc::Receiver<TerminalControl>,
    ) {
        let started = Instant::now();
        let timeout = Duration::from_secs(state.lock().await.summary.timeout_seconds);
        // Held outside the selected future so timeout/cancel can still close the channel.
        let mut channel = None;
        let mut connection = None;
        let cancellation = cancel.clone();
        let interactive = state.lock().await.summary.interactive;
        let operation = async {
            if interactive {
                // Fail closed: never connect or execute until the actual tab attaches.
                ready
                    .wait_for(|attached| *attached)
                    .await
                    .map_err(|_| "Terminal monitor closed")?;
            }
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
            if interactive {
                channel
                    .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
                    .await
                    .map_err(|e| format!("PTY request failed: {e}"))?;
                match channel.wait().await {
                    Some(ChannelMsg::Success) => {}
                    _ => {
                        return Err("Server rejected the interactive terminal (PTY) request".into())
                    }
                }
            }
            let command = {
                let mut state = state.lock().await;
                if *cancellation.borrow() {
                    return Err("Execution cancelled before dispatch".to_string());
                }
                state.summary.status = ExecutionStatus::Running;
                // If history is enabled, persist uncertainty BEFORE sending exec.
                state.summary.remote_outcome_unknown = true;
                if let Err(error) = state.persist(&self.db) {
                    state.summary.remote_outcome_unknown = false;
                    return Err(error);
                }
                if interactive {
                    state.send_terminal(TerminalEvent::Status(state.summary.clone()))?;
                }
                state.summary.command.clone()
            };
            channel
                .exec(true, command.as_bytes())
                .await
                .map_err(|e| format!("Exec request failed: {e}"))?;
            if !interactive {
                // Preserve EOF semantics for non-interactive local API callers.
                channel
                    .eof()
                    .await
                    .map_err(|e| format!("Stdin close failed: {e}"))?;
            }
            loop {
                let msg = tokio::select! {
                    control = controls.recv(), if interactive => {
                        match control {
                            Some(TerminalControl::Input(data)) => channel.data(&data[..]).await
                                .map_err(|e| format!("Terminal input failed: {e}"))?,
                            Some(TerminalControl::Resize(cols, rows)) => channel.window_change(cols, rows, 0, 0).await
                                .map_err(|e| format!("Terminal resize failed: {e}"))?,
                            None => return Err("Terminal monitor closed".into()),
                        }
                        continue;
                    },
                    msg = channel.wait() => match msg { Some(msg) => msg, None => break },
                };
                let mut state = state.lock().await;
                match msg {
                    ChannelMsg::Data { data } => state.append(&data, false)?,
                    ChannelMsg::ExtendedData { data, ext: 1 } => state.append(&data, true)?,
                    ChannelMsg::ExitStatus { exit_status } => {
                        state.summary.exit_code = Some(exit_status);
                        state.summary.remote_outcome_unknown = false;
                    }
                    ChannelMsg::ExitSignal { signal_name, .. } => {
                        state.summary.exit_signal = Some(if state.summary.output_withheld {
                            "withheld after local input".into()
                        } else {
                            format!("{signal_name:?}")
                        });
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
        // Serialize completion against settings changes/deletion and all result reads.
        let mut active = self.active.lock().await;
        let mut state = state.lock().await;
        state.summary.status = outcome.0;
        state.summary.error = outcome.1;
        if state.summary.output_withheld {
            // Server-provided signal names / transport errors may also echo input.
            if state.summary.exit_signal.is_some() {
                state.summary.exit_signal = Some("withheld after local input".into());
            }
            if state.summary.error.is_some() && outcome.0 == ExecutionStatus::Failed {
                state.summary.error = Some(
                    "Interactive command failed after local input; remote details are withheld"
                        .into(),
                );
            }
        }
        state.summary.finished_at = Some(Utc::now().to_rfc3339());
        state.summary.duration_ms = Some(started.elapsed().as_millis() as u64);
        match state.persist(&self.db) {
            Ok(saved) => {
                if !saved {
                    self.completed.lock().await.insert(state.snapshot());
                }
                active.remove(&state.summary.id);
            }
            Err(error) => {
                // Keep the final result queryable in memory if disk writes fail.
                state.summary.persistence_error = Some(error);
            }
        }
        let _ = state.send_terminal(TerminalEvent::Status(state.summary.clone()));
    }
}

#[cfg(test)]
pub(crate) mod tests;
