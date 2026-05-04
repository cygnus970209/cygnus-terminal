import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useTheme } from "../../hooks/useTheme";
import { useHighlightSettings } from "../../hooks/useHighlightSettings";
import { transformChunk } from "../../utils/ansiHighlight";
import {
  parseOsc7Path,
  SHELL_INTEGRATION_TIMEOUT_MS,
  type ShellIntegrationStatus,
} from "../../utils/osc7";
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
  /** OSC 7 또는 fallback 으로 cwd 가 갱신될 때 호출 (활성 탭의 FileTree 경로 동기화용). */
  onCwdChanged?: (tabId: string, path: string) => void;
  /** Shell integration 감지 상태 변화 시 호출. */
  onShellIntegrationChange?: (tabId: string, status: ShellIntegrationStatus) => void;
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
  onCwdChanged,
  onShellIntegrationChange,
}: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const shellIntegrationRef = useRef<ShellIntegrationStatus>("unknown");
  const lastCwdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const bufferRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);

  const { theme } = useTheme();
  const { settings: highlightSettings } = useHighlightSettings();

  // closure freshness 회피 — settings 변경 시에도 flushBuffer 는 stable 유지.
  const highlightSettingsRef = useRef(highlightSettings);
  highlightSettingsRef.current = highlightSettings;

  const flushBuffer = useCallback(() => {
    if (bufferRef.current && xtermRef.current) {
      let data = bufferRef.current;
      // alternate buffer (vi/less/top/man) 에서는 자체 화면을 그리므로 손대면 깨짐.
      // primary buffer 의 stream 출력에서만 transform.
      if (xtermRef.current.buffer.active.type !== "alternate") {
        data = transformChunk(data, highlightSettingsRef.current);
      }
      xtermRef.current.write(data);
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
      theme: theme.colors,
      allowProposedApi: true,
    });

    // OSC 7 (shell directory hint) 수신 — 셸이 활성화한 경우 prompt 그릴 때마다 cwd 가 들어온다.
    // race-free 한 cd 추적 채널. 미감지 시 timeout 후 pwd fallback 으로 전환.
    const oscHandler = xterm.parser.registerOscHandler(7, (data) => {
      const path = parseOsc7Path(data);
      if (!path) return false;

      if (shellIntegrationRef.current !== "detected") {
        shellIntegrationRef.current = "detected";
        onShellIntegrationChange?.(tabId, "detected");
      }

      if (path !== lastCwdRef.current) {
        lastCwdRef.current = path;
        onCwdChanged?.(tabId, path);
      }
      return false; // 기본 처리도 계속 (다른 OSC handler 있을 가능성)
    });

    const oscTimeoutId = setTimeout(() => {
      if (shellIntegrationRef.current === "unknown") {
        shellIntegrationRef.current = "timeout";
        onShellIntegrationChange?.(tabId, "timeout");
      }
    }, SHELL_INTEGRATION_TIMEOUT_MS);

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    xterm.loadAddon(fitAddon);
    xterm.loadAddon(webLinksAddon);
    xterm.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // 컨테이너 크기 변화 감지 — 사이드 패널 collapse/expand 시에도 자동으로 xterm grid 재계산.
    // window resize 만 듣는 기존 핸들러는 panel toggle 을 못 잡는다.
    // contentRect.width 가 0 이면 (탭 비활성으로 display:none 등) skip — fit 결과 cols=0 으로 깨짐 방지.
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          requestAnimationFrame(() => fitAddonRef.current?.fit());
        }
      }
    });
    resizeObserver.observe(terminalRef.current);

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

          // Race condition 가드 — 사용자가 이미 다음 명령을 타이핑 중이면 skip.
          // 우리 `pwd\r` 가 PTY stdin 에서 사용자 입력과 합쳐지면
          // `cd ` + `pwd\r` → `cd pwd` 같은 의도치 않은 명령이 실행된다.
          // 다음 cd 감지 시 다시 호출되므로 기능 손실은 없음.
          const buffer = xterm.buffer.active;
          const promptLine = buffer.getLine(buffer.cursorY + buffer.baseY);
          if (promptLine) {
            const userTyped = extractCommand(promptLine.translateToString(true));
            if (userTyped && userTyped.length > 0) return null;
          }

          const cursorBefore = buffer.cursorY + buffer.baseY;
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
      resizeObserver.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      clearTimeout(oscTimeoutId);
      oscHandler.dispose();
      if (sessionIdRef.current) {
        const closeCmd = type === "ssh" ? "close_ssh" : type === "telnet" ? "close_telnet" : type === "serial" ? "close_serial" : "close_pty";
        invoke(closeCmd, { sessionId: sessionIdRef.current });
      }
      xterm.dispose();
    };
    // 마운트 시 1회만 — theme 변경은 아래 별도 effect 로 처리.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 테마 변경 시 xterm 에 즉시 반영
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = theme.colors;
    }
  }, [theme]);

  return (
    <div
      ref={terminalRef}
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: theme.colors.background ?? "#1e1e2e",
        display: isActive ? "block" : "none",
      }}
    />
  );
}
