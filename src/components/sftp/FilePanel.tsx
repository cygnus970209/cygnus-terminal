import { useState, useEffect, useCallback, useRef, useMemo } from "react";
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
  getSelected: () => FileEntry[];
  getDragHoverDir: () => string | null;
  getRect: () => DOMRect | null;
}

export interface DragPayload {
  side: "left" | "right";
  entries: FileEntry[];
  sourcePath: string;
  sourceMode: "local" | "remote";
  sourceSftpId: string | null;
}

interface FilePanelProps {
  side: "left" | "right";
  mode: "remote" | "local";
  sftpId?: string | null;
  initialPath?: string;
  /** 상단 status stripe 에 보여줄 "user@host" / "Local" 등. 없으면 stripe 생략. */
  sourceLabel?: string;
  isFocused?: boolean;
  onFocus?: () => void;
  onFileAction?: (action: string, entry: FileEntry) => void;
  onDragStart?: (payload: DragPayload) => void;
  onDrop?: (targetPath: string, isDirTarget: boolean) => void;
  onContextMenu?: (
    selection: FileEntry[],
    currentPath: string,
    pos: { x: number; y: number },
  ) => void;
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
  side,
  mode,
  sftpId,
  initialPath,
  sourceLabel,
  isFocused,
  onFocus,
  onFileAction,
  onDragStart,
  onDrop,
  onContextMenu,
  registerHandle,
}: FilePanelProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || "/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOverSelf, setDragOverSelf] = useState(false);
  const [dragHoverDir, setDragHoverDir] = useState<string | null>(null);
  const dragHoverDirRef = useRef<string | null>(null);
  useEffect(() => {
    dragHoverDirRef.current = dragHoverDir;
  }, [dragHoverDir]);
  const panelRef = useRef<HTMLDivElement | null>(null);

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
      setSelectedPaths(new Set());
      setAnchorPath(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [mode, sftpId]);

  useEffect(() => {
    if (initialPath) loadDir(initialPath);
  }, [initialPath, sftpId]);

  const selectedEntries = useMemo(
    () => entries.filter((e) => selectedPaths.has(e.path)),
    [entries, selectedPaths],
  );

  useEffect(() => {
    registerHandle?.({
      currentPath,
      sftpId: sftpId || null,
      refresh: () => loadDir(currentPath),
      getSelected: () => selectedEntries,
      getDragHoverDir: () => dragHoverDirRef.current,
      getRect: () => panelRef.current?.getBoundingClientRect() ?? null,
    });
  }, [currentPath, sftpId, loadDir, registerHandle, selectedEntries]);

  const navigateTo = useCallback((path: string) => {
    loadDir(path);
  }, [loadDir]);

  const goParent = useCallback(() => {
    const parent = currentPath.replace(/[/\\][^/\\]+[/\\]?$/, "") || "/";
    navigateTo(parent);
  }, [currentPath, navigateTo]);

  // 선택 관리
  const handleRowClick = useCallback(
    (entry: FileEntry, e: React.MouseEvent) => {
      onFocus?.();
      if (e.shiftKey && anchorPath) {
        // Range: anchor 에서 현재까지
        const idxA = entries.findIndex((x) => x.path === anchorPath);
        const idxB = entries.findIndex((x) => x.path === entry.path);
        if (idxA === -1 || idxB === -1) return;
        const [from, to] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
        const range = new Set(entries.slice(from, to + 1).map((x) => x.path));
        setSelectedPaths(range);
      } else if (e.metaKey || e.ctrlKey) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
        setAnchorPath(entry.path);
      } else {
        setSelectedPaths(new Set([entry.path]));
        setAnchorPath(entry.path);
      }
    },
    [entries, anchorPath, onFocus],
  );

  // 키보드: Ctrl/Cmd+A, Escape
  useEffect(() => {
    if (!isFocused) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedPaths(new Set(entries.map((x) => x.path)));
      } else if (e.key === "Escape") {
        setSelectedPaths(new Set());
        setAnchorPath(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFocused, entries]);

  // 드래그
  const handleRowDragStart = useCallback(
    (entry: FileEntry, e: React.DragEvent) => {
      // 현재 드래그 시작한 행이 선택되지 않았으면 선택 상태를 이 행으로 바꾼다
      let chosen: FileEntry[];
      if (selectedPaths.has(entry.path) && selectedPaths.size > 1) {
        chosen = selectedEntries;
      } else {
        chosen = [entry];
        setSelectedPaths(new Set([entry.path]));
        setAnchorPath(entry.path);
      }
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData("application/x-cygnus-transfer", "1");
      onDragStart?.({
        side,
        entries: chosen,
        sourcePath: currentPath,
        sourceMode: mode,
        sourceSftpId: sftpId || null,
      });
    },
    [selectedPaths, selectedEntries, onDragStart, side, currentPath, mode, sftpId],
  );

  // 드래그 드롭: dragover에서 hover 상태 세팅, 종료(drop / window dragend)에서 일괄 해제.
  // dragenter/dragleave 로 관리하면 child 요소 오가며 경계 이벤트가 뒤섞여 불안정.
  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragOverSelf((v) => (v ? v : true));
  }, []);

  const handlePanelDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const target = dragHoverDir;
      setDragOverSelf(false);
      setDragHoverDir(null);
      onDrop?.(target || currentPath, Boolean(target));
    },
    [dragHoverDir, currentPath, onDrop],
  );

  // drop 없이 드래그가 끝난 경우 (ESC, 다른 창으로 빠져나감) → hover 상태 정리
  useEffect(() => {
    const onEnd = () => {
      setDragOverSelf(false);
      setDragHoverDir(null);
    };
    window.addEventListener("dragend", onEnd);
    return () => window.removeEventListener("dragend", onEnd);
  }, []);

  const handleDirDragOver = useCallback(
    (entry: FileEntry) => (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      setDragHoverDir((prev) => (prev === entry.path ? prev : entry.path));
    },
    [],
  );

  const handleDirDragLeave = useCallback(
    (entry: FileEntry) => (_e: React.DragEvent) => {
      setDragHoverDir((prev) => (prev === entry.path ? null : prev));
    },
    [],
  );

  const handleContextMenu = useCallback(
    (entry: FileEntry | null) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onFocus?.();
      let selection: FileEntry[];
      if (entry && !selectedPaths.has(entry.path)) {
        setSelectedPaths(new Set([entry.path]));
        setAnchorPath(entry.path);
        selection = [entry];
      } else {
        selection = selectedEntries;
      }
      onContextMenu?.(selection, currentPath, { x: e.clientX, y: e.clientY });
    },
    [onContextMenu, onFocus, selectedPaths, selectedEntries, currentPath],
  );

  const pathSegments = currentPath.split(/[/\\]/).filter(Boolean);

  return (
    <div
      ref={panelRef}
      className={`fp-panel ${dragOverSelf ? "fp-drag-over" : ""} ${
        isFocused ? "fp-focused" : ""
      }`}
      onClick={() => onFocus?.()}
      onDragOver={handlePanelDragOver}
      onDrop={handlePanelDrop}
      onContextMenu={handleContextMenu(null)}
    >
      {/* Source stripe — 현재 연결된 서버 / Local 을 명확히 */}
      {sourceLabel && (
        <div className={`fp-source fp-source-${mode}`}>
          <span className="fp-source-dot" />
          <span className="fp-source-label" title={sourceLabel}>
            {sourceLabel}
          </span>
          <span className="fp-source-kind">
            {mode === "remote" ? "SFTP" : "LOCAL"}
          </span>
        </div>
      )}

      {/* Breadcrumb */}
      <div className="fp-breadcrumb">
        <button className="fp-bc-up" onClick={goParent} title="Parent">↑</button>
        <span className="fp-bc-item" onClick={() => navigateTo("/")}>/</span>
        {pathSegments.map((seg, i) => {
          const segPath = "/" + pathSegments.slice(0, i + 1).join("/");
          return (
            <span key={segPath}>
              <span className="fp-bc-sep">/</span>
              <span className="fp-bc-item" onClick={() => navigateTo(segPath)}>
                {seg}
              </span>
            </span>
          );
        })}
        <button className="fp-refresh" onClick={() => loadDir(currentPath)} title="Refresh">
          ↻
        </button>
      </div>

      {/* List header */}
      <div className="fp-list-header">
        <span className="fp-col-name">Name</span>
        <span className="fp-col-size">Size</span>
        <span className="fp-col-date">Modified</span>
      </div>

      <div className="fp-list-body">
        {loading && entries.length === 0 && <div className="fp-status">Loading...</div>}
        {error && <div className="fp-status fp-error">{error}</div>}

        {currentPath !== "/" && (
          <div
            className="fp-row fp-row-dir fp-row-parent"
            onClick={goParent}
          >
            <span className="fp-col-name"><span className="fp-icon">📁</span> ..</span>
            <span className="fp-col-size" />
            <span className="fp-col-date" />
          </div>
        )}

        {entries.map((entry) => {
          const isSelected = selectedPaths.has(entry.path);
          const isDropTarget = entry.is_dir && dragHoverDir === entry.path;
          return (
            <div
              key={entry.path}
              className={`fp-row ${entry.is_dir ? "fp-row-dir" : ""} ${
                isSelected ? "fp-row-selected" : ""
              } ${isDropTarget ? "fp-row-drop-target" : ""}`}
              onClick={(e) => handleRowClick(entry, e)}
              onDoubleClick={() => {
                if (entry.is_dir) navigateTo(entry.path);
                else onFileAction?.("open", entry);
              }}
              onContextMenu={handleContextMenu(entry)}
              draggable
              onDragStart={(e) => handleRowDragStart(entry, e)}
              onDragOver={entry.is_dir ? handleDirDragOver(entry) : undefined}
              onDragLeave={entry.is_dir ? handleDirDragLeave(entry) : undefined}
            >
              <span className="fp-col-name">
                <span className="fp-icon">{entry.is_dir ? "📁" : "📄"}</span>
                {entry.name}
              </span>
              <span className="fp-col-size">{!entry.is_dir && formatSize(entry.size)}</span>
              <span className="fp-col-date">{formatDate(entry.modified)}</span>
            </div>
          );
        })}
      </div>

      {dragOverSelf && !dragHoverDir && (
        <div className="fp-drop-overlay">Drop to {currentPath}</div>
      )}
      {selectedPaths.size > 1 && (
        <div className="fp-selection-info">
          {selectedPaths.size} selected
        </div>
      )}
    </div>
  );
}

