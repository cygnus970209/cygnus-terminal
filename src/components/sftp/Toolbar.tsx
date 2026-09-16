import Icon from "../common/Icon";
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
    <div className="sftp-toolbar" role="toolbar" aria-label="File actions">
      <button
        className="tb-btn tb-primary"
        onClick={onUpload}
        title="Upload to remote"
      >
        <Icon name="upload" size={15} />
        <span>Upload</span>
      </button>
      <button
        className="tb-btn"
        onClick={onDownload}
        disabled={!hasSelection}
        title={hasSelection ? "Download selected" : "Select files to download"}
      >
        <Icon name="download" size={15} />
        <span>Download</span>
      </button>

      <div className="tb-sep" />

      <button className="tb-btn" onClick={onNewFolder} title="New folder">
        <Icon name="plus" size={15} />
        <span>New Folder</span>
      </button>
      <button
        className="tb-btn"
        onClick={onRename}
        disabled={!singleSelection}
        title="Rename"
      >
        <Icon name="edit" size={15} />
        <span>Rename</span>
      </button>
      <button
        className="tb-btn tb-danger"
        onClick={onDelete}
        disabled={!hasSelection}
        title="Delete"
      >
        <Icon name="trash" size={15} />
        <span>Delete</span>
      </button>

      <div className="tb-sep" />

      <button className="tb-btn" onClick={onRefresh} title="Refresh">
        <Icon name="refresh" size={15} />
        <span>Refresh</span>
      </button>
      <button className="tb-btn" onClick={onSync} title="Folder sync">
        <Icon name="transfer" size={15} />
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
