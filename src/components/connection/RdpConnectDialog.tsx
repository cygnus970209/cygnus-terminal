import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "../../services/secureInvoke";
import { DEFAULT_RDP_CONFIG, type RdpLaunch, type RdpProfile } from "../../types/rdp";
import type { ConnectionChoice } from "../../types/connection";
import Icon from "../common/Icon";
import ProtocolPicker from "./ProtocolPicker";
import RdpConfigFields from "../rdp/RdpConfigFields";
import "./ConnectDialog.css";
import "../rdp/RdpSession.css";

export default function RdpConnectDialog({ profile, onCancel, onSaved, onConnect, onProtocolChange }: {
  profile: RdpProfile | null; onCancel: () => void; onSaved: () => void;
  onConnect: (launch: RdpLaunch) => void; onProtocolChange: (protocol: ConnectionChoice) => void;
}) {
  const [config, setConfig] = useState(() => ({ ...(profile?.config ?? DEFAULT_RDP_CONFIG) }));
  const [name, setName] = useState(profile?.name ?? "");
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const overlayDown = useRef(false);
  const mounted = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !submitting.current) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const connect = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") !== "save";
    const settings = { ...config, host: config.host.trim(), username: config.username.trim(), domain: config.domain.trim() };
    if (!settings.host || !settings.username || !Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
      setError("Enter a server, username and port between 1 and 65535."); return;
    }
    submitting.current = true; setBusy(true); setError("");
    try {
      const title = name.trim() || settings.host;
      let id = profile?.id;
      if (save || profile) {
        const saved = await invoke<RdpProfile>("rdp_save_profile", { id: id ?? null, data: { name: title, config: settings } });
        id = saved.id;
        window.dispatchEvent(new Event("cygnus-profiles-changed"));
        if (!mounted.current) return;
        onSaved();
      }
      if (connect) onConnect({ config: settings, name: title, profileId: id });
      onCancel();
    } catch { if (mounted.current) setError("Could not save the RDP connection. Check its settings and try again."); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="dialog-overlay" onClick={(event) => { if (overlayDown.current && event.target === event.currentTarget && !busy) onCancel(); overlayDown.current = false; }}
    onMouseDown={(event) => { overlayDown.current = event.target === event.currentTarget; }}>
    <div className="dialog connection-dialog" role="dialog" aria-modal="true" aria-labelledby="rdp-dialog-title" onClick={(event) => event.stopPropagation()}>
      <div className="connection-dialog-heading">
        <div><span className="connection-dialog-eyebrow">CONNECTION DETAILS</span><h2 className="dialog-title" id="rdp-dialog-title">{profile ? "Edit" : "New"} RDP connection</h2><p>Windows remote desktop · Beta</p></div>
        <button className="icon-button" disabled={busy} aria-label="Close connection dialog" onClick={onCancel}><Icon name="close" /></button>
      </div>
      <ProtocolPicker value="rdp" onChange={profile || busy ? undefined : onProtocolChange} />
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="transport-fields rdp-dialog-fields">
          <label className="dialog-row">Name<input autoFocus maxLength={256} value={name} onChange={(event) => setName(event.target.value)} placeholder="Windows server" /></label>
          <RdpConfigFields config={config} onChange={setConfig} />
          <p className="transport-note">Verify the server certificate and enter your password in the RDP tab after connecting. Passwords are not saved. Direct NLA / NTLM connections; Windows compatibility is still in Beta.</p>
          {!profile && <label className="dialog-checkbox"><input type="checkbox" checked={save} onChange={(event) => setSave(event.target.checked)} />Save connection</label>}
          {error && <p className="connection-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="dialog-btn dialog-btn-cancel" onClick={onCancel}>Cancel</button>
            {(save || profile) && <button type="submit" value="save" className="dialog-btn dialog-btn-save">Save</button>}
            <button type="submit" value="connect" className="dialog-btn dialog-btn-connect">{busy ? "Saving…" : save || profile ? "Save & Connect" : "Connect"}</button>
          </div>
        </fieldset>
      </form>
    </div>
  </div>;
}
