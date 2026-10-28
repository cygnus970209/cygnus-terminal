import { t, useLocale } from "../../i18n";
import MigrationDialog from "./MigrationDialog";
import Select from "../common/Select";
import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Profile } from "../../types";
import type { RdpProfile } from "../../types/rdp";
import type { WinrmProfile } from "../../types/winrm";
import { connectionEntries, readConnectionFavorites, type ConnectionEntry, type ConnectionKey } from "../../types/connection";
import Icon from "../common/Icon";
import "./ConnectionsView.css";

interface ConnectionsViewProps {
  mode?: "sidebar" | "page";
  children?: ReactNode;
  onLocalShell?: () => void;
  onConnect: (profile: Profile) => void;
  onEdit: (profile: Profile) => void;
  onNew: () => void;
  onRdpConnect: (profile: RdpProfile) => void;
  onRdpEdit: (profile: RdpProfile) => void;
  activeRdpProfileId?: number;
  connectedRdpProfileIds?: number[];
  onWinrmConnect: (profile: WinrmProfile) => void;
  onWinrmEdit: (profile: WinrmProfile) => void;
  activeWinrmProfileId?: number;
  connectedWinrmProfileIds?: number[];
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
  onNew, onRdpConnect, onRdpEdit, activeRdpProfileId, connectedRdpProfileIds = [],
  onWinrmConnect, onWinrmEdit, activeWinrmProfileId, connectedWinrmProfileIds = [],
  reloadKey,
  activeProfileId,
  connectedProfileIds = [],
  onProfilesLoaded,
}: ConnectionsViewProps) {
  useLocale();
  const [showImport, setShowImport] = useState(false);
  const [protocolFilter, setProtocolFilter] = useState("");
  const [scope, setScope] = useState("all");
  const [groupFilter, setGroupFilter] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [rdpProfiles, setRdpProfiles] = useState<RdpProfile[]>([]);
  const [winrmProfiles, setWinrmProfiles] = useState<WinrmProfile[]>([]);
  const loadVersion = useRef(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [favorites, setFavorites] = useState<ConnectionKey[]>(() => {
    try { return readConnectionFavorites(localStorage.getItem(FAVORITES_KEY)); }
    catch { return []; }
  });
  const loadProfiles = useCallback(async () => {
    const version = ++loadVersion.current;
    const [terminal, rdp, winrm] = await Promise.allSettled([
      invoke<Profile[]>("list_profiles"), invoke<RdpProfile[]>("rdp_list_profiles"),
      invoke<WinrmProfile[]>("winrm_list_profiles"),
    ]);
    if (version !== loadVersion.current) return;
    const errors = [];
    if (terminal.status === "fulfilled") { setProfiles(terminal.value); onProfilesLoaded?.(terminal.value); }
    else errors.push(t("Could not load terminal connections."));
    if (rdp.status === "fulfilled") setRdpProfiles(rdp.value);
    else errors.push(t("Could not load RDP connections."));
    if (winrm.status === "fulfilled") setWinrmProfiles(winrm.value);
    else errors.push(t("Could not load WinRM connections."));
    setError(errors.length ? errors.join(" ") : null); setLoading(false);
  }, [onProfilesLoaded]);
  useEffect(() => {
    void loadProfiles();
    const refreshFavorites = () => {
      try {
        setFavorites(readConnectionFavorites(localStorage.getItem(FAVORITES_KEY)));
      } catch {
        /* Keep the current favorites if storage is unavailable. */
      }
    };
    window.addEventListener("cygnus-profiles-changed", loadProfiles);
    window.addEventListener("cygnus-favorites-changed", refreshFavorites);
    return () => {
      loadVersion.current++;
      window.removeEventListener("cygnus-profiles-changed", loadProfiles);
      window.removeEventListener("cygnus-favorites-changed", refreshFavorites);
    };
  }, [loadProfiles, reloadKey]);
  const saveFavorites = (next: ConnectionKey[]) => {
    setFavorites(next);
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event("cygnus-favorites-changed"));
    } catch {
      /* Favorites still work for this session. */
    }
  };
  const toggleFavorite = (id: ConnectionKey) => saveFavorites(favorites.includes(id)
    ? favorites.filter((item) => item !== id) : [...favorites, id]);
  const handleDelete = async (profile: ConnectionEntry) => {
    if (
      !confirm(
        t("Delete saved connection \"{v0}\"? Open sessions will stay open.", { v0: profile.name }),
      )
    )
      return;
    try {
      await invoke(profile.kind === "rdp" ? "rdp_delete_profile" : profile.kind === "winrm" ? "winrm_delete_profile" : "delete_profile", { id: profile.profile.id });
      saveFavorites(favorites.filter((key) => key !== profile.key));
      window.dispatchEvent(new Event("cygnus-profiles-changed"));
    } catch {
      setError(t("Could not delete this connection. Try again."));
    }
  };
  const entries = connectionEntries(profiles, rdpProfiles, winrmProfiles);
  const q = searchQuery.trim().toLowerCase();
  const filtered = entries.filter((entry) => entry.search.includes(q));
  const grouped = filtered.reduce<Record<string, ConnectionEntry[]>>((acc, entry) => {
    (acc[entry.group || "Ungrouped"] ??= []).push(entry);
    return acc;
  }, Object.create(null));
  const connectEntry = (entry: ConnectionEntry) => entry.kind === "rdp" ? onRdpConnect(entry.profile) : entry.kind === "winrm" ? onWinrmConnect(entry.profile) : onConnect(entry.profile);
  const editEntry = (entry: ConnectionEntry) => entry.kind === "rdp" ? onRdpEdit(entry.profile) : entry.kind === "winrm" ? onWinrmEdit(entry.profile) : onEdit(entry.profile);
  const connected = (entry: ConnectionEntry) => entry.kind === "rdp" ? connectedRdpProfileIds.includes(entry.profile.id) : entry.kind === "winrm" ? connectedWinrmProfileIds.includes(entry.profile.id) : connectedProfileIds.includes(entry.profile.id);
  const active = (entry: ConnectionEntry) => entry.kind === "rdp" ? activeRdpProfileId === entry.profile.id : entry.kind === "winrm" ? activeWinrmProfileId === entry.profile.id : activeProfileId === entry.profile.id;
  const row = (profile: ConnectionEntry, favoriteSection = false) => (
    <div
      key={profile.key}
      className={`cv-item ${active(profile) ? "cv-item-selected" : ""}`}
    >
      <button
        className="cv-item-main"
        onClick={() => connectEntry(profile)}
        title={t("Connect to {v0}", { v0: profile.endpoint })}
      >
        <span
          className={`cv-item-icon ${connected(profile) ? "cv-connected" : ""}`}
        >
          <Icon name={favoriteSection ? "star" : profile.kind === "rdp" ? "monitor" : "server"} size={15} />
        </span>
        <span className="cv-item-info">
          <span className="cv-item-name">{profile.name}</span>
          <span className="cv-item-detail">
            {(profile.protocol ?? "ssh").toUpperCase()} ·{" "}
            {profile.endpoint}
          </span>
        </span>
      </button>
      <div className="cv-item-actions">
        <button
          className={`cv-action-btn ${favorites.includes(profile.key) ? "cv-favorite" : ""}`}
          onClick={() => toggleFavorite(profile.key)}
          title={
            favorites.includes(profile.key) ? t("Remove favorite") : t("Add favorite")
          }
          aria-label={`${favorites.includes(profile.key) ? t("Unfavorite") : t("Favorite")} ${profile.name}`}
          aria-pressed={favorites.includes(profile.key)}
        >
          <Icon name="star" size={13} />
        </button>
        <button
          className="cv-action-btn"
          onClick={() => editEntry(profile)}
          title={t("Edit {v0}", { v0: profile.name })}
          aria-label={t("Edit {v0}", { v0: profile.name })}
        >
          <Icon name="edit" size={13} />
        </button>
        <button
          className="cv-action-btn cv-action-danger"
          onClick={() => void handleDelete(profile)}
          title={t("Delete {v0}", { v0: profile.name })}
          aria-label={t("Delete {v0}", { v0: profile.name })}
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
            (profile.group || "Ungrouped") === groupFilter) &&
          (scope === "all" ||
            (scope === "favorites"
              ? favorites.includes(profile.key)
              : connected(profile))),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const groups = [
      ...new Set(entries.map((profile) => profile.group || "Ungrouped")),
    ].sort();
    return (
      <section className="ssh-page" aria-label={t("Saved connections")}>
        {showImport && <MigrationDialog onClose={() => setShowImport(false)} />}
        <header className="ssh-page-header">
          <div>
            <div className="ssh-eyebrow">
              <Icon name="terminal" size={16} /> CYGNUS TERMINAL
            </div>
            <h1>{t("Connections")}</h1>
            <p>{t("SSH, RDP (Beta), WinRM, Telnet and Serial. Your connections in one place.")}</p>
          </div>
          <div className="ssh-header-actions">
            <button
              className="ssh-secondary"
              onClick={() => setShowImport(true)}
            >{t("Import connections")}</button>
            <button className="ssh-secondary" onClick={onLocalShell}>
              <Icon name="terminal" />{t("Local shell")}</button>
            <button className="ssh-primary" onClick={onNew}>
              <Icon name="plus" />{t("New connection")}</button>
          </div>
        </header>
        <div className="ssh-filters">
          <label className="cv-search-wrap">
            <Icon name="search" />
            <input
              className="cv-search"
              aria-label={t("Search connections")}
              placeholder={t("Search name, address, OS, shell or group…")}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          <Select
            aria-label={t("Filter by protocol")}
            value={protocolFilter}
            onValueChange={(value) => setProtocolFilter(value)}
          >
            <option value="">{t("All protocols")}</option>
            <option value="ssh">SSH</option>
            <option value="rdp">{t("RDP (Beta)")}</option>
            <option value="winrm">WinRM</option>
            <option value="telnet">Telnet</option>
            <option value="serial">{t("Serial")}</option>
          </Select>
          <Select
            aria-label={t("Filter by server group")}
            value={groupFilter}
            onValueChange={(value) => setGroupFilter(value)}
          >
            <option value="">{t("All groups")}</option>
            {groups.map((group) => (
              <option key={group}>{group}</option>
            ))}
          </Select>
        </div>
        <div className="ssh-list-heading">
          <div
            className="ssh-scopes"
            role="group"
            aria-label={t("Connection filters")}
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
                {t(label)}
              </button>
            ))}
          </div>
          <span>
            {visible.length}{" "}
            {visible.length === 1 ? t("connection") : t("connections")}
          </span>
        </div>
        {error && (
          <div className="cv-error" role="alert">
            {error}
            <button onClick={() => void loadProfiles()}>{t("Retry")}</button>
          </div>
        )}
        <div className="ssh-table-wrap">
          <table className="ssh-table">
            <thead>
              <tr>
                <th aria-label={t("Favorite")} />
                <th>{t("Connection / Endpoint")}</th>
                <th>{t("Group")}</th>
                <th>{t("Protocol / Settings")}</th>
                <th>{t("Status")}</th>
                <th>
                  <span className="ssh-actions-label">{t("Actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((profile) => (
                <tr key={profile.key}>
                  <td>
                    <button
                      className={`cv-action-btn ${favorites.includes(profile.key) ? "cv-favorite" : ""}`}
                      onClick={() => toggleFavorite(profile.key)}
                      aria-label={`${favorites.includes(profile.key) ? t("Unfavorite") : t("Favorite")} ${profile.name}`}
                      aria-pressed={favorites.includes(profile.key)}
                    >
                      <Icon name="star" />
                    </button>
                  </td>
                  <td>
                    <button
                      className="ssh-server-name"
                      onClick={() => connectEntry(profile)}
                      title={t("Connect to {v0}", { v0: profile.name })}
                    >
                      <Icon name={profile.kind === "rdp" ? "monitor" : "server"} />
                      <strong>{profile.name}</strong>
                    </button>
                    <span className="ssh-host">{profile.endpoint}</span>
                  </td>
                  <td>
                    <span className="ssh-group">
                      {profile.group || t("Ungrouped")}
                    </span>
                  </td>
                  <td>
                    <span className="connection-protocol">
                      {(profile.protocol ?? "ssh").toUpperCase()}
                    </span>
                    <small>
                      {profile.details}
                    </small>
                    {profile.environment && (
                      <small
                        title={t("Saved server environment: {v0}", { v0: profile.environment })}
                      >
                        {profile.environment}
                      </small>
                    )}
                  </td>
                  <td>
                    <span className="ssh-connection-state">
                      <span
                        className={`session-dot ${connected(profile) ? "session-dot-connected" : ""}`}
                      />
                      {connected(profile)
                        ? t("Connected")
                        : t("Not connected")}
                    </span>
                  </td>
                  <td>
                    <div className="ssh-row-actions">
                      <button
                        className="ssh-connect"
                        onClick={() => connectEntry(profile)}
                        aria-label={t("Connect to {v0}", { v0: profile.name })}
                      >{t("Connect")}<Icon name="chevron" size={13} />
                      </button>
                      <button
                        className="cv-action-btn"
                        onClick={() => editEntry(profile)}
                        aria-label={t("Edit {v0}", { v0: profile.name })}
                        title={t("Edit connection")}
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        className="cv-action-btn cv-action-danger"
                        onClick={() => void handleDelete(profile)}
                        aria-label={t("Delete {v0}", { v0: profile.name })}
                        title={t("Delete connection")}
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
              <Icon name={entries.length ? "search" : "server"} size={30} />
              <h2>
                {loading
                  ? t("Loading connections…")
                  : entries.length
                    ? t("No matching connections")
                    : t("Add your first connection")}
              </h2>
              <p>
                {loading
                  ? ""
                  : entries.length
                    ? t("Try another search or filter.")
                    : t("Choose a protocol and save your connection settings.")}
              </p>
              {!loading &&
                (entries.length ? (
                  <button
                    className="ssh-secondary"
                    onClick={() => {
                      setSearchQuery("");
                      setScope("all");
                      setGroupFilter("");
                      setProtocolFilter("");
                    }}
                  >{t("Clear filters")}</button>
                ) : (
                  <div className="ssh-header-actions">
                    <button className="ssh-primary" onClick={onNew}>
                      <Icon name="plus" />{t("New connection")}</button>
                    <button
                      className="ssh-secondary"
                      onClick={() => setShowImport(true)}
                    >{t("Import existing connections")}</button>
                  </div>
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
      {showImport && <MigrationDialog onClose={() => setShowImport(false)} />}
      <div className="cv-toolbar">
        <label className="cv-search-wrap">
          <Icon name="search" size={15} />
          <input
            className="cv-search"
            aria-label={t("Search connections")}
            placeholder={t("Search connections…")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
        <button className="cv-new-btn" onClick={onNew}>
          <Icon name="plus" size={15} />{t("New connection")}</button>
      </div>
      <button className="cv-new-btn" onClick={() => setShowImport(true)}>{t("Import connections")}</button>
      <div className="cv-list">
        {error && (
          <div className="cv-error" role="alert">
            {error}
            <button onClick={() => void loadProfiles()}>{t("Retry")}</button>
          </div>
        )}
        {filtered.some((p) => favorites.includes(p.key)) && (
          <section className="cv-group" aria-label={t("Favorites")}>
            <h3 className="cv-group-label">{t("Favorites")}</h3>
            {filtered
              .filter((p) => favorites.includes(p.key))
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
              ? t("Loading connections…")
              : entries.length === 0
                ? t("Your servers, one place.")
                : t("No matching connections.")}
            <p>
              {loading
                ? ""
                : entries.length === 0
                  ? t("Add a connection to get started.")
                  : t("Try a server name, host or group.")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
