import { ServerStats } from "../../hooks/useServerStats";
import "./MonitorPanel.css";

interface Props {
  stats: ServerStats | null;
  error: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function usageColor(pct: number): string {
  if (pct >= 90) return "var(--error, #f38ba8)";
  if (pct >= 70) return "var(--peach, #f5a97f)";
  if (pct >= 50) return "var(--warn, #f9e2af)";
  return "var(--success, #a6e3a1)";
}

function Gauge({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div className="mp-gauge">
      <div className="mp-gauge-head">
        <span className="mp-gauge-label">{label}</span>
        <span className="mp-gauge-value">{value}</span>
      </div>
      <div className="mp-gauge-bar">
        <div
          className="mp-gauge-fill"
          style={{ width: `${pct}%`, background: usageColor(pct) }}
        />
      </div>
    </div>
  );
}

export default function MonitorPanel({ stats, error }: Props) {
  if (error) {
    return <div className="mp-error">Monitor error: {error}</div>;
  }
  if (!stats) {
    return <div className="mp-loading">Collecting stats...</div>;
  }
  return (
    <div className="mp-panel">
      <div className="mp-row">
        <Gauge label="CPU" value={`${stats.cpu_usage}%`} pct={stats.cpu_usage} />
        <Gauge
          label="MEM"
          value={`${formatBytes(stats.mem_used)} / ${formatBytes(stats.mem_total)}`}
          pct={stats.mem_usage}
        />
        <Gauge
          label="DISK"
          value={`${formatBytes(stats.disk_used)} / ${formatBytes(stats.disk_total)}`}
          pct={stats.disk_usage}
        />
      </div>
      <div className="mp-footer">
        {stats.load_avg && (
          <span className="mp-meta"><span className="mp-meta-k">LOAD</span> {stats.load_avg}</span>
        )}
        {stats.uptime && (
          <span className="mp-meta"><span className="mp-meta-k">UPTIME</span> {stats.uptime}</span>
        )}
      </div>
    </div>
  );
}
