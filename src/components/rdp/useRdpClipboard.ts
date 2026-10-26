import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { RdpClipboardAction, RdpEvent } from "../../types/rdp";
import { validRdpClipboardText } from "../../utils/rdpClipboard";

const initial = { available: false, remoteText: false, enabled: false, busy: false, open: false, draft: "", preview: "", notice: "" };
export default function useRdpClipboard(getSessionId: () => string | null, onStopFailure: () => void) {
  const [state, setState] = useState(initial);
  const current = useRef(state);
  const context = useRef({ getSessionId, onStopFailure }); context.current = { getSessionId, onStopFailure };
  const serial = useRef(0);
  const epoch = useRef(0);
  const localOperation = useRef(false);
  const pending = useRef<{ id: number; type: RdpClipboardAction["type"] } | null>(null);
  const patch = useCallback((changes: Partial<typeof initial>) => {
    current.current = { ...current.current, ...changes }; setState(current.current);
  }, []);
  const reset = useCallback(() => {
    epoch.current++; pending.current = null; localOperation.current = false;
    current.current = initial; setState(initial);
  }, []);
  const run = useCallback((action: RdpClipboardAction) => {
    const sessionId = context.current.getSessionId();
    if (!sessionId || (action.type !== "disable" && (pending.current || localOperation.current || !current.current.available))) return;
    if ((action.type === "send" || action.type === "read") && !current.current.enabled) return;
    const id = ++serial.current, attempt = epoch.current;
    pending.current = { id, type: action.type };
    patch({ busy: true, notice: "", ...(action.type === "disable" ? { enabled: false, draft: "", preview: "" } : {}) });
    void invoke("rdp_clipboard", { sessionId, requestId: id, action }).catch(() => {
      if (epoch.current !== attempt || pending.current?.id !== id) return;
      pending.current = null;
      patch({ busy: false, notice: "Clipboard request could not be sent. Try again or reconnect." });
      if (action.type === "disable") context.current.onStopFailure();
    });
  }, [patch]);
  const stop = useCallback(() => {
    epoch.current++; localOperation.current = false;
    const revoke = current.current.enabled || pending.current !== null;
    patch({ open: false, enabled: false, draft: "", preview: "", notice: "" });
    if (revoke) run({ type: "disable" });
  }, [patch, run]);
  const handle = useCallback((event: RdpEvent) => {
    if (event.type === "clipboard_state") {
      patch({ available: event.available, remoteText: event.remote_text,
        ...(!event.available ? { enabled: false, draft: "", preview: "" } : {}) });
    } else if (event.type === "clipboard_result" && event.request_id === pending.current?.id) {
      pending.current = null;
      const outcome = event.outcome;
      patch({ busy: false });
      if (outcome.type === "enabled") patch({ enabled: true });
      else if (outcome.type === "disabled") patch({ enabled: false, draft: "", preview: "" });
      else if (outcome.type === "offered") patch({ draft: "", notice: "Text offered to the remote clipboard. Paste manually in the remote app." });
      else if (outcome.type === "received" && current.current.enabled && current.current.open && validRdpClipboardText(outcome.text)) patch({ preview: outcome.text, notice: "Review the remote text, then copy it to your local clipboard." });
      else patch({ notice: "Clipboard request was not completed. The server may reject this format or size. If unavailable, reconnect to try again." });
    }
  }, [patch]);
  useEffect(() => { window.addEventListener("blur", stop); return () => { window.removeEventListener("blur", stop); epoch.current++; pending.current = null; }; }, [stop]);
  const loadLocal = async () => {
    if (!current.current.enabled || localOperation.current || pending.current) return;
    localOperation.current = true; const attempt = epoch.current; patch({ busy: true, notice: "" });
    try {
      const text = await readText();
      if (attempt !== epoch.current || !current.current.enabled || !current.current.open) return;
      if (!validRdpClipboardText(text)) patch({ notice: "Use 1–2048 UTF-16 units of plain text. Line breaks and tabs are allowed." });
      else patch({ draft: text });
    } catch { if (attempt === epoch.current) patch({ notice: "The local clipboard could not be read." }); }
    finally { if (attempt === epoch.current) { localOperation.current = false; patch({ busy: false }); } }
  };
  const copyLocal = async () => {
    if (!current.current.enabled || !validRdpClipboardText(current.current.preview) || localOperation.current || pending.current) return;
    localOperation.current = true; const attempt = epoch.current; patch({ busy: true });
    try { await writeText(current.current.preview); if (attempt === epoch.current) patch({ preview: "", notice: "Copied to your local clipboard." }); }
    catch { if (attempt === epoch.current) patch({ notice: "The local clipboard could not be updated." }); }
    finally { if (attempt === epoch.current) { localOperation.current = false; patch({ busy: false }); } }
  };
  return { ...state, reset, handle, stop, loadLocal, copyLocal,
    toggle: () => current.current.open ? stop() : patch({ open: true }),
    setDraft: (draft: string) => patch({ draft }),
    enable: () => run({ type: "enable" }),
    send: () => { if (validRdpClipboardText(current.current.draft)) run({ type: "send", text: current.current.draft }); },
    read: () => { patch({ preview: "" }); run({ type: "read" }); },
  };
}
