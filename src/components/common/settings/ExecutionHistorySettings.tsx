import { useEffect, useRef, useState } from "react";
import {
  clearExecutionHistory, getExecutionHistorySettings, updateExecutionHistorySettings,
} from "../../../services/executionService";
import type { ExecutionHistorySettings as HistorySettings } from "../../../types/execution";
import "./ExecutionHistorySettings.css";

export default function ExecutionHistorySettings() {
  const [saved, setSaved] = useState<HistorySettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<"save" | "clear" | null>(null);
  const [reload, setReload] = useState(0);
  const confirmationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (confirmation) confirmationRef.current?.scrollIntoView({ block: "nearest" });
  }, [confirmation]);

  useEffect(() => {
    let disposed = false;
    getExecutionHistorySettings().then((settings) => {
      if (disposed) return;
      setSaved(settings);
      setEnabled(settings.enabled);
      setDays(String(settings.retention_days));
    }).catch((err) => { if (!disposed) setError(String(err)); });
    return () => { disposed = true; };
  }, [reload]);

  const perform = async (action: "save" | "clear") => {
    setBusy(true);
    setError("");
    setNotice("");
    setConfirmation(null);
    try {
      if (action === "clear") {
        await clearExecutionHistory();
        setNotice("Execution history deleted. Running jobs continue with temporary results only.");
      } else {
        const settings = { enabled, retention_days: Number(days) };
        await updateExecutionHistorySettings(settings);
        setSaved(settings);
        setNotice(enabled ? "History settings saved. Recording applies to new jobs." : "Recording disabled and execution history deleted.");
      }
    } catch (err) {
      setError(String(err));
      // A journal cleanup error may occur after the settings transaction commits.
      setReload((value) => value + 1);
    } finally { setBusy(false); }
  };

  const validDays = /^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 365;
  const changed = saved && (enabled !== saved.enabled || Number(days) !== saved.retention_days);
  const disabled = busy || confirmation !== null;

  return (
    <section className="execution-history-settings" aria-labelledby="execution-history-heading">
      <h3 id="execution-history-heading">Execution history</h3>
      <p>Controls commands and output from MCP and automated SSH jobs. Terminal command history has separate storage.</p>
      {error && <div className="execution-history-error" role="alert">{error}</div>}
      {notice && <div role="status">{notice}</div>}
      {!saved ? <>
        {error ? <button className="settings-btn" onClick={() => { setError(""); setReload((value) => value + 1); }}>Retry</button> : <p>Loading…</p>}
      </> : <>
        <label className="execution-history-toggle">
          <input type="checkbox" checked={enabled} disabled={disabled} onChange={(e) => {
            setEnabled(e.target.checked);
            if (!e.target.checked) setDays(String(saved.retention_days));
          }} />
          <span>Save execution history on this computer</span>
        </label>
        <p>Saved commands and output are not encrypted and may contain secrets. Turning this off deletes saved history and completed temporary results.</p>
        <label className="execution-history-days" htmlFor="execution-history-days">
          Keep history for (days)
          <input id="execution-history-days" type="number" min="1" max="365" step="1" value={days} disabled={disabled || !enabled} onChange={(e) => setDays(e.target.value)} aria-describedby="execution-history-retention" />
        </label>
        <p id="execution-history-retention">1–365 days from submission. A shorter period immediately removes expired completed jobs.</p>
        <p>Without saved history, completed results remain in memory for up to 15 minutes, limited to 32 jobs and 64 MiB. Closing the app removes them. Running jobs remain available until they finish.</p>
        <div className="settings-actions">
          <button className="settings-btn" disabled={disabled || !changed || !validDays} onClick={() => {
            if ((saved.enabled && !enabled) || (enabled && Number(days) < saved.retention_days)) setConfirmation("save");
            else void perform("save");
          }}>Save history settings</button>
          <button className="settings-btn execution-history-delete" disabled={disabled} onClick={() => setConfirmation("clear")}>Delete execution history…</button>
        </div>
        {confirmation && <div ref={confirmationRef} className="execution-history-confirm" role="group" aria-label="Confirm history deletion">
          <p>{confirmation === "clear" ? "Delete all saved history and completed temporary results? Running jobs continue, and their results will only be kept temporarily. New jobs follow your saved settings." : !enabled ? "Disable recording and delete all saved history and completed temporary results? Running jobs continue with temporary results only." : "Apply this shorter period and delete expired history?"} This cannot be undone.</p>
          <div className="settings-actions">
            <button className="settings-btn execution-history-delete" onClick={() => void perform(confirmation)}>Confirm deletion</button>
            <button className="settings-btn" onClick={() => setConfirmation(null)}>Cancel</button>
          </div>
        </div>}
      </>}
    </section>
  );
}
