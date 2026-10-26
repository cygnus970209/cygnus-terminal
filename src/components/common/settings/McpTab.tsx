import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "../../../services/secureInvoke";
import {
  getMcpStatus, startMcp, stopMcp, unlockMcpCredentials,
  type McpStatus,
} from "../../../services/mcpService";
import type { Profile } from "../../../types";
import McpClientSetup from "./McpClientSetup";
import McpServerPicker from "./McpServerPicker";
import McpAuthorizedClients from "./McpAuthorizedClients";
import "./McpTab.css";

export default function McpTab() {
  const [server, setServer] = useState<McpStatus | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [port, setPort] = useState("38473");
  const [allowExecution, setAllowExecution] = useState(false);
  const [allowSftpRead, setAllowSftpRead] = useState(false);
  const [allowSftpWrite, setAllowSftpWrite] = useState(false);
  const [acknowledgedRisks, setAcknowledgedRisks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let disposed = false;
    Promise.all([getMcpStatus(), invoke<Profile[]>("list_profiles")])
      .then(([status, saved]) => {
        if (disposed) return;
        setServer(status);
        setProfiles(saved.filter((p) => (p.protocol ?? "ssh") === "ssh"));
        setAcknowledgedRisks(status.config?.acknowledge_risks === true);
        const config = status.config ?? status.saved_config;
        if (config) {
          setSelected(config.profile_ids.filter((id) => saved.some((p) => p.id === id && (p.protocol ?? "ssh") === "ssh")));
          setPort(String(config.port));
          setAllowExecution(config.allow_execution);
          setAllowSftpRead(config.allow_sftp_read ?? false);
          setAllowSftpWrite(config.allow_sftp_write ?? false);
        }
      })
      .catch((err) => { if (!disposed) setError(String(err)); });
    return () => { disposed = true; };
  }, [reload]);

  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try { await operation(); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };

  const configured = server?.config != null;
  const disabled = busy || configured;
  const validPort = /^\d+$/.test(port) && Number(port) >= 0 && Number(port) <= 65535;

  return (
    <div className="mcp-settings">
      <div className="mcp-heading">
        <h3>Cygnus MCP</h3>
        <span>{server ? (server.running ? "Running" : "Stopped") : "Loading…"}</span>
      </div>
      <p>Connect an AI client to selected SSH servers while Cygnus is open. OAuth app approval is available in Beta. Saved approvals survive restarts; start MCP here to enable access on this computer.</p>
      {error && <div className="mcp-error" role="alert">{error}</div>}
      {notice && <div role="status">{notice}</div>}
      {!server && error && <button className="settings-btn" onClick={() => { setError(""); setReload((value) => value + 1); }}>Retry</button>}
      {server && <>
        <label className="mcp-field" htmlFor="mcp-port">
          Local port <span>0 selects an available port.</span>
          <input id="mcp-port" type="number" min="0" max="65535" step="1" value={port} disabled={disabled} onChange={(e) => setPort(e.target.value)} />
        </label>
        <McpServerPicker profiles={profiles} selected={selected} onChange={setSelected} disabled={disabled} />
        <label className="mcp-permission">
          <input type="checkbox" checked={allowExecution} disabled={disabled} onChange={(e) => setAllowExecution(e.target.checked)} />
          <span>Allow remote command execution<small>The connected AI client can run any command permitted by these SSH accounts, including commands that change or delete files. Commands open a dedicated MCP terminal; completed tabs are reused per server. Type passwords directly there. After manual input, subsequent output stays local.</small></span>
        </label>
        <label className="mcp-permission">
          <input type="checkbox" checked={allowSftpRead} disabled={disabled} onChange={(e) => {
            setAllowSftpRead(e.target.checked);
            if (!e.target.checked) setAllowSftpWrite(false);
          }} />
          <span>Allow SFTP file reading<small>List and read remote files accessible to these SSH accounts, including files containing secrets. File content is sent to the AI client and is not saved in Cygnus execution history.</small></span>
        </label>
        <label className="mcp-permission">
          <input type="checkbox" checked={allowSftpWrite} disabled={disabled || !allowSftpRead} onChange={(e) => setAllowSftpWrite(e.target.checked)} />
          <span>Allow SFTP file changes<small>Create, overwrite, rename and delete remote files. Requires SFTP reading. Each file write is limited to 64 KiB; larger transfers use the SFTP window.</small></span>
        </label>
        <section className="mcp-security-note" aria-labelledby="mcp-security-heading">
          <h4 id="mcp-security-heading">Security &amp; privacy</h4>
          <ul>
            <li>Cygnus uses saved SSH passwords locally to authenticate with your servers. MCP does not expose those saved credentials.</li>
            <li>Command output and file contents may be sent to your AI provider or saved by the client. Secrets in files such as <code>.env</code> and logs are not automatically masked.</li>
            <li>Command execution grants the SSH account's permissions, including file access even when SFTP permissions are off.</li>
          </ul>
          <label className="mcp-consent" htmlFor="mcp-acknowledge-risks">
            <input id="mcp-acknowledge-risks" type="checkbox" checked={acknowledgedRisks} disabled={busy || configured || !server} onChange={(event) => setAcknowledgedRisks(event.target.checked)} />
            <span>I understand these risks and agree to share permitted server data with my AI client.
              <small>{configured ? "Stop MCP to pause access. Revoke individual OAuth approvals below." : "Required each time you start MCP."}</small>
            </span>
          </label>
        </section>
        <div className="settings-actions">
          {configured ? (
            <button className="settings-btn" disabled={busy} onClick={() => void act(async () => {
              await stopMcp(); setServer(await getMcpStatus()); setAcknowledgedRisks(false); setNotice("MCP stopped. Cancellation was requested for its active SSH jobs and SFTP requests.");
            })}>Stop MCP</button>
          ) : (
            <button className="settings-btn" disabled={busy || !selected.length || !validPort || !acknowledgedRisks} onClick={() => void act(async () => {
              setServer(await startMcp({ port: Number(port), profile_ids: selected, allow_execution: allowExecution, allow_sftp_read: allowSftpRead, allow_sftp_write: allowSftpWrite, acknowledge_risks: acknowledgedRisks }));
            })}>Start MCP</button>
          )}
          {(allowExecution || allowSftpRead) && <button className="settings-btn" disabled={busy} onClick={() => void act(async () => {
            await unlockMcpCredentials(); setNotice("Saved credentials are unlocked for this app session.");
          })}>Unlock saved credentials</button>}
        </div>
        <p>For first-time connections, verify the host key in a terminal first. Stopping MCP cancels active requests and revokes the manual token; OAuth approvals remain saved. Remote changes may already have taken effect.</p>
        {server.endpoint && server.token && <details className="mcp-connection">
          <summary>Manual connection details</summary>
          <label className="mcp-field" htmlFor="mcp-endpoint">MCP URL
            <input id="mcp-endpoint" readOnly value={server.endpoint} />
          </label>
          <label className="mcp-field" htmlFor="mcp-token">Bearer token
            <input id="mcp-token" type="password" readOnly value={server.token} autoComplete="off" />
          </label>
          <div className="settings-actions">
            <button className="settings-btn" disabled={busy} onClick={() => void act(async () => { await writeText(server.endpoint!); setNotice("MCP URL copied."); })}>Copy URL</button>
            <button className="settings-btn" disabled={busy} onClick={() => void act(async () => { await writeText(server.token!); setNotice("Bearer token copied."); })}>Copy token</button>
          </div>
          <p>Choose Streamable HTTP in your MCP client. Use this URL and send the token as the Authorization: Bearer header. The token grants the access selected above.</p>
        </details>}
        <McpClientSetup endpoint={server.running ? server.endpoint : null} token={server.running ? server.token : null} busy={busy} />
        <McpAuthorizedClients />
      </>}
    </div>
  );
}
