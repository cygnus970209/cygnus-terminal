import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "../../services/secureInvoke";
import { cancelExecution } from "../../services/executionService";
import { useTheme } from "../../hooks/useTheme";
import { useVaultPromptRules } from "../../hooks/useVaultPromptRules";
import VaultPromptPicker from "../vault/VaultPromptPicker";
import { createPromptTriggerGuard } from "../../utils/promptTriggerGuard";
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
  const { rules } = useVaultPromptRules();
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const [picker, setPicker] = useState<{ jobId: string; top: number; left: number; label?: string } | null>(null);
  const pickerOpen = useRef(false);
  const detectPrompt = useRef<() => void>(() => {});
  const openPicker = useRef<() => void>(() => {});
  const sendInput = useRef<(jobId: string, data: string) => Promise<void>>(async () => {});
  const injectVault = useRef<(jobId: string, vaultItemId: number) => Promise<void>>(async () => {});
  const focusTerminal = () => {
    if (active.current && !document.querySelector('[role="dialog"], [aria-modal="true"], .dialog-overlay')) {
      terminal.current?.focus();
    }
  };
  const closePicker = () => {
    pickerOpen.current = false;
    setPicker(null);
    // Wait for the modal DOM to disappear before checking for other dialogs.
    requestAnimationFrame(focusTerminal);
  };

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let attached = false;
    let current = job;
    let failed = false;
    let outputReady = false;
    let pendingBytes = 0;
    const triggerGuard = createPromptTriggerGuard();
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
      pickerOpen.current = false;
      setPicker(null);
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
      if (value.status !== "running") {
        pickerOpen.current = false;
        setPicker(null);
      }
      setSummary(value);
      onJobStatus(tabId, value);
      term.options.disableStdin = failed || !attached || value.status !== "running";
      onSessionStatus(tabId, value.status === "running" ? "connected"
        : value.status === "connecting" || value.status === "cancelling" ? "connecting"
        : value.status === "succeeded" || value.status === "cancelled" ? "ended" : "error");
    };
    const showPicker = (label?: string) => {
      if (disposed || failed || !attached || !active.current || current.status !== "running" || pickerOpen.current) return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"], .dialog-overlay')) return;
      const rect = host.current!.getBoundingClientRect();
      const cursorY = term.buffer.active.cursorY;
      pickerOpen.current = true;
      setPicker({ jobId: current.id, label,
        top: Math.max(8, Math.min(rect.top + (cursorY + 1) * rect.height / Math.max(term.rows, 1), window.innerHeight - 460)),
        left: Math.max(8, Math.min(rect.left + 12, window.innerWidth - 368)),
      });
    };
    detectPrompt.current = () => {
      if (disposed || failed || !attached || !active.current || !outputReady || current.status !== "running" || pickerOpen.current) return;
      const buffer = term.buffer.active;
      if (buffer.type === "alternate") return;
      const row = buffer.baseY + buffer.cursorY;
      const line = buffer.getLine(row)?.translateToString(true) ?? "";
      const key = `${row}:${line}`;
      if (!line.trim() || triggerGuard.isSameAsLast(key)) return;
      for (const rule of rulesRef.current) {
        if (!rule.enabled) continue;
        try {
          if (!new RegExp(rule.pattern).test(line)) continue;
        } catch { continue; }
        showPicker(rule.label);
        if (pickerOpen.current) triggerGuard.markTriggered(key);
        return;
      }
    };
    openPicker.current = () => {
      const buffer = term.buffer.active;
      const row = buffer.baseY + buffer.cursorY;
      showPicker("Password / Vault");
      if (pickerOpen.current) triggerGuard.markTriggered(`${row}:${buffer.getLine(row)?.translateToString(true) ?? ""}`);
    };
    term.onLineFeed(() => triggerGuard.reset());
    const write = (data: string | Uint8Array, outputJobId?: string) => {
      pendingBytes += data.length;
      if (pendingBytes > 4 * 1024 * 1024) {
        fail("Terminal output exceeded the display buffer; cancellation requested.");
        return;
      }
      term.write(data, () => {
        pendingBytes -= data.length;
        if (outputJobId === current.id && data.length) {
          outputReady = true;
          detectPrompt.current();
        }
      });
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
      outputReady = false;
      pickerOpen.current = false;
      setPicker(null);
      triggerGuard.reset();
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
          write(new Uint8Array(event.data), next.id);
        } else if (event.type === "Snapshot") {
          write(event.data.stdout, next.id);
          write(event.data.stderr, next.id);
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
        detectPrompt.current();
        if (!pickerOpen.current) focusTerminal();
      }).catch((reason) => { if (!disconnected) fail(reason); });
      return () => {
        disconnected = true;
        if (current.id === next.id && !isFinished(current)) void cancelExecution(next.id).catch(() => {});
      };
    };
    // Keyboard, one-time passwords and Vault selections share one ordered queue.
    // Parse remote output only; local input never enters history or prompt detection.
    let inputQueue = Promise.resolve();
    let queuedBytes = 0;
    const enqueue = (jobId: string, bytes: number, operation: () => Promise<void>) => {
      if (queuedBytes + bytes > 65536) {
        return Promise.reject(new Error("Terminal input is too large"));
      }
      queuedBytes += bytes;
      const result = inputQueue.then(async () => {
        if (disposed || failed || !attached || !active.current || current.id !== jobId || current.status !== "running") {
          throw new Error("This terminal is no longer ready for input");
        }
        await operation();
      }).finally(() => { queuedBytes -= bytes; });
      inputQueue = result.catch(() => {});
      return result;
    };
    sendInput.current = (jobId, data) => enqueue(jobId, new TextEncoder().encode(data).length,
      () => invoke("execution_terminal_input", { jobId, data }));
    injectVault.current = (jobId, vaultItemId) => enqueue(jobId, 1,
      () => invoke("vault_inject", { jobId, vaultItemId }));
    term.onData((data) => {
      if (failed || !attached || !active.current || pickerOpen.current || current.status !== "running") return;
      const jobId = current.id;
      void sendInput.current(jobId, data).catch((reason) => { if (current.id === jobId) fail(reason); });
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
          if (text && !disposed && !failed && !pickerOpen.current && active.current && current.id === jobId && current.status === "running") term.paste(text);
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
      detectPrompt.current = () => {};
      openPicker.current = () => {};
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
    if (isActive) {
      scheduleLayout.current();
      detectPrompt.current();
      if (!pickerOpen.current) focusTerminal();
    } else {
      pickerOpen.current = false;
      setPicker(null);
    }
  }, [isActive, job.id]);

  return (
    <section className="mcp-terminal" style={{ display: isActive ? "flex" : "none" }} aria-label="MCP terminal">
      <div className="mcp-terminal-header">
        <span className="mcp-terminal-status" role="status">MCP · {summary.status.replace(/_/g, " ")}</span>
        <span>{summary.username}@{summary.host}</span>
        {summary.status === "running" && <button className="mcp-terminal-password" disabled={!!error}
          onClick={() => openPicker.current()}>Password / Vault</button>}
        {!isFinished(summary) && <button className="mcp-terminal-stop" disabled={summary.status === "cancelling"}
          onClick={() => void cancelExecution(job.id).catch((reason) => setError(String(reason)))}>Stop</button>}
      </div>
      <pre className="mcp-terminal-command" title={summary.command}>{summary.command}</pre>
      <p className="mcp-terminal-hint">{summary.output_withheld
        ? "Manual input detected. Subsequent output stays in this terminal and is excluded from AI results and execution history."
        : "Type here or use Password / Vault when prompted. After your first input, subsequent output stays local. Closing this tab requests cancellation."}</p>
      {(error || summary.error) && <p className="mcp-terminal-error" role="alert">{error || summary.error}</p>}
      {summary.remote_outcome_unknown && isFinished(summary) &&
        <p className="mcp-terminal-error">Remote termination is not confirmed. Check the server before retrying.</p>}
      <div className="mcp-terminal-screen" ref={host} />
      {picker && isActive && picker.jobId === job.id && summary.status === "running" && <VaultPromptPicker
        key={picker.jobId}
        serverId={summary.profile_id}
        anchorTop={picker.top} anchorLeft={picker.left} promptLabel={picker.label}
        onInject={(vaultItemId) => injectVault.current(picker.jobId, vaultItemId)}
        onSubmitPassword={(password) => sendInput.current(picker.jobId, `${password}\r`)}
        onClose={closePicker} onInjected={closePicker}
      />}
    </section>
  );
}
