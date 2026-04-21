import { useState, useEffect, useCallback, useRef } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import TransferPanel from "./TransferPanel";
import "./SftpView.css";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
}

interface SftpViewProps {
  sessionId: string;
  availableSessions?: { id: string; label: string }[];
  onPopoutWindow?: () => void;
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

function formatPermissions(perm: number | null): string {
  if (perm === null) return "";
  return (perm & 0o777).toString(8).padStart(3, "0");
}

export default function SftpView({ sessionId, availableSessions, onPopoutWindow }: SftpViewProps) {
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dragCounter = useRef(0);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  // SFTP 세션 열기
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        setLoading(true);
        const id = await invoke<string>("sftp_open", { sessionId });
        if (cancelled) return;
        setSftpId(id);
        const home = await invoke<string>("sftp_get_home_dir", { sftpId: id });
        if (cancelled) return;
        setCurrentPath(home);
        const files = await invoke<FileEntry[]>("sftp_list_dir", { sftpId: id, path: home });
        if (cancelled) return;
        setEntries(files);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    init();
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    return () => { if (sftpId) invoke("sftp_close", { sftpId }); };
  }, [sftpId]);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const navigateTo = useCallback(async (path: string) => {
    if (!sftpId) return;
    try {
      setLoading(true);
      setError(null);
      const files = await invoke<FileEntry[]>("sftp_list_dir", { sftpId, path });
      setEntries(files);
      setCurrentPath(path);
      setSelectedEntry(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [sftpId]);

  const handleDownload = useCallback(async (entry: FileEntry) => {
    if (!sftpId || entry.is_dir) return;
    try {
      const localPath = await save({ title: "Save File", defaultPath: entry.name });
      if (!localPath) return;
      showToast(`Downloading ${entry.name}...`);
      await invoke("sftp_download", { sftpId, remotePath: entry.path, localPath });
      showToast(`Downloaded: ${entry.name}`);
    } catch (err) {
      showToast(`Failed: ${err}`);
    }
    setContextMenu(null);
  }, [sftpId]);

  const handleOpenInEditor = useCallback(async (entry: FileEntry) => {
    if (!sftpId || entry.is_dir) return;
    try {
      type WatchEvent =
        | { type: "Uploading"; data: string }
        | { type: "Uploaded"; data: string }
        | { type: "Error"; data: string };

      const onEvent = new Channel<WatchEvent>();
      onEvent.onmessage = (event) => {
        if (event.type === "Uploading") {
          showToast(`Auto-uploading ${event.data}...`);
        } else if (event.type === "Uploaded") {
          showToast(`Uploaded: ${event.data}`);
        } else if (event.type === "Error") {
          showToast(`Error: ${event.data}`);
        }
      };

      showToast(`Opening ${entry.name} in editor...`);
      await invoke("open_in_editor", {
        sftpId,
        remotePath: entry.path,
        onEvent,
      });
      showToast(`${entry.name} opened. Save to auto-upload.`);
    } catch (err) {
      showToast(`Failed: ${err}`);
    }
  }, [sftpId]);

  const handleUpload = useCallback(async () => {
    if (!sftpId) return;
    try {
      const localPath = await openDialog({
        title: "Upload File",
        multiple: false,
        directory: false,
      });
      if (!localPath) return;
      const fileName = localPath.split("/").pop() || localPath.split("\\").pop() || "file";
      const remotePath = currentPath.endsWith("/")
        ? `${currentPath}${fileName}`
        : `${currentPath}/${fileName}`;
      showToast(`Uploading ${fileName}...`);
      await invoke("sftp_upload", { sftpId, remotePath, localPath });
      showToast(`Uploaded: ${fileName}`);
      navigateTo(currentPath);
    } catch (err) {
      showToast(`Failed: ${err}`);
    }
  }, [sftpId, currentPath, navigateTo]);

  const handleDrop = useCallback(async (files: FileList) => {
    if (!sftpId) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const remotePath = currentPath.endsWith("/")
        ? `${currentPath}${file.name}`
        : `${currentPath}/${file.name}`;
      try {
        showToast(`Uploading ${file.name}...`);
        const buffer = await file.arrayBuffer();
        await invoke("sftp_upload_bytes", {
          sftpId,
          remotePath,
          data: Array.from(new Uint8Array(buffer)),
        });
        showToast(`Uploaded: ${file.name}`);
      } catch (err) {
        showToast(`Failed: ${err}`);
      }
    }
    navigateTo(currentPath);
  }, [sftpId, currentPath, navigateTo]);

  const handleDelete = useCallback(async (entry: FileEntry) => {
    if (!sftpId) return;
    if (!confirm(`Delete ${entry.name}?`)) return;
    try {
      await invoke("sftp_delete", { sftpId, path: entry.path, isDir: entry.is_dir });
      navigateTo(currentPath);
      showToast(`Deleted: ${entry.name}`);
    } catch (err) {
      showToast(`Failed: ${err}`);
    }
    setContextMenu(null);
  }, [sftpId, currentPath, navigateTo]);

  const handleRename = useCallback(async (entry: FileEntry) => {
    if (!sftpId) return;
    const newName = prompt("New name:", entry.name);
    if (!newName || newName === entry.name) return;
    const parentDir = entry.path.replace(/\/[^/]+\/?$/, "") || "/";
    const newPath = parentDir.endsWith("/")
      ? `${parentDir}${newName}`
      : `${parentDir}/${newName}`;
    try {
      await invoke("sftp_rename", { sftpId, oldPath: entry.path, newPath });
      navigateTo(currentPath);
      showToast(`Renamed: ${newName}`);
    } catch (err) {
      showToast(`Failed: ${err}`);
    }
    setContextMenu(null);
  }, [sftpId, currentPath, navigateTo]);

  const handleCopyToServer = useCallback(async (entry: FileEntry, targetSessionId: string) => {
    if (!sftpId || entry.is_dir) return;
    try {
      // 대상 서버의 SFTP 세션 열기
      showToast(`Connecting to target server...`);
      const dstSftpId = await invoke<string>("sftp_open", { sessionId: targetSessionId });
      const dstHome = await invoke<string>("sftp_get_home_dir", { sftpId: dstSftpId });
      const dstPath = dstHome.endsWith("/")
        ? `${dstHome}${entry.name}`
        : `${dstHome}/${entry.name}`;

      showToast(`Copying ${entry.name}...`);
      const bytes = await invoke<number>("sftp_copy_between", {
        srcSftpId: sftpId,
        srcPath: entry.path,
        dstSftpId,
        dstPath,
      });
      showToast(`Copied: ${entry.name} (${formatSize(bytes)})`);

      // 대상 SFTP 세션 정리
      await invoke("sftp_close", { sftpId: dstSftpId });
    } catch (err) {
      showToast(`Failed: ${err}`);
    }
    setContextMenu(null);
  }, [sftpId]);

  const handleMkdir = useCallback(async () => {
    if (!sftpId) return;
    const name = prompt("New folder name:");
    if (!name) return;
    const path = currentPath.endsWith("/")
      ? `${currentPath}${name}`
      : `${currentPath}/${name}`;
    try {
      await invoke("sftp_mkdir", { sftpId, path });
      navigateTo(currentPath);
      showToast(`Created: ${name}`);
    } catch (err) {
      showToast(`Failed: ${err}`);
    }
  }, [sftpId, currentPath, navigateTo]);

  const pathSegments = currentPath.split("/").filter(Boolean);

  if (error && !sftpId) {
    return (
      <div className="sftp-view">
        <div className="sftp-error-full">{error}</div>
      </div>
    );
  }

  return (
    <div
      className={`sftp-view ${dragging ? "sftp-drag-over" : ""}`}
      onDragEnter={(e) => { e.preventDefault(); dragCounter.current++; setDragging(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => { e.preventDefault(); dragCounter.current--; if (dragCounter.current === 0) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); dragCounter.current = 0; setDragging(false); if (e.dataTransfer.files.length > 0) handleDrop(e.dataTransfer.files); }}
    >
      {/* Toolbar */}
      <div className="sftp-toolbar">
        <div className="sftp-breadcrumb">
          <span className="sftp-bc-item" onClick={() => navigateTo("/")}>/</span>
          {pathSegments.map((seg, i) => {
            const segPath = "/" + pathSegments.slice(0, i + 1).join("/");
            return (
              <span key={segPath}>
                <span className="sftp-bc-sep">/</span>
                <span className="sftp-bc-item" onClick={() => navigateTo(segPath)}>{seg}</span>
              </span>
            );
          })}
        </div>
        <div className="sftp-toolbar-actions">
          <button className="sftp-tool-btn" onClick={handleUpload} title="Upload">
            ↑ Upload
          </button>
          <button className="sftp-tool-btn" onClick={handleMkdir} title="New Folder">
            + Folder
          </button>
          <button className="sftp-tool-btn" onClick={() => navigateTo(currentPath)} title="Refresh">
            ↻
          </button>
          {onPopoutWindow && (
            <button className="sftp-tool-btn" onClick={onPopoutWindow} title="Open in new window">
              ⧉
            </button>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="sftp-main">
        {/* File list */}
        <div className="sftp-file-list">
          <div className="sftp-list-header">
            <span className="sftp-col-name">Name</span>
            <span className="sftp-col-size">Size</span>
            <span className="sftp-col-modified">Modified</span>
            <span className="sftp-col-perm">Perm</span>
          </div>
          <div className="sftp-list-body">
            {loading && entries.length === 0 && (
              <div className="sftp-loading">Loading...</div>
            )}
            {currentPath !== "/" && (
              <div
                className="sftp-row sftp-row-dir"
                onClick={() => {
                  const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
                  navigateTo(parent);
                }}
              >
                <span className="sftp-col-name">
                  <span className="sftp-file-icon">📁</span>
                  <span className="sftp-file-name">..</span>
                </span>
                <span className="sftp-col-size" />
                <span className="sftp-col-modified" />
                <span className="sftp-col-perm" />
              </div>
            )}
            {entries.map((entry) => (
              <div
                key={entry.path}
                className={`sftp-row ${entry.is_dir ? "sftp-row-dir" : ""} ${
                  selectedEntry?.path === entry.path ? "sftp-row-selected" : ""
                }`}
                onClick={() => setSelectedEntry(entry)}
                onDoubleClick={() => entry.is_dir ? navigateTo(entry.path) : handleOpenInEditor(entry)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, entry });
                }}
              >
                <span className="sftp-col-name">
                  <span className="sftp-file-icon">{entry.is_dir ? "📁" : "📄"}</span>
                  <span className="sftp-file-name">{entry.name}</span>
                </span>
                <span className="sftp-col-size">
                  {!entry.is_dir && formatSize(entry.size)}
                </span>
                <span className="sftp-col-modified">
                  {formatDate(entry.modified)}
                </span>
                <span className="sftp-col-perm">
                  {formatPermissions(entry.permissions)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Detail panel */}
        {selectedEntry && (
          <div className="sftp-detail">
            <div className="sftp-detail-header">
              <span className="sftp-detail-icon">
                {selectedEntry.is_dir ? "📁" : "📄"}
              </span>
              <span className="sftp-detail-name">{selectedEntry.name}</span>
            </div>
            <div className="sftp-detail-rows">
              <div className="sftp-detail-row">
                <span className="sftp-detail-label">Path</span>
                <span className="sftp-detail-value">{selectedEntry.path}</span>
              </div>
              <div className="sftp-detail-row">
                <span className="sftp-detail-label">Type</span>
                <span className="sftp-detail-value">
                  {selectedEntry.is_dir ? "Directory" : "File"}
                </span>
              </div>
              {!selectedEntry.is_dir && (
                <div className="sftp-detail-row">
                  <span className="sftp-detail-label">Size</span>
                  <span className="sftp-detail-value">
                    {formatSize(selectedEntry.size)}
                  </span>
                </div>
              )}
              <div className="sftp-detail-row">
                <span className="sftp-detail-label">Modified</span>
                <span className="sftp-detail-value">
                  {formatDate(selectedEntry.modified)}
                </span>
              </div>
              <div className="sftp-detail-row">
                <span className="sftp-detail-label">Permissions</span>
                <span className="sftp-detail-value">
                  {formatPermissions(selectedEntry.permissions)}
                </span>
              </div>
            </div>
            <div className="sftp-detail-actions">
              {!selectedEntry.is_dir && (
                <button
                  className="sftp-action-btn"
                  onClick={() => handleDownload(selectedEntry)}
                >
                  Download
                </button>
              )}
              <button
                className="sftp-action-btn"
                onClick={() => handleRename(selectedEntry)}
              >
                Rename
              </button>
              <button
                className="sftp-action-btn sftp-action-danger"
                onClick={() => handleDelete(selectedEntry)}
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Transfer Panel */}
      <TransferPanel />

      {/* Context menu */}
      {contextMenu && (
        <div
          className="sftp-ctx-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.entry.is_dir && (
            <button className="sftp-ctx-item" onClick={() => { navigateTo(contextMenu.entry.path); setContextMenu(null); }}>
              Open
            </button>
          )}
          {!contextMenu.entry.is_dir && (
            <>
              <button className="sftp-ctx-item" onClick={() => { handleOpenInEditor(contextMenu.entry); setContextMenu(null); }}>
                Edit
              </button>
              <button className="sftp-ctx-item" onClick={() => handleDownload(contextMenu.entry)}>
                Download
              </button>
            </>
          )}
          <button className="sftp-ctx-item" onClick={() => handleRename(contextMenu.entry)}>
            Rename
          </button>
          {!contextMenu.entry.is_dir && availableSessions && availableSessions.length > 0 && (
            <>
              <div className="sftp-ctx-divider" />
              <div className="sftp-ctx-label">Copy to...</div>
              {availableSessions
                .filter((s) => s.id !== sessionId)
                .map((s) => (
                  <button
                    key={s.id}
                    className="sftp-ctx-item"
                    onClick={() => handleCopyToServer(contextMenu.entry, s.id)}
                  >
                    {s.label}
                  </button>
                ))}
            </>
          )}
          <div className="sftp-ctx-divider" />
          <button className="sftp-ctx-item sftp-ctx-danger" onClick={() => handleDelete(contextMenu.entry)}>
            Delete
          </button>
        </div>
      )}

      {dragging && <div className="sftp-drop-overlay">Drop files to upload</div>}
      {toast && <div className="sftp-toast">{toast}</div>}
    </div>
  );
}
