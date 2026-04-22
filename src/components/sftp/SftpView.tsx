import { useState, useCallback, useRef, useEffect } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import FilePanel, { FileEntry, FilePanelHandle } from "./FilePanel";
import TransferPanel from "./TransferPanel";
import SyncDialog from "./SyncDialog";
import "./SftpView.css";

interface SftpViewProps {
  sessionId: string;
  sftpId: string;
  homePath: string;
  availableSessions?: { id: string; sftpId: string; label: string; homePath: string }[];
  onPopoutWindow?: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

type RightPanelMode = "local" | "remote";

export default function SftpView({
  sessionId,
  sftpId,
  homePath,
  availableSessions,
  onPopoutWindow,
}: SftpViewProps) {
  const [rightMode, setRightMode] = useState<RightPanelMode>("local");
  const [rightSftpId, setRightSftpId] = useState<string | null>(null);
  const [rightHomePath, setRightHomePath] = useState<string>("/");
  const [toast, setToast] = useState<string | null>(null);
  const [showSync, setShowSync] = useState(false);

  // 로컬 홈 디렉토리 로드
  useEffect(() => {
    invoke<string>("get_local_home_dir").then((home) => {
      setRightHomePath(home);
    }).catch(() => {});
  }, []);
  const [dragSource, setDragSource] = useState<{ side: "left" | "right"; entry: FileEntry } | null>(null);

  const leftHandle = useRef<FilePanelHandle | null>(null);
  const rightHandle = useRef<FilePanelHandle | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const handleRightSourceChange = useCallback(async (value: string) => {
    if (value === "local") {
      setRightMode("local");
      setRightSftpId(null);
      setRightHomePath("/");
    } else {
      const session = availableSessions?.find((s) => s.id === value);
      if (!session) return;
      setRightMode("remote");
      setRightSftpId(session.sftpId);
      setRightHomePath(session.homePath);
    }
  }, [availableSessions]);

  // 왼쪽 → 오른쪽 전송 (또는 반대)
  const handleTransfer = useCallback(async (
    source: { side: "left" | "right"; entry: FileEntry },
    targetPath: string,
  ) => {
    const entry = source.entry;
    if (entry.is_dir) return;

    const destFile = targetPath.endsWith("/")
      ? `${targetPath}${entry.name}`
      : `${targetPath}/${entry.name}`;

    try {
      if (source.side === "left") {
        // 왼쪽(원격) → 오른쪽
        if (rightMode === "local") {
          // 원격 → 로컬 다운로드
          showToast(`Downloading ${entry.name}...`);
          await invoke("sftp_download", {
            sftpId,
            remotePath: entry.path,
            localPath: destFile,
          });
          showToast(`Downloaded: ${entry.name}`);
        } else if (rightSftpId) {
          // 원격A → 원격B
          showToast(`Copying ${entry.name}...`);
          const bytes = await invoke<number>("sftp_copy_between", {
            srcSftpId: sftpId,
            srcPath: entry.path,
            dstSftpId: rightSftpId,
            dstPath: destFile,
          });
          showToast(`Copied: ${entry.name} (${formatSize(bytes)})`);
        }
      } else {
        // 오른쪽 → 왼쪽(원격)
        if (rightMode === "local") {
          // 로컬 → 원격 업로드
          showToast(`Uploading ${entry.name}...`);
          await invoke("sftp_upload", {
            sftpId,
            remotePath: destFile,
            localPath: entry.path,
          });
          showToast(`Uploaded: ${entry.name}`);
        } else if (rightSftpId) {
          // 원격B → 원격A
          showToast(`Copying ${entry.name}...`);
          const bytes = await invoke<number>("sftp_copy_between", {
            srcSftpId: rightSftpId,
            srcPath: entry.path,
            dstSftpId: sftpId,
            dstPath: destFile,
          });
          showToast(`Copied: ${entry.name} (${formatSize(bytes)})`);
        }
      }
      leftHandle.current?.refresh();
      rightHandle.current?.refresh();
    } catch (err) {
      showToast(`Failed: ${err}`);
    }
  }, [sftpId, rightSftpId, rightMode]);

  const handleFileAction = useCallback(async (
    side: "left" | "right",
    action: string,
    entry: FileEntry,
  ) => {
    if (action === "open" && !entry.is_dir) {
      // 더블클릭 → 에디터로 열기 (왼쪽 원격 파일만)
      if (side === "left") {
        type WatchEvent =
          | { type: "Uploading"; data: string }
          | { type: "Uploaded"; data: string }
          | { type: "Error"; data: string };

        const onEvent = new Channel<WatchEvent>();
        onEvent.onmessage = (event) => {
          if (event.type === "Uploading") showToast(`Auto-uploading ${event.data}...`);
          else if (event.type === "Uploaded") showToast(`Uploaded: ${event.data}`);
          else if (event.type === "Error") showToast(`Error: ${event.data}`);
        };

        try {
          showToast(`Opening ${entry.name}...`);
          await invoke("open_in_editor", { sftpId, remotePath: entry.path, onEvent });
          showToast(`${entry.name} opened. Save to auto-upload.`);
        } catch (err) {
          showToast(`Failed: ${err}`);
        }
      }
    }
  }, [sftpId]);

  return (
    <div className="sftp-view">
      {/* Headers */}
      <div className="sftp-dual-header">
        <div className="sftp-panel-header">
          <span className="sftp-panel-label">Remote</span>
          <button className="sftp-hdr-btn" onClick={() => setShowSync(true)} title="Folder Sync">
            ⇄ Sync
          </button>
          {onPopoutWindow && (
            <button className="sftp-hdr-btn" onClick={onPopoutWindow} title="Pop out">⧉</button>
          )}
        </div>
        <div className="sftp-panel-divider" />
        <div className="sftp-panel-header">
          <select
            className="sftp-source-select"
            value={rightMode === "local" ? "local" : rightSftpId || ""}
            onChange={(e) => handleRightSourceChange(e.target.value)}
          >
            <option value="local">Local</option>
            {availableSessions
              ?.filter((s) => s.id !== sessionId)
              .map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
          </select>
        </div>
      </div>

      {/* Dual panels */}
      <div className="sftp-dual-panels">
        <FilePanel
          mode="remote"
          sftpId={sftpId}
          initialPath={homePath}
          registerHandle={(h) => { leftHandle.current = h; }}
          onFileAction={(action, entry) => handleFileAction("left", action, entry)}
          onDragStart={(entry) => setDragSource({ side: "left", entry })}
          onDrop={(targetPath) => {
            if (dragSource && dragSource.side === "right") {
              handleTransfer(dragSource, targetPath);
            }
            setDragSource(null);
          }}
        />
        <div className="sftp-panel-divider" />
        <FilePanel
          mode={rightMode}
          sftpId={rightSftpId}
          initialPath={rightHomePath}
          registerHandle={(h) => { rightHandle.current = h; }}
          onFileAction={(action, entry) => handleFileAction("right", action, entry)}
          onDragStart={(entry) => setDragSource({ side: "right", entry })}
          onDrop={(targetPath) => {
            if (dragSource && dragSource.side === "left") {
              handleTransfer(dragSource, targetPath);
            }
            setDragSource(null);
          }}
        />
      </div>

      <TransferPanel />

      {toast && <div className="sftp-toast">{toast}</div>}
      {showSync && (
        <SyncDialog
          sftpId={sftpId}
          remoteBasePath={leftHandle.current?.currentPath || homePath}
          onClose={() => {
            setShowSync(false);
            leftHandle.current?.refresh();
          }}
        />
      )}
    </div>
  );
}
