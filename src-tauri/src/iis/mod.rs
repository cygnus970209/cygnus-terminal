//! Read-only IIS and Windows event queries on an existing verified SSH session.
//! Only a numeric site ID crosses the IPC boundary; paths and scripts never do.
use crate::ssh::{
    powershell::{self, Query},
    SshManager,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, time::Duration};

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IisStatus {
    Available,
    NotInstalled,
    Unavailable,
}

#[derive(Debug, Deserialize, Serialize)]
pub enum ObjectState {
    Starting,
    Started,
    Stopping,
    Stopped,
    Unknown,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub protocol: String,
    pub address: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Application {
    pub path: String,
    pub pool: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Site {
    pub id: u32,
    pub name: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub state: Option<ObjectState>,
    pub bindings: Vec<Binding>,
    pub applications: Vec<Application>,
    pub log_enabled: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Pool {
    pub name: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub state: Option<ObjectState>,
    pub runtime: String,
    pub pipeline: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Overview {
    schema: u32,
    pub status: IisStatus,
    #[serde(deserialize_with = "Option::deserialize")]
    pub sites: Option<Vec<Site>>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub pools: Option<Vec<Pool>>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LogStatus {
    Available,
    Unavailable,
    SiteMissing,
    Disabled,
    UnsupportedFormat,
    UnsupportedPath,
    NoLogs,
    TooManyFiles,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SiteLog {
    schema: u32,
    pub site_id: u32,
    pub status: LogStatus,
    #[serde(deserialize_with = "Option::deserialize")]
    pub file: Option<String>,
    pub lines: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WindowsEvent {
    pub record_id: u64,
    pub id: u32,
    pub level: u8,
    pub provider: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub time: Option<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub message: Option<String>,
    pub message_truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EventLog {
    pub name: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub events: Option<Vec<WindowsEvent>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Events {
    schema: u32,
    pub logs: Vec<EventLog>,
}

async fn query<T: serde::de::DeserializeOwned>(
    ssh: &SshManager,
    session_id: &str,
    query: Query,
) -> Result<T, String> {
    let env = ssh.server_environment(session_id).await?;
    if env.os != "windows"
        || env.detected_os.as_deref() != Some("windows")
        || env.detected_shell.as_deref() != Some(env.shell.as_str())
    {
        return Err("IIS and Windows event tools require a verified Windows SSH session".into());
    }
    let runtime = env
        .powershell
        .ok_or("A supported PowerShell runtime could not be verified")?;
    let (handle, cancel) = ssh.command_connection(session_id).await?;
    powershell::run(
        handle,
        &cancel,
        runtime.engine,
        query,
        Duration::from_secs(15),
    )
    .await
}

pub async fn overview(ssh: &SshManager, session_id: &str) -> Result<Overview, String> {
    let result = query(ssh, session_id, Query::IisOverview).await?;
    validate_overview(&result)?;
    Ok(result)
}

pub async fn site_log(ssh: &SshManager, session_id: &str, site_id: u32) -> Result<SiteLog, String> {
    if site_id == 0 {
        return Err("A positive IIS site ID is required".into());
    }
    let result = query(ssh, session_id, Query::IisLog { site_id }).await?;
    validate_log(&result, site_id)?;
    Ok(result)
}

pub async fn events(ssh: &SshManager, session_id: &str) -> Result<Events, String> {
    let result = query(ssh, session_id, Query::WindowsEvents).await?;
    validate_events(&result)?;
    Ok(result)
}

fn label(value: &str, max: usize, empty: bool) -> bool {
    (empty || !value.is_empty()) && value.len() <= max && !value.chars().any(char::is_control)
}

fn validate_overview(result: &Overview) -> Result<(), String> {
    let invalid = || "Invalid IIS overview response".to_string();
    if result.schema != 1
        || (result.status != IisStatus::Available
            && (result.sites.is_some() || result.pools.is_some()))
    {
        return Err(invalid());
    }
    if let Some(sites) = &result.sites {
        let mut ids = HashSet::new();
        if sites.len() > 200 {
            return Err(invalid());
        }
        for site in sites {
            if site.id == 0
                || !ids.insert(site.id)
                || !label(&site.name, 1024, false)
                || site.bindings.len() > 64
                || site.applications.len() > 64
                || site
                    .bindings
                    .iter()
                    .any(|b| !label(&b.protocol, 64, false) || !label(&b.address, 4096, false))
                || site.applications.iter().any(|a| {
                    !a.path.starts_with('/')
                        || !label(&a.path, 4096, false)
                        || !label(&a.pool, 1024, false)
                })
            {
                return Err(invalid());
            }
        }
    }
    if let Some(pools) = &result.pools {
        let mut names = HashSet::new();
        if pools.len() > 200
            || pools.iter().any(|p| {
                !label(&p.name, 1024, false)
                    || !names.insert(p.name.to_lowercase())
                    || !label(&p.runtime, 64, true)
                    || !matches!(p.pipeline.as_str(), "Integrated" | "Classic")
            })
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn validate_log(result: &SiteLog, site_id: u32) -> Result<(), String> {
    let invalid = || "Invalid IIS log response".to_string();
    if result.schema != 1
        || result.site_id != site_id
        || result.lines.len() > 50
        || result.lines.iter().map(String::len).sum::<usize>() > 65536
    {
        return Err(invalid());
    }
    if result.status == LogStatus::Available {
        let file = result.file.as_deref().ok_or_else(invalid)?;
        if !label(file, 1024, false)
            || !file.to_lowercase().ends_with(".log")
            || file.contains(['/', '\\', ':'])
        {
            return Err(invalid());
        }
    } else if result.file.is_some() || !result.lines.is_empty() || result.truncated {
        return Err(invalid());
    }
    Ok(())
}

fn validate_events(result: &Events) -> Result<(), String> {
    let invalid = || "Invalid Windows event response".to_string();
    let mut logs = HashSet::new();
    if result.schema != 1 || result.logs.len() != 2 {
        return Err(invalid());
    }
    for log in &result.logs {
        if !matches!(log.name.as_str(), "Application" | "System") || !logs.insert(&log.name) {
            return Err(invalid());
        }
        if let Some(events) = &log.events {
            let mut records = HashSet::new();
            if events.len() > 20 {
                return Err(invalid());
            }
            for e in events {
                if e.record_id > (1u64 << 53) - 1
                    || !records.insert(e.record_id)
                    || !(1..=3).contains(&e.level)
                    || !label(&e.provider, 1024, false)
                    || e.message.as_ref().is_some_and(|s| s.len() > 4096)
                    || e.time.as_ref().is_some_and(|s| {
                        s.len() > 64 || chrono::DateTime::parse_from_rfc3339(s).is_err()
                    })
                {
                    return Err(invalid());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
