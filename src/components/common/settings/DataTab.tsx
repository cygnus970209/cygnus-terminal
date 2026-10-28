import { t, useLocale } from "../../../i18n";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import ExecutionHistorySettings from "./ExecutionHistorySettings";

export default function DataTab() {
  useLocale();
  const [status, setStatus] = useState<string | null>(null);

  const showStatus = (msg: string, ms = 2500) => {
    setStatus(msg);
    setTimeout(() => setStatus(null), ms);
  };

  const handleExport = async () => {
    try {
      const path = await save({
        title: t("Export Data"),
        defaultPath: "cygnus-export.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;

      await invoke("export_to_file", { path });
      showStatus(t("Exported successfully!"));
    } catch (err) {
      showStatus(t("Export failed: {v0}", { v0: String(err) }), 3000);
    }
  };

  const handleImport = async () => {
    try {
      const path = await open({
        title: t("Import Data"),
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });
      if (!path) return;

      const count = await invoke<number>("import_from_file", { path });
      window.dispatchEvent(new Event("cygnus-profiles-changed"));
      showStatus(t("Imported {v0} items!", { v0: count }));
    } catch (err) {
      showStatus(t("Import failed: {v0}", { v0: String(err) }), 3000);
    }
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("Data")}</h3>
      <p className="settings-desc">{t("Export or import profiles (including RDP connection settings), command bookmarks, and path bookmarks.")}<br />{t("Passwords and saved RDP certificate trust are not included. Verify RDP certificates again after importing on another device.")}</p>
      <div className="settings-actions">
        <button className="settings-btn" onClick={handleExport}>{t("Export JSON")}</button>
        <button className="settings-btn" onClick={handleImport}>{t("Import JSON")}</button>
      </div>
      {status && <div className="settings-status">{status}</div>}
      <ExecutionHistorySettings />
    </div>
  );
}
