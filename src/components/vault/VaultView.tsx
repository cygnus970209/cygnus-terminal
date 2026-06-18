import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./VaultView.css";

type VaultKind =
  | "password"
  | "passphrase"
  | "pat-username"
  | "pat-password"
  | "ssh-key";

type VaultSource = "cygnus" | "op" | "bw";

interface VaultItem {
  id: number;
  label: string;
  kind: VaultKind;
  pair_id: string | null;
  source: VaultSource;
  source_ref: string | null;
  has_value: boolean;
  sensitive: boolean;
  scope: string | null;
  server_ids: number[];
  created_at: string;
  last_used_at: string | null;
}

interface Profile {
  id: number;
  name: string;
  host: string;
  group_name: string;
  environment: string;
}

const KIND_OPTIONS: { value: VaultKind; label: string }[] = [
  { value: "password", label: "Password" },
  { value: "passphrase", label: "Passphrase (SSH key)" },
  { value: "pat-username", label: "PAT — Username" },
  { value: "pat-password", label: "PAT — Password" },
  { value: "ssh-key", label: "SSH Key (raw)" },
];

const KIND_LABEL: Record<VaultKind, string> = Object.fromEntries(
  KIND_OPTIONS.map((o) => [o.value, o.label])
) as Record<VaultKind, string>;

interface VaultViewProps {
  onClose?: () => void;
}

