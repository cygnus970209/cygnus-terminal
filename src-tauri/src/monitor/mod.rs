use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::ssh::SshManager;

#[derive(Debug, Clone, Serialize, Default)]
pub struct ServerStats {
    pub cpu_usage: f64,
    pub mem_total: u64,
    pub mem_used: u64,
    pub mem_usage: f64,
    pub disk_total: u64,
    pub disk_used: u64,
    pub disk_usage: f64,
    pub load_avg: String,
    pub uptime: String,
}

#[derive(Default, Clone)]
struct CpuSnapshot {
    total: f64,
    idle: f64,
}

pub struct MonitorManager {
    stats: Arc<Mutex<HashMap<String, ServerStats>>>,
    tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
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
        let monitor_id_owned = monitor_id.to_string();
        let session_id_owned = session_id.to_string();
        let stats = Arc::clone(&self.stats);
        let ssh = ssh_manager.clone_inner();

        let task = tokio::spawn(async move {
            let mut prev_cpu = CpuSnapshot::default();
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));

            loop {
                interval.tick().await;
                match Self::collect_stats(&session_id_owned, &ssh, &prev_cpu).await {
                    Ok((s, new_cpu)) => {
                        prev_cpu = new_cpu;
                        stats.lock().await.insert(monitor_id_owned.clone(), s);
                    }
                    Err(e) => {
                        eprintln!("[Monitor] Failed to collect stats: {}", e);
                        break;
                    }
                }
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

    pub async fn get_stats(&self, monitor_id: &str) -> Result<ServerStats, String> {
        self.stats
            .lock()
            .await
            .get(monitor_id)
            .cloned()
            .ok_or_else(|| "Monitor not running".into())
    }

    async fn collect_stats(
        session_id: &str,
        ssh: &Arc<Mutex<HashMap<String, crate::ssh::SshSession>>>,
        prev_cpu: &CpuSnapshot,
    ) -> Result<(ServerStats, CpuSnapshot), String> {
        let sessions = ssh.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "SSH session not found".to_string())?;

        let cmd = "cat /proc/stat | head -1; echo '---'; free -b | grep Mem; echo '---'; df -B1 --total | grep total; echo '---'; cat /proc/loadavg; echo '---'; uptime -p 2>/dev/null || uptime";

        let mut channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Channel open failed: {e}"))?;

        channel
            .exec(true, cmd)
            .await
            .map_err(|e| format!("Exec failed: {e}"))?;

        let mut output = String::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => {
                    output.push_str(&String::from_utf8_lossy(&data));
                }
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        drop(sessions);

        let sections: Vec<&str> = output.split("---").collect();
        let mut stats = ServerStats::default();
        let mut current_cpu = CpuSnapshot::default();

        // CPU: 이전 스냅샷과 비교하여 실시간 사용률 계산
        if let Some(cpu_line) = sections.first() {
            let parts: Vec<&str> = cpu_line.trim().split_whitespace().collect();
            if parts.len() >= 5 {
                let user: f64 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0);
                let nice: f64 = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0);
                let system: f64 = parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0.0);
                let idle: f64 = parts.get(4).and_then(|s| s.parse().ok()).unwrap_or(0.0);
                let iowait: f64 = parts.get(5).and_then(|s| s.parse().ok()).unwrap_or(0.0);
                let irq: f64 = parts.get(6).and_then(|s| s.parse().ok()).unwrap_or(0.0);
                let softirq: f64 = parts.get(7).and_then(|s| s.parse().ok()).unwrap_or(0.0);

                let total = user + nice + system + idle + iowait + irq + softirq;
                current_cpu = CpuSnapshot { total, idle };

                // 이전 값이 있으면 델타 계산
                if prev_cpu.total > 0.0 {
                    let d_total = total - prev_cpu.total;
                    let d_idle = idle - prev_cpu.idle;
                    if d_total > 0.0 {
                        stats.cpu_usage = ((d_total - d_idle) / d_total * 100.0 * 10.0).round() / 10.0;
                    }
                }
            }
        }

        // Memory
        if let Some(mem_line) = sections.get(1) {
            let parts: Vec<&str> = mem_line.trim().split_whitespace().collect();
            if parts.len() >= 3 {
                stats.mem_total = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
                stats.mem_used = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
                if stats.mem_total > 0 {
                    stats.mem_usage =
                        (stats.mem_used as f64 / stats.mem_total as f64 * 100.0 * 10.0).round() / 10.0;
                }
            }
        }

        // Disk
        if let Some(disk_line) = sections.get(2) {
            let parts: Vec<&str> = disk_line.trim().split_whitespace().collect();
            if parts.len() >= 4 {
                stats.disk_total = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
                stats.disk_used = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
                if stats.disk_total > 0 {
                    stats.disk_usage =
                        (stats.disk_used as f64 / stats.disk_total as f64 * 100.0 * 10.0).round() / 10.0;
                }
            }
        }

        // Load average
        if let Some(load_line) = sections.get(3) {
            let parts: Vec<&str> = load_line.trim().split_whitespace().collect();
            if parts.len() >= 3 {
                stats.load_avg = format!("{} {} {}", parts[0], parts[1], parts[2]);
            }
        }

        // Uptime
        if let Some(uptime_line) = sections.get(4) {
            stats.uptime = uptime_line.trim().to_string();
        }

        Ok((stats, current_cpu))
    }
}
