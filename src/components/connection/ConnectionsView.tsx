import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Profile } from "../../types";
import "./ConnectionsView.css";

interface ConnectionsViewProps {
  onConnect: (profile: Profile) => void;
  onEdit: (profile: Profile) => void;
  onNew: () => void;
  reloadKey?: number;
}

export default function ConnectionsView({
  onConnect,
  onEdit,
  onNew,
  reloadKey,
}: ConnectionsViewProps) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [searchQuery, setSearchQuery] = useState("");

  const loadProfiles = useCallback(async () => {
    try {
      const list = await invoke<Profile[]>("list_profiles");
      setProfiles(list);
    } catch (err) {
      console.error("Failed to load profiles:", err);
    }
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles, reloadKey]);

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this profile?")) return;
    try {
      await invoke("delete_profile", { id });
      loadProfiles();
    } catch (err) {
      console.error("Failed to delete profile:", err);
    }
  };

  const filtered = profiles.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.host.toLowerCase().includes(q) ||
      p.username.toLowerCase().includes(q) ||
      p.group_name.toLowerCase().includes(q)
    );
  });

  const grouped = filtered.reduce<Record<string, Profile[]>>((acc, p) => {
    const group = p.group_name || "Ungrouped";
    (acc[group] ??= []).push(p);
    return acc;
  }, {});

  return (
    <div className="cv-container">
      <div className="cv-toolbar">
        <input
          className="cv-search"
          type="text"
          placeholder="Search connections..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button className="cv-new-btn" onClick={onNew}>
          + New Connection
        </button>
      </div>

      <div className="cv-list">
        {Object.entries(grouped).map(([group, items]) => (
          <div key={group} className="cv-group">
            {group !== "Ungrouped" && (
              <div className="cv-group-label">{group}</div>
            )}
            {items.map((profile) => (
              <div key={profile.id} className="cv-item">
                <div
                  className="cv-item-main"
                  onClick={() => onConnect(profile)}
                >
                  <span className="cv-item-icon">⬡</span>
                  <div className="cv-item-info">
                    <span className="cv-item-name">{profile.name}</span>
                    <span className="cv-item-detail">
                      {profile.username}@{profile.host}:{profile.port}
                      {profile.auth_type === "key" ? " (key)" : ""}
                    </span>
                  </div>
                </div>
                <div className="cv-item-actions">
                  <button
                    className="cv-action-btn"
                    onClick={() => onEdit(profile)}
                    title="Edit"
                  >
                    ✎
                  </button>
                  <button
                    className="cv-action-btn cv-action-danger"
                    onClick={() => handleDelete(profile.id)}
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="cv-empty">
            {profiles.length === 0
              ? "No saved connections yet."
              : "No matching connections."}
          </div>
        )}
      </div>
    </div>
  );
}
