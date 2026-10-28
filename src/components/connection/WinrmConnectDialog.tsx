import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "../../services/secureInvoke";
import { useEscapeDismiss } from "../../hooks/useEscapeDismiss";
import { t, useLocale } from "../../i18n";
import type { ConnectionChoice } from "../../types/connection";
import { DEFAULT_WINRM_CONFIG, type WinrmConfig, type WinrmLaunch, type WinrmProfile } from "../../types/winrm";
import Icon from "../common/Icon";
import Select from "../common/Select";
import ProtocolPicker from "./ProtocolPicker";
import GroupPicker from "./GroupPicker";
import "./ConnectDialog.css";

interface Props {
  profile: WinrmProfile | null;
  onProtocolChange: (protocol: ConnectionChoice) => void;
  onSaved: () => void;
  onConnect: (launch: WinrmLaunch) => void;
  onCancel: () => void;
}
export default function WinrmConnectDialog({ profile, onProtocolChange, onSaved, onConnect, onCancel }: Props) {
  useLocale();
  const [config, setConfig] = useState<WinrmConfig>(profile?.config ?? DEFAULT_WINRM_CONFIG);
  const [name, setName] = useState(profile?.name ?? "");
  const [group, setGroup] = useState(profile?.group_name ?? "");
  const [password, setPassword] = useState("");
  const [forgetPassword, setForgetPassword] = useState(false);
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dismissed = useRef(false);
  useEffect(() => { dismissed.current = false; return () => { dismissed.current = true; }; }, []);
  const close = () => { dismissed.current = true; onCancel(); };
  useEscapeDismiss(close);
  const update = <K extends keyof WinrmConfig>(key: K, value: WinrmConfig[K]) => setConfig(previous => ({
    ...previous, [key]: value,
    ...((key === "host" || key === "port") ? { certificate_pin: "" } : {}),
  }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const connect = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") !== "save";
    setBusy(true); setError("");
    try {
      const cleaned = { ...config, host: config.host.trim(), username: config.username.trim(), domain: config.domain.trim(), certificate_pin: config.certificate_pin.trim() };
      let saved: WinrmProfile | undefined;
      if (save || profile) {
        saved = await invoke<WinrmProfile>("winrm_save_profile", {
          id: profile?.id ?? null, data: { name: name.trim() || cleaned.host, group_name: group.trim(), config: cleaned },
          password: forgetPassword ? "" : password || null,
        });
        onSaved();
      }
      if (dismissed.current) return;
      if (connect) onConnect({ name: saved?.name ?? (name.trim() || cleaned.host), config: saved?.config ?? cleaned,
        profileId: saved?.id, hasPassword: saved?.has_password, password: saved ? undefined : password || undefined });
      else close();
    } catch (err) { if (!dismissed.current) setError(String(err)); }
    finally { if (!dismissed.current) setBusy(false); }
  };
  return <div className="dialog-overlay" onClick={close}>
    <div className="dialog connection-dialog" role="dialog" aria-modal="true" aria-labelledby="winrm-dialog-title" onClick={e => e.stopPropagation()}>
      <div className="connection-dialog-heading">
        <div><span className="connection-dialog-eyebrow">{t("CONNECTION DETAILS")}</span>
          <h2 className="dialog-title" id="winrm-dialog-title">{profile ? t("Edit WinRM connection") : t("New WinRM connection")}</h2>
          <p>{t("Run PowerShell commands on a Windows host.")}</p></div>
        <button className="icon-button" aria-label={t("Close connection dialog")} onClick={close}><Icon name="close" /></button>
      </div>
      <ProtocolPicker value="winrm" onChange={profile || busy ? undefined : onProtocolChange} />
      <form onSubmit={submit}><fieldset disabled={busy} className="transport-fields">
        <label className="dialog-row">{t("Name")}<input autoFocus maxLength={256} value={name} onChange={e => setName(e.target.value)} placeholder="Windows Server" /></label>
        <label className="dialog-row">{t("Host")}<input required maxLength={253} value={config.host} onChange={e => update("host", e.target.value)} placeholder="server.example.com" /></label>
        <label className="dialog-row">{t("Transport")}<Select value={config.transport} onValueChange={value => setConfig(previous => ({ ...previous,
          transport: value as WinrmConfig["transport"], port: previous.port === 5985 || previous.port === 5986 ? (value === "https" ? 5986 : 5985) : previous.port,
          authentication: value === "http" ? "ntlm" : previous.authentication, certificate_pin: "",
        }))}><option value="https">HTTPS</option><option value="http">HTTP</option></Select></label>
        <label className="dialog-row">{t("Port")}<input required type="number" min={1} max={65535} step={1} value={config.port || ""} onChange={e => update("port", Number(e.target.value))} /></label>
        <label className="dialog-row">{t("Username")}<input required maxLength={256} autoComplete="username" value={config.username} onChange={e => update("username", e.target.value)} placeholder="Administrator" /></label>
        <label className="dialog-row">{t("Domain (optional)")}<input maxLength={256} value={config.domain} onChange={e => update("domain", e.target.value)} placeholder="CONTOSO" /></label>
        <label className="dialog-row">{t("Authentication")}<Select value={config.authentication} onValueChange={value => update("authentication", value as WinrmConfig["authentication"])}>
          <option value="ntlm">NTLM</option>{config.transport === "https" && <option value="basic">Basic</option>}
        </Select></label>
        <label className="dialog-row">{t("Password")}<input type="password" autoComplete="new-password" value={password} disabled={forgetPassword} onChange={e => setPassword(e.target.value)} placeholder={profile?.has_password ? t("Leave blank to keep saved password") : t("Enter password or provide it when connecting")} /></label>
        {profile?.has_password && <label className="dialog-checkbox"><input type="checkbox" checked={forgetPassword} onChange={e => setForgetPassword(e.target.checked)} />{t("Remove saved password")}</label>}
        {config.transport === "https" && <label className="dialog-row">{t("Certificate SHA-256 (optional)")}<input value={config.certificate_pin} onChange={e => update("certificate_pin", e.target.value)} placeholder={t("Use system certificate trust")} /></label>}
        <GroupPicker value={group} onChange={setGroup} />
        <p className="transport-note">{config.transport === "http" ? t("HTTP uses NTLM message encryption. Use it only on trusted networks; HTTPS verifies the server identity.") : t("HTTPS verifies the server certificate. For a self-signed certificate, enter a SHA-256 fingerprint verified separately.")}</p>
        <p className="transport-note">{t("The Windows host must have a WinRM listener and allow this account. Basic authentication must be enabled on the server when selected.")}</p>
        {!profile && <label className="dialog-checkbox"><input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)} />{t("Save connection")}</label>}
        {error && <p className="connection-error" role="alert">{t(error)}</p>}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn dialog-btn-cancel" onClick={close}>{t("Cancel")}</button>
          {(save || profile) && <button type="submit" value="save" className="dialog-btn dialog-btn-save">{t("Save")}</button>}
          <button type="submit" value="connect" className="dialog-btn dialog-btn-connect">{busy ? t("Saving…") : save || profile ? t("Save & Connect") : t("Connect")}</button>
        </div>
      </fieldset></form>
    </div>
  </div>;
}
