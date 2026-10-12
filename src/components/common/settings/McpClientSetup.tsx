import { useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  buildMcpClientSetup, detectMcpPlatform, MCP_CLIENTS, mcpClientConfigPath, mcpPlatformLabel,
  type McpClient,
} from "../../../utils/mcpClientSetup";

interface McpClientSetupProps {
  endpoint: string | null;
  token: string | null;
  busy: boolean;
}

export default function McpClientSetup({ endpoint, token, busy }: McpClientSetupProps) {
  const [client, setClient] = useState<McpClient>("codex");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const platform = detectMcpPlatform(navigator.platform, navigator.userAgent);
  const cli = client === "codex" || client === "claude";
  const label = MCP_CLIENTS.find((entry) => entry.id === client)!.label;
  const ready = endpoint !== null && token !== null;

  const copy = async () => {
    if (!endpoint || !token) return;
    setNotice("");
    setError("");
    try {
      await writeText(buildMcpClientSetup(client, platform, endpoint, token));
      setNotice(`${label} ${cli ? "commands" : "JSON"} copied with the current bearer token.`);
    } catch (err) { setError(String(err)); }
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
      {!ready ? <p>Start MCP to generate commands and configuration with its current URL and token.</p> : <>
        {cli ? <>
          <p>Run both lines in a local {platform === "windows" ? "PowerShell" : "terminal"}, then start <code>{client === "codex" ? "codex" : "claude"}</code> in that same terminal. Set the token again in each new terminal.</p>
          <p>The CLI must already be installed. This registers a user-level server named <code>cygnus</code>.</p>
        </> : <>
          <p>User configuration file: <code className="mcp-config-path">{mcpClientConfigPath(client, platform)}</code></p>
          {client === "kiro" && <p>In Kiro's command palette, choose <strong>Kiro: Open user MCP config (JSON)</strong>.</p>}
          <p>Merge the <code>cygnus</code> entry into <code>mcpServers</code>, preserving other servers. Save, then reconnect the server in {label}.</p>
        </>}
        <pre className="mcp-setup-code" tabIndex={0} aria-label={`${label} ${cli ? "registration commands" : "configuration JSON"}; token hidden`}><code>{buildMcpClientSetup(client, platform, endpoint!, "<BEARER_TOKEN>")}</code></pre>
        <p>The preview hides the token. Copy includes the real token{cli ? "; pasted commands may be saved in shell history." : "; the JSON stores it in plain text. Keep it in your user settings, outside shared repositories."}</p>
        <div className="settings-actions">
          <button className="settings-btn" disabled={busy} onClick={() => void copy()}>{cli ? "Copy commands" : "Copy JSON"}</button>
        </div>
        {cli && <p>If <code>cygnus</code> is already registered and needs replacing, run <code>{client === "codex" ? "codex mcp remove cygnus" : "claude mcp remove --scope user cygnus"}</code>, then register again.</p>}
        <p>Keep Cygnus running. After restarting MCP, copy the updated {cli ? "commands" : "JSON"} and reconnect. Use the client on this computer, where the local MCP address is reachable.</p>
        {notice && <div role="status">{notice}</div>}
        {error && <div className="mcp-error" role="alert">{error}</div>}
      </>}
    </section>
  );
}
