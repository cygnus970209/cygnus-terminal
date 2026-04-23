import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke, Channel } from "@tauri-apps/api/core";
import { SshConfig } from "../../types";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  tabId: string;
  type: "local" | "ssh" | "telnet" | "serial";
  sshConfig?: SshConfig;
  telnetConfig?: { host: string; port: number };
  serialConfig?: { portName: string; baudRate: number };
  isActive: boolean;
  onSessionCreated?: (tabId: string, sessionId: string) => void;
  onTitleChange?: (tabId: string, title: string) => void;
  onRegisterCapturePath?: (tabId: string, fn: () => Promise<string | null>) => void;
  onRegisterBufferCheck?: (tabId: string, fn: () => boolean) => void;
  onCdDetected?: () => void;
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
  telnetConfig,
  serialConfig,
  isActive,
  onSessionCreated,
  onTitleChange,
  onRegisterCapturePath,
  onRegisterBufferCheck,
  onCdDetected,
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
        blue: "#7aa2f7",
        magenta: "#f5c2e7",
        cyan: "#94e2d5",
        white: "#bac2de",
        brightBlack: "#585b70",
        brightRed: "#f38ba8",
        brightGreen: "#a6e3a1",
        brightYellow: "#f9e2af",
        brightBlue: "#7aa2f7",
        brightMagenta: "#f5c2e7",
        brightCyan: "#94e2d5",
        brightWhite: "#a6adc8",
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
          sessionId = await invoke<string>("create_ssh_session", {
            host: sshConfig.host,
            port: sshConfig.port,
            username: sshConfig.username,
            authType: sshConfig.authType,
            password: sshConfig.password || null,
            keyPath: sshConfig.keyPath || null,
            jumpHost: sshConfig.jumpHost || null,
            agentForward: sshConfig.agentForward || false,
            onEvent,
          });
          onTitleChange?.(tabId, `${sshConfig.username}@${sshConfig.host}`);
        } else if (type === "telnet" && telnetConfig) {
          xterm.write(`Connecting via Telnet to ${telnetConfig.host}:${telnetConfig.port}...\r\n`);
          sessionId = await invoke<string>("create_telnet_session", {
            host: telnetConfig.host,
            port: telnetConfig.port,
            onEvent,
          });
          onTitleChange?.(tabId, `telnet://${telnetConfig.host}`);
        } else if (type === "serial" && serialConfig) {
          xterm.write(`Opening ${serialConfig.portName} at ${serialConfig.baudRate} baud...\r\n`);
          sessionId = await invoke<string>("create_serial_session", {
            portName: serialConfig.portName,
            baudRate: serialConfig.baudRate,
            onEvent,
          });
          onTitleChange?.(tabId, `${serialConfig.portName}`);
        } else {
          sessionId = await invoke<string>("create_pty_session", {
            onEvent,
          });
          onTitleChange?.(tabId, "Local Shell");
        }

        sessionIdRef.current = sessionId;
        onSessionCreated?.(tabId, sessionId);

        // pwd 캡처 함수 등록
        const writeCmd = type === "ssh" ? "write_ssh" : type === "telnet" ? "write_telnet" : type === "serial" ? "write_serial" : "write_pty";
        // alternate screen buffer 감지 (vi, nano, less, top 등)
        const isAlternateBuffer = () => xterm.buffer.active.type === "alternate";
        onRegisterBufferCheck?.(tabId, isAlternateBuffer);

        onRegisterCapturePath?.(tabId, async () => {
          if (!sessionIdRef.current || isAlternateBuffer()) return null;
          const cursorBefore = xterm.buffer.active.cursorY + xterm.buffer.active.baseY;
          await invoke(writeCmd, { sessionId: sessionIdRef.current, data: "pwd\r" });
          await new Promise((r) => setTimeout(r, 500));
          const outputLine = xterm.buffer.active.getLine(cursorBefore + 1);
          if (!outputLine) return null;
          const path = outputLine.translateToString(true).trim();
          return path.startsWith("/") ? path : null;
        });
        const profileId = sshConfig?.profileId;

        xterm.onData((data) => {
          if (!sessionIdRef.current) return;

          // 에디터/페이저 모드에서는 히스토리 캡처 스킵
          if (profileId && !isAlternateBuffer() && (data === "\r" || data === "\n")) {
            const buffer = xterm.buffer.active;
            const cursorLine = buffer.cursorY + buffer.baseY;
            const line = buffer.getLine(cursorLine);
            if (line) {
              const text = line.translateToString(true).trim();
              // 다양한 프롬프트 패턴: $, #, >, %, ❯, →, ), ] 뒤의 텍스트
              const promptMatch = text.match(/[$#>%❯→\])\x1b]*\s+(.+)/)
                || text.match(/[$#>%]\s*(.+)/);
              let cmd = promptMatch ? promptMatch[1].trim() : "";
              // 프롬프트 없이 커서 위치 기반 fallback
              if (!cmd && buffer.cursorX > 0) {
                const cursorPos = buffer.cursorX;
                const rawText = line.translateToString(false);
                // 커서 위치까지의 텍스트에서 마지막 공백 이후 추출 시도
                const beforeCursor = rawText.substring(0, cursorPos).trim();
                if (beforeCursor.length > 0) {
                  cmd = beforeCursor;
                }
              }
              if (cmd && cmd.length > 0 && cmd.length < 1000) {
                invoke("save_command_history", { profileId, command: cmd });
                if (cmd.match(/^cd\s|^cd$/)) {
                  onCdDetected?.();
                }
              }
            }
          }

          invoke(writeCmd, { sessionId: sessionIdRef.current, data });
        });

        // Handle resize
        const resizeCmd = type === "ssh" ? "resize_ssh" : type === "telnet" ? "resize_telnet" : "resize_pty"; // serial은 resize 없음
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
        const closeCmd = type === "ssh" ? "close_ssh" : type === "telnet" ? "close_telnet" : type === "serial" ? "close_serial" : "close_pty";
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
