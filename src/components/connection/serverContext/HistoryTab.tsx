import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useInvokeState } from "../../../hooks/useInvokeState";
import { CommandHistoryEntry } from "../../../types/server-context";
import { HISTORY_REFRESH_INTERVAL_MS } from "../../../constants";

interface Props {
  profileId: number;
  onExecuteCommand: (command: string) => void;
}

export default function HistoryTab({ profileId, onExecuteCommand }: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: CommandHistoryEntry;
  } | null>(null);

  const { data: history, reload } = useInvokeState<CommandHistoryEntry[]>(
    "search_command_history",
    []
  );

  const loadHistory = useCallback(
    () => reload({ profileId, query: searchQuery || null, limit: 100 }),
    [reload, profileId, searchQuery]
  );

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // 주기적 새로고침
  useEffect(() => {
    const interval = setInterval(loadHistory, HISTORY_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadHistory]);

  // 다른 곳 클릭 시 context menu 닫기
  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const handleDelete = async (id: number) => {
    try {
      await invoke("delete_command_history", { id });
      loadHistory();
    } catch (err) {
      console.error("Failed to delete history:", err);
    }
  };

  const handleSaveToBookmarks = async (command: string) => {
    try {
      await invoke("create_command_bookmark", {
        req: { profile_id: profileId, command, label: null },
      });
      setContextMenu(null);
    } catch (err) {
      console.error("Failed to save bookmark:", err);
    }
  };

  return (
    <>
      <div className="sc-search">
        <input
          type="text"
          placeholder="Search commands..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="sc-list">
        {history.map((entry) => (
          <div
            key={entry.id}
            className="sc-item sc-item-history"
            onClick={() => onExecuteCommand(entry.command)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, entry });
            }}
            title={entry.executed_at}
          >
            <span className="sc-item-icon">$</span>
            <span className="sc-item-text">{entry.command}</span>
            <button
              className="sc-delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(entry.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        {history.length === 0 && (
          <div className="sc-empty">No command history yet.</div>
        )}
      </div>

      {contextMenu && (
        <div
          className="sc-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="sc-context-menu-item"
            onClick={() => handleSaveToBookmarks(contextMenu.entry.command)}
          >
            Save to Commands
          </button>
          <button
            className="sc-context-menu-item sc-context-menu-item-danger"
            onClick={() => {
              handleDelete(contextMenu.entry.id);
              setContextMenu(null);
            }}
          >
            Delete
          </button>
        </div>
      )}
    </>
  );
}
