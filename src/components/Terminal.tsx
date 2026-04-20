import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke, Channel } from "@tauri-apps/api/core";
import { SshConfig } from "./ConnectDialog";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  tabId: string;
  type: "local" | "ssh";
  sshConfig?: SshConfig;
  isActive: boolean;
  onSessionCreated?: (tabId: string, sessionId: string) => void;
  onTitleChange?: (tabId: string, title: string) => void;
}

interface PtyEventOutput {
  type: "Output";
  data: string;
}

interface PtyEventExit {
  type: "Exit";
  data: null;
}

type PtyEvent = PtyEventOutput | PtyEventExit;

export default function Terminal({
  tabId,
  type,
  sshConfig,
  isActive,
  onSessionCreated,
  onTitleChange,
}: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const bufferRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);

  const flushBuffer = useCallback(() => {
    if (bufferRef.current && xtermRef.current) {
      xtermRef.current.write(bufferRef.current);
      bufferRef.current = "";
    }
    rafRef.current = null;
  }, []);

  const scheduleWrite = useCallback(
    (data: string) => {
      bufferRef.current += data;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushBuffer);
      }
    },
    [flushBuffer]
  );

  useEffect(() => {
    if (isActive && fitAddonRef.current) {
      setTimeout(() => fitAddonRef.current?.fit(), 10);
    }
  }, [isActive]);

  useEffect(() => {
    if (!terminalRef.current) return;

    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        selectionBackground: "#585b70",
        black: "#45475a",
        red: "#f38ba8",
        green: "#a6e3a1",
        yellow: "#f9e2af",
        blue: "#89b4fa",
        magenta: "#f5c2e7",
        cyan: "#94e2d5",
        white: "#bac2de",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    xterm.loadAddon(fitAddon);
    xterm.loadAddon(webLinksAddon);
    xterm.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    const initSession = async () => {
      try {
        const onEvent = new Channel<PtyEvent>();
        onEvent.onmessage = (event) => {
          if (event.type === "Output") {
            scheduleWrite(event.data);
          } else if (event.type === "Exit") {
            xterm.write("\r\n\x1b[31m[Session ended]\x1b[0m\r\n");
          }
        };

        let sessionId: string;

        if (type === "ssh" && sshConfig) {
          xterm.write(`Connecting to ${sshConfig.host}:${sshConfig.port}...\r\n`);
          // SSH still uses event-based approach for now
          sessionId = await invoke<string>("create_ssh_session", {
            host: sshConfig.host,
            port: sshConfig.port,
            username: sshConfig.username,
            authType: sshConfig.authType,
            password: sshConfig.password || null,
            keyPath: sshConfig.keyPath || null,
          });
          onTitleChange?.(tabId, `${sshConfig.username}@${sshConfig.host}`);
        } else {
          sessionId = await invoke<string>("create_pty_session", {
            onEvent,
          });
          onTitleChange?.(tabId, "Local Shell");
        }

        sessionIdRef.current = sessionId;
        onSessionCreated?.(tabId, sessionId);

        // Forward user input to PTY/SSH
        const writeCmd = type === "ssh" ? "write_ssh" : "write_pty";
        xterm.onData((data) => {
          if (sessionIdRef.current) {
            invoke(writeCmd, { sessionId: sessionIdRef.current, data });
          }
        });

        // Handle resize
        const resizeCmd = type === "ssh" ? "resize_ssh" : "resize_pty";
        xterm.onResize(({ rows, cols }) => {
          if (sessionIdRef.current) {
            invoke(resizeCmd, { sessionId: sessionIdRef.current, rows, cols });
          }
        });

        fitAddon.fit();
      } catch (err) {
        xterm.write(`\x1b[31mError: ${err}\x1b[0m\r\n`);
      }
    };

    initSession();

    const handleResize = () => {
      if (isActive) fitAddon.fit();
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (sessionIdRef.current) {
        const closeCmd = type === "ssh" ? "close_ssh" : "close_pty";
        invoke(closeCmd, { sessionId: sessionIdRef.current });
      }
      xterm.dispose();
    };
  }, []);

  return (
    <div
      ref={terminalRef}
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#1e1e2e",
        display: isActive ? "block" : "none",
      }}
    />
  );
}
