import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";

export default function DataTab() {
  const [status, setStatus] = useState<string | null>(null);

  const showStatus = (msg: string, ms = 2500) => {
    setStatus(msg);
    setTimeout(() => setStatus(null), ms);
  };

  const handleExport = async () => {
    try {
      const path = await save({
        title: "Export Data",
        defaultPath: "cygnus-export.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;

      await invoke("export_to_file", { path });
      showStatus("Exported successfully!");
    } catch (err) {
      showStatus(`Export failed: ${err}`, 3000);
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
      showStatus(`Imported ${count} items!`);
    } catch (err) {
      showStatus(`Import failed: ${err}`, 3000);
    }
  };

  return (
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
      {status && <div className="settings-status">{status}</div>}
    </div>
  );
}
