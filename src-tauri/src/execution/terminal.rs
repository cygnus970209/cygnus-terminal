//! Local-only terminal controls. There is deliberately no MCP stdin tool.
use super::*;
use zeroize::Zeroizing;

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum TerminalEvent {
    Snapshot(ExecutionJob),
    Output(Vec<u8>),
    Status(ExecutionSummary),
}

pub type TerminalSink = Arc<dyn Fn(TerminalEvent) -> Result<(), String> + Send + Sync>;

pub(super) enum TerminalControl {
    Input(Zeroizing<Vec<u8>>),
    Resize(u32, u32),
}

impl JobState {
    pub(super) fn send_terminal(&self, event: TerminalEvent) -> Result<(), String> {
        self.terminal
            .as_ref()
            .ok_or("Terminal monitor is not attached")?(event)
    }
}

impl ExecutionManager {
    pub fn with_terminal_notifier(
        mut self,
        notify: impl Fn(ExecutionSummary) -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        self.terminal_notifier = Some(Arc::new(notify));
        self
    }

    pub async fn active_terminals(&self) -> Vec<ExecutionSummary> {
        let active = self.active.lock().await;
        let mut jobs = Vec::new();
        for job in active.values() {
            let state = job.state.lock().await;
            if state.summary.interactive && !state.summary.status.is_terminal() {
                jobs.push(state.summary.clone());
            }
        }
        jobs.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        jobs
    }

    pub async fn attach_terminal(&self, id: &str, sink: TerminalSink) -> Result<(), String> {
        let active = self.active.lock().await;
        if let Some(job) = active.get(id) {
            let mut state = job.state.lock().await;
            if !state.summary.interactive {
                return Err("This job has no interactive terminal".into());
            }
            // Snapshot and sink registration are atomic with output processing.
            sink(TerminalEvent::Snapshot(state.snapshot()))?;
            state.terminal = Some(sink);
            job.ready.send_replace(true);
            return Ok(());
        }
        drop(active);
        let job = self.get(id).await.map_err(String::from)?;
        if !job.summary.interactive {
            return Err("This job has no interactive terminal".into());
        }
        sink(TerminalEvent::Snapshot(job))
    }

    pub async fn terminal_input(&self, id: &str, data: Zeroizing<Vec<u8>>) -> Result<(), String> {
        if data.is_empty() || data.len() > 65536 {
            return Err("Terminal input must contain 1–65536 bytes".into());
        }
        let active = self.active.lock().await;
        let job = active.get(id).ok_or("Execution is no longer running")?;
        let mut state = job.state.lock().await;
        if state.summary.status != ExecutionStatus::Running || state.terminal.is_none() {
            return Err("The interactive terminal is not ready for input".into());
        }
        let input = job
            .input
            .as_ref()
            .ok_or("This job has no interactive terminal")?;
        // Set this BEFORE enqueuing input: even a server that echoes passwords cannot
        // put manual input into MCP responses, the result cache, or execution history.
        if !state.summary.output_withheld {
            state.summary.output_withheld = true;
            state.persist(&self.db)?;
            state.send_terminal(TerminalEvent::Status(state.summary.clone()))?;
        }
        input
            .try_send(TerminalControl::Input(data))
            .map_err(|_| "Terminal input queue is full or closed".into())
    }

    pub async fn terminal_resize(&self, id: &str, cols: u32, rows: u32) -> Result<(), String> {
        if !(1..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
            return Err("Terminal dimensions must be between 1 and 1000".into());
        }
        let active = self.active.lock().await;
        let job = active.get(id).ok_or("Execution is no longer running")?;
        job.input
            .as_ref()
            .ok_or("This job has no interactive terminal")?
            .try_send(TerminalControl::Resize(cols, rows))
            .map_err(|_| "Terminal input queue is full or closed".into())
    }
}
