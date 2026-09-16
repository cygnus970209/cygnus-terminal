import Select from "../common/Select";
import { useState, useEffect, useCallback, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Profile, profileEndpoint } from "../../types";
import Icon from "../common/Icon";
import "./ConnectionsView.css";

interface ConnectionsViewProps {
  mode?: "sidebar" | "page";
  children?: ReactNode;
  onLocalShell?: () => void;
  onConnect: (profile: Profile) => void;
  onEdit: (profile: Profile) => void;
  onNew: () => void;
  reloadKey?: number;
  activeProfileId?: number | null;
  connectedProfileIds?: number[];
  onProfilesLoaded?: (profiles: Profile[]) => void;
}
const FAVORITES_KEY = "cygnus.connections.favorites";

export default function ConnectionsView({
  mode = "sidebar",
  children,
  onLocalShell,
  onConnect,
  onEdit,
  onNew,
  reloadKey,
  activeProfileId,
  connectedProfileIds = [],
  onProfilesLoaded,
}: ConnectionsViewProps) {
  const [protocolFilter, setProtocolFilter] = useState("");
  const [scope, setScope] = useState("all");
  const [groupFilter, setGroupFilter] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [favorites, setFavorites] = useState<number[]>(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(FAVORITES_KEY) ?? "[]",
      );
      return Array.isArray(value)
        ? value.filter((id): id is number => typeof id === "number")
        : [];
    } catch {
      return [];
    }
  });
  const loadProfiles = useCallback(async () => {
    setError(null);
    try {
      const list = await invoke<Profile[]>("list_profiles");
      setProfiles(list);
      onProfilesLoaded?.(list);
    } catch {
      setError("Could not load connections. Try again.");
    } finally {
      setLoading(false);
    }
  }, [onProfilesLoaded]);
  useEffect(() => {
    void loadProfiles();
    const refreshFavorites = () => {
      try {
        const value = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
        if (Array.isArray(value))
          setFavorites(value.filter((id) => typeof id === "number"));
      } catch {
        /* Keep the current favorites if storage is unavailable. */
      }
    };
    window.addEventListener("cygnus-profiles-changed", loadProfiles);
    window.addEventListener("cygnus-favorites-changed", refreshFavorites);
    return () => {
      window.removeEventListener("cygnus-profiles-changed", loadProfiles);
      window.removeEventListener("cygnus-favorites-changed", refreshFavorites);
    };
  }, [loadProfiles, reloadKey]);
  const toggleFavorite = (id: number) => {
    const next = favorites.includes(id)
      ? favorites.filter((item) => item !== id)
      : [...favorites, id];
    setFavorites(next);
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event("cygnus-favorites-changed"));
    } catch {
      /* Favorites still work for this session. */
    }
  };
  const handleDelete = async (profile: Profile) => {
    if (
      !confirm(
        `Delete saved connection "${profile.name}"? Open sessions will stay open.`,
      )
    )
      return;
    try {
      await invoke("delete_profile", { id: profile.id });
      window.dispatchEvent(new Event("cygnus-profiles-changed"));
    } catch {
      setError("Could not delete this connection. Try again.");
    }
  };
  const q = searchQuery.trim().toLowerCase();
  const filtered = profiles.filter((p) =>
    [p.name, p.host, p.username, p.group_name, p.protocol ?? "ssh"].some(
      (value) => value.toLowerCase().includes(q),
    ),
  );
  const grouped = filtered.reduce<Record<string, Profile[]>>((acc, p) => {
    (acc[p.group_name || "Ungrouped"] ??= []).push(p);
    return acc;
  }, {});
  const row = (profile: Profile, favoriteSection = false) => (
    <div
      key={profile.id}
      className={`cv-item ${activeProfileId === profile.id ? "cv-item-selected" : ""}`}
    >
      <button
        className="cv-item-main"
        onClick={() => onConnect(profile)}
        title={`Connect to ${profileEndpoint(profile)}`}
      >
        <span
          className={`cv-item-icon ${connectedProfileIds.includes(profile.id) ? "cv-connected" : ""}`}
        >
          <Icon name={favoriteSection ? "star" : "server"} size={15} />
        </span>
        <span className="cv-item-info">
          <span className="cv-item-name">{profile.name}</span>
          <span className="cv-item-detail">
            {(profile.protocol ?? "ssh").toUpperCase()} ·{" "}
            {profileEndpoint(profile)}
          </span>
        </span>
      </button>
      <div className="cv-item-actions">
        <button
          className={`cv-action-btn ${favorites.includes(profile.id) ? "cv-favorite" : ""}`}
          onClick={() => toggleFavorite(profile.id)}
          title={
            favorites.includes(profile.id) ? "Remove favorite" : "Add favorite"
          }
          aria-label={`${favorites.includes(profile.id) ? "Unfavorite" : "Favorite"} ${profile.name}`}
          aria-pressed={favorites.includes(profile.id)}
        >
          <Icon name="star" size={13} />
        </button>
        <button
          className="cv-action-btn"
          onClick={() => onEdit(profile)}
          title={`Edit ${profile.name}`}
          aria-label={`Edit ${profile.name}`}
        >
          <Icon name="edit" size={13} />
        </button>
        <button
          className="cv-action-btn cv-action-danger"
          onClick={() => void handleDelete(profile)}
          title={`Delete ${profile.name}`}
          aria-label={`Delete ${profile.name}`}
        >
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  );
  if (mode === "page") {
    const visible = filtered
      .filter(
        (profile) =>
          (!protocolFilter || (profile.protocol ?? "ssh") === protocolFilter) &&
          (!groupFilter ||
            (profile.group_name || "Ungrouped") === groupFilter) &&
          (scope === "all" ||
            (scope === "favorites"
              ? favorites.includes(profile.id)
              : connectedProfileIds.includes(profile.id))),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const groups = [
      ...new Set(profiles.map((profile) => profile.group_name || "Ungrouped")),
    ].sort();
    return (
      <section className="ssh-page" aria-label="SSH connections">
        <header className="ssh-page-header">
          <div>
            <div className="ssh-eyebrow">
              <Icon name="terminal" size={16} /> CYGNUS TERMINAL
            </div>
            <h1>Connections</h1>
            <p>SSH, Telnet and Serial. Your connections in one place.</p>
          </div>
          <div className="ssh-header-actions">
            <button className="ssh-secondary" onClick={onLocalShell}>
              <Icon name="terminal" />
              Local shell
            </button>
            <button className="ssh-primary" onClick={onNew}>
              <Icon name="plus" />
              New connection
            </button>
          </div>
        </header>
        <div className="ssh-filters">
          <label className="cv-search-wrap">
            <Icon name="search" />
            <input
              className="cv-search"
              aria-label="Search connections"
              placeholder="Search name, address, protocol or group…"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          <Select
            aria-label="Filter by protocol"
            value={protocolFilter}
            onValueChange={(value) => setProtocolFilter(value)}
          >
            <option value="">All protocols</option>
            <option value="ssh">SSH</option>
            <option value="telnet">Telnet</option>
            <option value="serial">Serial</option>
          </Select>
          <Select
            aria-label="Filter by server group"
            value={groupFilter}
            onValueChange={(value) => setGroupFilter(value)}
          >
            <option value="">All groups</option>
            {groups.map((group) => (
              <option key={group}>{group}</option>
            ))}
          </Select>
        </div>
        <div className="ssh-list-heading">
          <div
            className="ssh-scopes"
            role="group"
            aria-label="Connection filters"
          >
            {[
              ["all", "All connections"],
              ["favorites", "Favorites"],
              ["connected", "Connected"],
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={scope === value}
                onClick={() => setScope(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <span>
            {visible.length}{" "}
            {visible.length === 1 ? "connection" : "connections"}
          </span>
        </div>
        {error && (
          <div className="cv-error" role="alert">
            {error}
            <button onClick={() => void loadProfiles()}>Retry</button>
          </div>
        )}
        <div className="ssh-table-wrap">
          <table className="ssh-table">
            <thead>
              <tr>
                <th aria-label="Favorite" />
                <th>Connection / Endpoint</th>
                <th>Group</th>
                <th>Protocol / Settings</th>
                <th>Status</th>
                <th>
                  <span className="ssh-actions-label">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((profile) => (
                <tr key={profile.id}>
                  <td>
                    <button
                      className={`cv-action-btn ${favorites.includes(profile.id) ? "cv-favorite" : ""}`}
                      onClick={() => toggleFavorite(profile.id)}
                      aria-label={`${favorites.includes(profile.id) ? "Unfavorite" : "Favorite"} ${profile.name}`}
                      aria-pressed={favorites.includes(profile.id)}
                    >
                      <Icon name="star" />
                    </button>
                  </td>
                  <td>
                    <button
                      className="ssh-server-name"
                      onClick={() => onConnect(profile)}
                      title={`Connect to ${profile.name}`}
                    >
                      <Icon name="server" />
                      <strong>{profile.name}</strong>
                    </button>
                    <span className="ssh-host">{profileEndpoint(profile)}</span>
                  </td>
                  <td>
                    <span className="ssh-group">
                      {profile.group_name || "Ungrouped"}
                    </span>
                  </td>
                  <td>
                    <span className="connection-protocol">
                      {(profile.protocol ?? "ssh").toUpperCase()}
                    </span>
                    <small>
                      {profile.protocol === "serial"
                        ? `${profile.baud_rate ?? 115200} baud`
                        : profile.protocol === "telnet"
                          ? `Port ${profile.port}`
                          : `${profile.username} · ${profile.auth_type === "key" ? "SSH key" : "Password"}`}
                    </small>
                  </td>
                  <td>
                    <span className="ssh-connection-state">
                      <span
                        className={`session-dot ${connectedProfileIds.includes(profile.id) ? "session-dot-connected" : ""}`}
                      />
                      {connectedProfileIds.includes(profile.id)
                        ? "Connected"
                        : "Not connected"}
                    </span>
                  </td>
                  <td>
                    <div className="ssh-row-actions">
                      <button
                        className="ssh-connect"
                        onClick={() => onConnect(profile)}
                        aria-label={`Connect to ${profile.name}`}
                      >
                        Connect
                        <Icon name="chevron" size={13} />
                      </button>
                      <button
                        className="cv-action-btn"
                        onClick={() => onEdit(profile)}
                        aria-label={`Edit ${profile.name}`}
                        title="Edit connection"
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        className="cv-action-btn cv-action-danger"
                        onClick={() => void handleDelete(profile)}
                        aria-label={`Delete ${profile.name}`}
                        title="Delete connection"
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!error && visible.length === 0 && (
            <div className="ssh-empty">
              <Icon name={profiles.length ? "search" : "server"} size={30} />
              <h2>
                {loading
                  ? "Loading connections…"
                  : profiles.length
                    ? "No matching connections"
                    : "Add your first connection"}
              </h2>
              <p>
                {loading
                  ? ""
                  : profiles.length
                    ? "Try another search or filter."
                    : "Choose a protocol and save your connection settings."}
              </p>
              {!loading &&
                (profiles.length ? (
                  <button
                    className="ssh-secondary"
                    onClick={() => {
                      setSearchQuery("");
                      setScope("all");
                      setGroupFilter("");
                      setProtocolFilter("");
                    }}
                  >
                    Clear filters
                  </button>
                ) : (
                  <button className="ssh-primary" onClick={onNew}>
                    <Icon name="plus" />
                    New connection
                  </button>
                ))}
            </div>
          )}
        </div>
        <footer className="ssh-page-footer">{children}</footer>
      </section>
    );
  }
  return (
    <div className="cv-container">
      <div className="cv-toolbar">
        <label className="cv-search-wrap">
          <Icon name="search" size={15} />
          <input
            className="cv-search"
            aria-label="Search connections"
            placeholder="Search connections…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
        <button className="cv-new-btn" onClick={onNew}>
          <Icon name="plus" size={15} />
          New connection
        </button>
      </div>
      <div className="cv-list">
        {error && (
          <div className="cv-error" role="alert">
            {error}
            <button onClick={() => void loadProfiles()}>Retry</button>
          </div>
        )}
        {filtered.some((p) => favorites.includes(p.id)) && (
          <section className="cv-group" aria-label="Favorites">
            <h3 className="cv-group-label">Favorites</h3>
            {filtered
              .filter((p) => favorites.includes(p.id))
              .map((p) => row(p, true))}
          </section>
        )}
        {Object.entries(grouped).map(([group, items]) => (
          <section key={group} className="cv-group" aria-label={group}>
            <h3 className="cv-group-label">
              {group}
              <span>{items.length}</span>
            </h3>
            {items.map((p) => row(p))}
          </section>
        ))}
        {!error && filtered.length === 0 && (
          <div className="cv-empty">
            {loading
              ? "Loading connections…"
              : profiles.length === 0
                ? "Your servers, one place."
                : "No matching connections."}
            <p>
              {loading
                ? ""
                : profiles.length === 0
                  ? "Add a connection to get started."
                  : "Try a server name, host or group."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
