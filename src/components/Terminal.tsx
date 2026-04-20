import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  sessionId: string | null;
  onSessionCreated?: (id: string) => void;
}

export default function Terminal({ sessionId, onSessionCreated }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(sessionId);
  const bufferRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);

  // 16ms buffered write to xterm — prevents UI freeze on large output
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

    let unlistenOutput: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;

    const initSession = async () => {
      try {
        const id = await invoke<string>("create_pty_session");
        sessionIdRef.current = id;
        onSessionCreated?.(id);

        // Listen for PTY output
        unlistenOutput = await listen<string>(`pty-output-${id}`, (event) => {
          scheduleWrite(event.payload);
        });

        // Listen for PTY exit
        unlistenExit = await listen(`pty-exit-${id}`, () => {
          xterm.write("\r\n\x1b[31m[Session ended]\x1b[0m\r\n");
        });

        // Forward user input to PTY
        xterm.onData((data) => {
          if (sessionIdRef.current) {
            invoke("write_pty", {
              sessionId: sessionIdRef.current,
              data,
            });
          }
        });

        // Handle resize
        xterm.onResize(({ rows, cols }) => {
          if (sessionIdRef.current) {
            invoke("resize_pty", {
              sessionId: sessionIdRef.current,
              rows,
              cols,
            });
          }
        });

        // Initial resize to fit container
        fitAddon.fit();
      } catch (err) {
        xterm.write(`\x1b[31mFailed to create session: ${err}\x1b[0m\r\n`);
      }
    };

    initSession();

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      unlistenOutput?.();
      unlistenExit?.();
      if (sessionIdRef.current) {
        invoke("close_pty", { sessionId: sessionIdRef.current });
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
      }}
    />
  );
}
