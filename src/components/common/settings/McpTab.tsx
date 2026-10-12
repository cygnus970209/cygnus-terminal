import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "../../../services/secureInvoke";
import {
  getMcpStatus, startMcp, stopMcp, unlockMcpCredentials,
  type McpStatus,
} from "../../../services/mcpService";
import type { Profile } from "../../../types";
import McpClientSetup from "./McpClientSetup";
import "./McpTab.css";

export default function McpTab() {
  const [server, setServer] = useState<McpStatus | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [port, setPort] = useState("38473");
  const [allowExecution, setAllowExecution] = useState(false);
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
        setProfiles(saved.filter((p) => p.protocol === "ssh"));
        if (status.config) {
          setSelected(status.config.profile_ids);
          setPort(String(status.config.port));
          setAllowExecution(status.config.allow_execution);
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
      <p>Connect an AI client to selected SSH servers while Cygnus is open. Access stays on this computer and resets when the app closes.</p>
      {error && <div className="mcp-error" role="alert">{error}</div>}
      {notice && <div role="status">{notice}</div>}
      {!server && error && <button className="settings-btn" onClick={() => { setError(""); setReload((value) => value + 1); }}>Retry</button>}
      {server && <>
        <label className="mcp-field" htmlFor="mcp-port">
          Local port <span>0 selects an available port.</span>
          <input id="mcp-port" type="number" min="0" max="65535" step="1" value={port} disabled={disabled} onChange={(e) => setPort(e.target.value)} />
        </label>
        <fieldset disabled={disabled}>
          <legend>Shared SSH servers</legend>
          <div className="mcp-profiles">
            {profiles.length === 0 && <p>Save an SSH connection in Connections first.</p>}
            {profiles.map((profile) => (
              <label key={profile.id} className="mcp-profile">
                <input type="checkbox" checked={selected.includes(profile.id)} onChange={(e) => {
                  setSelected((ids) => e.target.checked ? [...ids, profile.id] : ids.filter((id) => id !== profile.id));
                }} />
                <span><strong>{profile.name}</strong><small>{profile.username}@{profile.host}:{profile.port}{profile.environment && ` · ${profile.environment}`}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mcp-permission">
          <input type="checkbox" checked={allowExecution} disabled={disabled} onChange={(e) => setAllowExecution(e.target.checked)} />
          <span>Allow remote command execution<small>The connected AI client can run any command permitted by these SSH accounts, including commands that change or delete files.</small></span>
        </label>
        <div className="settings-actions">
          {configured ? (
            <button className="settings-btn" disabled={busy} onClick={() => void act(async () => {
              await stopMcp(); setServer(await getMcpStatus()); setNotice("MCP stopped. Cancellation was requested for its active jobs.");
            })}>Stop MCP</button>
          ) : (
            <button className="settings-btn" disabled={busy || !selected.length || !validPort} onClick={() => void act(async () => {
              setServer(await startMcp({ port: Number(port), profile_ids: selected, allow_execution: allowExecution }));
            })}>Start MCP</button>
          )}
          {allowExecution && <button className="settings-btn" disabled={busy} onClick={() => void act(async () => {
            await unlockMcpCredentials(); setNotice("Saved credentials are unlocked for this app session.");
          })}>Unlock saved credentials</button>}
        </div>
        <p>For first-time connections, verify the host key in a terminal first. Stopping MCP revokes its token and requests cancellation of its active jobs; remote termination may remain unconfirmed.</p>
        {server.endpoint && server.token && <div className="mcp-connection">
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
        </div>}
        <McpClientSetup key={server.token ?? "stopped"} endpoint={server.running ? server.endpoint : null} token={server.running ? server.token : null} busy={busy} />
      </>}
    </div>
  );
}
