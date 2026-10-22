//! Internal, fixed read-only PowerShell queries. No script text or executable path
//! is accepted from IPC/MCP, profiles, process names, or other remote output.
use super::environment::read_command;
use super::ManagedSshHandle;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

const FRAME: &str = "__CYGNUS_JSON__:";
const OUTPUT_LIMIT: usize = 65536;
pub(super) const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PowerShellEngine {
    PowerShell,
    Pwsh,
}

#[derive(Clone, Debug, Serialize)]
pub struct PowerShellRuntime {
    pub(crate) engine: PowerShellEngine,
    pub version: String,
    pub(crate) cim: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum Query {
    Probe,
    Snapshot,
    IisOverview,
    IisLog { site_id: u32 },
    WindowsEvents,
}

/// UTF-16LE is required for -EncodedCommand on both Windows PowerShell and pwsh.
/// The ASCII result frame carries UTF-8 JSON through any outer SSH shell codepage.
/// No execution-policy override, profiles, credentials, or remote CIM sessions.
pub(crate) fn command(engine: PowerShellEngine, query: Query) -> String {
    let executable = match engine {
        PowerShellEngine::PowerShell => "powershell.exe",
        PowerShellEngine::Pwsh => "pwsh.exe",
    };
    let script = match query {
        Query::Probe => include_str!("powershell/probe.ps1"),
        Query::Snapshot => include_str!("powershell/snapshot.ps1"),
        Query::IisOverview => include_str!("powershell/iis-overview.ps1"),
        Query::IisLog { .. } => include_str!("powershell/iis-log.ps1"),
        Query::WindowsEvents => include_str!("powershell/windows-events.ps1"),
    };
    // Preserve line boundaries while keeping fixed scripts below CMD's argument limit.
    let script = script.lines().map(str::trim).collect::<Vec<_>>().join("\n");
    let parameters = match query {
        Query::IisLog { site_id } => format!("$siteId={site_id};"),
        _ => String::new(),
    };
    let wrapped = format!(
        "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try{{$result=&{{{parameters}\n{script}\n}};$json=ConvertTo-Json -InputObject $result -Depth 6 -Compress;[Console]::WriteLine('{FRAME}'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)));exit 0}}catch{{exit 1}}"
    );
    let bytes: Vec<u8> = wrapped.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "{executable} -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand {}",
        STANDARD.encode(bytes)
    )
}

#[cfg(test)]
pub(crate) fn decode<T: DeserializeOwned>(output: &str) -> Result<T, String> {
    decode_with_limit(output, OUTPUT_LIMIT)
}

fn decode_with_limit<T: DeserializeOwned>(output: &str, limit: usize) -> Result<T, String> {
    // Accept one frame only. Banners, duplicate frames and truncated JSON fail closed.
    let frame = output
        .trim()
        .trim_start_matches('\u{feff}')
        .strip_prefix(FRAME)
        .ok_or("Invalid PowerShell response frame")?;
    if frame.len() > limit {
        return Err("PowerShell response is too large".into());
    }
    let json = STANDARD
        .decode(frame)
        .map_err(|_| "Invalid PowerShell response encoding")?;
    serde_json::from_slice(&json).map_err(|_| "Invalid PowerShell response schema".into())
}

pub(crate) async fn run<T: DeserializeOwned>(
    handle: Arc<ManagedSshHandle>,
    cancel: &CancellationToken,
    engine: PowerShellEngine,
    query: Query,
    timeout: Duration,
) -> Result<T, String> {
    let limit = match query {
        Query::IisOverview | Query::WindowsEvents => 262144,
        _ => OUTPUT_LIMIT,
    };
    let output = read_command(handle, cancel, &command(engine, query), timeout, limit).await?;
    decode_with_limit(&output, limit)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Probe {
    schema: u32,
    os: String,
    version: String,
    cim: bool,
}

pub(super) async fn discover(
    handle: Arc<ManagedSshHandle>,
    cancel: &CancellationToken,
    shell: &str,
    deadline: tokio::time::Instant,
) -> Option<PowerShellRuntime> {
    let candidates: &[PowerShellEngine] = match shell {
        "powershell" => &[PowerShellEngine::PowerShell],
        "pwsh" => &[PowerShellEngine::Pwsh],
        "cmd" => &[PowerShellEngine::PowerShell, PowerShellEngine::Pwsh],
        _ => return None,
    };
    for &engine in candidates {
        let remaining = deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .min(PROBE_TIMEOUT);
        if remaining.is_zero() || cancel.is_cancelled() {
            break;
        }
        if let Ok(probe) =
            run::<Probe>(handle.clone(), cancel, engine, Query::Probe, remaining).await
        {
            if let Some(runtime) = validate_runtime(engine, probe) {
                return Some(runtime);
            }
        }
    }
    None
}

fn validate_runtime(engine: PowerShellEngine, probe: Probe) -> Option<PowerShellRuntime> {
    let parts: Vec<u32> = probe
        .version
        .split('.')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    if probe.schema != 1 || probe.os != "Win32NT" || !(2..=4).contains(&parts.len()) {
        return None;
    }
    let supported = match engine {
        PowerShellEngine::PowerShell => parts[0] == 5 && parts[1] >= 1,
        PowerShellEngine::Pwsh => parts[0] >= 7,
    };
    supported.then_some(PowerShellRuntime {
        engine,
        version: probe.version,
        cim: probe.cim,
    })
}

#[cfg(test)]
mod tests;
