import { t, useLocale } from "../../i18n";
import { useState } from "react";
import type useRdpClipboard from "./useRdpClipboard";
import { validRdpClipboardText } from "../../utils/rdpClipboard";
type Props = { clipboard: ReturnType<typeof useRdpClipboard> };
export default function RdpClipboardPanel({ clipboard: c }: Props) {
  useLocale();
  const [composing, setComposing] = useState(false);
  return <div className="rdp-clipboard" aria-label={t("RDP clipboard")} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); c.stop(); } }} onKeyUp={(e) => e.stopPropagation()}>
    <div className="rdp-actions"><strong>{t("Clipboard · Text only · Beta")}</strong><button onClick={c.stop}>{t("Stop sharing & close")}</button></div>
    <p className="rdp-note">{t("Sharing is off by default. Allowing sharing may clear the remote clipboard; copy remote text after allowing. Nothing syncs automatically. Closing this panel, switching tabs or leaving the app stops sharing and clears previews. Text already received by the other computer cannot be recalled.")}</p>
    {!c.available && <p className="rdp-note">{t("The server has not enabled clipboard sharing, or a request was cancelled or timed out. Reconnect to try again.")}</p>}
    {!c.enabled ? <button disabled={!c.available || c.busy} onClick={c.enable}>{t("Allow text sharing for this session")}</button> : <>
      <div className="rdp-clipboard-fields">
        <div><label>{t("Text to share with remote")}<textarea aria-label={t("Text to share with remote")} value={c.draft} disabled={c.busy} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onChange={(e) => c.setDraft(e.target.value)} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} /></label>
          <div className="rdp-actions"><button disabled={c.busy} onClick={() => void c.loadLocal()}>{t("Load local clipboard")}</button><button disabled={c.busy || composing || !validRdpClipboardText(c.draft)} onClick={c.send}>{t("Send to remote clipboard")}</button></div>
        </div>
        <div><label>{t("Remote clipboard preview")}<textarea aria-label={t("Remote clipboard preview")} value={c.preview} readOnly spellCheck={false} /></label>
          <div className="rdp-actions"><button disabled={c.busy || !c.remoteText} onClick={c.read}>{t("Read remote clipboard")}</button><button disabled={c.busy || !validRdpClipboardText(c.preview)} onClick={() => void c.copyLocal()}>{t("Copy preview locally")}</button></div>
        </div>
      </div>
      <p className="rdp-note">{t("Up to 2048 UTF-16 units. Plain text, line breaks and tabs only. Review commands before pasting into a terminal; multiline text may execute commands. Files and images are not shared.")}</p>
    </>}
    <p className="rdp-note" role="status">{c.busy ? t("Waiting for clipboard…") : c.notice}</p>
  </div>;
}