export default function VaultView(_props: VaultViewProps) {
  const [items, setItems] = useState<VaultItem[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);

  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<VaultKind>("password");
  const [value, setValue] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [scope, setScope] = useState<"" | "local" | "global">("");
  const [pairId, setPairId] = useState("");
  const [serverIds, setServerIds] = useState<number[]>([]);

  const loadAll = useCallback(async () => {
    try {
      const [vault, profs] = await Promise.all([
        invoke<VaultItem[]>("vault_list"),
        invoke<Profile[]>("list_profiles"),
      ]);
      setItems(vault);
      setProfiles(profs);
    } catch (err) {
      console.error("Failed to load vault:", err);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const profileById = useMemo(() => {
    const m = new Map<number, Profile>();
    profiles.forEach((p) => m.set(p.id, p));
    return m;
  }, [profiles]);

  const resetForm = () => {
    setLabel("");
    setKind("password");
    setValue("");
    setSensitive(false);
    setScope("");
    setPairId("");
    setServerIds([]);
    setEditId(null);
    setShowAdd(false);
  };

  const handleEdit = (item: VaultItem) => {
    setEditId(item.id);
    setLabel(item.label);
    setKind(item.kind);
    setValue(""); // 평문은 절대 미리 채우지 않음
    setSensitive(item.sensitive);
    setScope(
      item.scope === "local" || item.scope === "global" ? item.scope : ""
    );
    setPairId(item.pair_id ?? "");
    setServerIds([...item.server_ids]);
    setShowAdd(true);
  };

  const handleSave = async () => {
    if (!label.trim()) return;
    const trimmedScope = scope === "" ? null : scope;
    const trimmedPair = pairId.trim() === "" ? null : pairId.trim();

    try {
      if (editId) {
        await invoke("vault_update", {
          id: editId,
          req: {
            label: label.trim(),
            kind,
            sensitive,
            scope: trimmedScope,
            pair_id: trimmedPair,
            // value 가 비어있으면 기존 값 유지(undefined로 보냄)
            value: value === "" ? undefined : value,
          },
        });
        await invoke("vault_link_server", {
          vaultItemId: editId,
          serverIds,
        });
      } else {
        const created = await invoke<VaultItem>("vault_create", {
          req: {
            label: label.trim(),
            kind,
            source: "cygnus",
            value: value === "" ? null : value,
            sensitive,
            scope: trimmedScope,
            pair_id: trimmedPair,
            server_ids: serverIds,
          },
        });
        // server_ids 가 vault_create에서 처리되지만, 명시적으로 같은 결과를 보장
        if (created.server_ids.length !== serverIds.length) {
          await invoke("vault_link_server", {
            vaultItemId: created.id,
            serverIds,
          });
        }
      }
      resetForm();
      loadAll();
    } catch (err) {
      console.error("Failed to save vault item:", err);
      alert(`Failed to save: ${err}`);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this vault item? This cannot be undone.")) return;
    try {
      await invoke("vault_delete", { id });
      loadAll();
    } catch (err) {
      console.error("Failed to delete vault item:", err);
    }
  };

  const toggleServer = (id: number) => {
    setServerIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const filtered = items.filter((i) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      i.label.toLowerCase().includes(q) ||
      i.kind.toLowerCase().includes(q) ||
      (i.scope ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="vault-container">
      <div className="vault-toolbar">
        <input
          className="vault-search"
          type="text"
          placeholder="Search vault items..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button
          className="vault-new-btn"
          onClick={() => {
            if (showAdd) resetForm();
            else setShowAdd(true);
          }}
        >
          {showAdd ? "Cancel" : "+ New Item"}
        </button>
      </div>

      {showAdd && (
        <div className="vault-form">
          <div className="vault-form-row">
            <input
              className="vault-input"
              type="text"
              placeholder="Label (e.g. prod-api · sudo · alice)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
              style={{ flex: 2 }}
            />
            <select
              className="vault-select"
              value={kind}
              onChange={(e) => setKind(e.target.value as VaultKind)}
              style={{ flex: 1 }}
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <input
            className="vault-input vault-mono"
            type="password"
            placeholder={
              editId
                ? "New value (leave empty to keep existing)"
                : "Secret value"
            }
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="new-password"
          />

          <div className="vault-form-row">
            <select
              className="vault-select"
              value={scope}
              onChange={(e) =>
                setScope(e.target.value as "" | "local" | "global")
              }
              style={{ flex: 1 }}
            >
              <option value="">Server-scoped (default)</option>
              <option value="local">Local PTY only</option>
              <option value="global">Global (any server)</option>
            </select>
            <input
              className="vault-input vault-mono"
              type="text"
              placeholder="pair_id (optional, links PAT user/pass)"
              value={pairId}
              onChange={(e) => setPairId(e.target.value)}
              style={{ flex: 1 }}
            />
            <label className="vault-checkbox">
              <input
                type="checkbox"
                checked={sensitive}
                onChange={(e) => setSensitive(e.target.checked)}
              />
              <span>Sensitive</span>
            </label>
          </div>

          <div className="vault-server-section">
            <div className="vault-section-label">
              Linked servers
              <span className="vault-section-hint">
                {scope === "global" || scope === "local"
                  ? `Ignored when scope = ${scope}`
                  : `${serverIds.length} selected`}
              </span>
            </div>
            <div className="vault-server-grid">
              {profiles.length === 0 && (
                <span className="vault-empty-inline">
                  No profiles yet. Create one first.
                </span>
              )}
              {profiles.map((p) => {
                const checked = serverIds.includes(p.id);
                return (
                  <label
                    key={p.id}
                    className={`vault-server-chip ${
                      checked ? "checked" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleServer(p.id)}
                    />
                    <span className="vault-chip-label">{p.name}</span>
                    <span className="vault-chip-host">{p.host}</span>
                    {p.environment === "production" && (
                      <span className="vault-chip-env">prod</span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          <div className="vault-form-actions">
            <button className="vault-save-btn" onClick={handleSave}>
              {editId ? "Update" : "Save"}
            </button>
          </div>
        </div>
      )}

      <div className="vault-list">
        {filtered.map((it) => {
          const linkedNames = it.server_ids
            .map((id) => profileById.get(id)?.name)
            .filter((n): n is string => Boolean(n));
          return (
            <div key={it.id} className="vault-item">
              <div className="vault-item-main">
                <div className="vault-item-header">
                  <span className="vault-item-label">{it.label}</span>
                  <span className="vault-item-kind">{KIND_LABEL[it.kind]}</span>
                  {it.sensitive && (
                    <span className="vault-badge vault-badge-sensitive">
                      sensitive
                    </span>
                  )}
                  {it.source !== "cygnus" && (
                    <span className="vault-badge vault-badge-source">
                      {it.source}
                    </span>
                  )}
                  {it.scope && (
                    <span className="vault-badge vault-badge-scope">
                      {it.scope}
                    </span>
                  )}
                  {!it.has_value && it.source === "cygnus" && (
                    <span className="vault-badge vault-badge-empty">
                      no value
                    </span>
                  )}
                </div>
                <div className="vault-item-meta">
                  {linkedNames.length > 0 ? (
                    <span className="vault-item-servers">
                      {linkedNames.join(" · ")}
                    </span>
                  ) : (
                    <span className="vault-item-servers vault-item-no-servers">
                      {it.scope === "global"
                        ? "All servers"
                        : it.scope === "local"
                        ? "Local PTY only"
                        : "Not linked to any server"}
                    </span>
                  )}
                </div>
              </div>
              <div className="vault-item-actions">
                <button
                  className="vault-action-btn"
                  onClick={() => handleEdit(it)}
                  title="Edit"
                >
                  ✎
                </button>
                <button
                  className="vault-action-btn vault-action-danger"
                  onClick={() => handleDelete(it.id)}
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && !showAdd && (
          <div className="vault-empty">
            {items.length === 0
              ? 'No vault items yet. Click "+ New Item" to add a credential.'
              : "No matches for the current search."}
          </div>
        )}
      </div>
    </div>
  );
}
