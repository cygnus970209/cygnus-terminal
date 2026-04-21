import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./MonitorBar.css";

interface ServerStats {
  cpu_usage: number;
  mem_total: number;
  mem_used: number;
  mem_usage: number;
  disk_total: number;
  disk_used: number;
  disk_usage: number;
  load_avg: string;
  uptime: string;
}

interface MonitorBarProps {
  sessionId: string;
  visible: boolean;
  onToggle: () => void;
  onToggleLogs?: () => void;
  logViewerActive?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function usageColor(pct: number): string {
  if (pct >= 90) return "#f38ba8";
  if (pct >= 70) return "#fab387";
  if (pct >= 50) return "#f9e2af";
  return "#a6e3a1";
}

export default function MonitorBar({
  sessionId,
  visible,
  onToggle,
  onToggleLogs,
  logViewerActive,
}: MonitorBarProps) {
  const [monitorId, setMonitorId] = useState<string | null>(null);
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 모니터 시작
  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    const start = async () => {
      try {
        const id = await invoke<string>("monitor_start", { sessionId });
        if (!cancelled) setMonitorId(id);
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    };
    start();

    return () => {
      cancelled = true;
    };
  }, [sessionId, visible]);

  // 주기적 stats 폴링
  useEffect(() => {
    if (!monitorId || !visible) return;

    const poll = async () => {
      try {
        const s = await invoke<ServerStats>("monitor_get_stats", { monitorId });
        setStats(s);
        setError(null);
      } catch (err) {
        setError(String(err));
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [monitorId, visible]);

  // 클린업
  useEffect(() => {
    return () => {
      if (monitorId) {
        invoke("monitor_stop", { monitorId });
      }
    };
  }, [monitorId]);

  if (!visible) {
    return (
      <div className="monitor-toggle-bar">
        <button className="monitor-toggle monitor-toggle-closed" onClick={onToggle}>
          Monitor ▴
        </button>
        {onToggleLogs && (
          <button
            className={`monitor-toggle monitor-toggle-closed ${logViewerActive ? "monitor-toggle-active" : ""}`}
            onClick={onToggleLogs}
          >
            Logs {logViewerActive ? "▾" : "▴"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="monitor-bar">
      <div className="monitor-header">
        <span className="monitor-title">Server Monitor</span>
        {stats?.uptime && (
          <span className="monitor-uptime">{stats.uptime}</span>
        )}
        {onToggleLogs && (
          <button
            className={`monitor-logs-btn ${logViewerActive ? "monitor-logs-active" : ""}`}
            onClick={onToggleLogs}
          >
            Logs
          </button>
        )}
        <button className="monitor-close" onClick={onToggle}>
          ▾
        </button>
      </div>
      {error && <div className="monitor-error">{error}</div>}
      {stats && (
        <div className="monitor-stats">
          <div className="monitor-gauge">
            <div className="monitor-gauge-header">
              <span className="monitor-gauge-label">CPU</span>
              <span className="monitor-gauge-value">{stats.cpu_usage}%</span>
            </div>
            <div className="monitor-gauge-bar">
              <div
                className="monitor-gauge-fill"
                style={{
                  width: `${stats.cpu_usage}%`,
                  background: usageColor(stats.cpu_usage),
                }}
              />
            </div>
          </div>

          <div className="monitor-gauge">
            <div className="monitor-gauge-header">
              <span className="monitor-gauge-label">MEM</span>
              <span className="monitor-gauge-value">
                {formatBytes(stats.mem_used)} / {formatBytes(stats.mem_total)}
              </span>
            </div>
            <div className="monitor-gauge-bar">
              <div
                className="monitor-gauge-fill"
                style={{
                  width: `${stats.mem_usage}%`,
                  background: usageColor(stats.mem_usage),
                }}
              />
            </div>
          </div>

          <div className="monitor-gauge">
            <div className="monitor-gauge-header">
              <span className="monitor-gauge-label">DISK</span>
              <span className="monitor-gauge-value">
                {formatBytes(stats.disk_used)} / {formatBytes(stats.disk_total)}
              </span>
            </div>
            <div className="monitor-gauge-bar">
              <div
                className="monitor-gauge-fill"
                style={{
                  width: `${stats.disk_usage}%`,
                  background: usageColor(stats.disk_usage),
                }}
              />
            </div>
          </div>

          {stats.load_avg && (
            <div className="monitor-load">
              <span className="monitor-gauge-label">LOAD</span>
              <span className="monitor-load-value">{stats.load_avg}</span>
            </div>
          )}
        </div>
      )}
      {!stats && !error && (
        <div className="monitor-loading">Collecting stats...</div>
      )}
    </div>
  );
}
