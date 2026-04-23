import "./Toolbar.css";

interface ToolbarProps {
  selectedCount: number;
  focusedSide: "left" | "right" | null;
  onUpload: () => void;
  onDownload: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onSync: () => void;
}

export default function Toolbar({
  selectedCount,
  focusedSide,
  onUpload,
  onDownload,
  onNewFolder,
  onRename,
  onDelete,
  onRefresh,
  onSync,
}: ToolbarProps) {
  const hasSelection = selectedCount > 0;
  const singleSelection = selectedCount === 1;

  return (
    <div className="sftp-toolbar">
      <button className="tb-btn" onClick={onUpload} title="Upload to remote">
        <span className="tb-icon">↑</span>
        <span>Upload</span>
      </button>
      <button
        className="tb-btn"
        onClick={onDownload}
        disabled={!hasSelection}
        title={hasSelection ? "Download selected" : "Select files to download"}
      >
        <span className="tb-icon">↓</span>
        <span>Download</span>
      </button>

      <div className="tb-sep" />

      <button className="tb-btn" onClick={onNewFolder} title="New folder">
        <span className="tb-icon">+</span>
        <span>New Folder</span>
      </button>
      <button
        className="tb-btn"
        onClick={onRename}
        disabled={!singleSelection}
        title="Rename"
      >
        <span className="tb-icon">✎</span>
        <span>Rename</span>
      </button>
      <button
        className="tb-btn tb-danger"
        onClick={onDelete}
        disabled={!hasSelection}
        title="Delete"
      >
        <span className="tb-icon">🗑</span>
        <span>Delete</span>
      </button>

      <div className="tb-sep" />

      <button className="tb-btn" onClick={onRefresh} title="Refresh">
        <span className="tb-icon">↻</span>
        <span>Refresh</span>
      </button>
      <button className="tb-btn" onClick={onSync} title="Folder sync">
        <span className="tb-icon">⇄</span>
        <span>Sync</span>
      </button>

      <div className="tb-spacer" />

      {focusedSide && (
        <span className="tb-focus-hint">
          Focus: {focusedSide === "left" ? "Left" : "Right"}
          {selectedCount > 0 && ` · ${selectedCount} selected`}
        </span>
      )}
    </div>
  );
}
