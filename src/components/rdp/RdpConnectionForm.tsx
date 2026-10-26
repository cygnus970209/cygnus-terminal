import RdpConfigFields from "./RdpConfigFields";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import Select from "../common/Select";
import type { RdpConfig, RdpProfile } from "../../types/rdp";

interface Props {
  config: RdpConfig;
  onChange: (config: RdpConfig) => void;
  onConnect: (event: FormEvent, name: string, profileId?: number) => void;
}
export default function RdpConnectionForm({ config, onChange, onConnect }: Props) {
  const [profiles, setProfiles] = useState<RdpProfile[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const loadVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const load = async () => {
      const version = ++loadVersion.current;
      try {
        const list = await invoke<RdpProfile[]>("rdp_list_profiles");
        if (!mounted.current || version !== loadVersion.current) return;
        setProfiles(list);
        setSelected((id) => list.some((p) => p.id === id) ? id : null);
      } catch {
        if (mounted.current && version === loadVersion.current) setError("Saved RDP connections could not be loaded. You can still connect directly.");
      } finally {
        if (mounted.current && version === loadVersion.current) setLoading(false);
      }
    };
    void load();
    window.addEventListener("cygnus-profiles-changed", load);
    return () => { mounted.current = false; loadVersion.current++; window.removeEventListener("cygnus-profiles-changed", load); };
  }, []);

  async function save(asNew: boolean) {
    setSaving(true); setError(null); setNotice("");
    try {
      const saved = await invoke<RdpProfile>("rdp_save_profile", {
        id: asNew ? null : selected,
        data: { name: name.trim(), config: { ...config, host: config.host.trim(), username: config.username.trim(), domain: config.domain.trim() } },
      });
      window.dispatchEvent(new Event("cygnus-profiles-changed"));
      if (!mounted.current) return;
      setProfiles((all) => [...all.filter((p) => p.id !== saved.id), saved]);
      setSelected(saved.id); setName(saved.name); onChange(saved.config); setNotice("Connection settings saved. Passwords are never saved.");
    } catch { if (mounted.current) setError("Could not save the RDP connection. Check its name and settings, then try again."); }
    finally { if (mounted.current) setSaving(false); }
  }
  async function remove() {
    if (selected === null) return;
    setSaving(true); setError(null);
    try {
      await invoke("rdp_delete_profile", { id: selected });
      window.dispatchEvent(new Event("cygnus-profiles-changed"));
      if (!mounted.current) return;
      setProfiles((all) => all.filter((p) => p.id !== selected)); setSelected(null); setConfirmDelete(false);
      setNotice("Saved connection deleted. Open sessions and saved certificates are kept.");
    } catch { if (mounted.current) setError("Could not delete the saved RDP connection. Try again."); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <form className="rdp-form" onSubmit={(event) => { if (saving) { event.preventDefault(); return; } onConnect(event, name.trim(), selected ?? undefined); }}>
    <h2>Connect to a remote desktop</h2>
    <p className="rdp-note">Beta · Windows compatibility testing is limited. Direct connection with NLA / NTLM.</p>
    {error && <p className="rdp-error" role="alert">{error}</p>}
    {notice && <p className="rdp-note" role="status">{notice}</p>}
    <fieldset disabled={saving} className="rdp-form-fields">
      <label>Saved RDP connections<Select aria-label="Saved RDP connections" value={selected === null ? "" : String(selected)} disabled={loading} onValueChange={(value) => {
        const profile = profiles.find((p) => String(p.id) === value);
        setSelected(profile?.id ?? null); setName(profile?.name ?? ""); setConfirmDelete(false); setError(null); setNotice("");
        if (profile) onChange({ ...profile.config });
      }}>
        <option value="">{loading ? "Loading connections…" : "New connection"}</option>
        {profiles.map((profile) => <option key={profile.id} value={String(profile.id)}>{profile.name} · {profile.config.host}:{profile.config.port}</option>)}
      </Select></label>
      <label>Connection name <span className="rdp-note">Required only when saving</span><input autoComplete="off" maxLength={256} value={name} onChange={(e) => { setName(e.target.value); setNotice(""); }} /></label>
      <RdpConfigFields config={config} onChange={onChange} />
      <p className="rdp-note">Windows scale applies on connection; the server may keep an existing session’s scale. Remote resolution can be changed when the server supports it. Fit and 1:1 views are always available.</p>
      <div className="rdp-actions">
        <button type="button" disabled={!name.trim()} onClick={() => void save(false)}>{selected === null ? "Save connection" : "Save changes"}</button>
        {selected !== null && <><button type="button" disabled={!name.trim()} onClick={() => void save(true)}>Save as new</button><button type="button" onClick={() => setConfirmDelete(true)}>Delete saved connection</button></>}
      </div>
      {confirmDelete && <div className="rdp-notice"><p>Delete “{profiles.find((p) => p.id === selected)?.name}”? Open sessions and certificate trust will be kept.</p><div className="rdp-actions"><button type="button" onClick={() => void remove()}>Delete connection</button><button type="button" onClick={() => setConfirmDelete(false)}>Keep connection</button></div></div>}
      <p className="rdp-note">Enter the password after verifying the server certificate. Use Text input / 한글 for local IME composition, then Send text. Direct keys use the US layout. Text clipboard sharing is available after explicit approval. Drive sharing and RD Gateway are not supported.</p>
      <button className="rdp-primary" type="submit">Connect</button>
    </fieldset>
  </form>;
}
