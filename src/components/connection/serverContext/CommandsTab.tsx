import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useInvokeState } from "../../../hooks/useInvokeState";
import { CommandBookmark } from "../../../types/server-context";

interface Props {
  profileId: number;
  onExecuteCommand: (command: string) => void;
}

export default function CommandsTab({ profileId, onExecuteCommand }: Props) {
  const [newCmd, setNewCmd] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const { data: bookmarks, reload } = useInvokeState<CommandBookmark[]>(
    "list_command_bookmarks",
    []
  );

  const loadBookmarks = useCallback(
    () => reload({ profileId }),
    [reload, profileId]
  );

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  const handleAdd = async () => {
    if (!newCmd.trim()) return;
    try {
      await invoke("create_command_bookmark", {
        req: {
          profile_id: profileId,
          command: newCmd.trim(),
          label: newLabel.trim() || null,
        },
      });
      setNewCmd("");
      setNewLabel("");
      setShowAdd(false);
      loadBookmarks();
    } catch (err) {
      console.error("Failed to create bookmark:", err);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await invoke("delete_command_bookmark", { id });
      loadBookmarks();
    } catch (err) {
      console.error("Failed to delete bookmark:", err);
    }
  };

  return (
    <>
      <div className="sc-header-row">
        <button className="sc-add-btn" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "+ Add"}
        </button>
      </div>
      {showAdd && (
        <div className="sc-add-form">
          <input
            type="text"
            placeholder="Command (e.g. docker ps)"
            value={newCmd}
            onChange={(e) => setNewCmd(e.target.value)}
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
              onClick={() => onExecuteCommand(bm.command)}
            >
              <span className="sc-item-icon">★</span>
              <div className="sc-item-info">
                {bm.label && <span className="sc-item-label">{bm.label}</span>}
                <span className="sc-item-text">{bm.command}</span>
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
            No bookmarked commands.
            <br />
            Click + Add to save one.
          </div>
        )}
      </div>
    </>
  );
}
