import { useEffect, useState } from "react";
import { getMcpOAuthClients, revokeMcpOAuthClient, type McpOAuthClient } from "../../../services/mcpService";

export default function McpAuthorizedClients() {
  const [clients, setClients] = useState<McpOAuthClient[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const result = await getMcpOAuthClients();
        if (!disposed && request === generation) { setClients(result ?? []); setError(""); }
      } catch { if (!disposed) setError("Could not load authorized clients."); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [reload]);
  return <section className="mcp-authorized-clients" aria-labelledby="mcp-authorized-heading">
    <h3 id="mcp-authorized-heading">Authorized clients</h3>
    <p>OAuth approvals remain saved when MCP stops. Revoke access to invalidate this client's tokens and cancel its active requests. Remote changes cannot be undone.</p>
    {!clients.length && <p>No authorized clients.</p>}
    {clients.map((client) => <div className="mcp-authorized-client" key={client.id}>
      <div><strong>{client.name}</strong><small>{client.profile_ids.length} server(s){client.allow_execution ? " · commands" : ""}{client.allow_sftp_read ? " · SFTP read" : ""}{client.allow_sftp_write ? " · SFTP changes" : ""}</small>
        <small>Approved {new Date(client.approved_at * 1000).toLocaleString()} · Expires {new Date(client.expires_at * 1000).toLocaleDateString()}</small>
      </div>
      <button className="settings-btn" disabled={busy !== null} onClick={async () => {
        setBusy(client.id); setError("");
        try { await revokeMcpOAuthClient(client.id); setClients((previous) => previous.filter((c) => c.id !== client.id)); setReload((value) => value + 1); }
        catch { setError("Could not revoke access. Try again."); }
        finally { setBusy(null); }
      }}>{busy === client.id ? "Revoking…" : "Revoke access"}</button>
    </div>)}
    {error && <p className="mcp-error" role="alert">{error}</p>}
  </section>;
}
