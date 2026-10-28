import { t, useLocale } from "../../../i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { confirm } from "@tauri-apps/plugin-dialog";
import { CommandHistoryEntry } from "../../../types/server-context";
import { HISTORY_REFRESH_INTERVAL_MS } from "../../../constants";

interface Props {
  profileId: number;
  onExecuteCommand: (command: string) => void;
  showToast: (message: string) => void;
}

export default function HistoryTab({ profileId, onExecuteCommand, showToast }: Props) {
  useLocale();
  const [searchQuery, setSearchQuery] = useState("");
  const [history, setHistory] = useState<CommandHistoryEntry[]>([]);
  const [loadError, setLoadError] = useState("");
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");
  const clearingRef = useRef(false);
  const requestVersion = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: CommandHistoryEntry;
  } | null>(null);

  const loadHistory = useCallback(async () => {
    if (clearingRef.current) return;
    const version = ++requestVersion.current;
    try {
      const entries = await invoke<CommandHistoryEntry[]>("search_command_history", {
        profileId, query: searchQuery || null, limit: 100,
      });
      if (version !== requestVersion.current) return;
      setHistory(entries);
      setLoadError("");
    } catch {
      if (version === requestVersion.current) setLoadError("Could not load history. Try again.");
    }
  }, [profileId, searchQuery]);

  useEffect(() => {
    void loadHistory();
    return () => { requestVersion.current++; };
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

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    menuRef.current.style.left = `${Math.max(4, Math.min(contextMenu.x, window.innerWidth - rect.width - 4))}px`;
    menuRef.current.style.top = `${Math.max(4, Math.min(contextMenu.y, window.innerHeight - rect.height - 4))}px`;
  }, [contextMenu]);

  const handleClear = async () => {
    if (clearingRef.current) return;
    clearingRef.current = true;
    setContextMenu(null);
    setClearing(true);
    setClearError("");
    // Invalidate searches started before deletion so they cannot restore stale rows.
    requestVersion.current++;
    try {
      const approved = await confirm(
        "Delete all command history for this server, including entries hidden by search? This cannot be undone.",
        { title: t("Delete command history"), kind: "warning", okLabel: "Delete all history", cancelLabel: "Cancel" },
      );
      if (!approved) return;
      const deleted = await invoke<number>("clear_command_history", { profileId });
      setHistory([]);
      showToast(`Deleted ${deleted} history ${deleted === 1 ? "entry" : "entries"}`);
    } catch {
      setClearError("Could not delete history. Try again.");
    } finally {
      clearingRef.current = false;
      setClearing(false);
      void loadHistory();
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await invoke("delete_command_history", { id });
      loadHistory();
    } catch (err) {
      console.error("Failed to delete history:", err);
    }
  };

  const handleCopy = async (command: string) => {
    setContextMenu(null);
    try {
      await writeText(command);
      showToast("Command copied");
    } catch {
      showToast("Could not copy command. Try again.");
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
          placeholder={t("Search commands...")}
          value={searchQuery}
          disabled={clearing}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="sc-header-row">
        <button
          className="sc-add-btn sc-history-clear"
          disabled={clearing}
          onClick={() => void handleClear()}
        >{t("Delete all…")}</button>
      </div>
      <div className="sc-list">
        {clearError && <div className="sc-history-error" role="alert">{clearError}</div>}
        {loadError && <div className="sc-history-error" role="alert">
          {loadError} <button className="sc-add-btn" disabled={clearing} onClick={() => void loadHistory()}>{t("Retry")}</button>
        </div>}
        {history.map((entry) => (
          <div
            key={entry.id}
            className="sc-item sc-item-history"
            onClick={() => { if (!clearingRef.current) onExecuteCommand(entry.command); }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (clearingRef.current) return;
              setContextMenu({ x: e.clientX, y: e.clientY, entry });
            }}
            title={entry.command}
          >
            <span className="sc-item-icon">$</span>
            <span className="sc-item-text">{entry.command}</span>
            <button
              className="sc-delete-btn"
              disabled={clearing}
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(entry.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        {history.length === 0 && !loadError && (
          <div className="sc-empty">{searchQuery ? t("No matching commands.") : t("No command history yet.")}</div>
        )}
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="sc-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="sc-context-menu-item"
            onClick={() => void handleCopy(contextMenu.entry.command)}
          >{t("Copy")}</button>
          <button
            className="sc-context-menu-item"
            onClick={() => handleSaveToBookmarks(contextMenu.entry.command)}
          >{t("Save to Commands")}</button>
          <button
            className="sc-context-menu-item sc-context-menu-item-danger"
            onClick={() => {
              handleDelete(contextMenu.entry.id);
              setContextMenu(null);
            }}
          >{t("Delete")}</button>
          <button
            className="sc-context-menu-item sc-context-menu-item-danger"
            onClick={() => void handleClear()}
          >{t("Delete all history…")}</button>
        </div>
      )}
    </>
  );
}
