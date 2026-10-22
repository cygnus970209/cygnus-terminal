//! Session-local discovery. Only fixed, read-only probes cross the SSH boundary.
//! Saved hints never grant capabilities, and raw probe output is never exposed to MCP/UI.
use super::ManagedSshHandle;
use russh::{client, ChannelMsg};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(20);
const OUTPUT_LIMIT: usize = 8192;
const POSIX_PROBE: &str = r#"printf '__CYGNUS_POSIX__:%s\n' "$0""#;
const POWERSHELL_PROBE: &str = "Write-Output ('__CYGNUS_PS__:' + $PSVersionTable.PSVersion.Major + ':' + [System.Environment]::OSVersion.Platform)";
const CMD_PROBE: &str = "echo __CYGNUS_CMD__:%OS%";
const TOOLS_PROBE: &str = "if command -v tail >/dev/null 2>&1; then printf '__CYGNUS_TAIL__\\n'; fi; if command -v journalctl >/dev/null 2>&1; then printf '__CYGNUS_JOURNAL__\\n'; fi; if [ -r /proc/stat ] && [ -r /proc/loadavg ] && command -v cat >/dev/null 2>&1 && command -v head >/dev/null 2>&1 && command -v free >/dev/null 2>&1 && command -v grep >/dev/null 2>&1 && command -v df >/dev/null 2>&1 && command -v uptime >/dev/null 2>&1; then printf '__CYGNUS_MONITOR__\\n'; fi; printf '__CYGNUS_TOOLS_DONE__\\n'";

