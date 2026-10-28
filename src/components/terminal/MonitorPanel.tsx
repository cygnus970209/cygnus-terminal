import { t, useLocale } from "../../i18n";
import { ServerStats } from "../../hooks/useServerStats";
import { formatBytes } from "../../utils/format";
import "./MonitorPanel.css";

interface Props {
  stats: ServerStats | null;
  error: string | null;
}

function usageColor(pct: number): string {
  if (pct >= 90) return "var(--error)";
  if (pct >= 70) return "var(--peach)";
  if (pct >= 50) return "var(--warn)";
  return "var(--success)";
}

function usedTotal(used: number | null, total: number | null): string {
  return used == null || total == null ? "Unavailable" : `${formatBytes(used)} / ${formatBytes(total)}`;
}

function Gauge({ label, value, pct }: { label: string; value: string; pct: number | null }) {
  useLocale();
  return (
    <div className="mp-gauge">
      <div className="mp-gauge-head">
        <span className="mp-gauge-label">{label}</span>
        <span className="mp-gauge-value" title={value}>{value}</span>
      </div>
      <div className="mp-gauge-bar" aria-hidden="true">
        {pct != null && (
          <div className="mp-gauge-fill" style={{ width: `${pct}%`, background: usageColor(pct) }} />
        )}
      </div>
    </div>
  );
}

export default function MonitorPanel({ stats, error }: Props) {
  useLocale();
  if (error) return <div className="mp-error" role="alert">{t("Monitor error: ")}{error}</div>;
  if (!stats) return <div className="mp-loading" role="status">{t("Collecting stats...")}</div>;
  const windows = stats.windows;
  const partial = stats.platform === "windows" && (
    stats.cpu_usage == null || stats.mem_total == null || stats.disk_total == null ||
    stats.uptime == null || windows?.processes == null
  );
  return (
    <div className="mp-panel">
      <div className="mp-row">
        <Gauge
          label="CPU"
          value={stats.cpu_usage == null ? (windows ? "Unavailable" : "Sampling…") : `${stats.cpu_usage}%`}
          pct={stats.cpu_usage}
        />
        <Gauge label="MEM" value={usedTotal(stats.mem_used, stats.mem_total)} pct={stats.mem_usage} />
        <Gauge label="DISK" value={usedTotal(stats.disk_used, stats.disk_total)} pct={stats.disk_usage} />
      </div>
      <div className="mp-footer">
        {windows && <span className="mp-meta">Windows · PowerShell {windows.powershell_version}</span>}
        {stats.load_avg && (
          <span className="mp-meta"><span className="mp-meta-k">LOAD</span>{stats.load_avg}</span>
        )}
        <span className="mp-meta"><span className="mp-meta-k">{t("UPTIME")}</span>{stats.uptime ?? t("Unavailable")}</span>
      </div>
      {partial && (
        <p className="mp-notice" role="status">{t("Some metrics are unavailable. Check this SSH account’s CIM permissions and the Windows providers.")}</p>
      )}
      {windows && (
        <div className="mp-windows-details">
          <details className="mp-details" open>
            <summary>{t("Local disks")}{windows.disks ? ` (${windows.disks.length})` : t(" · unavailable")}</summary>
            {windows.disks == null ? <p className="mp-notice">{t("Disk information could not be read.")}</p> :
              windows.disks.length === 0 ? <p className="mp-notice">{t("No local fixed disks returned.")}</p> : (
                <table className="mp-table" aria-label={t("Windows local disks")}>
                  <thead><tr><th>{t("Drive")}</th><th>{t("Used / total")}</th><th>{t("Free")}</th></tr></thead>
                  <tbody>{windows.disks.map((disk) => (
                    <tr key={disk.name}>
                      <td>{disk.name}</td>
                      <td>{usedTotal(disk.total_bytes - disk.free_bytes, disk.total_bytes)}</td>
                      <td>{formatBytes(disk.free_bytes)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
          </details>
          <details className="mp-details">
            <summary>{t("Processes · top 20 by memory")}</summary>
            {windows.processes == null ? <p className="mp-notice">{t("Process information could not be read.")}</p> :
              windows.processes.length === 0 ? <p className="mp-notice">{t("No processes returned.")}</p> : (
                <table className="mp-table" aria-label={t("Windows processes")}>
                  <thead><tr><th>{t("Process")}</th><th>PID</th><th title={t("Resident memory (working set)")}>{t("Memory")}</th></tr></thead>
                  <tbody>{windows.processes.map((process) => (
                    <tr key={process.pid}>
                      <td title={process.name}>{process.name}</td>
                      <td>{process.pid}</td>
                      <td>{formatBytes(process.memory_bytes)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
          </details>
        </div>
      )}
    </div>
  );
}
