import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  buildMcpClientSetup, buildMcpOAuthSetup, detectMcpPlatform, MCP_CLIENTS, mcpClientConfigPath, mcpPlatformLabel,
  type McpClient,
} from "../../../utils/mcpClientSetup";

interface McpClientSetupProps {
  endpoint: string | null;
  token: string | null;
  busy: boolean;
}

export default function McpClientSetup({ endpoint, token, busy }: McpClientSetupProps) {
  const [client, setClient] = useState<McpClient>("codex");
  const [auth, setAuth] = useState("oauth");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [copying, setCopying] = useState(false);
  const copyRequest = useRef(0);
  const platform = detectMcpPlatform(navigator.platform, navigator.userAgent);
  const oauth = auth === "oauth";
  const format = client === "codex" ? (oauth ? "command" : "TOML") : client === "claude" ? "command" : "JSON";
  const label = MCP_CLIENTS.find((entry) => entry.id === client)!.label;
  const ready = endpoint !== null && (oauth || token !== null);

  useEffect(() => {
    setNotice(""); setError(""); setCopying(false);
    // A completed clipboard request must not claim that a revoked token is current.
    return () => { copyRequest.current += 1; };
  }, [client, endpoint, token, auth]);

  const copy = async () => {
    if (!endpoint || (!oauth && !token) || busy || copying) return;
    const request = ++copyRequest.current;
    setNotice("");
    setError("");
    setCopying(true);
    try {
      await writeText(oauth ? buildMcpOAuthSetup(client, platform, endpoint) : buildMcpClientSetup(client, platform, endpoint, token!));
      if (request === copyRequest.current) setNotice(`${label} ${format} copied${oauth ? ". Authenticate and approve the connection in Cygnus." : " with the current bearer token."}`);
    } catch {
      if (request === copyRequest.current) setError("Could not copy the setup. Try again.");
    } finally {
      if (request === copyRequest.current) setCopying(false);
    }
  };

  return (
    <section className="mcp-client-setup" aria-labelledby="mcp-client-heading">
      <div className="mcp-heading">
        <h3 id="mcp-client-heading">Connect an AI client</h3>
        <span>{mcpPlatformLabel(platform)}</span>
      </div>
      <label className="mcp-field" htmlFor="mcp-client">Client
        <select id="mcp-client" value={client} onChange={(event) => {
          setClient(event.target.value as McpClient); setNotice(""); setError("");
        }}>
          {MCP_CLIENTS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      <label className="mcp-field" htmlFor="mcp-auth">Authentication
        <select id="mcp-auth" value={auth} onChange={(event) => setAuth(event.target.value)}>
          <option value="oauth">App approval (OAuth · Beta)</option>
          <option value="manual">Manual bearer token</option>
        </select>
      </label>
      {!ready ? <p>Start MCP to generate the connection setup.</p> : <>
        {oauth ? <>
          {(client === "codex" || client === "claude") ? <>
            <p>Run the command in a local {platform === "windows" ? "PowerShell" : "terminal"}. If <code>cygnus</code> already exists, remove it first with <code>{client === "codex" ? "codex mcp remove cygnus" : "claude mcp remove --scope user cygnus"}</code> to clear the old token configuration.</p>
            <p>{client === "claude" ? <>Open <code>/mcp</code> in Claude Code, select <code>cygnus</code>, then authenticate.</> : <>If sign-in does not open automatically, run <code>codex mcp login cygnus</code>.</>}</p>
          </> : <>
            <p>User configuration file: <code className="mcp-config-path">{mcpClientConfigPath(client, platform)}</code></p>
            <p>Replace the <code>cygnus</code> entry with this JSON entry, removing old Authorization headers. Preserve other servers, then reconnect and authenticate in {label}.</p>
          </>}
          <p>In Cygnus, match the code shown in your browser and approve the requested server access. Your client receives credentials automatically; no token copy is needed.</p>
          <pre className="mcp-setup-code" tabIndex={0} aria-label={`${label} OAuth ${format}`}><code>{buildMcpOAuthSetup(client, platform, endpoint!)}</code></pre>
          <p>Approvals survive MCP restarts and clients renew tokens automatically. Authenticate again after 90 days without renewal. Keep the same local port; revoke a client below to require approval again.</p>
        </> : <>
        {client === "claude" ? <>
          <p>Run the command in a local {platform === "windows" ? "PowerShell" : "terminal"}. Claude Code must already be installed. This registers a user-level server named <code>cygnus</code> with the current token.</p>
          <p>If <code>cygnus</code> is already registered, run <code>claude mcp remove --scope user cygnus</code> first, then paste the new command.</p>
        </> : <>
          <p>User configuration file: <code className="mcp-config-path">{mcpClientConfigPath(client, platform)}</code></p>
          {client === "kiro" && <p>In Kiro's command palette, choose <strong>Kiro: Open user MCP config (JSON)</strong>.</p>}
          {client === "codex"
            ? <p>Replace the existing <code>[mcp_servers.cygnus]</code> entry and its header settings with this block, or add it if absent. Remove any old <code>bearer_token_env_var</code> for this server. Preserve other settings, save, then restart Codex. If you use a custom Codex configuration directory, edit its <code>config.toml</code> instead.</p>
            : <p>Replace or add the <code>cygnus</code> entry in <code>mcpServers</code>, preserving other servers. Save, then reconnect the server in {label}.</p>}
        </>}
        <pre className="mcp-setup-code" tabIndex={0} aria-label={`${label} ${format}; token hidden`}><code>{buildMcpClientSetup(client, platform, endpoint!, "<BEARER_TOKEN>")}</code></pre>
        <p>No environment variables are needed. The preview hides the token; the copy button includes the actual current token.</p>
        <p>{client === "claude" ? "The token is stored in your user settings and may remain in shell history." : "The configuration stores the token in plain text. Keep it in your user settings, outside shared repositories."}</p>
        <p>Stopping MCP revokes the manual token. After starting MCP again, copy the new {format} to replace the previous setup and reconnect your client.</p>
        </>}
        <div className="settings-actions">
          <button className="settings-btn" disabled={busy || copying} onClick={() => void copy()}>{copying ? "Copying…" : `Copy ${format}`}</button>
        </div>
        <p>Keep Cygnus running and use the client on this computer.</p>
        {notice && <div role="status">{notice}</div>}
        {error && <div className="mcp-error" role="alert">{error}</div>}
      </>}
    </section>
  );
}
