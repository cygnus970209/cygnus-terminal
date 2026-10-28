import { t, useLocale } from "../../i18n";
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
  useLocale();
  const hasSelection = selectedCount > 0;
  const singleSelection = selectedCount === 1;

  return (
    <div className="sftp-toolbar" role="toolbar" aria-label={t("File actions")}>
      <button
        className="tb-btn tb-primary"
        onClick={onUpload}
        title={t("Upload to remote")}
      >
        <Icon name="upload" size={15} />
        <span>{t("Upload")}</span>
      </button>
      <button
        className="tb-btn"
        onClick={onDownload}
        disabled={!hasSelection}
        title={hasSelection ? t("Download selected") : t("Select files to download")}
      >
        <Icon name="download" size={15} />
        <span>{t("Download")}</span>
      </button>

      <div className="tb-sep" />

      <button className="tb-btn" onClick={onNewFolder} title={t("New folder")}>
        <Icon name="plus" size={15} />
        <span>{t("New Folder")}</span>
      </button>
      <button
        className="tb-btn"
        onClick={onRename}
        disabled={!singleSelection}
        title={t("Rename")}
      >
        <Icon name="edit" size={15} />
        <span>{t("Rename")}</span>
      </button>
      <button
        className="tb-btn tb-danger"
        onClick={onDelete}
        disabled={!hasSelection}
        title={t("Delete")}
      >
        <Icon name="trash" size={15} />
        <span>{t("Delete")}</span>
      </button>

      <div className="tb-sep" />

      <button className="tb-btn" onClick={onRefresh} title={t("Refresh")}>
        <Icon name="refresh" size={15} />
        <span>{t("Refresh")}</span>
      </button>
      <button className="tb-btn" onClick={onSync} title={t("Folder sync")}>
        <Icon name="transfer" size={15} />
        <span>{t("Sync")}</span>
      </button>

      <div className="tb-spacer" />

      {focusedSide && (
        <span className="tb-focus-hint">{t("Focus: ")}{focusedSide === "left" ? t("Left") : t("Right")}
          {selectedCount > 0 && ` · ${selectedCount} selected`}
        </span>
      )}
    </div>
  );
}
