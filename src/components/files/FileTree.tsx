import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import "./FileTree.css";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
}

interface FileTreeProps {
  sessionId: string;
  navigateToPath?: string | null;
  cdTrackingEnabled: boolean;
  onCdTrackingChange: (enabled: boolean) => void;
  onCollapse?: () => void;
  onOpenSftpView?: () => void;
}

interface ExpandedDirs {
  [path: string]: FileEntry[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} K`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} G`;
}

export default function FileTree({
  sessionId,
  navigateToPath,
  cdTrackingEnabled,
  onCdTrackingChange,
  onCollapse,
  onOpenSftpView,
}: FileTreeProps) {
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<ExpandedDirs>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [transferStatus, setTransferStatus] = useState<string | null>(null);
  const dragCounter = useRef(0);

  // SFTP 세션 열기
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        setLoading(true);
        setError(null);
        const id = await invoke<string>("sftp_open", { sessionId });
        if (cancelled) return;
        setSftpId(id);

        const home = await invoke<string>("sftp_get_home_dir", { sftpId: id });
        if (cancelled) return;
        setCurrentPath(home);

        const files = await invoke<FileEntry[]>("sftp_list_dir", {
          sftpId: id,
          path: home,
        });
        if (cancelled) return;
        setEntries(files);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    init();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // cd 트래킹: navigateToPath 변경 시 자동 이동
  useEffect(() => {
    if (navigateToPath && sftpId && navigateToPath !== currentPath) {
      navigateTo(navigateToPath);
    }
  }, [navigateToPath]);

  // 세션 정리는 App 레벨에서 관리 (FileTree는 세션을 닫지 않음)

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const navigateTo = useCallback(
    async (path: string) => {
      if (!sftpId) return;
      try {
        setLoading(true);
        setError(null);
        const files = await invoke<FileEntry[]>("sftp_list_dir", {
          sftpId,
          path,
        });
        setEntries(files);
        setCurrentPath(path);
        setExpandedDirs({});
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [sftpId]
  );

  const toggleDir = useCallback(
    async (entry: FileEntry) => {
      if (!sftpId || !entry.is_dir) return;

      if (expandedDirs[entry.path]) {
        setExpandedDirs((prev) => {
          const next = { ...prev };
          delete next[entry.path];
          return next;
        });
        return;
      }

      try {
        const files = await invoke<FileEntry[]>("sftp_list_dir", {
          sftpId,
          path: entry.path,
        });
        setExpandedDirs((prev) => ({ ...prev, [entry.path]: files }));
      } catch (err) {
        console.error("Failed to list dir:", err);
      }
    },
    [sftpId, expandedDirs]
  );

  const handleDownload = useCallback(
    async (entry: FileEntry) => {
      if (!sftpId || entry.is_dir) return;
      try {
        const localPath = await save({
          title: "Save File",
          defaultPath: entry.name,
        });
        if (!localPath) return;
        setTransferStatus(`Downloading ${entry.name}...`);
        await invoke("sftp_download", {
          sftpId,
          remotePath: entry.path,
          localPath,
        });
        setTransferStatus(`Downloaded: ${entry.name}`);
        setTimeout(() => setTransferStatus(null), 2500);
      } catch (err) {
        setTransferStatus(`Failed: ${err}`);
        setTimeout(() => setTransferStatus(null), 3000);
      }
      setContextMenu(null);
    },
    [sftpId]
  );

  const handleUpload = useCallback(
    async (files: FileList) => {
      if (!sftpId) return;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const remotePath = currentPath.endsWith("/")
          ? `${currentPath}${file.name}`
          : `${currentPath}/${file.name}`;
        try {
          setTransferStatus(`Uploading ${file.name}...`);
          // 파일을 ArrayBuffer로 읽어서 로컬 임시 파일로 저장 후 업로드
          const buffer = await file.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          // Tauri에서는 파일 경로 기반이므로 write_file로 직접 전송
          await invoke("sftp_upload_bytes", {
            sftpId,
            remotePath,
            data: Array.from(bytes),
          });
          setTransferStatus(`Uploaded: ${file.name}`);
        } catch (err) {
          setTransferStatus(`Failed: ${err}`);
        }
      }
      setTimeout(() => setTransferStatus(null), 2500);
      navigateTo(currentPath);
    },
    [sftpId, currentPath, navigateTo]
  );

  const handleDelete = useCallback(
    async (entry: FileEntry) => {
      if (!sftpId) return;
      try {
        await invoke("sftp_delete", {
          sftpId,
          path: entry.path,
          isDir: entry.is_dir,
        });
        navigateTo(currentPath);
      } catch (err) {
        console.error("Failed to delete:", err);
      }
      setContextMenu(null);
    },
    [sftpId, currentPath, navigateTo]
  );

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
    } catch (err) {
      console.error("Failed to create dir:", err);
    }
  }, [sftpId, currentPath, navigateTo]);

  // breadcrumb 경로 파싱
  const pathSegments = currentPath.split("/").filter(Boolean);

  const renderEntry = (entry: FileEntry, depth: number) => {
    const isExpanded = !!expandedDirs[entry.path];
    const children = expandedDirs[entry.path];

    return (
      <div key={entry.path}>
        <div
          className={`ft-entry ${entry.is_dir ? "ft-entry-dir" : ""}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() =>
            entry.is_dir ? toggleDir(entry) : undefined
          }
          onDoubleClick={() =>
            entry.is_dir ? navigateTo(entry.path) : undefined
          }
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, entry });
          }}
          title={entry.path}
        >
          <span className="ft-icon">
            {entry.is_dir ? (isExpanded ? "▾" : "▸") : ""}
          </span>
          <span className="ft-icon-type">
            {entry.is_dir ? "📁" : "📄"}
          </span>
          <span className="ft-name">{entry.name}</span>
          {!entry.is_dir && (
            <span className="ft-size">{formatSize(entry.size)}</span>
          )}
        </div>
        {isExpanded &&
          children?.map((child) => renderEntry(child, depth + 1))}
      </div>
    );
  };

  if (error) {
    return (
      <div className="file-tree">
        <div className="ft-header">
          <span className="ft-title">Files</span>
        </div>
        <div className="ft-error">{error}</div>
      </div>
    );
  }

  return (
    <div
      className={`file-tree ${dragging ? "ft-drag-over" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        dragCounter.current++;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragCounter.current--;
        if (dragCounter.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCounter.current = 0;
        setDragging(false);
        if (e.dataTransfer.files.length > 0) {
          handleUpload(e.dataTransfer.files);
        }
      }}
    >
      <div className="ft-header">
        <span className="ft-title">Files</span>
        <label className="ft-track-toggle" title="Sync with terminal cd">
          <input
            type="checkbox"
            checked={cdTrackingEnabled}
            onChange={(e) => onCdTrackingChange(e.target.checked)}
          />
          <span className="ft-track-label">cd</span>
        </label>
        <button className="ft-btn" onClick={handleMkdir} title="New Folder">
          +📁
        </button>
        <button
          className="ft-btn"
          onClick={() => navigateTo(currentPath)}
          title="Refresh"
        >
          ↻
        </button>
        {onOpenSftpView && (
          <button className="ft-btn" onClick={onOpenSftpView} title="Open SFTP view">
            ⧉
          </button>
        )}
        {onCollapse && (
          <button className="ft-btn" onClick={onCollapse} title="Hide file tree">
            ▸
          </button>
        )}
      </div>

      <div className="ft-breadcrumb">
        <span
          className="ft-breadcrumb-item"
          onClick={() => navigateTo("/")}
        >
          /
        </span>
        {pathSegments.map((seg, i) => {
          const segPath = "/" + pathSegments.slice(0, i + 1).join("/");
          return (
            <span key={segPath}>
              <span className="ft-breadcrumb-sep">/</span>
              <span
                className="ft-breadcrumb-item"
                onClick={() => navigateTo(segPath)}
              >
                {seg}
              </span>
            </span>
          );
        })}
      </div>

      <div className="ft-list">
        {loading && entries.length === 0 && (
          <div className="ft-loading">Loading...</div>
        )}
        {/* 상위 디렉토리 */}
        {currentPath !== "/" && (
          <div
            className="ft-entry ft-entry-dir"
            style={{ paddingLeft: 8 }}
            onClick={() => {
              const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
              navigateTo(parent);
            }}
          >
            <span className="ft-icon">▸</span>
            <span className="ft-icon-type">📁</span>
            <span className="ft-name ft-name-parent">..</span>
          </div>
        )}
        {entries.map((entry) => renderEntry(entry, 0))}
      </div>

      {contextMenu && (
        <div
          className="ft-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.entry.is_dir && (
            <button
              className="ft-context-item"
              onClick={() => {
                navigateTo(contextMenu.entry.path);
                setContextMenu(null);
              }}
            >
              Open
            </button>
          )}
          {!contextMenu.entry.is_dir && (
            <button
              className="ft-context-item"
              onClick={() => handleDownload(contextMenu.entry)}
            >
              Download
            </button>
          )}
          <button
            className="ft-context-item ft-context-item-danger"
            onClick={() => handleDelete(contextMenu.entry)}
          >
            Delete
          </button>
        </div>
      )}

      {dragging && (
        <div className="ft-drop-overlay">Drop files to upload</div>
      )}

      {transferStatus && (
        <div className="ft-transfer-status">{transferStatus}</div>
      )}
    </div>
  );
}
