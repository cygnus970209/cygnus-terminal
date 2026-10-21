mod windows;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::ssh::SshManager;

#[derive(Debug, Clone, Serialize, Default)]
pub struct ServerStats {
    pub platform: &'static str,
    pub cpu_usage: Option<f64>,
    pub mem_total: Option<u64>,
    pub mem_used: Option<u64>,
    pub mem_usage: Option<f64>,
    pub disk_total: Option<u64>,
    pub disk_used: Option<u64>,
    pub disk_usage: Option<f64>,
    pub load_avg: Option<String>,
    pub uptime: Option<String>,
    pub windows: Option<windows::WindowsDetails>,
}

#[derive(Default, Clone)]
struct CpuSnapshot {
    total: f64,
    idle: f64,
}

pub struct MonitorManager {
    stats: Arc<Mutex<HashMap<String, Result<ServerStats, String>>>>,
    tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
}

impl Default for MonitorManager {
    fn default() -> Self {
        Self::new()
    }
}

impl MonitorManager {
    pub fn new() -> Self {
        Self {
            stats: Arc::new(Mutex::new(HashMap::new())),
            tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start(
        &self,
        monitor_id: &str,
        session_id: &str,
        ssh_manager: &SshManager,
    ) -> Result<(), String> {
        let environment = ssh_manager.server_environment(session_id).await?;
        environment.require(crate::ssh::environment::ServerCapability::Monitor)?;
        let monitor_id_owned = monitor_id.to_string();
        let session_id_owned = session_id.to_string();
        let stats = Arc::clone(&self.stats);
        let ssh = ssh_manager.clone();

        let task = tokio::spawn(async move {
            let mut prev_cpu = CpuSnapshot::default();
            loop {
                let result = if environment.os == "windows" {
                    match environment.powershell.as_ref() {
                        Some(runtime) => windows::collect(&session_id_owned, &ssh, runtime)
                            .await
                            .map(|stats| (stats, CpuSnapshot::default())),
                        None => Err("Windows monitoring runtime is unavailable".into()),
                    }
                } else {
                    Self::collect_stats(&session_id_owned, &ssh, &prev_cpu).await
                };
                match result {
                    Ok((s, new_cpu)) => {
                        prev_cpu = new_cpu;
                        stats.lock().await.insert(monitor_id_owned.clone(), Ok(s));
                    }
                    Err(e) => {
                        stats.lock().await.insert(monitor_id_owned.clone(), Err(e));
                        break;
                    }
                }
                // Sequential sampling: slow Windows queries cannot create catch-up bursts.
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        });

        self.tasks.lock().await.insert(monitor_id.to_string(), task);
        Ok(())
    }

    pub async fn stop(&self, monitor_id: &str) {
        if let Some(task) = self.tasks.lock().await.remove(monitor_id) {
            task.abort();
        }
        self.stats.lock().await.remove(monitor_id);
    }

    pub async fn get_stats(&self, monitor_id: &str) -> Result<Option<ServerStats>, String> {
        if let Some(result) = self.stats.lock().await.get(monitor_id).cloned() {
            return result.map(Some);
        }
        if self.tasks.lock().await.contains_key(monitor_id) {
            Ok(None)
        } else {
            Err("Monitor is no longer running".into())
        }
    }

    async fn collect_stats(
        session_id: &str,
        ssh: &SshManager,
        prev_cpu: &CpuSnapshot,
    ) -> Result<(ServerStats, CpuSnapshot), String> {
        let (handle, cancel) = ssh.command_connection(session_id).await?;
        let cmd = "LC_ALL=C; export LC_ALL; cat /proc/stat | head -1; echo '---'; free -b | grep Mem; echo '---'; df -B1 --total | grep total; echo '---'; cat /proc/loadavg; echo '---'; uptime -p 2>/dev/null || uptime";
        let output = crate::ssh::environment::read_command(
            handle,
            &cancel,
            cmd,
            std::time::Duration::from_secs(5),
            65536,
        )
        .await?;
        Self::parse_stats(&output, prev_cpu)
    }

    fn parse_stats(
        output: &str,
        prev_cpu: &CpuSnapshot,
    ) -> Result<(ServerStats, CpuSnapshot), String> {
        let sections: Vec<&str> = output.split("---").collect();
        // Missing tools, permission errors and malformed output are not healthy zero values.
        if sections.len() != 5 || sections[4].trim().is_empty() {
            return Err("Incomplete Linux monitoring output".into());
        }
        let rows: Vec<Vec<&str>> = sections
            .iter()
            .take(4)
            .map(|s| s.split_whitespace().collect())
            .collect();
        if rows[0].len() < 8
            || rows[0][0] != "cpu"
            || rows[1].len() < 3
            || rows[1][0] != "Mem:"
            || rows[2].len() < 4
            || rows[2][0] != "total"
            || rows[3].len() < 3
        {
            return Err("Invalid Linux monitoring output".into());
        }
        if rows[0][1..8].iter().any(|v| v.parse::<u64>().is_err())
            || rows[1][1..3].iter().any(|v| v.parse::<u64>().is_err())
            || rows[2][1..4].iter().any(|v| v.parse::<u64>().is_err())
            || rows[3][..3]
                .iter()
                .any(|v| v.parse::<f64>().map_or(true, |n| !n.is_finite() || n < 0.0))
        {
            return Err("Invalid Linux monitoring values".into());
        }
        let cpu: Vec<f64> = rows[0][1..8]
            .iter()
            .map(|value| value.parse::<f64>().expect("validated CPU value"))
            .collect();
        let current_cpu = CpuSnapshot {
            total: cpu.iter().sum(),
            idle: cpu[3],
        };
        let d_total = current_cpu.total - prev_cpu.total;
        let d_idle = current_cpu.idle - prev_cpu.idle;
        let cpu_usage =
            if prev_cpu.total > 0.0 && d_total > 0.0 && (0.0..=d_total).contains(&d_idle) {
                Some(percent(d_total - d_idle, d_total))
            } else {
                None
            };
        let mem_total = rows[1][1].parse::<u64>().expect("validated memory total");
        let mem_used = rows[1][2].parse::<u64>().expect("validated memory usage");
        let disk_total = rows[2][1].parse::<u64>().expect("validated disk total");
        let disk_used = rows[2][2].parse::<u64>().expect("validated disk usage");
        if mem_total == 0 || disk_total == 0 || mem_used > mem_total || disk_used > disk_total {
            return Err("Invalid Linux monitoring totals".into());
        }
        let stats = ServerStats {
            platform: "linux",
            cpu_usage,
            mem_total: Some(mem_total),
            mem_used: Some(mem_used),
            mem_usage: Some(percent(mem_used as f64, mem_total as f64)),
            disk_total: Some(disk_total),
            disk_used: Some(disk_used),
            disk_usage: Some(percent(disk_used as f64, disk_total as f64)),
            load_avg: Some(rows[3][..3].join(" ")),
            uptime: Some(sections[4].trim().to_string()),
            windows: None,
        };
        Ok((stats, current_cpu))
    }
}

fn percent(used: f64, total: f64) -> f64 {
    (used / total * 1000.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    const VALID: &str = "cpu 20 0 10 70 0 0 0 0\n---\nMem: 1000 400 600\n---\ntotal 2000 500 1500 25% -\n---\n0.10 0.20 0.30 1/100 50\n---\nup 1 hour\n";

    #[test]
    fn parses_linux_metrics_and_cpu_delta() {
        let (_, snapshot) = MonitorManager::parse_stats(VALID, &CpuSnapshot::default()).unwrap();
        let next = VALID.replace("cpu 20 0 10 70", "cpu 30 0 10 80");
        let (stats, _) = MonitorManager::parse_stats(&next, &snapshot).unwrap();
        assert_eq!(stats.cpu_usage, Some(50.0));
        assert_eq!(stats.mem_usage, Some(40.0));
        assert_eq!(stats.disk_usage, Some(25.0));
        assert_eq!(stats.load_avg.as_deref(), Some("0.10 0.20 0.30"));
    }

    #[test]
    fn failed_or_partial_metrics_do_not_become_healthy_zero_values() {
        for output in [
            String::new(),
            "command not found".into(),
            VALID.replace("Mem: 1000", "Mem: error"),
            VALID.replace("total 2000", "total 0"),
            VALID.replace("0.10", "NaN"),
            VALID.replace("Mem: 1000 400", "Mem: 100 400"),
            VALID.replace("up 1 hour", ""),
        ] {
            assert!(MonitorManager::parse_stats(&output, &CpuSnapshot::default()).is_err());
        }
    }
}
