import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useInvokeState } from "../../../hooks/useInvokeState";
import { PathBookmark } from "../../../types/server-context";

interface Props {
  profileId: number;
  onExecuteCommand: (command: string) => void;
  onCaptureCurrentPath?: () => Promise<string | null>;
  showToast: (msg: string) => void;
}

export default function PathsTab({
  profileId,
  onExecuteCommand,
  onCaptureCurrentPath,
  showToast,
}: Props) {
  const [newPath, setNewPath] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const { data: bookmarks, reload } = useInvokeState<PathBookmark[]>(
    "list_path_bookmarks",
    []
  );

  const loadBookmarks = useCallback(
    () => reload({ profileId }),
    [reload, profileId]
  );

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  const handleSaveCurrent = async () => {
    if (!onCaptureCurrentPath) return;
    const path = await onCaptureCurrentPath();
    if (!path) {
      showToast("Cannot capture path in current mode");
      return;
    }
    try {
      await invoke("create_path_bookmark", {
        req: { profile_id: profileId, path, label: null },
      });
      loadBookmarks();
      showToast(`Saved: ${path}`);
    } catch (err) {
      console.error("Failed to save current path:", err);
    }
  };

  const handleAdd = async () => {
    if (!newPath.trim()) return;
    try {
      await invoke("create_path_bookmark", {
        req: {
          profile_id: profileId,
          path: newPath.trim(),
          label: newLabel.trim() || null,
        },
      });
      setNewPath("");
      setNewLabel("");
      setShowAdd(false);
      loadBookmarks();
    } catch (err) {
      console.error("Failed to create path bookmark:", err);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await invoke("delete_path_bookmark", { id });
      loadBookmarks();
    } catch (err) {
      console.error("Failed to delete path bookmark:", err);
    }
  };

  return (
    <>
      <div className="sc-header-row">
        {onCaptureCurrentPath && (
          <button className="sc-add-btn" onClick={handleSaveCurrent}>
            Save Current
          </button>
        )}
        <button className="sc-add-btn" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "+ Add"}
        </button>
      </div>
      {showAdd && (
        <div className="sc-add-form">
          <input
            type="text"
            placeholder="Path (e.g. /var/log)"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            autoFocus
          />
          <input
            type="text"
            placeholder="Label (optional)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <button className="sc-save-btn" onClick={handleAdd}>
            Save
          </button>
        </div>
      )}
      <div className="sc-list">
        {bookmarks.map((bm) => (
          <div key={bm.id} className="sc-item sc-item-bookmark">
            <div
              className="sc-item-main"
              onClick={() => onExecuteCommand(`cd ${bm.path}`)}
            >
              <span className="sc-item-icon">📁</span>
              <div className="sc-item-info">
                {bm.label && <span className="sc-item-label">{bm.label}</span>}
                <span className="sc-item-text">{bm.path}</span>
              </div>
            </div>
            <button
              className="sc-delete-btn"
              onClick={() => handleDelete(bm.id)}
            >
              ×
            </button>
          </div>
        ))}
        {bookmarks.length === 0 && !showAdd && (
          <div className="sc-empty">
            No bookmarked paths.
            <br />
            Click + Add to save one.
          </div>
        )}
      </div>
    </>
  );
}
