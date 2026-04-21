import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import "./SettingsDialog.css";

interface SettingsDialogProps {
  onClose: () => void;
}

export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [status, setStatus] = useState<string | null>(null);

  const handleExport = async () => {
    try {
      const path = await save({
        title: "Export Data",
        defaultPath: "cygnus-export.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;

      await invoke("export_to_file", { path });
      setStatus("Exported successfully!");
      setTimeout(() => setStatus(null), 2500);
    } catch (err) {
      setStatus(`Export failed: ${err}`);
      setTimeout(() => setStatus(null), 3000);
    }
  };

  const handleImport = async () => {
    try {
      const path = await open({
        title: "Import Data",
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });
      if (!path) return;

      const count = await invoke<number>("import_from_file", { path });
      setStatus(`Imported ${count} items!`);
      setTimeout(() => setStatus(null), 2500);
    } catch (err) {
      setStatus(`Import failed: ${err}`);
      setTimeout(() => setStatus(null), 3000);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2 className="settings-title">Settings</h2>
          <button className="settings-close" onClick={onClose}>×</button>
        </div>

        <div className="settings-content">
          <div className="settings-section">
            <h3 className="settings-section-title">Data</h3>
            <p className="settings-desc">
              Export or import profiles, command bookmarks, and path bookmarks.
              <br />
              Passwords are not included in exports for security.
            </p>
            <div className="settings-actions">
              <button className="settings-btn" onClick={handleExport}>
                Export JSON
              </button>
              <button className="settings-btn" onClick={handleImport}>
                Import JSON
              </button>
            </div>
          </div>

          <div className="settings-section">
            <h3 className="settings-section-title">Shortcuts</h3>
            <div className="settings-shortcuts">
              <div className="settings-shortcut">
                <span className="settings-key">⌘ ,</span>
                <span>Settings</span>
              </div>
            </div>
          </div>

          <div className="settings-section">
            <h3 className="settings-section-title">About</h3>
            <p className="settings-desc">Cygnus Terminal v0.1.0</p>
          </div>
        </div>

        {status && <div className="settings-status">{status}</div>}
      </div>
    </div>
  );
}
