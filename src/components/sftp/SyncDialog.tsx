import { useState, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import "./SyncDialog.css";

interface SyncEntry {
  relative_path: string;
  action: string;
  size: number;
  reason: string;
}

interface SyncPlan {
  entries: SyncEntry[];
  total_bytes: number;
  total_files: number;
}

type SyncEvent =
  | { type: "Progress"; data: { file: string; done: number; total: number } }
  | { type: "Completed"; data: { uploaded: number; downloaded: number } }
  | { type: "Error"; data: string };

interface SyncDialogProps {
  sftpId: string;
  remoteBasePath: string;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function SyncDialog({ sftpId, remoteBasePath, onClose }: SyncDialogProps) {
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState(remoteBasePath);
  const [direction, setDirection] = useState<"upload" | "download" | "both">("upload");
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<{ file: string; done: number; total: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleBrowseLocal = async () => {
    const path = await openDialog({
      title: "Select Local Folder",
      directory: true,
      multiple: false,
    });
    if (path) setLocalPath(path);
  };

  const handlePreview = useCallback(async () => {
    if (!localPath || !remotePath) return;
    try {
      setLoading(true);
      setError(null);
      setPlan(null);
      const p = await invoke<SyncPlan>("sync_preview", {
        sftpId,
        localPath,
        remotePath,
        direction,
      });
      setPlan(p);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [sftpId, localPath, remotePath, direction]);

  const handleSync = useCallback(async () => {
    if (!plan || !localPath || !remotePath) return;
    try {
      setSyncing(true);
      setError(null);
      setResult(null);

      const onEvent = new Channel<SyncEvent>();
      onEvent.onmessage = (event) => {
        if (event.type === "Progress") {
          setProgress(event.data);
        } else if (event.type === "Completed") {
          setResult(`Done! Uploaded: ${event.data.uploaded}, Downloaded: ${event.data.downloaded}`);
          setProgress(null);
        } else if (event.type === "Error") {
          setError(event.data);
        }
      };

      await invoke("sync_execute", {
        sftpId,
        localPath,
        remotePath,
        plan,
        onEvent,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setSyncing(false);
    }
  }, [sftpId, localPath, remotePath, plan]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="sync-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="sync-header">
          <h2 className="sync-title">Folder Sync</h2>
          <button className="sync-close" onClick={onClose}>×</button>
        </div>

        <div className="sync-content">
          <div className="sync-field">
            <label>Local Folder</label>
            <div className="sync-input-row">
              <input
                type="text"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="/Users/you/project"
              />
              <button className="sync-browse" onClick={handleBrowseLocal}>Browse</button>
            </div>
          </div>

          <div className="sync-field">
            <label>Remote Folder</label>
            <input
              type="text"
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
            />
          </div>

          <div className="sync-field">
            <label>Direction</label>
            <div className="sync-direction">
              <label className="sync-radio">
                <input type="radio" checked={direction === "upload"} onChange={() => setDirection("upload")} />
                Upload (Local → Remote)
              </label>
              <label className="sync-radio">
                <input type="radio" checked={direction === "download"} onChange={() => setDirection("download")} />
                Download (Remote → Local)
              </label>
              <label className="sync-radio">
                <input type="radio" checked={direction === "both"} onChange={() => setDirection("both")} />
                Bidirectional (newer wins)
              </label>
            </div>
          </div>

          <button
            className="sync-preview-btn"
            onClick={handlePreview}
            disabled={!localPath || !remotePath || loading}
          >
            {loading ? "Scanning..." : "Preview Changes"}
          </button>

          {error && <div className="sync-error">{error}</div>}

          {plan && (
            <div className="sync-plan">
              <div className="sync-plan-summary">
                {plan.total_files} files, {formatSize(plan.total_bytes)}
              </div>
              <div className="sync-plan-list">
                {plan.entries.map((e) => (
                  <div key={e.relative_path} className="sync-plan-entry">
                    <span className={`sync-action sync-action-${e.action}`}>
                      {e.action === "upload" ? "↑" : "↓"}
                    </span>
                    <span className="sync-path">{e.relative_path}</span>
                    <span className="sync-reason">{e.reason}</span>
                    <span className="sync-size">{formatSize(e.size)}</span>
                  </div>
                ))}
                {plan.entries.length === 0 && (
                  <div className="sync-empty">Everything is in sync!</div>
                )}
              </div>

              {plan.entries.length > 0 && (
                <button
                  className="sync-execute-btn"
                  onClick={handleSync}
                  disabled={syncing}
                >
                  {syncing ? "Syncing..." : `Sync ${plan.total_files} files`}
                </button>
              )}
            </div>
          )}

          {progress && (
            <div className="sync-progress">
              <div className="sync-progress-bar">
                <div
                  className="sync-progress-fill"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
              <span className="sync-progress-text">
                {progress.done}/{progress.total} — {progress.file}
              </span>
            </div>
          )}

          {result && <div className="sync-result">{result}</div>}
        </div>
      </div>
    </div>
  );
}
