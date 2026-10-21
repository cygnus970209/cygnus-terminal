use super::ServerStats;
use crate::ssh::{
    powershell::{self, PowerShellRuntime, Query},
    SshManager,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Snapshot {
    schema: u32,
    #[serde(deserialize_with = "Option::deserialize")]
    cpu: Option<Vec<Cpu>>,
    #[serde(deserialize_with = "Option::deserialize")]
    memory: Option<Memory>,
    #[serde(deserialize_with = "Option::deserialize")]
    disks: Option<Vec<WindowsDisk>>,
    #[serde(deserialize_with = "Option::deserialize")]
    uptime_seconds: Option<u64>,
    #[serde(deserialize_with = "Option::deserialize")]
    processes: Option<Vec<WindowsProcess>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cpu {
    load: f64,
    logical: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Memory {
    total_kib: u64,
    free_kib: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowsDisk {
    pub name: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowsProcess {
    pub pid: u32,
    pub name: String,
    pub memory_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowsDetails {
    pub powershell_version: String,
    pub disks: Option<Vec<WindowsDisk>>,
    pub processes: Option<Vec<WindowsProcess>>,
}

pub(super) async fn collect(
    session_id: &str,
    ssh: &SshManager,
    runtime: &PowerShellRuntime,
) -> Result<ServerStats, String> {
    let (handle, cancel) = ssh.command_connection(session_id).await?;
    let snapshot = powershell::run(
        handle,
        &cancel,
        runtime.engine,
        Query::Snapshot,
        powershell::SNAPSHOT_TIMEOUT,
    )
    .await?;
    normalize(snapshot, &runtime.version)
}

fn normalize(snapshot: Snapshot, version: &str) -> Result<ServerStats, String> {
    const INVALID: &str = "Invalid Windows monitoring values";
    // Keep counters exact when crossing the JSON/JavaScript boundary.
    const MAX_BYTES: u64 = (1u64 << 53) - 1;
    if snapshot.schema != 1 {
        return Err("Unsupported Windows monitoring schema".into());
    }
    let mut stats = ServerStats {
        platform: "windows",
        ..Default::default()
    };
    if let Some(cpus) = snapshot.cpu {
        if cpus.len() > 256 {
            return Err(INVALID.into());
        }
        let mut logical = 0u64;
        let mut load = 0.0;
        for cpu in cpus {
            if !cpu.load.is_finite()
                || !(0.0..=100.0).contains(&cpu.load)
                || cpu.logical == 0
                || cpu.logical > 65536
            {
                return Err(INVALID.into());
            }
            logical += u64::from(cpu.logical);
            load += cpu.load * f64::from(cpu.logical);
        }
        if logical > 0 {
            stats.cpu_usage = Some((load / logical as f64 * 10.0).round() / 10.0);
        }
    }
    if let Some(memory) = snapshot.memory {
        if memory.total_kib == 0
            || memory.free_kib > memory.total_kib
            || memory.total_kib > MAX_BYTES / 1024
        {
            return Err(INVALID.into());
        }
        let total = memory.total_kib * 1024;
        let used = (memory.total_kib - memory.free_kib) * 1024;
        stats.mem_total = Some(total);
        stats.mem_used = Some(used);
        stats.mem_usage = Some(super::percent(used as f64, total as f64));
    }
    let mut disks = snapshot.disks;
    if let Some(disks) = disks.as_mut() {
        if disks.len() > 64 {
            return Err(INVALID.into());
        }
        let mut names = HashSet::new();
        let (mut total, mut free) = (0u64, 0u64);
        for disk in disks.iter() {
            let name = disk.name.as_bytes();
            if name.len() != 2
                || !name[0].is_ascii_uppercase()
                || name[1] != b':'
                || !names.insert(&disk.name)
                || disk.total_bytes == 0
                || disk.free_bytes > disk.total_bytes
            {
                return Err(INVALID.into());
            }
            total = total
                .checked_add(disk.total_bytes)
                .filter(|n| *n <= MAX_BYTES)
                .ok_or(INVALID)?;
            free = free.checked_add(disk.free_bytes).ok_or(INVALID)?;
        }
        if total > 0 {
            stats.disk_total = Some(total);
            stats.disk_used = Some(total - free);
            stats.disk_usage = Some(super::percent((total - free) as f64, total as f64));
        }
        disks.sort_by(|a, b| a.name.cmp(&b.name));
    }
    if let Some(seconds) = snapshot.uptime_seconds {
        // Reject nonsensical/overflowing durations, including a cast negative value.
        if seconds > 100 * 366 * 86400 {
            return Err(INVALID.into());
        }
        stats.uptime = Some(format!(
            "{}d {}h {}m",
            seconds / 86400,
            seconds / 3600 % 24,
            seconds / 60 % 60
        ));
    }
    let mut processes = snapshot.processes;
    if let Some(processes) = processes.as_mut() {
        let mut pids = HashSet::new();
        if processes.len() > 20
            || processes.iter().any(|p| {
                p.name.is_empty()
                    || p.name.len() > 1024
                    || p.name.chars().any(char::is_control)
                    || p.memory_bytes > MAX_BYTES
                    || !pids.insert(p.pid)
            })
        {
            return Err(INVALID.into());
        }
        processes.sort_by_key(|p| (std::cmp::Reverse(p.memory_bytes), p.pid));
    }
    stats.windows = Some(WindowsDetails {
        powershell_version: version.into(),
        disks,
        processes,
    });
    Ok(stats)
}

#[cfg(test)]
mod tests;
