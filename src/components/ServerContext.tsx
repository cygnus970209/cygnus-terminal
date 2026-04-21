import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./ServerContext.css";

interface CommandHistoryEntry {
  id: number;
  profile_id: number;
  command: string;
  executed_at: string;
}

interface CommandBookmark {
  id: number;
  profile_id: number;
  command: string;
  label: string | null;
  sort_order: number;
  created_at: string;
}

interface PathBookmark {
  id: number;
  profile_id: number;
  path: string;
  label: string | null;
  created_at: string;
}

interface ServerContextProps {
  profileId: number;
  onExecuteCommand: (command: string) => void;
  onCaptureCurrentPath?: () => Promise<string | null>;
}

type TabType = "history" | "commands" | "paths";

export default function ServerContext({
  profileId,
  onExecuteCommand,
  onCaptureCurrentPath,
}: ServerContextProps) {
  const [activeTab, setActiveTab] = useState<TabType>("history");
  const [history, setHistory] = useState<CommandHistoryEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [commandBookmarks, setCommandBookmarks] = useState<CommandBookmark[]>([]);
  const [pathBookmarks, setPathBookmarks] = useState<PathBookmark[]>([]);
  const [newBookmarkCmd, setNewBookmarkCmd] = useState("");
  const [newBookmarkLabel, setNewBookmarkLabel] = useState("");
  const [showAddBookmark, setShowAddBookmark] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newPathLabel, setNewPathLabel] = useState("");
  const [showAddPath, setShowAddPath] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [historyContextMenu, setHistoryContextMenu] = useState<{
    x: number;
    y: number;
    entry: CommandHistoryEntry;
  } | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const entries = await invoke<CommandHistoryEntry[]>(
        "search_command_history",
        {
          profileId,
          query: searchQuery || null,
          limit: 100,
        }
      );
      setHistory(entries);
    } catch (err) {
      console.error("Failed to load history:", err);
    }
  }, [profileId, searchQuery]);

  const loadCommandBookmarks = useCallback(async () => {
    try {
      const bookmarks = await invoke<CommandBookmark[]>(
        "list_command_bookmarks",
        { profileId }
      );
      setCommandBookmarks(bookmarks);
    } catch (err) {
      console.error("Failed to load command bookmarks:", err);
    }
  }, [profileId]);

  const loadPathBookmarks = useCallback(async () => {
    try {
      const bookmarks = await invoke<PathBookmark[]>(
        "list_path_bookmarks",
        { profileId }
      );
      setPathBookmarks(bookmarks);
    } catch (err) {
      console.error("Failed to load path bookmarks:", err);
    }
  }, [profileId]);

  useEffect(() => {
    if (activeTab === "history") loadHistory();
    else if (activeTab === "commands") loadCommandBookmarks();
    else if (activeTab === "paths") loadPathBookmarks();
  }, [activeTab, profileId, loadHistory, loadCommandBookmarks, loadPathBookmarks]);

  useEffect(() => {
    const close = () => setHistoryContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const handleDeleteHistory = async (id: number) => {
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
        req: {
          profile_id: profileId,
          command,
          label: null,
        },
      });
      setHistoryContextMenu(null);
    } catch (err) {
      console.error("Failed to save bookmark:", err);
    }
  };

  // 히스토리는 주기적 새로고침
  useEffect(() => {
    if (activeTab !== "history") return;
    const interval = setInterval(loadHistory, 3000);
    return () => clearInterval(interval);
  }, [activeTab, loadHistory]);

  const handleAddCommandBookmark = async () => {
    if (!newBookmarkCmd.trim()) return;
    try {
      await invoke("create_command_bookmark", {
        req: {
          profile_id: profileId,
          command: newBookmarkCmd.trim(),
          label: newBookmarkLabel.trim() || null,
        },
      });
      setNewBookmarkCmd("");
      setNewBookmarkLabel("");
      setShowAddBookmark(false);
      loadCommandBookmarks();
    } catch (err) {
      console.error("Failed to create bookmark:", err);
    }
  };

  const handleDeleteCommandBookmark = async (id: number) => {
    try {
      await invoke("delete_command_bookmark", { id });
      loadCommandBookmarks();
    } catch (err) {
      console.error("Failed to delete bookmark:", err);
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const handleSaveCurrentPath = async () => {
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
      loadPathBookmarks();
      showToast(`Saved: ${path}`);
    } catch (err) {
      console.error("Failed to save current path:", err);
    }
  };

  const handleAddPathBookmark = async () => {
    if (!newPath.trim()) return;
    try {
      await invoke("create_path_bookmark", {
        req: {
          profile_id: profileId,
          path: newPath.trim(),
          label: newPathLabel.trim() || null,
        },
      });
      setNewPath("");
      setNewPathLabel("");
      setShowAddPath(false);
      loadPathBookmarks();
    } catch (err) {
      console.error("Failed to create path bookmark:", err);
    }
  };

  const handleDeletePathBookmark = async (id: number) => {
    try {
      await invoke("delete_path_bookmark", { id });
      loadPathBookmarks();
    } catch (err) {
      console.error("Failed to delete path bookmark:", err);
    }
  };

  return (
    <div className="server-context">
      <div className="sc-tabs">
        <button
          className={`sc-tab ${activeTab === "history" ? "sc-tab-active" : ""}`}
          onClick={() => setActiveTab("history")}
        >
          History
        </button>
        <button
          className={`sc-tab ${activeTab === "commands" ? "sc-tab-active" : ""}`}
          onClick={() => setActiveTab("commands")}
        >
          Commands
        </button>
        <button
          className={`sc-tab ${activeTab === "paths" ? "sc-tab-active" : ""}`}
          onClick={() => setActiveTab("paths")}
        >
          Paths
        </button>
      </div>

      <div className="sc-content">
        {activeTab === "history" && (
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
                    setHistoryContextMenu({ x: e.clientX, y: e.clientY, entry });
                  }}
                  title={entry.executed_at}
                >
                  <span className="sc-item-icon">$</span>
                  <span className="sc-item-text">{entry.command}</span>
                  <button
                    className="sc-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteHistory(entry.id);
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
          </>
        )}

        {activeTab === "commands" && (
          <>
            <div className="sc-header-row">
              <button
                className="sc-add-btn"
                onClick={() => setShowAddBookmark(!showAddBookmark)}
              >
                {showAddBookmark ? "Cancel" : "+ Add"}
              </button>
            </div>
            {showAddBookmark && (
              <div className="sc-add-form">
                <input
                  type="text"
                  placeholder="Command (e.g. docker ps)"
                  value={newBookmarkCmd}
                  onChange={(e) => setNewBookmarkCmd(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddCommandBookmark()}
                  autoFocus
                />
                <input
                  type="text"
                  placeholder="Label (optional)"
                  value={newBookmarkLabel}
                  onChange={(e) => setNewBookmarkLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddCommandBookmark()}
                />
                <button className="sc-save-btn" onClick={handleAddCommandBookmark}>
                  Save
                </button>
              </div>
            )}
            <div className="sc-list">
              {commandBookmarks.map((bm) => (
                <div key={bm.id} className="sc-item sc-item-bookmark">
                  <div
                    className="sc-item-main"
                    onClick={() => onExecuteCommand(bm.command)}
                  >
                    <span className="sc-item-icon">★</span>
                    <div className="sc-item-info">
                      {bm.label && (
                        <span className="sc-item-label">{bm.label}</span>
                      )}
                      <span className="sc-item-text">{bm.command}</span>
                    </div>
                  </div>
                  <button
                    className="sc-delete-btn"
                    onClick={() => handleDeleteCommandBookmark(bm.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {commandBookmarks.length === 0 && !showAddBookmark && (
                <div className="sc-empty">
                  No bookmarked commands.
                  <br />
                  Click + Add to save one.
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === "paths" && (
          <>
            <div className="sc-header-row">
              {onCaptureCurrentPath && (
                <button
                  className="sc-add-btn"
                  onClick={handleSaveCurrentPath}
                >
                  Save Current
                </button>
              )}
              <button
                className="sc-add-btn"
                onClick={() => setShowAddPath(!showAddPath)}
              >
                {showAddPath ? "Cancel" : "+ Add"}
              </button>
            </div>
            {showAddPath && (
              <div className="sc-add-form">
                <input
                  type="text"
                  placeholder="Path (e.g. /var/log)"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddPathBookmark()}
                  autoFocus
                />
                <input
                  type="text"
                  placeholder="Label (optional)"
                  value={newPathLabel}
                  onChange={(e) => setNewPathLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddPathBookmark()}
                />
                <button className="sc-save-btn" onClick={handleAddPathBookmark}>
                  Save
                </button>
              </div>
            )}
            <div className="sc-list">
              {pathBookmarks.map((bm) => (
                <div key={bm.id} className="sc-item sc-item-bookmark">
                  <div
                    className="sc-item-main"
                    onClick={() => onExecuteCommand(`cd ${bm.path}`)}
                  >
                    <span className="sc-item-icon">📁</span>
                    <div className="sc-item-info">
                      {bm.label && (
                        <span className="sc-item-label">{bm.label}</span>
                      )}
                      <span className="sc-item-text">{bm.path}</span>
                    </div>
                  </div>
                  <button
                    className="sc-delete-btn"
                    onClick={() => handleDeletePathBookmark(bm.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {pathBookmarks.length === 0 && !showAddPath && (
                <div className="sc-empty">
                  No bookmarked paths.
                  <br />
                  Click + Add to save one.
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {historyContextMenu && (
        <div
          className="sc-context-menu"
          style={{ left: historyContextMenu.x, top: historyContextMenu.y }}
        >
          <button
            className="sc-context-menu-item"
            onClick={() => {
              handleSaveToBookmarks(historyContextMenu.entry.command);
            }}
          >
            Save to Commands
          </button>
          <button
            className="sc-context-menu-item sc-context-menu-item-danger"
            onClick={() => {
              handleDeleteHistory(historyContextMenu.entry.id);
              setHistoryContextMenu(null);
            }}
          >
            Delete
          </button>
        </div>
      )}

      {toast && <div className="sc-toast">{toast}</div>}
    </div>
  );
}
