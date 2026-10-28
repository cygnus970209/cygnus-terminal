import { t, useLocale } from "../../i18n";
import { useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RdpApproval, RdpCertificate } from "../../types/rdp";

interface Props {
  certificate: RdpCertificate;
  endpoint: string;
  sessionId: string | null;
  onApprove: (approval: RdpApproval) => void;
  onForgotten: () => void;
}
export default function RdpCertificateForm({ certificate, endpoint, sessionId, onApprove, onForgotten }: Props) {
  useLocale();
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [acceptChanged, setAcceptChanged] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = certificate.saved_fingerprint ?? null;
  const changed = saved !== null && saved !== certificate.fingerprint;
  const matches = saved === certificate.fingerprint;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!sessionId || forgetting || (changed && !acceptChanged)) return;
    const approval = { fingerprint: certificate.fingerprint, password, expected_saved_fingerprint: saved, remember, accept_changed: acceptChanged };
    setPassword(""); onApprove(approval);
  }
  async function forget() {
    if (!sessionId || !saved) return;
    setForgetting(true); setPassword(""); setError(null);
    try { await invoke("rdp_forget_certificate", { sessionId, expectedFingerprint: saved }); onForgotten(); }
    catch { setError(t("The saved certificate could not be removed. Reconnect to review the current certificate.")); setForgetting(false); }
  }
  return <form className="rdp-form" onSubmit={submit}>
    <h2>{changed ? t("RDP certificate changed") : matches ? t("Saved certificate matches") : t("Verify this RDP server")}</h2>
    <p>{endpoint}</p>
    {changed && <p className="rdp-notice rdp-warning" role="alert">{t("This server is presenting a different certificate. Verify the new fingerprint with a trusted source before entering your password.")}</p>}
    {error && <p className="rdp-error" role="alert">{error}</p>}
    {matches ? <p className="rdp-note">{t("The fingerprint matches the certificate you saved for this server and port.")}</p> : <p className="rdp-note">{t("Compare this SHA-256 fingerprint with a trusted source.")}</p>}
    {changed && <><p className="rdp-note">{t("Previously saved SHA-256")}</p><code className="rdp-fingerprint">{saved}</code></>}
    <p className="rdp-note">{t("Presented SHA-256")}</p><code className="rdp-fingerprint">{certificate.fingerprint}</code>
    <dl className="rdp-certificate"><dt>{t("Subject")}</dt><dd>{certificate.subject}</dd><dt>{t("Issuer")}</dt><dd>{certificate.issuer}</dd><dt>{t("Valid from")}</dt><dd>{certificate.valid_from}</dd><dt>{t("Valid until")}</dt><dd>{certificate.valid_until}</dd></dl>
    <p className="rdp-note">{t("This beta compares fingerprints. It does not automatically verify the certificate issuer, hostname or validity dates.")}</p>
    <fieldset disabled={forgetting} className="rdp-form-fields">
      {changed && <label className="rdp-check"><input type="checkbox" checked={acceptChanged} onChange={(e) => { setAcceptChanged(e.target.checked); if (!e.target.checked) setPassword(""); }} />{t("I verified this changed fingerprint with a trusted source")}</label>}
      {!matches && <label className="rdp-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{changed ? t("Replace the saved fingerprint for this server and port") : t("Remember this fingerprint for this server and port")}</label>}
      <label>{t("RDP password")}<input type="password" autoComplete="off" required maxLength={1024} disabled={changed && !acceptChanged} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <p className="rdp-note">{t("Sent only to this RDP server after approval. Not saved or shared with MCP.")}</p>
      <button className="rdp-primary" type="submit" disabled={!sessionId || (changed && !acceptChanged)}>{matches ? t("Connect") : remember ? t("Trust & connect") : t("Trust once & connect")}</button>
      {saved && <button type="button" onClick={() => setConfirmForget(true)}>{t("Forget saved certificate…")}</button>}
      {confirmForget && <div className="rdp-notice"><p>{t("Forget this saved fingerprint and disconnect? The next connection will require a fresh verification.")}</p><div className="rdp-actions"><button type="button" onClick={() => void forget()}>{t("Forget & disconnect")}</button><button type="button" onClick={() => setConfirmForget(false)}>{t("Keep certificate")}</button></div></div>}
    </fieldset>
  </form>;
}
