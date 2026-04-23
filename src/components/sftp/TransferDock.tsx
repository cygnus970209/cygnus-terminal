import { useState, useMemo } from "react";
import "./TransferDock.css";

export interface TransferJob {
  id: string;
  job_type: string;
  source_path: string;
  dest_path: string;
  file_name: string;
  total_bytes: number;
  transferred_bytes: number;
  status: string;
  error: string | null;
  speed_bps: number;
}

export type TransferEvent =
  | { type: "QueueUpdate"; data: TransferJob[] }
  | {
      type: "Progress";
      data: {
        job_id: string;
        transferred_bytes: number;
        total_bytes: number;
        speed_bps: number;
      };
    }
  | { type: "Completed"; data: string }
  | { type: "Failed"; data: { job_id: string; error: string } };

interface Props {
  jobs: TransferJob[];
  onCancel: (jobId: string) => void;
  onClearCompleted: () => void;
  /** StatusBar drawer 안에 넣을 때는 true — 자체 header/collapse 없이 body 만 렌더 */
  headless?: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

function formatEta(job: TransferJob): string {
  if (job.speed_bps === 0 || job.total_bytes === 0) return "";
  const remaining = Math.max(0, job.total_bytes - job.transferred_bytes);
  const secs = remaining / job.speed_bps;
  if (!isFinite(secs)) return "";
  if (secs < 60) return `${Math.ceil(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.ceil(secs % 60)}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function JobRow({ job, onCancel }: { job: TransferJob; onCancel: (id: string) => void }) {
  const pct =
    job.total_bytes > 0
      ? Math.min(100, Math.floor((job.transferred_bytes / job.total_bytes) * 100))
      : job.status === "completed"
        ? 100
        : 0;

  const arrow =
    job.job_type === "upload" ? "↑" : job.job_type === "download" ? "↓" : "⇄";

  const canCancel = job.status === "running" || job.status === "pending";

  return (
    <div className={`td-row td-status-${job.status}`}>
      <div className="td-row-main">
        <span className="td-arrow">{arrow}</span>
        <span
          className="td-name"
          title={`${job.source_path} → ${job.dest_path}`}
        >
          {job.file_name}
        </span>
        <span className="td-meta">
          {formatBytes(job.transferred_bytes)} / {formatBytes(job.total_bytes)}
          {job.status === "running" && job.speed_bps > 0 && (
            <>
              <span className="td-dot">·</span>
              {formatSpeed(job.speed_bps)}
              {formatEta(job) && (
                <>
                  <span className="td-dot">·</span>
                  {formatEta(job)}
                </>
              )}
            </>
          )}
          {job.status === "failed" && job.error && (
            <>
              <span className="td-dot">·</span>
              <span className="td-err">{job.error}</span>
            </>
          )}
          {job.status === "completed" && <span className="td-done">done</span>}
          {job.status === "cancelled" && (
            <span className="td-cancelled">cancelled</span>
          )}
          {job.status === "pending" && <span className="td-pending">queued</span>}
        </span>
        {canCancel && (
          <button
            className="td-cancel"
            onClick={() => onCancel(job.id)}
            title="Cancel"
          >
            ✕
          </button>
        )}
      </div>
      <div className="td-bar">
        <div
          className="td-bar-fill"
          style={{ width: `${pct}%` }}
          data-status={job.status}
        />
      </div>
    </div>
  );
}

export default function TransferDock({ jobs, onCancel, onClearCompleted, headless }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const { active, finished, totalBytes, transferredBytes } = useMemo(() => {
    const active = jobs.filter(
      (j) => j.status === "running" || j.status === "pending",
    );
    const finished = jobs.filter(
      (j) =>
        j.status === "completed" ||
        j.status === "failed" ||
        j.status === "cancelled",
    );
    const totalBytes = active.reduce((s, j) => s + j.total_bytes, 0);
    const transferredBytes = active.reduce((s, j) => s + j.transferred_bytes, 0);
    return { active, finished, totalBytes, transferredBytes };
  }, [jobs]);

  const overallPct =
    totalBytes > 0 ? Math.min(100, Math.floor((transferredBytes / totalBytes) * 100)) : 0;

  const body = (
    <div className="td-body">
      {jobs.length === 0 ? (
        <div className="td-empty">No transfers yet</div>
      ) : (
        <>
          {active.map((j) => (
            <JobRow key={j.id} job={j} onCancel={onCancel} />
          ))}
          {finished.map((j) => (
            <JobRow key={j.id} job={j} onCancel={onCancel} />
          ))}
        </>
      )}
    </div>
  );

  if (headless) {
    return (
      <div className="transfer-dock td-headless">
        {jobs.length > 0 && (
          <div className="td-mini-only">
            <span className="td-mini-bar">
              <span className="td-mini-fill" style={{ width: `${overallPct}%` }} />
            </span>
            <span className="td-mini-label">{overallPct}%</span>
            {finished.length > 0 && (
              <button className="td-clear-btn" onClick={onClearCompleted}>
                Clear completed
              </button>
            )}
          </div>
        )}
        {body}
      </div>
    );
  }

  return (
    <div className={`transfer-dock ${collapsed ? "td-collapsed" : ""}`}>
      <button
        className="td-header"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? "Expand transfers" : "Collapse transfers"}
      >
        <span className="td-caret">{collapsed ? "▸" : "▾"}</span>
        <span className="td-title">Transfers</span>
        {active.length > 0 && (
          <span className="td-badge">{active.length}</span>
        )}
        {active.length > 0 && (
          <span className="td-mini-progress">
            <span className="td-mini-bar">
              <span
                className="td-mini-fill"
                style={{ width: `${overallPct}%` }}
              />
            </span>
            <span className="td-mini-label">{overallPct}%</span>
          </span>
        )}
        <span className="td-spacer" />
        {finished.length > 0 && (
          <span
            className="td-clear"
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onClearCompleted();
            }}
          >
            Clear
          </span>
        )}
      </button>

      {!collapsed && body}
    </div>
  );
}
