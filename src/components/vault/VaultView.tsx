import Select from "../common/Select";
import Icon from "../common/Icon";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "../../services/secureInvoke";
import "./VaultView.css";

type VaultKind =
  | "password"
  | "passphrase"
  | "pat-username"
  | "pat-password"
  | "ssh-key";
interface VaultItem {
  id: number;
  label: string;
  kind: VaultKind;
  pair_id: string | null;
  source: "cygnus" | "op" | "bw";
  has_value: boolean;
  sensitive: boolean;
  scope: string | null;
  server_ids: number[];
}
interface Profile {
  id: number;
  name: string;
  host: string;
  environment: string;
}
const KINDS: { value: VaultKind; label: string }[] = [
  { value: "password", label: "Password" },
  { value: "passphrase", label: "SSH passphrase" },
  { value: "pat-username", label: "PAT username" },
  { value: "pat-password", label: "PAT password" },
  { value: "ssh-key", label: "SSH key" },
];
const kindLabel = (kind: VaultKind) =>
  KINDS.find((item) => item.value === kind)?.label ?? kind;
type Filter = "all" | "password" | "key" | "token";

export default function VaultView({ onClose }: { onClose?: () => void }) {
  const [items, setItems] = useState<VaultItem[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<VaultKind>("password");
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const [scope, setScope] = useState<"" | "local" | "global">("");
  const [pairId, setPairId] = useState("");
  const [serverIds, setServerIds] = useState<number[]>([]);
  const [serverQuery, setServerQuery] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [vault, servers] = await Promise.all([
        invoke<VaultItem[]>("vault_list"),
        invoke<Profile[]>("list_profiles"),
      ]);
      setItems(vault);
      setProfiles(servers);
    } catch (err) {
      setError(`Could not load credentials: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadAll();
  }, [loadAll]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    return () => {
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (editing) labelRef.current?.focus();
    else searchRef.current?.focus();
  }, [editing]);

  const profileById = useMemo(
    () => new Map(profiles.map((p) => [p.id, p])),
    [profiles],
  );
  const matchesFilter = (item: VaultItem, target: Filter) =>
    target === "all" ||
    (target === "password" && item.kind === "password") ||
    (target === "key" && ["ssh-key", "passphrase"].includes(item.kind)) ||
    (target === "token" && item.kind.startsWith("pat-"));
  const filtered = items.filter(
    (item) =>
      matchesFilter(item, filter) &&
      [
        item.label,
        kindLabel(item.kind),
        item.scope ?? "",
        ...item.server_ids.map((id) => profileById.get(id)?.name ?? ""),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );

  const openEditor = (item?: VaultItem) => {
    setEditId(item?.id ?? null);
    setLabel(item?.label ?? "");
    setKind(item?.kind ?? "password");
    setValue("");
    setShowValue(false);
    setSensitive(item?.sensitive ?? false);
    setScope(
      item?.scope === "local" || item?.scope === "global" ? item.scope : "",
    );
    setPairId(item?.pair_id ?? "");
    setServerIds(item?.server_ids ? [...item.server_ids] : []);
    setServerQuery("");
    setDeleteId(null);
    setError(null);
    setEditing(true);
  };
  const back = () => {
    if (busy.current) return;
    setValue("");
    setShowValue(false);
    setError(null);
    setEditing(false);
  };
  const close = () => {
    if (!busy.current) onClose?.();
  };
  const save = async () => {
    if (!label.trim() || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const common = {
        label: label.trim(),
        kind,
        sensitive,
        scope: scope || null,
        pair_id: pairId.trim() || null,
      };
      if (editId !== null) {
        await invoke("vault_update", {
          id: editId,
          req: { ...common, value: value === "" ? undefined : value },
        });
        await invoke("vault_link_server", { vaultItemId: editId, serverIds });
      } else {
        await invoke("vault_create", {
          req: {
            ...common,
            source: "cygnus",
            value: value === "" ? null : value,
            server_ids: serverIds,
          },
        });
      }
      setValue("");
      setShowValue(false);
      setEditing(false);
      await loadAll();
    } catch (err) {
      setError(`Could not save credential: ${String(err)}`);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const remove = async (id: number) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      await invoke("vault_delete", { id });
      setDeleteId(null);
      await loadAll();
    } catch (err) {
      setError(`Could not delete credential: ${String(err)}`);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      className="vault-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !editing) close();
      }}
    >
      <div
        className="vault-container"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-title"
        onKeyDown={(e) => {
          if (e.defaultPrevented) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (editing) back();
            else close();
          }
          if (e.key === "Tab" && !document.querySelector('[role="listbox"]')) {
            const nodes = Array.from(
              dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
              ) ?? [],
            ).filter((node) => node.getClientRects().length > 0);
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="vault-header">
          <div className="vault-heading-icon">
            <Icon name="vault" size={22} />
          </div>
          <div className="vault-heading">
            <h2 id="vault-title">Vault</h2>
            <p>Credentials for your servers, in one place.</p>
          </div>
          <button
            className="vault-icon-btn"
            aria-label="Close vault"
            onClick={close}
            disabled={saving}
          >
            <Icon name="close" />
          </button>
        </header>
        {error && (
          <div className="vault-error" role="alert">
            <span>{error}</span>
            {!editing && (
              <button
                onClick={() => void loadAll()}
                disabled={loading || saving}
              >
                Retry
              </button>
            )}
          </div>
        )}
        {editing ? (
          <form
            className="vault-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="vault-editor-heading">
              <button
                type="button"
                className="vault-back"
                onClick={back}
                disabled={saving}
              >
                ← Back to vault
              </button>
              <h3>{editId !== null ? "Edit credential" : "New credential"}</h3>
              <p>
                {editId !== null
                  ? "Update details or replace the stored value."
                  : "Save a credential and choose where to use it."}
              </p>
            </div>
            <fieldset disabled={saving} className="vault-fields">
              <div className="vault-field-row">
                <label className="vault-field">
                  <span>
                    Name <span className="vault-required">*</span>
                  </span>
                  <input
                    ref={labelRef}
                    className="vault-input"
                    required
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Production sudo"
                    autoComplete="off"
                  />
                </label>
                <div className="vault-field">
                  <label htmlFor="vault-kind">Type</label>
                  <Select
                    id="vault-kind"
                    aria-label="Credential type"
                    value={kind}
                    onValueChange={(v) => setKind(v as VaultKind)}
                    disabled={saving}
                  >
                    {KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <label className="vault-field" htmlFor="vault-value">
                <span>
                  {editId !== null ? "Replace value" : "Secret value"}
                </span>
              </label>
              <div className="vault-secret">
                <input
                  id="vault-value"
                  className="vault-input vault-mono"
                  type={showValue ? "text" : "password"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={
                    editId !== null
                      ? "Leave empty to keep the current value"
                      : "Enter credential value"
                  }
                />
                <button
                  type="button"
                  aria-label={showValue ? "Hide value" : "Show value"}
                  aria-pressed={showValue}
                  onClick={() => setShowValue(!showValue)}
                >
                  {showValue ? "Hide" : "Show"}
                </button>
              </div>
              <p className="vault-field-hint">
                {editId !== null
                  ? "The stored value is never loaded into this form."
                  : "Stored values are encrypted on this device."}
              </p>
              <section className="vault-server-section">
                <div className="vault-section-heading">
                  <h4>Linked servers</h4>
                  <span>{serverIds.length} selected</span>
                </div>
                <input
                  className="vault-input"
                  aria-label="Search servers"
                  placeholder="Find a server…"
                  value={serverQuery}
                  onChange={(e) => setServerQuery(e.target.value)}
                />
                {scope && (
                  <p className="vault-field-hint">
                    {scope === "global"
                      ? "This credential is available to all servers."
                      : "This credential is scoped to local terminals."}{" "}
                    Server selections are retained.
                  </p>
                )}
                <div className="vault-server-grid">
                  {profiles
                    .filter((p) =>
                      `${p.name} ${p.host}`
                        .toLowerCase()
                        .includes(serverQuery.toLowerCase()),
                    )
                    .map((p) => (
                      <label
                        key={p.id}
                        className={`vault-server-chip ${serverIds.includes(p.id) ? "checked" : ""}`}
                      >
                        <input
                          type="checkbox"
                          disabled={!!scope}
                          checked={serverIds.includes(p.id)}
                          onChange={() =>
                            setServerIds((ids) =>
                              ids.includes(p.id)
                                ? ids.filter((id) => id !== p.id)
                                : [...ids, p.id],
                            )
                          }
                        />
                        <Icon name="server" />
                        <span>
                          <strong>{p.name}</strong>
                          <small>{p.host}</small>
                        </span>
                        {p.environment === "production" && (
                          <span className="vault-badge">Production</span>
                        )}
                      </label>
                    ))}
                  {profiles.length === 0 && (
                    <p className="vault-field-hint">
                      No saved servers yet. You can link this credential later.
                    </p>
                  )}
                  {profiles.length > 0 &&
                    !profiles.some((p) =>
                      `${p.name} ${p.host}`
                        .toLowerCase()
                        .includes(serverQuery.toLowerCase()),
                    ) && (
                      <p className="vault-field-hint">
                        No servers match your search.
                      </p>
                    )}
                </div>
              </section>
              <details className="vault-advanced">
                <summary>Advanced options</summary>
                <div className="vault-field-row">
                  <div className="vault-field">
                    <label htmlFor="vault-scope">Scope</label>
                    <Select
                      id="vault-scope"
                      aria-label="Credential scope"
                      value={scope}
                      onValueChange={(v) => setScope(v as typeof scope)}
                      disabled={saving}
                    >
                      <option value="">Linked servers</option>
                      <option value="local">Local terminals</option>
                      <option value="global">All servers</option>
                    </Select>
                  </div>
                  <label className="vault-field">
                    <span>Pair ID</span>
                    <input
                      className="vault-input"
                      value={pairId}
                      onChange={(e) => setPairId(e.target.value)}
                      placeholder="Link a PAT username and password"
                    />
                  </label>
                </div>
                <label className="vault-checkbox">
                  <input
                    type="checkbox"
                    checked={sensitive}
                    onChange={(e) => setSensitive(e.target.checked)}
                  />
                  Mark as sensitive
                </label>
              </details>
            </fieldset>
            <footer className="vault-editor-footer">
              <button
                type="button"
                className="vault-secondary"
                onClick={back}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="vault-primary"
                disabled={saving || !label.trim()}
              >
                {saving
                  ? "Saving…"
                  : editId !== null
                    ? "Save changes"
                    : "Save credential"}
              </button>
            </footer>
          </form>
        ) : (
          <>
            <div className="vault-toolbar">
              <div className="vault-search-wrap">
                <Icon name="search" />
                <input
                  ref={searchRef}
                  aria-label="Search credentials"
                  placeholder="Search credentials or servers…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <button
                className="vault-primary"
                onClick={() => openEditor()}
                disabled={loading || saving}
              >
                <Icon name="plus" />
                New credential
              </button>
            </div>
            <div className="vault-filters" aria-label="Credential categories">
              {(
                [
                  ["all", "All credentials"],
                  ["password", "Passwords"],
                  ["key", "SSH keys"],
                  ["token", "Tokens"],
                ] as [Filter, string][]
              ).map(([id, name]) => (
                <button
                  key={id}
                  aria-pressed={filter === id}
                  onClick={() => {
                    setFilter(id);
                    setDeleteId(null);
                  }}
                >
                  {name}
                  <span>
                    {items.filter((item) => matchesFilter(item, id)).length}
                  </span>
                </button>
              ))}
            </div>
            <div className="vault-list" aria-busy={loading}>
              {loading ? (
                <div className="vault-empty" role="status">
                  Loading credentials…
                </div>
              ) : error && items.length === 0 ? (
                <div className="vault-empty">
                  <Icon name="vault" size={30} />
                  <h3>Credentials unavailable</h3>
                  <p>Use Retry above to load your vault again.</p>
                </div>
              ) : filtered.length === 0 ? (
                <div className="vault-empty">
                  <Icon
                    name={query || filter !== "all" ? "search" : "vault"}
                    size={30}
                  />
                  <h3>
                    {items.length === 0
                      ? "Your credentials, ready when you need them"
                      : "No matching credentials"}
                  </h3>
                  <p>
                    {items.length === 0
                      ? "Save passwords, SSH keys and tokens, then link them to your servers."
                      : "Try a different name, server or credential type."}
                  </p>
                  {items.length === 0 ? (
                    <button
                      className="vault-primary"
                      onClick={() => openEditor()}
                    >
                      Add your first credential
                    </button>
                  ) : (
                    <button
                      className="vault-secondary"
                      onClick={() => {
                        setQuery("");
                        setFilter("all");
                      }}
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="vault-list-labels">
                    <span>Credential</span>
                    <span>Available on</span>
                    <span />
                  </div>
                  {filtered.map((item) => {
                    const servers = item.server_ids
                      .map((id) => profileById.get(id)?.name)
                      .filter(Boolean)
                      .join(", ");
                    const destination =
                      item.scope === "global"
                        ? "All servers"
                        : item.scope === "local"
                          ? "Local terminals"
                          : servers || "No linked servers";
                    return (
                      <div className="vault-item" key={item.id}>
                        <div className="vault-item-name">
                          <div className="vault-item-icon">
                            <Icon
                              name={
                                item.kind.startsWith("pat-")
                                  ? "snippets"
                                  : "vault"
                              }
                              size={18}
                            />
                          </div>
                          <div>
                            <strong title={item.label}>{item.label}</strong>
                            <span>
                              {kindLabel(item.kind)}
                              {item.sensitive && " · Sensitive"}
                              {item.source !== "cygnus" &&
                                ` · ${item.source === "op" ? "1Password" : "Bitwarden"}`}
                              {!item.has_value &&
                                item.source === "cygnus" &&
                                " · No stored value"}
                            </span>
                          </div>
                        </div>
                        <div className="vault-item-servers" title={destination}>
                          <Icon
                            name={
                              item.scope === "local" ? "terminal" : "server"
                            }
                            size={14}
                          />
                          <span>{destination}</span>
                        </div>
                        <div className="vault-item-actions">
                          {deleteId === item.id ? (
                            <>
                              <span className="vault-delete-label">
                                Delete permanently?
                              </span>
                              <button
                                className="vault-secondary"
                                disabled={saving}
                                onClick={() => setDeleteId(null)}
                              >
                                Cancel
                              </button>
                              <button
                                className="vault-danger"
                                disabled={saving}
                                onClick={() => void remove(item.id)}
                              >
                                Delete
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="vault-icon-btn"
                                disabled={saving}
                                aria-label={`Edit ${item.label}`}
                                title="Edit credential"
                                onClick={() => openEditor(item)}
                              >
                                <Icon name="edit" />
                              </button>
                              <button
                                className="vault-icon-btn vault-delete"
                                disabled={saving}
                                aria-label={`Delete ${item.label}`}
                                title="Delete credential"
                                onClick={() => setDeleteId(item.id)}
                              >
                                <Icon name="trash" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            <footer className="vault-footer">
              <span>
                <Icon name="vault" size={13} />
                Local values are encrypted
              </span>
              <span>
                {filtered.length} of {items.length} credentials
              </span>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