#[derive(Clone, Debug, Default, Serialize)]
pub struct ServerCapabilities {
    pub monitor: bool,
    pub file_logs: bool,
    pub journal: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct EnvironmentHints {
    pub target_os: String,
    pub remote_shell: String,
}

impl EnvironmentHints {
    pub fn new(target_os: Option<String>, remote_shell: Option<String>) -> Result<Self, String> {
        let target_os = target_os.unwrap_or_else(|| "auto".into());
        let remote_shell = remote_shell.unwrap_or_else(|| "auto".into());
        crate::db::profile::validate_server_environment(&target_os, &remote_shell)?;
        Ok(Self {
            target_os,
            remote_shell,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ServerEnvironment {
    pub configured: EnvironmentHints,
    pub detected_os: Option<String>,
    pub detected_shell: Option<String>,
    pub os: String,
    pub shell: String,
    pub capabilities: ServerCapabilities,
    pub notice: Option<String>,
    pub powershell: Option<super::powershell::PowerShellRuntime>,
}

#[derive(Clone, Copy)]
pub enum ServerCapability {
    Monitor,
    FileLogs,
    Journal,
}

impl ServerEnvironment {
    fn new(configured: EnvironmentHints) -> Self {
        Self {
            configured,
            detected_os: None,
            detected_shell: None,
            os: "unknown".into(),
            shell: "unknown".into(),
            capabilities: ServerCapabilities::default(),
            notice: None,
            powershell: None,
        }
    }

    fn resolve(&mut self) {
        self.os = effective(&self.configured.target_os, &self.detected_os);
        self.shell = effective(&self.configured.remote_shell, &self.detected_shell);
    }

    fn compatible_posix(&self) -> bool {
        self.detected_shell.as_deref() == Some("posix")
            && self.shell == "posix"
            && matches!(self.os.as_str(), "linux" | "other")
            && self.detected_os.as_deref() == Some(self.os.as_str())
    }

    pub fn require(&self, capability: ServerCapability) -> Result<(), String> {
        let (allowed, name) = match capability {
            ServerCapability::Monitor => (self.capabilities.monitor, "Server monitoring"),
            ServerCapability::FileLogs => (self.capabilities.file_logs, "File log streaming"),
            ServerCapability::Journal => (self.capabilities.journal, "journalctl"),
        };
        if allowed {
            Ok(())
        } else {
            Err(format!("{name} is not available for this SSH session"))
        }
    }
}

fn effective(configured: &str, detected: &Option<String>) -> String {
    if configured == "auto" {
        detected.as_deref().unwrap_or("unknown").into()
    } else {
        configured.into()
    }
}

fn posix_shell(output: &str) -> bool {
    output.lines().any(|line| {
        let Some(shell) = line.trim().strip_prefix("__CYGNUS_POSIX__:") else {
            return false;
        };
        matches!(
            shell
                .rsplit('/')
                .next()
                .unwrap_or("")
                .trim_start_matches('-'),
            "sh" | "bash" | "zsh" | "dash" | "ash" | "ksh" | "ksh93" | "mksh"
        )
    })
}

fn unix_os(output: &str) -> Option<String> {
    match output.trim() {
        "Linux" => Some("linux".into()),
        "Darwin" | "FreeBSD" | "OpenBSD" | "NetBSD" | "SunOS" | "AIX" => Some("other".into()),
        s if s.starts_with("MINGW") || s.starts_with("MSYS") || s.starts_with("CYGWIN") => {
            Some("windows".into())
        }
        _ => None,
    }
}

fn powershell(output: &str) -> Option<(&'static str, &'static str)> {
    output.lines().find_map(|line| {
        let (major, platform) = line
            .trim()
            .strip_prefix("__CYGNUS_PS__:")?
            .split_once(':')?;
        let shell = match major.parse::<u32>().ok()? {
            1..=5 => "powershell",
            6.. => "pwsh",
            _ => return None,
        };
        match platform {
            "Win32NT" => Some(("windows", shell)),
            "Unix" => Some(("unix", shell)),
            _ => None,
        }
    })
}

pub(super) async fn discover(
    handle: Arc<ManagedSshHandle>,
    cancel: &CancellationToken,
    hints: EnvironmentHints,
) -> ServerEnvironment {
    let mut env = ServerEnvironment::new(hints);
    let deadline = tokio::time::Instant::now() + DISCOVERY_TIMEOUT;
    let probe = |command: &'static str| {
        let remaining = deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .min(PROBE_TIMEOUT);
        read_command(handle.clone(), cancel, command, remaining, OUTPUT_LIMIT)
    };
    if probe(POSIX_PROBE).await.is_ok_and(|s| posix_shell(&s)) {
        env.detected_shell = Some("posix".into());
        env.detected_os = probe("uname -s").await.ok().and_then(|s| unix_os(&s));
    } else if let Some((os, shell)) = probe(POWERSHELL_PROBE)
        .await
        .ok()
        .and_then(|s| powershell(&s))
    {
        env.detected_shell = Some(shell.into());
        env.detected_os = if os == "unix" {
            probe("uname -s").await.ok().and_then(|s| unix_os(&s))
        } else {
            Some(os.into())
        };
    } else if probe(CMD_PROBE)
        .await
        .is_ok_and(|s| s.trim() == "__CYGNUS_CMD__:Windows_NT")
    {
        env.detected_os = Some("windows".into());
        env.detected_shell = Some("cmd".into());
    }
    env.resolve();
    if env.compatible_posix() {
        if let Ok(output) = probe(TOOLS_PROBE).await {
            let lines: Vec<_> = output.lines().map(str::trim).collect();
            if lines.contains(&"__CYGNUS_TOOLS_DONE__") {
                env.capabilities = ServerCapabilities {
                    monitor: env.os == "linux" && lines.contains(&"__CYGNUS_MONITOR__"),
                    file_logs: lines.contains(&"__CYGNUS_TAIL__"),
                    journal: env.os == "linux" && lines.contains(&"__CYGNUS_JOURNAL__"),
                };
            }
        }
    }
    if env.os == "windows"
        && env.detected_os.as_deref() == Some("windows")
        && env.detected_shell.as_deref() == Some(env.shell.as_str())
    {
        env.powershell = super::powershell::discover(handle, cancel, &env.shell, deadline).await;
        env.capabilities.monitor = env.powershell.as_ref().is_some_and(|runtime| runtime.cim);
    }
    env.notice = if env.detected_os.is_none() || env.detected_shell.is_none() {
        Some(
            "Could not verify the remote environment. OS-specific tools remain unavailable.".into(),
        )
    } else if env.detected_os.as_deref() != Some(&env.os)
        || env.detected_shell.as_deref() != Some(&env.shell)
    {
        Some("Saved environment differs from the SSH command environment. OS-specific tools remain unavailable.".into())
    } else if env.os == "windows" {
        Some(if env.capabilities.monitor {
            "Windows logs are available in IIS tools. POSIX log streaming is unavailable."
        } else {
            "Windows monitoring requires a verified PowerShell 5.1 or 7+ runtime with Get-CimInstance. Reconnect after enabling it."
        }.into())
    } else if !env.capabilities.monitor && !env.capabilities.file_logs && !env.capabilities.journal
    {
        Some("Required tools or a compatible POSIX command shell could not be verified.".into())
    } else {
        None
    };
    env
}

// Channel cleanup also runs when a caller drops the future mid-probe.
pub(crate) struct CommandChannel(pub(crate) Option<russh::Channel<client::Msg>>);
impl Drop for CommandChannel {
    fn drop(&mut self) {
        if let (Some(channel), Ok(runtime)) = (self.0.take(), tokio::runtime::Handle::try_current())
        {
            runtime.spawn(async move {
                let _ = tokio::time::timeout(Duration::from_millis(250), channel.close()).await;
            });
        }
    }
}

/// Bounded non-interactive command output for internal read-only providers.
/// Must never be exposed as an unrestricted IPC/MCP command runner.
pub(crate) async fn read_command(
    handle: Arc<ManagedSshHandle>,
    cancel: &CancellationToken,
    command: &str,
    timeout: Duration,
    limit: usize,
) -> Result<String, String> {
    if timeout.is_zero() || cancel.is_cancelled() {
        return Err("Command cancelled or timed out".into());
    }
    let mut owned = CommandChannel(None);
    let operation = async {
        owned.0 = Some(
            handle
                .channel_open_session()
                .await
                .map_err(|_| "SSH channel unavailable")?,
        );
        let channel = owned.0.as_mut().unwrap();
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|_| "SSH command request failed")?;
        channel.eof().await.map_err(|_| "SSH input close failed")?;
        let mut output = Vec::new();
        let mut received = 0usize;
        let mut exit = None;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    received = received.saturating_add(data.len());
                    if received > limit {
                        return Err("Command output limit exceeded".into());
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    received = received.saturating_add(data.len());
                    if received > limit {
                        return Err("Command output limit exceeded".into());
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Failure | ChannelMsg::ExitSignal { .. } => {
                    return Err("SSH command rejected or failed".into())
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        if exit != Some(0) {
            return Err("SSH command did not complete successfully".into());
        }
        String::from_utf8(output).map_err(|_| "Invalid command output encoding".into())
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("SSH session closed".into()),
        result = tokio::time::timeout(timeout, operation) => result.map_err(|_| "SSH command timed out".to_string())?,
    }
}

#[cfg(test)]
mod tests;
