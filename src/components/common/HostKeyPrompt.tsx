import { useRef } from "react";
import { t, useLocale } from "../../i18n";
import { useEscapeDismiss } from "../../hooks/useEscapeDismiss";
import { invoke } from "@tauri-apps/api/core";
import "./HostKeyPrompt.css";

export interface HostKeyPromptPayload {
  id: string;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  status: string;
}

interface Props {
  prompt: HostKeyPromptPayload;
  onClose: () => void;
}

export default function HostKeyPrompt({ prompt, onClose }: Props) {
  useLocale();
  const responding = useRef(false);
  const respond = async (accept: boolean) => {
    if (responding.current) return;
    responding.current = true;
    try {
      await invoke("ssh_host_key_respond", {
        promptId: prompt.id,
        accept,
      });
    } catch (err) {
      console.error("Failed to respond to host key prompt:", err);
    } finally {
      onClose();
    }
  };

  useEscapeDismiss(() => { void respond(false); }, true, 3000);

  return (
    <div className="hkp-overlay" onMouseDown={() => respond(false)}>
      <div
        className="hkp-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="hkp-title"
      >
        <div className="hkp-head">
          <span className="hkp-badge">{t("NEW HOST")}</span>
          <h2 className="hkp-title" id="hkp-title">{t("Verify Server Identity")}</h2>
        </div>

        <p className="hkp-lead">{t("You're connecting to")}{" "}
          <code className="hkp-target">
            {prompt.host}:{prompt.port}
          </code>{" "}{t("for the first time. Confirm the server's fingerprint before trusting it.")}</p>

        <div className="hkp-field">
          <span className="hkp-field-label">{t("Key type")}</span>
          <code className="hkp-field-value">{prompt.key_type}</code>
        </div>
        <div className="hkp-field">
          <span className="hkp-field-label">{t("Fingerprint")}</span>
          <code className="hkp-fingerprint">{prompt.fingerprint}</code>
        </div>

        <p className="hkp-warn">{t("If the fingerprint doesn't match what the server's admin gave you, someone may be intercepting your connection. Reject and verify out of band.")}</p>

        <div className="hkp-actions">
          <button
            className="hkp-btn hkp-btn-reject"
            onClick={() => respond(false)}
          >{t("Reject")}</button>
          <button
            className="hkp-btn hkp-btn-accept"
            onClick={() => respond(true)}
          >{t("Trust and Connect")}</button>
        </div>
      </div>
    </div>
  );
}
