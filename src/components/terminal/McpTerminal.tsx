import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "../../services/secureInvoke";
import { cancelExecution } from "../../services/executionService";
import { useTheme } from "../../hooks/useTheme";
import { createTerminalLayoutScheduler } from "../../utils/terminalLayout";
import { TERMINAL_SCROLLBACK_LINES } from "../../constants";
import type { ExecutionSummary, ExecutionTerminalEvent } from "../../types/execution";
import type { SessionStatus } from "../../types";
import "@xterm/xterm/css/xterm.css";
import "./McpTerminal.css";

const isFinished = (job: ExecutionSummary) =>
  !["connecting", "running", "cancelling"].includes(job.status);

interface Props {
  tabId: string;
  job: ExecutionSummary;
  isActive: boolean;
  onSessionStatus: (tabId: string, status: SessionStatus) => void;
  onJobStatus: (tabId: string, job: ExecutionSummary) => void;
}

export default function McpTerminal({ tabId, job, isActive, onSessionStatus, onJobStatus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerm | null>(null);
  const scheduleLayout = useRef<() => void>(() => {});
  const connect = useRef<(job: ExecutionSummary) => () => void>(() => () => {});
  const active = useRef(isActive);
  active.current = isActive;
  const [summary, setSummary] = useState(job);
  const [error, setError] = useState<string | null>(null);
  const { theme } = useTheme();

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let attached = false;
    let current = job;
    let failed = false;
    let pendingBytes = 0;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      scrollback: TERMINAL_SCROLLBACK_LINES,
      theme: theme.colors,
      allowProposedApi: false,
      disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    terminal.current = term;
    const fail = (reason: unknown) => {
      if (disposed) return;
      failed = true;
      setError(String(reason));
      term.options.disableStdin = true;
      onSessionStatus(tabId, "error");
      void cancelExecution(current.id).catch(() => {});
    };
    const update = (value: ExecutionSummary) => {
      if (isFinished(value) && !isFinished(current)) {
        term.write(`\r\n[MCP ${value.status}${value.exit_code === null ? "" : ` · exit ${value.exit_code}`} ]\r\n`);
      }
      current = value;
      setSummary(value);
      onJobStatus(tabId, value);
      term.options.disableStdin = failed || !attached || value.status !== "running";
      onSessionStatus(tabId, value.status === "running" ? "connected"
        : value.status === "connecting" || value.status === "cancelling" ? "connecting"
        : value.status === "succeeded" || value.status === "cancelled" ? "ended" : "error");
    };
    const write = (data: string | Uint8Array) => {
      pendingBytes += data.length;
      if (pendingBytes > 4 * 1024 * 1024) {
        fail("Terminal output exceeded the display buffer; cancellation requested.");
        return;
      }
      term.write(data, () => { pendingBytes -= data.length; });
    };
    const layout = createTerminalLayoutScheduler(
      () => !disposed && active.current && !!host.current?.clientWidth && !!host.current?.clientHeight,
      () => {
        fit.fit();
        if (attached && !isFinished(current)) {
          void invoke("execution_terminal_resize", { jobId: current.id, cols: term.cols, rows: term.rows })
            .catch(() => {});
        }
      },
    );
    scheduleLayout.current = layout.schedule;
    const observer = new ResizeObserver(layout.schedule);
    observer.observe(host.current);
    layout.schedule();
    connect.current = (next) => {
      let disconnected = false;
      current = next;
      attached = false;
      failed = false;
      setError(null);
      update(next);
      // Reuse the xterm instance and its bounded scrollback. Render command text
      // without allowing it to inject terminal controls before execution.
      const command = next.command.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\n/g, "\r\n");
      // 1047 restores the normal buffer without 1049's saved-cursor jump, which
      // would overwrite earlier job output when no alternate screen was active.
      write(`\x1b[?1047l\x1b[!p\x1b[0m\r\n[MCP · ${next.started_at}]\r\n$ ${command}\r\n`);
      const events = new Channel<ExecutionTerminalEvent>();
      events.onmessage = (event) => {
        if (disposed || disconnected) return;
        if (event.type === "Output") {
          write(new Uint8Array(event.data));
        } else if (event.type === "Snapshot") {
          write(event.data.stdout);
          write(event.data.stderr);
          update(event.data);
        } else {
          update(event.data);
        }
      };
      void invoke("execution_terminal_attach", { jobId: next.id, onEvent: events }).then(() => {
        if (disposed || disconnected) {
          void cancelExecution(next.id).catch(() => {});
          return;
        }
        attached = true;
        update(current);
        layout.schedule();
        if (active.current && !document.querySelector('[role="dialog"], [aria-modal="true"], .dialog-overlay')) term.focus();
      }).catch((reason) => { if (!disconnected) fail(reason); });
      return () => {
        disconnected = true;
        if (current.id === next.id && !isFinished(current)) void cancelExecution(next.id).catch(() => {});
      };
    };
    // One ordered queue for local keyboard/paste input. Never send it to command history,
    // completion notifications, the vault parser, or MCP. Errors never include the data.
    let inputQueue = Promise.resolve();
    let queuedBytes = 0;
    term.onData((data) => {
      if (failed || !attached || current.status !== "running") return;
      const jobId = current.id;
      queuedBytes += data.length;
      if (queuedBytes > 65536) {
        fail("Terminal input is too large; cancellation requested.");
        return;
      }
      inputQueue = inputQueue.then(async () => {
        if (!disposed && !failed && current.id === jobId && current.status === "running") {
          await invoke("execution_terminal_input", { jobId, data });
        }
      }).catch((reason) => {
        if (current.id === jobId) fail(reason);
      }).finally(() => { queuedBytes -= data.length; });
    });
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !(event.metaKey || event.ctrlKey)) return true;
      if (event.key.toLowerCase() === "c" && term.hasSelection()) {
        event.preventDefault();
        void writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (event.key.toLowerCase() === "v") {
        event.preventDefault();
        const jobId = current.id;
        void readText().then((text) => {
          if (text && !disposed && !failed && active.current && current.id === jobId && current.status === "running") term.paste(text);
        }).catch(() => {});
        return false;
      }
      return true;
    });
    return () => {
      disposed = true;
      observer.disconnect();
      layout.dispose();
      scheduleLayout.current = () => {};
      terminal.current = null;
      term.dispose();
    };
    // Keep xterm alive across sequential jobs so local-only output stays in scrollback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, onSessionStatus, onJobStatus]);

  useEffect(() => connect.current(job), [job.id]);

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = theme.colors;
  }, [theme]);
  useEffect(() => {
    if (isActive) scheduleLayout.current();
  }, [isActive]);

  return (
    <section className="mcp-terminal" style={{ display: isActive ? "flex" : "none" }} aria-label="MCP terminal">
      <div className="mcp-terminal-header">
        <span className="mcp-terminal-status" role="status">MCP · {summary.status.replace(/_/g, " ")}</span>
        <span>{summary.username}@{summary.host}</span>
        {!isFinished(summary) && <button className="mcp-terminal-stop" disabled={summary.status === "cancelling"}
          onClick={() => void cancelExecution(job.id).catch((reason) => setError(String(reason)))}>Stop</button>}
      </div>
      <pre className="mcp-terminal-command" title={summary.command}>{summary.command}</pre>
      <p className="mcp-terminal-hint">{summary.output_withheld
        ? "Manual input detected. Subsequent output stays in this terminal and is excluded from AI results and execution history."
        : "You can type here, including passwords. After your first input, subsequent output stays local. Closing this tab requests cancellation."}</p>
      {(error || summary.error) && <p className="mcp-terminal-error" role="alert">{error || summary.error}</p>}
      {summary.remote_outcome_unknown && isFinished(summary) &&
        <p className="mcp-terminal-error">Remote termination is not confirmed. Check the server before retrying.</p>}
      <div className="mcp-terminal-screen" ref={host} />
    </section>
  );
}
