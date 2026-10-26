import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getMcpOAuthApprovals, respondMcpOAuth, type McpOAuthApproval } from "../../services/mcpService";
import type { Profile } from "../../types";
import "./McpOAuthApproval.css";

export default function McpOAuthApprovalNotice({ profiles }: { profiles: Profile[] }) {
  const [pending, setPending] = useState<McpOAuthApproval[]>([]);
  const [reviewId, setReviewId] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const approvals = await getMcpOAuthApprovals();
        if (!disposed && request === generation) setPending(approvals ?? []);
      } catch { /* No network request can approve access when IPC is unavailable. */ }
    };
    const subscription = listen("mcp-oauth-pending", () => void refresh());
    void subscription.then(refresh).catch(() => {});
    const timer = setInterval(() => void refresh(), 2000);
    return () => { disposed = true; clearInterval(timer); void subscription.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);
  const reviewing = pending.find((p) => p.id === reviewId);
  if (reviewing) return <ApprovalDialog key={reviewing.id} request={reviewing} profiles={profiles} onClose={() => {
    setPending((previous) => previous.filter((p) => p.id !== reviewing.id)); setReviewId(null);
  }} />;
  if (!pending.length) return null;
  // A network request must never move keyboard focus away from a terminal/password input.
  return <aside className="mcp-oauth-notice" aria-label="MCP connection requests">
    <span>{pending.length} MCP connection request{pending.length === 1 ? "" : "s"}</span>
    <button onClick={() => setReviewId(pending[0].id)}>Review connection</button>
  </aside>;
}

function ApprovalDialog({ request, profiles, onClose }: {
  request: McpOAuthApproval; profiles: Profile[]; onClose: () => void;
}) {
  const [matched, setMatched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const reject = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    reject.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const respond = async (accept: boolean) => {
    if (busy || (accept && !matched)) return;
    setBusy(true); setError("");
    try { await respondMcpOAuth(request.id, accept); onClose(); }
    catch { setError("This request could not be completed. It may have expired; authenticate again in your client."); }
    finally { setBusy(false); }
  };
  return <div className="mcp-oauth-overlay" onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); void respond(false); }
    if (event.key === "Tab") {
      const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <div ref={dialog} className="mcp-oauth-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-oauth-title">
      <h2 id="mcp-oauth-title">Approve MCP connection</h2>
      <p><strong>{request.client_name}</strong> is requesting access. This name is supplied by the client and is not a verified identity.</p>
      <p>Match this code with the browser window you opened:</p>
      <code className="mcp-oauth-code">{request.verification_code}</code>
      <p className="mcp-oauth-callback">Return address: <code>{request.redirect_uri}</code></p>
      <h3>Shared servers</h3>
      <ul>{request.profile_ids.map((id) => {
        const profile = profiles.find((p) => p.id === id);
        return <li key={id}>{profile ? `${profile.name} · ${profile.username}@${profile.host}` : `Server #${id}`}</li>;
      })}</ul>
      <p>Server metadata{request.allow_execution ? ", command execution" : ""}{request.allow_sftp_read ? ", SFTP reading" : ""}{request.allow_sftp_write ? ", SFTP changes" : ""}.</p>
      <p>Command output and file contents may be sent to your AI provider. Command execution includes the SSH account's file access. This approval is remembered across restarts and expires after 90 days without renewal. Revoke it in Settings → MCP.</p>
      <label><input type="checkbox" checked={matched} disabled={busy} onChange={(event) => setMatched(event.target.checked)} />I started this connection, matched the code, and approve the access above.</label>
      {error && <p role="alert" className="mcp-error">{error}</p>}
      <div className="mcp-oauth-actions">
        <button ref={reject} disabled={busy} onClick={() => void respond(false)}>Reject</button>
        <button disabled={busy || !matched} onClick={() => void respond(true)}>{busy ? "Completing…" : "Approve connection"}</button>
      </div>
    </div>
  </div>;
}
