import { ReactNode } from "react";
import { ServerStats } from "../../hooks/useServerStats";
import { TransferJob } from "../sftp/TransferDock";
import "./StatusBar.css";

export type DrawerTab = "monitor" | "transfers" | "logs" | null;

interface Props {
  sessionLabel?: string | null; // 현재 활성 SSH 탭 label (있으면 표시)
  sshActive: boolean;           // 현재 세션이 SSH 인지 (monitor 탭 활성 조건)
  stats: ServerStats | null;    // summary 에 쓸 값
  transferJobs: TransferJob[];

  activeDrawer: DrawerTab;
  onToggleDrawer: (tab: DrawerTab) => void;

  /** drawer 안에 들어갈 content. App.tsx 가 activeDrawer 에 따라 렌더해서 children 으로 넣는다. */
  children?: ReactNode;
}

function formatPct(n: number | undefined) {
  if (n === undefined) return "--";
  return `${Math.round(n)}%`;
}

export default function StatusBar({
  sessionLabel,
  sshActive,
  stats,
  transferJobs,
  activeDrawer,
  onToggleDrawer,
  children,
}: Props) {
  const activeCount = transferJobs.filter(
    (j) => j.status === "running" || j.status === "pending",
  ).length;

  const drawerTitle =
    activeDrawer === "monitor"
      ? "Monitor"
      : activeDrawer === "transfers"
        ? `Transfers${activeCount > 0 ? ` (${activeCount})` : ""}`
        : activeDrawer === "logs"
          ? "Logs"
          : "";

  const handleTabClick = (tab: Exclude<DrawerTab, null>) => {
    onToggleDrawer(activeDrawer === tab ? null : tab);
  };

  return (
    <div className="sb-wrap">
      {activeDrawer && (
        <div className="sb-drawer">
          <div className="sb-drawer-head">
            <span className="sb-drawer-title">{drawerTitle}</span>
            <button
              className="sb-drawer-close"
              onClick={() => onToggleDrawer(null)}
              title="Close"
            >
              ▾
            </button>
          </div>
          <div className="sb-drawer-body">{children}</div>
        </div>
      )}

      <div className="sb-bar">
        <div className="sb-left">
          {sessionLabel && (
            <span className="sb-session">
              <span className="sb-session-dot" />
              <span className="sb-session-name">{sessionLabel}</span>
            </span>
          )}
          {sshActive && stats && (
            <span className="sb-quick">
              <span className="sb-quick-k">CPU</span>
              <span className="sb-quick-v">{formatPct(stats.cpu_usage)}</span>
              <span className="sb-quick-sep">·</span>
              <span className="sb-quick-k">RAM</span>
              <span className="sb-quick-v">{formatPct(stats.mem_usage)}</span>
              <span className="sb-quick-sep">·</span>
              <span className="sb-quick-k">DISK</span>
              <span className="sb-quick-v">{formatPct(stats.disk_usage)}</span>
            </span>
          )}
        </div>

        <div className="sb-tabs">
          <button
            className={`sb-tab ${activeDrawer === "monitor" ? "active" : ""}`}
            onClick={() => handleTabClick("monitor")}
            disabled={!sshActive}
            title={sshActive ? "Monitor (Cmd+1)" : "Monitor — SSH session only"}
          >
            Monitor
          </button>
          <button
            className={`sb-tab ${activeDrawer === "transfers" ? "active" : ""}`}
            onClick={() => handleTabClick("transfers")}
            title="Transfers (Cmd+2)"
          >
            Transfers
            {activeCount > 0 && <span className="sb-badge">{activeCount}</span>}
          </button>
          <button
            className={`sb-tab ${activeDrawer === "logs" ? "active" : ""}`}
            onClick={() => handleTabClick("logs")}
            disabled={!sshActive}
            title={sshActive ? "Logs (Cmd+3)" : "Logs — SSH session only"}
          >
            Logs
          </button>
        </div>

        <div className="sb-right">
          <span className="sb-hint" title="Command palette (coming)">⌘K</span>
        </div>
      </div>
    </div>
  );
}
