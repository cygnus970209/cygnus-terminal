import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "../../services/secureInvoke";
import { t, useLocale } from "../../i18n";
import type { SessionStatus } from "../../types";
import { winrmEndpoint, type WinrmLaunch, type WinrmOutput } from "../../types/winrm";
import "./WinrmSession.css";

interface Props {
  tabId: string;
  launch: WinrmLaunch;
  isActive: boolean;
  onSessionStatus: (tabId: string, status: SessionStatus) => void;
  onCredentialsUsed: (tabId: string) => void;
}
interface Entry { id: number; script: string; output?: WinrmOutput; error?: string; }
export default function WinrmSession({ tabId, launch, isActive, onSessionStatus, onCredentialsUsed }: Props) {
  useLocale();
  const [status, setStatus] = useState<SessionStatus>("ended");
  const [password, setPassword] = useState("");
  const [script, setScript] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const session = useRef<string | null>(null);
  const generation = useRef(0);
  const running = useRef(false);
  const sequence = useRef(0);
  const initial = useRef(launch);
  const setSessionStatus = useCallback((value: SessionStatus) => {
    setStatus(value); onSessionStatus(tabId, value);
  }, [tabId, onSessionStatus]);
  const connect = useCallback(async (secret?: string) => {
    const version = ++generation.current;
    const previous = session.current;
    const id = crypto.randomUUID();
    session.current = id;
    if (previous) void invoke("winrm_close", { sessionId: previous }).catch(() => {});
    setError(""); setSessionStatus("connecting"); setBusy(false); running.current = false;
    const pending = invoke<void>("winrm_connect", {
      sessionId: id, profileId: initial.current.profileId ?? null, config: initial.current.config, password: secret || null,
    });
    initial.current = { ...initial.current, password: undefined };
    setPassword(""); onCredentialsUsed(tabId);
    try {
      await pending;
      if (version === generation.current) setSessionStatus("connected");
      else void invoke("winrm_close", { sessionId: id }).catch(() => {});
    } catch (err) {
      if (version === generation.current) { setError(String(err)); setSessionStatus("error"); }
    }
  }, [onCredentialsUsed, setSessionStatus, tabId]);
  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      if (initial.current.password || initial.current.hasPassword) void connect(initial.current.password);
      else setSessionStatus("ended");
    });
    return () => {
      disposed = true;
      generation.current++;
      if (session.current) void invoke("winrm_close", { sessionId: session.current }).catch(() => {});
      session.current = null;
    };
  }, [connect, setSessionStatus]);
  const disconnect = () => {
    generation.current++;
    if (session.current) void invoke("winrm_close", { sessionId: session.current }).catch(() => {});
    session.current = null; running.current = false; setBusy(false); setStopping(false); setSessionStatus("ended");
  };
  const run = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!session.current || status !== "connected" || running.current || !script.trim()) return;
    const id = ++sequence.current;
    const version = generation.current;
    const currentScript = script;
    running.current = true; setBusy(true); setStopping(false); setError("");
    setEntries(previous => [...previous.slice(-4), { id, script: currentScript }]);
    try {
      const output = await invoke<WinrmOutput>("winrm_execute", { sessionId: session.current, script: currentScript });
      if (version === generation.current) setEntries(previous => previous.map(entry => entry.id === id ? { ...entry, output } : entry));
    } catch (err) {
      if (version === generation.current) setEntries(previous => previous.map(entry => entry.id === id ? { ...entry, error: String(err) } : entry));
    } finally {
      if (version === generation.current) { running.current = false; setBusy(false); setStopping(false); }
    }
  };
  const stop = async () => {
    if (!session.current || stopping) return;
    setStopping(true);
    try { await invoke("winrm_cancel", { sessionId: session.current }); }
    catch (err) { setError(String(err)); setStopping(false); }
  };
  return <section className="winrm-session" hidden={!isActive} aria-label={t("WinRM PowerShell console")}>
    <header className="winrm-toolbar">
      <div><strong>WinRM · PowerShell</strong><span>{winrmEndpoint(launch.config)} · {launch.config.transport.toUpperCase()}</span></div>
      {(status === "connected" || status === "connecting") && <button className="dialog-btn" onClick={disconnect}>{status === "connecting" ? t("Cancel") : t("Disconnect")}</button>}
    </header>
    <p className="winrm-hint">{t("Each run starts a new PowerShell process. Variables and the current directory do not persist between runs. Interactive prompts and full-screen programs are not supported.")}</p>
    {status !== "connected" && <form className="winrm-login" onSubmit={event => { event.preventDefault(); void connect(password); }}>
      <label>{t("Password")}<input type="password" autoComplete="current-password" value={password} disabled={status === "connecting"} onChange={event => setPassword(event.target.value)} placeholder={launch.hasPassword ? t("Leave blank to use saved password") : t("Windows account password")} /></label>
      <button className="dialog-btn dialog-btn-connect" disabled={status === "connecting"}>{status === "connecting" ? t("Connecting…") : t("Connect")}</button>
    </form>}
    {error && <p className="connection-error" role="alert">{t(error)}</p>}
    <form className="winrm-editor" onSubmit={event => void run(event)}>
      <label htmlFor={`${tabId}-script`}>{t("PowerShell script")}</label>
      <textarea id={`${tabId}-script`} spellCheck={false} value={script} maxLength={16 * 1024} placeholder="Get-NetAdapterStatistics | Format-Table" onChange={event => setScript(event.target.value)} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void run(); }
      }} />
      <div className="winrm-editor-actions"><span>{t("Ctrl/⌘ + Enter to run · 5-minute limit · 1 MiB output limit")}</span>
        <div className="winrm-run-actions">
          <button type="submit" className="dialog-btn dialog-btn-connect" disabled={busy || status !== "connected" || !script.trim()}>{t("Run script")}</button>
          {busy && <button type="button" className="dialog-btn" disabled={stopping} onClick={() => void stop()}>{stopping ? t("Stopping…") : t("Stop")}</button>}
        </div>
      </div>
    </form>
    <div className="winrm-output-heading"><h2>{t("Output")}</h2><button className="dialog-btn" disabled={busy || !entries.length} onClick={() => setEntries([])}>{t("Clear")}</button></div>
    <div className="winrm-results" aria-busy={busy}>
      {!entries.length && <p className="winrm-hint">{t("Run a script to see its output here. The last five runs are kept in this tab.")}</p>}
      {entries.map(entry => <article className="winrm-result" key={entry.id}>
        <pre className="winrm-command">{entry.script}</pre>
        {entry.output && <><pre>{entry.output.stdout}</pre>{entry.output.stderr && <pre className="winrm-stderr">{entry.output.stderr}</pre>}<p>{t("Exit code: {v0}", { v0: entry.output.exit_code })}</p></>}
        {entry.error && <p className="connection-error" role="alert">{t(entry.error)}</p>}
        {!entry.output && !entry.error && <p role="status">{busy ? t("Running…") : t("Disconnected")}</p>}
      </article>)}
    </div>
  </section>;
}
