import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke, Channel } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { SshConfig } from "../../types";
import { extractCommand } from "../../utils/promptParser";
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

    // Copy / Paste 단축키. xterm 은 기본 clipboard 연동이 없어서 직접 붙인다.
    //  macOS: ⌘C copy (선택 있을 때만), ⌘V paste
    //  Win/Linux: Ctrl+Shift+C copy, Ctrl+Shift+V paste
    //  Ctrl+C 는 SIGINT 로 남겨둠 (터미널 관례).
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const k = ev.key.toLowerCase();

      const isCopy = isMac
        ? ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && k === "c"
        : ev.ctrlKey && ev.shiftKey && !ev.altKey && k === "c";
      const isPaste = isMac
        ? ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && k === "v"
        : ev.ctrlKey && ev.shiftKey && !ev.altKey && k === "v";
      const isSelectAll = isMac
        ? ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && k === "a"
        : false; // 리눅스/윈도우에서 Ctrl+A 는 bash bind key (line start) — 건드리지 않음

      if (isCopy) {
        const sel = xterm.getSelection();
        // Tauri native clipboard — WKWebView 의 Safari 권한 프롬프트("Paste" 미니 팝업)를 우회.
        if (sel) writeText(sel).catch(() => {});
        ev.preventDefault();
        ev.stopPropagation();
        return false;
      }
      if (isPaste) {
        // preventDefault 안 하면 브라우저 native paste 가 xterm textarea 로 또 들어가서 2회 paste 됨.
        ev.preventDefault();
        ev.stopPropagation();
        readText()
          .then((text) => {
            if (text) xterm.paste(text);
          })
          .catch(() => {});
        return false;
      }
      if (isSelectAll) {
        xterm.selectAll();
        ev.preventDefault();
        ev.stopPropagation();
        return false;
      }
      return true;
    });

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
              const text = line.translateToString(true);
              // Right-most prompt 종결 문자(`$ # > % ❯ →`) 뒤의 명령어만 추출.
              // Amazon Linux 식 `[ec2-user@host ~]$ ls` 처럼 prompt 안에 공백이 있어도
              // 잘리지 않는다. 자세한 정규식 근거는 utils/promptParser.ts 주석 참조.
              let cmd = extractCommand(text) ?? "";
              // prompt regex 가 실패하면 cursor 위치 기반 fallback (PS1 에 prompt 종결 문자가
              // 없는 비표준 환경 대비). 이 경로에서는 prompt 잔여물이 남을 수 있어 보수적으로만 사용.
              if (!cmd && buffer.cursorX > 0) {
                const cursorPos = buffer.cursorX;
                const rawText = line.translateToString(false);
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
