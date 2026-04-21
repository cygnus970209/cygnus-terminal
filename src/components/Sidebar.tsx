import { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Sidebar.css";

export interface Profile {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "key";
  password?: string;
  key_path?: string;
  group_name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface SidebarProps {
  onConnectProfile: (profile: Profile) => void;
  onEditProfile: (profile: Profile) => void;
  onNewProfile: () => void;
  onCollapse?: () => void;
}

const Sidebar = forwardRef<{ reload: () => void }, SidebarProps>(function Sidebar(
  { onConnectProfile, onEditProfile, onNewProfile, onCollapse },
  ref
) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    profile: Profile;
  } | null>(null);

  const loadProfiles = useCallback(async () => {
    try {
      const list = await invoke<Profile[]>("list_profiles");
      setProfiles(list);
    } catch (err) {
      console.error("Failed to load profiles:", err);
    }
  }, []);

  useImperativeHandle(ref, () => ({ reload: loadProfiles }), [loadProfiles]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, profile: Profile) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, profile });
  };

  const handleDelete = async (id: number) => {
    try {
      await invoke("delete_profile", { id });
      loadProfiles();
    } catch (err) {
      console.error("Failed to delete profile:", err);
    }
    setContextMenu(null);
  };

  // 그룹별 분류
  const grouped = profiles.reduce<Record<string, Profile[]>>((acc, p) => {
    const group = p.group_name || "Ungrouped";
    (acc[group] ??= []).push(p);
    return acc;
  }, {});

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Connections</span>
        <button className="sidebar-add-btn" onClick={onNewProfile} title="New Profile">
          +
        </button>
        {onCollapse && (
          <button className="sidebar-collapse-btn" onClick={onCollapse} title="Hide sidebar">
            ◂
          </button>
        )}
      </div>
      <div className="sidebar-list">
        {Object.entries(grouped).map(([group, items]) => (
          <div key={group} className="sidebar-group">
            {group !== "Ungrouped" && (
              <div className="sidebar-group-label">{group}</div>
            )}
            {items.map((profile) => (
              <div
                key={profile.id}
                className="sidebar-item"
                onClick={() => onConnectProfile(profile)}
                onContextMenu={(e) => handleContextMenu(e, profile)}
                title={`${profile.username}@${profile.host}:${profile.port}`}
              >
                <span className="sidebar-item-icon">⬡</span>
                <div className="sidebar-item-info">
                  <span className="sidebar-item-name">{profile.name}</span>
                  <span className="sidebar-item-host">
                    {profile.username}@{profile.host}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ))}
        {profiles.length === 0 && (
          <div className="sidebar-empty">
            No saved connections.
            <br />
            Click + to add one.
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              onEditProfile(contextMenu.profile);
              setContextMenu(null);
            }}
          >
            Edit
          </button>
          <button
            className="context-menu-item context-menu-item-danger"
            onClick={() => handleDelete(contextMenu.profile.id)}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
});

export default Sidebar;
