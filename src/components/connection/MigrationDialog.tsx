import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Select from "../common/Select";
import Icon from "../common/Icon";
import "./MigrationDialog.css";

type Source = { kind: "ssh" | "iterm"; path: string; name: string };
type Candidate = {
  profile: {
    name: string;
    host: string;
    port: number;
    username: string;
    group_name: string;
    key_path?: string;
  };
  warnings: string[];
  blocked: boolean;
  duplicate: boolean;
};
type Preview = {
  candidates: Candidate[];
  fingerprint: string;
  groups: string[];
};

export default function MigrationDialog({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [detecting, setDetecting] = useState(true);
  const [source, setSource] = useState<Source | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [groupOverrides, setGroupOverrides] = useState<Record<number, string>>(
    {},
  );
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState<number | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const allCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    void invoke<Source[]>("detect_migration_sources")
      .then((list) => {
        if (active) setSources(list);
      })
      .catch(() => {
        if (active)
          setError("Could not detect local settings. Choose a file below.");
      })
      .finally(() => {
        if (active) setDetecting(false);
      });
    return () => {
      active = false;
      previous?.focus();
    };
  }, []);
  const load = async (next: Source) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await invoke<Preview>("preview_migration", {
        kind: next.kind,
        path: next.path,
      });
      setSource(next);
      setPreview(result);
      setGroupOverrides({});
      setSelected(
        new Set(
          result.candidates.flatMap((c, i) =>
            c.blocked || c.duplicate ? [] : [i],
          ),
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const choose = async (kind: Source["kind"]) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    let path: string | null = null;
    try {
      const chosen = await open({
        title:
          kind === "ssh" ? "Choose SSH config" : "Choose iTerm2 JSON or plist",
        multiple: false,
        directory: false,
      });
      if (typeof chosen === "string") path = chosen;
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    if (path)
      await load({
        kind,
        path,
        name: kind === "ssh" ? "SSH config" : "iTerm2 profiles",
      });
  };
  const save = async () => {
    if (!source || !preview || !selected.size || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const count = await invoke<number>("import_migration", {
        selection: {
          ...source,
          fingerprint: preview.fingerprint,
          indices: [...selected],
          group_overrides: Object.fromEntries(
            [...selected]
              .filter((i) => groupOverrides[i] !== undefined)
              .map((i) => [i, groupOverrides[i]]),
          ),
        },
      });
      window.dispatchEvent(new Event("cygnus-profiles-changed"));
      setComplete(count);
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const groupOptions = [
    ...new Set([
      ...(preview?.groups ?? []),
      ...(preview?.candidates.map((c) => c.profile.group_name) ?? []),
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const available =
    preview?.candidates.flatMap((c, i) =>
      c.blocked || c.duplicate ? [] : [i],
    ) ?? [];
  useEffect(() => {
    if (allCheckbox.current)
      allCheckbox.current.indeterminate =
        selected.size > 0 && selected.size < available.length;
  }, [selected, available.length]);
  useEffect(() => {
    if (!busy) close.current?.focus();
  }, [preview, complete, busy]);
  return createPortal(
    <div
      className="migration-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busyRef.current) onClose();
      }}
    >
      <div
        className="migration-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="migration-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            if (!busyRef.current) onClose();
          }
          if (e.key === "Tab") {
            const elements = dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
            );
            if (!elements?.length) {
              e.preventDefault();
              return;
            }
            const first = elements[0],
              last = elements[elements.length - 1];
            if (
              e.shiftKey &&
              (document.activeElement === first ||
                !dialog.current?.contains(document.activeElement))
            ) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header className="migration-header">
          <div>
            <span className="migration-eyebrow">BRING YOUR SERVERS</span>
            <h2 id="migration-title">Import connections</h2>
          </div>
          <button
            ref={close}
            className="migration-close"
            disabled={busy}
            onClick={onClose}
            aria-label="Close import"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="migration-body" aria-busy={busy}>
          {error && (
            <div className="migration-error" role="alert">
              {error}
            </div>
          )}
          {complete !== null ? (
            <div className="migration-success" role="status">
              <Icon name="server" size={32} />
              <h3>
                {complete} {complete === 1 ? "connection" : "connections"}{" "}
                imported
              </h3>
              <p>
                Your servers are ready in Connections. Edit any profiles that
                still need a username, password or SSH key.
              </p>
            </div>
          ) : preview ? (
            <>
              <div className="migration-source">
                <strong>{source?.name}</strong>
                <span title={source?.path}>{source?.path}</span>
              </div>
              <p className="migration-description">
                Review your connections. Existing endpoints are skipped.
                Passwords and private key contents are not copied.
              </p>
              <div className="migration-list-heading">
                <label>
                  <input
                    type="checkbox"
                    ref={allCheckbox}
                    aria-label="Select all available connections"
                    disabled={busy || !available.length}
                    checked={
                      available.length > 0 && selected.size === available.length
                    }
                    onChange={(e) =>
                      setSelected(new Set(e.target.checked ? available : []))
                    }
                  />{" "}
                  Select available
                </label>
                <span>
                  {selected.size} / {preview.candidates.length} selected
                </span>
              </div>
              {!preview.candidates.length && (
                <p className="migration-empty">
                  No named connections found. SSH files need explicit Host
                  entries; wildcard defaults alone do not create connections.
                </p>
              )}
              <div className="migration-list">
                {preview.candidates.map((c, i) => (
                  <div
                    className={`migration-row ${c.blocked || c.duplicate ? "migration-unavailable" : ""}`}
                    key={i}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Import ${c.profile.name}`}
                      disabled={busy || c.blocked || c.duplicate}
                      checked={selected.has(i)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(i);
                        else next.delete(i);
                        setSelected(next);
                      }}
                    />
                    <div className="migration-row-details">
                      <div className="migration-row-heading">
                        <strong>{c.profile.name}</strong>
                        <span>
                          {c.blocked
                            ? "Manual setup"
                            : c.duplicate
                              ? "Duplicate"
                              : c.warnings.length
                                ? "Review settings"
                                : "Ready"}
                        </span>
                      </div>
                      {c.profile.host ? (
                        <code>
                          {c.profile.username ? `${c.profile.username}@` : ""}
                          {c.profile.host}:{c.profile.port}
                        </code>
                      ) : (
                        <small>
                          Address unavailable — review source settings
                        </small>
                      )}
                      <small>
                        {(groupOverrides[i] ?? c.profile.group_name) ||
                          "Ungrouped"}
                        {c.profile.key_path ? ` · ${c.profile.key_path}` : ""}
                      </small>
                      {c.duplicate && (
                        <small>
                          Same endpoint and user already saved or listed above.
                        </small>
                      )}
                      {c.warnings.map((warning, n) => (
                        <small className="migration-warning" key={n}>
                          {warning}
                        </small>
                      ))}
                    </div>
                    <div className="migration-row-group">
                      <span>Group</span>
                      <Select
                        aria-label={`Group for ${c.profile.name}`}
                        value={groupOverrides[i] ?? c.profile.group_name}
                        disabled={busy || c.blocked || c.duplicate}
                        onValueChange={(group) =>
                          setGroupOverrides((current) => ({
                            ...current,
                            [i]: group,
                          }))
                        }
                      >
                        <option value="">No group</option>
                        {groupOptions.map((group) => (
                          <option key={group} value={group}>
                            {group}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <p className="migration-description">
                Keep your server list when moving to Cygnus. Choose detected
                settings or a file to preview before importing.
              </p>
              <h3 className="migration-section-title">On this computer</h3>
              {detecting ? (
                <p role="status">Looking for settings…</p>
              ) : sources.length ? (
                <div className="migration-sources">
                  {sources.map((s) => (
                    <button
                      key={s.path}
                      disabled={busy}
                      onClick={() => void load(s)}
                    >
                      <Icon name="server" />
                      <span>
                        <strong>{s.name}</strong>
                        <small>{s.path}</small>
                      </span>
                      <Icon name="chevron" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="migration-empty">
                  No standard settings files found. You can choose a file below.
                </p>
              )}
              <h3 className="migration-section-title">Choose a file</h3>
              <div className="migration-file-options">
                <button disabled={busy} onClick={() => void choose("ssh")}>
                  <strong>SSH config</strong>
                  <small>OpenSSH host entries</small>
                </button>
                <button disabled={busy} onClick={() => void choose("iterm")}>
                  <strong>iTerm2 profiles</strong>
                  <small>Exported JSON or preferences plist</small>
                </button>
              </div>
              <p className="migration-help">
                iTerm2: Settings → Profiles → Other Actions → Save Profile as
                JSON. SSH aliases are resolved using this computer’s
                ~/.ssh/config.
              </p>
              <p className="migration-help">
                Moving from Termius? If you have an SSH config export, choose
                SSH config above. Direct Termius vault migration is not yet
                supported.
              </p>
            </>
          )}
        </div>
        <footer className="migration-footer">
          <span role="status">
            {busy
              ? "Working…"
              : complete !== null
                ? "Original settings are unchanged."
                : "Your files stay on this computer."}
          </span>
          {complete !== null ? (
            <button className="migration-primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              {preview && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setPreview(null);
                    setSource(null);
                    setError("");
                  }}
                >
                  Back
                </button>
              )}
              {preview ? (
                <button
                  className="migration-primary"
                  disabled={busy || !selected.size}
                  onClick={() => void save()}
                >
                  Import {selected.size}{" "}
                  {selected.size === 1 ? "connection" : "connections"}
                </button>
              ) : (
                <button disabled={busy} onClick={onClose}>
                  Cancel
                </button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
