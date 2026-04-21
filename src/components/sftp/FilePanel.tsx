import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./FilePanel.css";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
}

export interface FilePanelHandle {
  currentPath: string;
  sftpId: string | null;
  refresh: () => void;
}

interface FilePanelProps {
  mode: "remote" | "local";
  sftpId?: string | null;
  initialPath?: string;
  onFileAction?: (action: string, entry: FileEntry) => void;
  onDragStart?: (entry: FileEntry) => void;
  onDrop?: (targetPath: string) => void;
  registerHandle?: (handle: FilePanelHandle) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDate(epoch: number | null): string {
  if (!epoch) return "";
  return new Date(epoch * 1000).toLocaleString();
}

export default function FilePanel({
  mode,
  sftpId,
  initialPath,
  onFileAction,
  onDragStart,
  onDrop,
  registerHandle,
}: FilePanelProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || "/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  const loadDir = useCallback(async (path: string) => {
    try {
      setLoading(true);
      setError(null);
      let files: FileEntry[];

      if (mode === "remote" && sftpId) {
        files = await invoke<FileEntry[]>("sftp_list_dir", { sftpId, path });
      } else if (mode === "local") {
        files = await invoke<FileEntry[]>("list_local_dir", { path });
      } else {
        setLoading(false);
        return;
      }

      setEntries(files);
      setCurrentPath(path);
      setSelectedEntry(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [mode, sftpId]);

  useEffect(() => {
    if (initialPath) loadDir(initialPath);
  }, [initialPath, sftpId]);

  useEffect(() => {
    registerHandle?.({
      currentPath,
      sftpId: sftpId || null,
      refresh: () => loadDir(currentPath),
    });
  }, [currentPath, sftpId, loadDir, registerHandle]);

  const navigateTo = useCallback((path: string) => {
    loadDir(path);
  }, [loadDir]);

  const pathSegments = currentPath.split(/[/\\]/).filter(Boolean);

  return (
    <div
      className={`fp-panel ${dragOver ? "fp-drag-over" : ""}`}
      onDragEnter={(e) => { e.preventDefault(); dragCounter.current++; setDragOver(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => { e.preventDefault(); dragCounter.current--; if (dragCounter.current === 0) setDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        dragCounter.current = 0;
        setDragOver(false);
        onDrop?.(currentPath);
      }}
    >
      {/* Breadcrumb */}
      <div className="fp-breadcrumb">
        <span className="fp-bc-item" onClick={() => navigateTo("/")}>/</span>
        {pathSegments.map((seg, i) => {
          const segPath = "/" + pathSegments.slice(0, i + 1).join("/");
          return (
            <span key={segPath}>
              <span className="fp-bc-sep">/</span>
              <span className="fp-bc-item" onClick={() => navigateTo(segPath)}>{seg}</span>
            </span>
          );
        })}
        <button className="fp-refresh" onClick={() => loadDir(currentPath)} title="Refresh">↻</button>
      </div>

      {/* File list */}
      <div className="fp-list-header">
        <span className="fp-col-name">Name</span>
        <span className="fp-col-size">Size</span>
        <span className="fp-col-date">Modified</span>
      </div>
      <div className="fp-list-body">
        {loading && entries.length === 0 && <div className="fp-status">Loading...</div>}
        {error && <div className="fp-status fp-error">{error}</div>}

        {currentPath !== "/" && (
          <div className="fp-row fp-row-dir" onClick={() => {
            const parent = currentPath.replace(/[/\\][^/\\]+[/\\]?$/, "") || "/";
            navigateTo(parent);
          }}>
            <span className="fp-col-name"><span className="fp-icon">📁</span> ..</span>
            <span className="fp-col-size" />
            <span className="fp-col-date" />
          </div>
        )}

        {entries.map((entry) => (
          <div
            key={entry.path}
            className={`fp-row ${entry.is_dir ? "fp-row-dir" : ""} ${selectedEntry?.path === entry.path ? "fp-row-selected" : ""}`}
            onClick={() => setSelectedEntry(entry)}
            onDoubleClick={() => {
              if (entry.is_dir) {
                navigateTo(entry.path);
              } else {
                onFileAction?.("open", entry);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setSelectedEntry(entry);
              onFileAction?.("context", entry);
            }}
            draggable={!entry.is_dir}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", JSON.stringify(entry));
              onDragStart?.(entry);
            }}
          >
            <span className="fp-col-name">
              <span className="fp-icon">{entry.is_dir ? "📁" : "📄"}</span>
              {entry.name}
            </span>
            <span className="fp-col-size">{!entry.is_dir && formatSize(entry.size)}</span>
            <span className="fp-col-date">{formatDate(entry.modified)}</span>
          </div>
        ))}
      </div>

      {dragOver && <div className="fp-drop-overlay">Drop here to transfer</div>}
    </div>
  );
}
