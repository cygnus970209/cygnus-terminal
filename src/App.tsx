import { useState, useCallback, useRef, useEffect } from "react";
import { invoke, keychainNotice } from "./services/secureInvoke";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  Profile,
  SshConfig,
  Tab,
  type SessionStatus,
  type ConnectionProtocol,
} from "./types";
import TransferDock from "./components/sftp/TransferDock";
import { TransferJob } from "./types/sftp";
import TabBar from "./components/common/TabBar";
import Icon from "./components/common/Icon";
import ResizablePanel from "./components/common/ResizablePanel";
import SettingsDialog from "./components/common/SettingsDialog";
import Terminal from "./components/terminal/Terminal";
import McpTerminal from "./components/terminal/McpTerminal";
import type { ExecutionSummary } from "./types/execution";
import LogViewer from "./components/terminal/LogViewer";
import MonitorPanel from "./components/terminal/MonitorPanel";
import IisPanel from "./components/terminal/IisPanel";
import RdpSession from "./components/rdp/RdpSession";
import StatusBar, { DrawerTab } from "./components/common/StatusBar";
import { useServerStats } from "./hooks/useServerStats";
import { useServerEnvironment } from "./hooks/useServerEnvironment";
import {
  capabilityReason,
  environmentDetails,
  environmentLabel,
} from "./types/serverEnvironment";
import { useInvokeState } from "./hooks/useInvokeState";
import { useTauriListener } from "./hooks/useTauriListener";
import { useTransferChannel } from "./hooks/useTransferChannel";
import { type ShellIntegrationStatus } from "./utils/osc7";
import { normalizeTerminalInput } from "./utils/terminalInput";
import {
  activeTabAfterClose,
  moveTab,
  tabsToClose,
  toggleTabPin,
  type TabCloseAction,
  type TabDropSide,
} from "./utils/tabs";
import CommandPalette, {
  PaletteItem,
} from "./components/common/CommandPalette";
import UpdateBanner from "./components/common/UpdateBanner";
import HostKeyPrompt, {
  HostKeyPromptPayload,
} from "./components/common/HostKeyPrompt";
import { message } from "@tauri-apps/plugin-dialog";
import ConnectionsView from "./components/connection/ConnectionsView";
import ConnectDialog from "./components/connection/ConnectDialog";
import TransportConnectDialog from "./components/connection/TransportConnectDialog";
import ServerContext from "./components/connection/ServerContext";
import FileTree from "./components/files/FileTree";
import SnippetsView from "./components/snippets/SnippetsView";
import VaultView from "./components/vault/VaultView";
import SftpView from "./components/sftp/SftpView";
import "./App.css";

let tabCounter = 1;

function App() {
  const [tabs, setTabs] = useState<(Tab & { sshConfig?: SshConfig })[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>("connections");
  const mcpSlots = useRef(new Map<string, ExecutionSummary>());
  useEffect(() => {
    let disposed = false;
    const open = (job: ExecutionSummary) => {
      if (disposed) return;
      if ([...mcpSlots.current.values()].some((value) => value.id === job.id)) return;
      const reusable = [...mcpSlots.current.entries()].find(([, previous]) =>
        previous.profile_id === job.profile_id && !["connecting", "running", "cancelling"].includes(previous.status));
      const id = reusable?.[0] ?? `mcp-${job.id}`;
      mcpSlots.current.set(id, job);
      setTabs((previous) => {
        if (previous.some((tab) => tab.id === id)) {
          return previous.map((tab) => tab.id === id ? { ...tab, execution: job } : tab);
        }
        return [...previous, { id, type: "mcp", title: `MCP · ${job.profile_name}`, profileId: job.profile_id, execution: job }];
      });
      // New automation must never redirect keystrokes (especially a password)
      // away from the terminal the human is currently using.
      setActiveTabId((current) => !current || current === "connections" ? id : current);
    };
    // Subscribe before querying pending jobs so an event during app startup is never lost.
    const subscription = listen<ExecutionSummary>("mcp-execution-created", (event) => open(event.payload));
    void subscription.then(async () => {
      const jobs = await invoke<ExecutionSummary[]>("execution_terminal_list");
      jobs.forEach(open);
    }).catch(console.error);
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  const handleMcpJobStatus = useCallback((id: string, job: ExecutionSummary) => {
    if (mcpSlots.current.get(id)?.id === job.id) mcpSlots.current.set(id, job);
  }, []);
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [editProfile, setEditProfile] = useState<Profile | null>(null);
  const [sessionMap, setSessionMap] = useState<Record<string, string>>({});
  const [sftpSessions, setSftpSessions] = useState<
    Record<string, { sftpId: string; homePath: string }>
  >({});
  const [profileReloadKey, setProfileReloadKey] = useState(0);
  const capturePathFns = useRef<Record<string, () => Promise<string | null>>>(
    {},
  );
  const bufferCheckFns = useRef<Record<string, () => boolean>>({});

  const [cdTrackingEnabled, setCdTrackingEnabled] = useState(true);
  const [cwdByTab, setCwdByTab] = useState<Record<string, string>>({});
  // 탭별 shell integration 상태 (OSC 7 감지 여부). FileTree 자동 추적 상태 표시에 사용.
  const [shellIntegrationByTab, setShellIntegrationByTab] = useState<
    Record<string, ShellIntegrationStatus>
  >({});
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);
  const [knownProfiles, setKnownProfiles] = useState<Profile[]>([]);
  const [sessionStatuses, setSessionStatuses] = useState<
    Record<string, SessionStatus>
  >({});
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [showVault, setShowVault] = useState(false);
  const [connectionProtocol, setConnectionProtocol] =
    useState<ConnectionProtocol>("ssh");
  // SSH host key 확인 큐. 연속 연결 시 여러 개가 쌓일 수 있어 FIFO 로 하나씩 처리.
  const [hostKeyPrompts, setHostKeyPrompts] = useState<HostKeyPromptPayload[]>(
    [],
  );
  const { data: paletteSnippets, reload: reloadPaletteSnippets } =
    useInvokeState<
      { id: number; title: string; command: string; category: string }[]
    >("list_snippets", []);

  // 글로벌 단축키: Cmd/Ctrl+K 로 Command Palette 토글.
  // capturing phase 로 등록 — xterm textarea 같은 자식이 stopPropagation 해도 가로채인다.
  // e.code 사용 — 한영 IME 상태와 무관하게 물리 K 키를 잡는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keychainNotice.getSnapshot()) return;
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
        e.preventDefault();
        e.stopPropagation();
        setShowPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Palette 열릴 때마다 최신 snippets 로드
  useEffect(() => {
    if (!showPalette) return;
    reloadPaletteSnippets({ query: null });
  }, [showPalette, reloadPaletteSnippets]);

  // macOS 메뉴 "Preferences" + View 서브메뉴 이벤트 수신
  useTauriListener("open-settings", () => setShowSettings(true));
  useTauriListener("toggle-server-ctx", () => {
    setContextOpen(true);
    setLeftCollapsed((value) => !value);
  });
  useTauriListener("toggle-file-tree", () =>
    setRightCollapsed((value) => !value),
  );
  useTauriListener<string>("toggle-drawer", (e) => {
    const tab = e.payload as DrawerTab;
    if (
      (tab === "monitor" && !monitorAvailable) ||
      (tab === "logs" && !logsAvailable) ||
      (tab === "iis" && !iisAvailable)
    ) return;
    setDrawerTab((cur) => (cur === tab ? null : tab));
  });

  // SSH host key 이벤트 구독:
  //  - ssh-host-key-prompt: 처음 보는 호스트. 확인 다이얼로그로 사용자 승인 필요.
  //  - ssh-host-key-rejected: 변경/DB 에러/사용자 거절로 인해 연결이 차단됨.
  useTauriListener<HostKeyPromptPayload>("ssh-host-key-prompt", (e) => {
    setHostKeyPrompts((prev) => [...prev, e.payload]);
  });
  useTauriListener<{
    host: string;
    port: number;
    reason: string;
    stored_type?: string;
    new_type?: string;
    new_fingerprint?: string;
    detail?: string;
  }>("ssh-host-key-rejected", (e) => {
    const p = e.payload;
    if (p.reason === "changed") {
      message(
        `⚠️ Host key CHANGED for ${p.host}:${p.port}\n\n` +
          `Previously trusted: ${p.stored_type}\n` +
          `Now presenting:     ${p.new_type}\n` +
          `New fingerprint:    ${p.new_fingerprint}\n\n` +
          `This may indicate a man-in-the-middle attack. The connection was refused.\n\n` +
          `If you know the server key was rotated legitimately, remove the old entry from the known hosts DB and reconnect.`,
        { title: "SSH Host Key Changed", kind: "error" },
      ).catch(() => {});
    } else if (p.reason === "db_error") {
      message(
        `Could not verify host key for ${p.host}:${p.port} (${p.detail}). Connection refused.`,
        { title: "SSH Verification Failed", kind: "error" },
      ).catch(() => {});
    }
    // user_rejected_or_timeout 은 사용자 의도이므로 별도 알림 없음.
  });

  // 현재 활성 탭이 SSH 세션이면 stats 폴링 활성화
  const currentTabForStats = tabs.find((t) => t.id === activeTabId);
  const currentSshSessionId =
    currentTabForStats?.type === "ssh" &&
    activeTabId &&
    sessionStatuses[activeTabId] === "connected"
      ? sessionMap[activeTabId]
      : null;
  const sshActive = !!currentSshSessionId;
  const { environment, error: environmentError } = useServerEnvironment(currentSshSessionId);
  const monitorAvailable = sshActive && !!environment?.capabilities.monitor;
  const logsAvailable = sshActive && !!(environment?.capabilities.file_logs || environment?.capabilities.journal);
  const showIis = environment?.os === "windows";
  const iisAvailable = sshActive && showIis && !!environment?.powershell;
  const unavailableReason = capabilityReason(environment, environmentError, sshActive);
  const { stats: serverStats, error: statsError } = useServerStats(currentSshSessionId, monitorAvailable);
  const visibleDrawer =
    (drawerTab === "monitor" && !monitorAvailable) ||
    (drawerTab === "logs" && !logsAvailable) ||
    (drawerTab === "iis" && !iisAvailable)
      ? null
      : drawerTab;

  // 전역 Transfer state. FileTree 의 다운로드/업로드가 TransferManager 큐를 타게 하고
  // 진행률·속도·ETA 를 하단 Dock 에서 공유한다. SFTP popout 윈도우는 별도 인스턴스라
  // 자기 Channel 을 쓰고, 여기는 메인 윈도우 전용.
  // 업로드/다운로드 완료 시 FileTree 가 현재 디렉토리를 리로드하도록 증가시키는 카운터.
  const [fileTreeRefreshKey, setFileTreeRefreshKey] = useState(0);
  const { transferJobs, setTransferJobs, transferChannel } = useTransferChannel(
    {
      onCompleted: () => setFileTreeRefreshKey((k) => k + 1),
    },
  );

  // Channel 유실(HMR reload 등) 복구용 polling
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const jobs = await invoke<TransferJob[]>("sftp_transfer_list");
        setTransferJobs(jobs);
      } catch {
        // ignore
      }
    }, 2000);
    return () => clearInterval(iv);
  }, []);

  const handleCancelTransfer = useCallback(async (jobId: string) => {
    try {
      await invoke("sftp_transfer_cancel", { jobId });
    } catch (err) {
      console.error("Cancel failed:", err);
    }
  }, []);

  const handleClearCompletedTransfers = useCallback(async () => {
    try {
      await invoke("sftp_transfer_clear_completed");
      setTransferJobs((prev) =>
        prev.filter(
          (j) =>
            j.status !== "completed" &&
            j.status !== "failed" &&
            j.status !== "cancelled",
        ),
      );
    } catch (err) {
      console.error("Clear failed:", err);
    }
  }, []);

  // popout SFTP 윈도우에 공유할 세션 리스트.
  const broadcastSftpSessions = useCallback(() => {
    const list = tabs
      .filter(
        (t) =>
          t.type === "ssh" &&
          sessionMap[t.id] &&
          sftpSessions[sessionMap[t.id]],
      )
      .map((t) => ({
        id: sessionMap[t.id],
        sftpId: sftpSessions[sessionMap[t.id]].sftpId,
        label: t.title,
        homePath: sftpSessions[sessionMap[t.id]].homePath,
      }));
    emit("sftp-sessions", list);
  }, [tabs, sessionMap, sftpSessions]);

  // tabs/sessionMap/sftpSessions 변경 시마다 브로드캐스트.
  useEffect(() => {
    broadcastSftpSessions();
  }, [broadcastSftpSessions]);

  // popout이 뒤늦게 뜰 때 최신 스냅샷을 요청하면 재발송.
  useTauriListener("sftp-sessions-request", broadcastSftpSessions);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeProfileId =
    activeTab?.profileId ?? activeTab?.sshConfig?.profileId ?? null;
  const activeProfile = knownProfiles.find(
    (profile) => profile.id === activeProfileId,
  );
  const displayTabs = tabs.map((tab) => ({
    ...tab,
    title: tab.type === "mcp" ? tab.title :
      knownProfiles.find(
        (profile) => profile.id === (tab.profileId ?? tab.sshConfig?.profileId),
      )?.name ?? tab.title,
  }));
  const activeTitle = activeTab?.type === "mcp" ? activeTab.title : activeProfile?.name ?? activeTab?.title ?? "Connections";
  const activeStatus = activeTabId
    ? (sessionStatuses[activeTabId] ?? "connecting")
    : "ended";
  const canShowContext = !!activeProfileId && sshActive;
  const showingContext = contextOpen && canShowContext;

  const createLocalTab = useCallback(() => {
    const id = `tab-${++tabCounter}`;
    const newTab: Tab = { id, title: "Local Shell", type: "local" };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
  }, []);

  const createRdpTab = useCallback(() => {
    const id = `tab-${++tabCounter}`;
    setTabs((previous) => [...previous, { id, title: "Remote desktop", type: "rdp" }]);
    setActiveTabId(id);
  }, []);

  const createSshTab = useCallback((config: SshConfig) => {
    const id = `tab-${++tabCounter}`;
    const newTab = {
      id,
      title: `${config.username}@${config.host}`,
      type: "ssh" as const,
      sshConfig: config,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
    setShowConnectDialog(false);
    setEditProfile(null);
  }, []);

  const createTelnetTab = useCallback(
    (host: string, port: number, profileId?: number) => {
      const id = `tab-${++tabCounter}`;
      const newTab = {
        id,
        title: `telnet://${host}:${port}`,
        type: "telnet" as const,
        telnetConfig: { host, port },
        profileId,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(id);
      setShowConnectDialog(false);
    },
    [],
  );

  const handleSerialConnect = useCallback(
    (portName: string, baudRate: number, profileId?: number) => {
      const id = `tab-${++tabCounter}`;
      setTabs((prev) => [
        ...prev,
        {
          id,
          title: portName,
          type: "serial" as const,
          serialConfig: { portName, baudRate },
          profileId,
        } as Tab & { sshConfig?: SshConfig },
      ]);
      setActiveTabId(id);
      setShowConnectDialog(false);
    },
    [],
  );

  /** SFTP popout 열기. sshTabId 가 있으면 해당 세션으로, 없으면 빈 popout (내부에서 프로필 선택) */
  const openSftpPopout = useCallback(
    async (sshTabId?: string | null, sshTabTitle?: string) => {
      let label = "sftp-blank";
      let params = new URLSearchParams({
        view: "sftp",
        label: sshTabTitle || "SFTP",
      });

      if (sshTabId) {
        const sshSessionId = sessionMap[sshTabId];
        if (sshSessionId) {
          let current = sftpSessions[sshSessionId];
          if (!current) {
            try {
              const sftpId = await invoke<string>("sftp_open", {
                sessionId: sshSessionId,
              });
              const homePath = await invoke<string>("sftp_get_home_dir", {
                sftpId,
              });
              current = { sftpId, homePath };
              setSftpSessions((prev) => ({
                ...prev,
                [sshSessionId]: current!,
              }));
            } catch (err) {
              console.error("Failed to open SFTP:", err);
              return;
            }
          }
          label = `sftp-${sshSessionId}`;
          params = new URLSearchParams({
            view: "sftp",
            sftpId: current.sftpId,
            homePath: current.homePath,
            sshSessionId,
            label: sshTabTitle || "SFTP",
          });
        }
      }

      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        try {
          await existing.show();
          await existing.setFocus();
        } catch (err) {
          console.error("Failed to focus popout:", err);
        }
        return;
      }

      try {
        new WebviewWindow(label, {
          url: `/?${params.toString()}`,
          title: sshTabId ? `SFTP — ${sshTabTitle}` : "SFTP",
          width: 1200,
          height: 800,
          minWidth: 800,
          minHeight: 500,
        });
      } catch (err) {
        console.error("Failed to create popout:", err);
      }
    },
    [sessionMap, sftpSessions],
  );

  /** LogViewer popout 열기. 활성 SSH 세션 기준으로 윈도우 생성 (기존 있으면 focus). */
  const openLogPopout = useCallback(async () => {
    if (!activeTabId) return;
    const sshSessionId = sessionMap[activeTabId];
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!sshSessionId || !tab) return;

    const label = `log-${sshSessionId}`;
    const params = new URLSearchParams({
      view: "log",
      sshSessionId,
      label: tab.title,
    });

    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      try {
        await existing.show();
        await existing.setFocus();
      } catch (err) {
        console.error("Failed to focus log popout:", err);
      }
      return;
    }

    try {
      new WebviewWindow(label, {
        url: `/?${params.toString()}`,
        title: `Logs — ${tab.title}`,
        width: 900,
        height: 600,
        minWidth: 600,
        minHeight: 300,
      });
    } catch (err) {
      console.error("Failed to create log popout:", err);
    }
  }, [activeTabId, sessionMap, tabs]);

  const closeTabs = useCallback((id: string, action: TabCloseAction) => {
    const closing = tabsToClose(tabs, id, action);
    if (!closing.size) return;
    setTabs((prev) => prev.filter((tab) => !closing.has(tab.id)));
    setActiveTabId((current) => activeTabAfterClose(tabs, current, closing));

    // Terminal owns transport cleanup on unmount. Keep side effects outside state updaters.
    const closedSessions = new Set<string>();
    for (const tab of tabs) {
      if (!closing.has(tab.id)) continue;
      mcpSlots.current.delete(tab.id);
      const sessionId = sessionMap[tab.id];
      if (sessionId) {
        closedSessions.add(sessionId);
        const sftp = sftpSessions[sessionId];
        if (sftp) void invoke("sftp_close", { sftpId: sftp.sftpId }).catch(console.error);
      }
      delete capturePathFns.current[tab.id];
      delete bufferCheckFns.current[tab.id];
    }
    const omitClosed = <T,>(values: Record<string, T>) =>
      Object.fromEntries(Object.entries(values).filter(([key]) => !closing.has(key)));
    setSessionMap(omitClosed);
    setSessionStatuses(omitClosed);
    setCwdByTab(omitClosed);
    setShellIntegrationByTab(omitClosed);
    setSftpSessions((prev) => Object.fromEntries(
      Object.entries(prev).filter(([key]) => !closedSessions.has(key)),
    ));
  }, [tabs, sessionMap, sftpSessions]);

  const togglePin = useCallback((id: string) => {
    setTabs((prev) => toggleTabPin(prev, id));
  }, []);
  const reorderTab = useCallback((id: string, targetId: string, side: TabDropSide) => {
    setTabs((prev) => moveTab(prev, id, targetId, side));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F10" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      if (!activeTab || showConnectDialog || showSettings || showPalette || showSnippets || showVault ||
        hostKeyPrompts.length || keychainNotice.getSnapshot() ||
        document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      // Capture before xterm: F10 must not also be sent to the remote shell.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) togglePin(activeTab.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeTab, showConnectDialog, showSettings, showPalette, showSnippets, showVault, hostKeyPrompts.length, togglePin]);

  const handleTitleChange = useCallback((tabId: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title } : t)));
  }, []);

  const handleSessionStatus = useCallback(
    (tabId: string, status: SessionStatus) => {
      setSessionStatuses((prev) => ({ ...prev, [tabId]: status }));
    },
    [],
  );

  const handleSessionCreated = useCallback(
    (tabId: string, sessionId: string) => {
      setSessionMap((prev) => ({ ...prev, [tabId]: sessionId }));
    },
    [],
  );

  const handleRegisterCapturePath = useCallback(
    (tabId: string, fn: () => Promise<string | null>) => {
      capturePathFns.current[tabId] = fn;
    },
    [],
  );

  const handleRegisterBufferCheck = useCallback(
    (tabId: string, fn: () => boolean) => {
      bufferCheckFns.current[tabId] = fn;
    },
    [],
  );

  const handleCaptureCurrentPath = useCallback(async (): Promise<
    string | null
  > => {
    if (!activeTabId) return null;
    const fn = capturePathFns.current[activeTabId];
    return fn ? fn() : null;
  }, [activeTabId]);

  const handleConnectProfile = useCallback(
    async (profile: Profile) => {
      try {
        const fullProfile = await invoke<Profile>("get_profile", {
          id: profile.id,
        });
        if (fullProfile.protocol === "telnet") {
          createTelnetTab(fullProfile.host, fullProfile.port, fullProfile.id);
          return;
        }
        if (fullProfile.protocol === "serial") {
          handleSerialConnect(
            fullProfile.host,
            fullProfile.baud_rate ?? 115200,
            fullProfile.id,
          );
          return;
        }
        createSshTab({
          host: fullProfile.host,
          port: fullProfile.port,
          username: fullProfile.username,
          authType: fullProfile.auth_type,
          password: fullProfile.password ?? undefined,
          keyPath: fullProfile.key_path ?? undefined,
          profileId: fullProfile.id,
          jumpHost: fullProfile.jump_host
            ? JSON.parse(fullProfile.jump_host)
            : undefined,
          agentForward: fullProfile.agent_forward || false,
          targetOs: fullProfile.target_os ?? "auto",
          remoteShell: fullProfile.remote_shell ?? "auto",
        });
      } catch (err) {
        console.error("Failed to load profile:", err);
      }
    },
    [createSshTab, createTelnetTab, handleSerialConnect],
  );

  const handleEditProfile = useCallback(async (profile: Profile) => {
    try {
      // The startup list intentionally omits encrypted jump-host details.
      // Load them only when the user explicitly opens this connection for editing.
      const fullProfile = await invoke<Profile>("get_profile", { id: profile.id });
      if (fullProfile.jump_host) {
        const jump = JSON.parse(fullProfile.jump_host);
        delete jump.password;
        fullProfile.jump_host = JSON.stringify(jump);
      }
      setEditProfile({ ...fullProfile, password: undefined });
      setConnectionProtocol(fullProfile.protocol ?? "ssh");
      setShowConnectDialog(true);
    } catch (err) {
      alert(`Could not open connection settings: ${String(err)}`);
    }
  }, []);

  const handleNewProfile = useCallback(() => {
    setEditProfile(null);
    setConnectionProtocol("ssh");
    setShowConnectDialog(true);
  }, []);

  const handleProfileSaved = useCallback(() => {
    setProfileReloadKey((k) => k + 1);
  }, []);

  const handleCwdChanged = useCallback((tabId: string, path: string) => {
    setCwdByTab((previous) => previous[tabId] === path ? previous : { ...previous, [tabId]: path });
  }, []);

  const handleShellIntegrationChange = useCallback(
    (tabId: string, status: ShellIntegrationStatus) => {
      setShellIntegrationByTab((prev) => ({ ...prev, [tabId]: status }));
    },
    [],
  );

  const handleExecuteCommand = useCallback(
    (command: string) => {
      if (!activeTabId) return;
      // 에디터/페이저 모드에서는 커맨드 실행 차단
      const checkFn = bufferCheckFns.current[activeTabId];
      if (checkFn && checkFn()) return;

      const sessionId = sessionMap[activeTabId];
      if (!sessionId) return;
      const tab = tabs.find((t) => t.id === activeTabId);
      if (!tab) return;

      const writeCmd = tab.type === "ssh" ? "write_ssh" : "write_pty";
      invoke(writeCmd, { sessionId, data: normalizeTerminalInput(command) + "\r" });
    },
    [activeTabId, sessionMap, tabs],
  );

  // Command Palette 에 노출할 항목 — actions / tabs / snippets 를 하나의 검색 가능한 리스트로
  const paletteItems: PaletteItem[] = [
    {
      id: "action:new-ssh",
      kind: "action",
      title: "New SSH connection",
      hint: "⌘N",
      onSelect: handleNewProfile,
    },
    {
      id: "action:new-local",
      kind: "action",
      title: "New Local shell",
      onSelect: createLocalTab,
    },
    {
      id: "action:new-rdp",
      kind: "action",
      title: "New RDP desktop (Preview)",
      onSelect: createRdpTab,
    },
    {
      id: "action:connections",
      kind: "action",
      title: "Open Connections",
      onSelect: () => setActiveTabId("connections"),
    },
    {
      id: "action:manage-snippets",
      kind: "action",
      title: "Manage Snippets...",
      onSelect: () => setShowSnippets(true),
    },
    {
      id: "action:manage-vault",
      kind: "action",
      title: "Manage Vault...",
      onSelect: () => setShowVault(true),
    },
    {
      id: "action:open-settings",
      kind: "action",
      title: "Open Settings",
      hint: "⌘,",
      onSelect: () => setShowSettings(true),
    },
    ...tabs.map<PaletteItem>((t) => ({
      id: `tab:${t.id}`,
      kind: "tab",
      title: `Switch to: ${t.title}`,
      hint: t.type,
      onSelect: () => setActiveTabId(t.id),
    })),
    ...paletteSnippets.map<PaletteItem>((s) => ({
      id: `snippet:${s.id}`,
      kind: "snippet",
      title: s.title,
      subtitle: s.command,
      hint: s.category || undefined,
      onSelect: () => handleExecuteCommand(s.command),
    })),
  ];

  return (
    <div className="app">
      <UpdateBanner />
      <div className="app-body">
        <ResizablePanel
          side="left"
          defaultWidth={240}
          minWidth={200}
          maxWidth={340}
          collapsed={leftCollapsed || activeTabId === "connections"}
          keepMounted
        >
          <aside
            className="connections-sidebar"
            aria-label="Connections sidebar"
          >
            <div className="sidebar-brand">
              <Icon name="terminal" size={19} />
              <button onClick={() => setActiveTabId("connections")}>
                Cygnus <span>Terminal</span>
              </button>
            </div>
            {canShowContext && (
              <nav className="sidebar-section-switch" aria-label="Sidebar view">
                <button
                  aria-pressed={!contextOpen}
                  onClick={() => setContextOpen(false)}
                >
                  <Icon name="server" size={14} /> Connections
                </button>
                <button
                  aria-pressed={contextOpen}
                  onClick={() => setContextOpen(true)}
                >
                  <Icon name="terminal" size={14} /> Server tools
                </button>
              </nav>
            )}
            {showingContext ? (
              <section
                className="sidebar-server-tools"
                aria-label="Server tools"
              >
                <div className="sidebar-server-name" title={activeTitle}>
                  {activeTitle}
                </div>
                <ServerContext
                  key={activeProfileId}
                  profileId={activeProfileId!}
                  sessionId={sessionMap[activeTabId!]}
                  onExecuteCommand={handleExecuteCommand}
                  onCaptureCurrentPath={
                    shellIntegrationByTab[activeTabId!] === "detected"
                      ? handleCaptureCurrentPath
                      : undefined
                  }
                />
              </section>
            ) : (
              <ConnectionsView
                onConnect={handleConnectProfile}
                onEdit={handleEditProfile}
                onNew={handleNewProfile}
                reloadKey={profileReloadKey}
                activeProfileId={activeProfileId}
                onProfilesLoaded={setKnownProfiles}
                connectedProfileIds={tabs
                  .filter(
                    (tab) =>
                      sessionStatuses[tab.id] === "connected" &&
                      (tab.profileId ?? tab.sshConfig?.profileId),
                  )
                  .map((tab) => (tab.profileId ?? tab.sshConfig?.profileId)!)}
              />
            )}
            <nav className="sidebar-tools" aria-label="Workspace tools">
              <button onClick={() => setActiveTabId("connections")}>
                <Icon name="server" />
                Connections<span>All servers</span>
              </button>
              <button
                onClick={() =>
                  openSftpPopout(
                    activeTab?.type === "ssh" ? activeTabId! : undefined,
                    activeTitle,
                  )
                }
              >
                <Icon name="transfer" />
                SFTP<span>Open window</span>
              </button>
              <button onClick={() => setShowSnippets(true)}>
                <Icon name="snippets" />
                Snippets
              </button>
              <button onClick={() => setShowVault(true)}>
                <Icon name="vault" />
                Vault
              </button>
              <button onClick={() => setShowSettings(true)}>
                <Icon name="settings" />
                Settings
              </button>
            </nav>
          </aside>
        </ResizablePanel>
        <main className="workspace">
          <TabBar
            tabs={displayTabs}
            activeTabId={activeTabId}
            statuses={sessionStatuses}
            onSelectTab={setActiveTabId}
            onCloseTabs={closeTabs}
            onTogglePin={togglePin}
            onMoveTab={reorderTab}
            onNewLocalTab={createLocalTab}
            onNewRdpTab={createRdpTab}
            onNewSshTab={handleNewProfile}
            onNewSerialTab={() => {
              setEditProfile(null);
              setConnectionProtocol("serial");
              setShowConnectDialog(true);
            }}
            onNewTelnetTab={() => {
              setEditProfile(null);
              setConnectionProtocol("telnet");
              setShowConnectDialog(true);
            }}
            onToggleSidebar={() => setLeftCollapsed((v) => !v)}
            sidebarCollapsed={leftCollapsed}
          />
          {activeTabId !== "connections" && (
            <header className="session-header">
              <div className="session-heading">
                <span
                  className={`session-dot session-dot-${activeStatus}`}
                  title={activeStatus}
                />
                <h1 title={activeTitle}>{activeTitle}</h1>
                {sshActive && (
                  <span
                    className="session-group"
                    title={environment ? environmentDetails(environment) : unavailableReason}
                  >
                    {environment
                      ? environmentLabel(environment)
                      : environmentError
                        ? "Unknown environment"
                        : "Checking environment…"}
                  </span>
                )}
                {activeProfile?.group_name && (
                  <span
                    className="session-group"
                    title={activeProfile.group_name}
                  >
                    {activeProfile.group_name}
                  </span>
                )}
                <span
                  className="session-address"
                  title={
                    activeTab?.sshConfig
                      ? `${activeTab.sshConfig.username}@${activeTab.sshConfig.host}:${activeTab.sshConfig.port}`
                      : undefined
                  }
                >
                  {activeTab?.sshConfig
                    ? `${activeTab.sshConfig.username}@${activeTab.sshConfig.host}`
                    : ""}
                </span>
              </div>
              <div className="session-tools">
                {activeTab?.type === "ssh" && (
                  <>
                    <button
                      disabled={!sshActive}
                      className={!rightCollapsed ? "is-active" : ""}
                      aria-pressed={!rightCollapsed && sshActive}
                      onClick={() => setRightCollapsed((value) => !value)}
                      title="Browse remote files via SFTP"
                    >
                      <Icon name="folder" />
                      <span>SFTP Files</span>
                    </button>
                    <button
                      disabled={!canShowContext}
                      className={
                        showingContext && !leftCollapsed ? "is-active" : ""
                      }
                      aria-pressed={showingContext && !leftCollapsed}
                      onClick={() => {
                        if (showingContext && !leftCollapsed)
                          setLeftCollapsed(true);
                        else {
                          setContextOpen(true);
                          setLeftCollapsed(false);
                        }
                      }}
                      title={
                        canShowContext
                          ? "History, commands, paths and ports"
                          : "Server tools require a connected saved profile"
                      }
                    >
                      <Icon name="history" />
                      <span>Server tools</span>
                    </button>
                    <button
                      disabled={!monitorAvailable}
                      className={visibleDrawer === "monitor" ? "is-active" : ""}
                      aria-pressed={visibleDrawer === "monitor"}
                      onClick={() =>
                        setDrawerTab((v) =>
                          v === "monitor" ? null : "monitor",
                        )
                      }
                      title={monitorAvailable ? "Toggle monitor" : unavailableReason}
                    >
                      <Icon name="monitor" />
                      <span>Monitor</span>
                    </button>
                    {showIis && <button
                      disabled={!iisAvailable}
                      className={visibleDrawer === "iis" ? "is-active" : ""}
                      aria-pressed={visibleDrawer === "iis"}
                      onClick={() => setDrawerTab((v) => v === "iis" ? null : "iis")}
                      title={iisAvailable ? "IIS & Windows events" : "A verified Windows PowerShell runtime is required"}
                    >
                      <Icon name="server" />
                      <span>IIS</span>
                    </button>}
                  </>
                )}
                <button
                  onClick={() => setShowPalette(true)}
                  title="Command palette (⌘/Ctrl K)"
                  aria-label="Open command palette"
                >
                  <Icon name="search" />
                </button>
              </div>
            </header>
          )}
          <div className="workspace-body">
            <div
              className={`terminal-container ${activeTabId === "connections" ? "connections-home" : ""}`}
            >
              {activeTabId === "connections" && (
                <ConnectionsView
                  mode="page"
                  onConnect={handleConnectProfile}
                  onEdit={handleEditProfile}
                  onNew={handleNewProfile}
                  onLocalShell={createLocalTab}
                  reloadKey={profileReloadKey}
                  onProfilesLoaded={setKnownProfiles}
                  connectedProfileIds={tabs
                    .filter(
                      (tab) =>
                        sessionStatuses[tab.id] === "connected" &&
                        (tab.profileId ?? tab.sshConfig?.profileId),
                    )
                    .map((tab) => (tab.profileId ?? tab.sshConfig?.profileId)!)}
                >
                  <nav
                    className="ssh-workspace-tools"
                    aria-label="Workspace tools"
                  >
                    <button onClick={() => openSftpPopout()}>
                      <Icon name="transfer" />
                      SFTP
                    </button>
                    <button onClick={() => setShowSnippets(true)}>
                      <Icon name="snippets" />
                      Snippets
                    </button>
                    <button onClick={() => setShowVault(true)}>
                      <Icon name="vault" />
                      Vault
                    </button>
                    <button onClick={() => setShowSettings(true)}>
                      <Icon name="settings" />
                      Settings
                    </button>
                  </nav>
                </ConnectionsView>
              )}
              {activeTab?.type === "sftp" &&
                activeTab.linkedSessionId &&
                sessionMap[activeTab.linkedSessionId] &&
                sftpSessions[sessionMap[activeTab.linkedSessionId]] && (
                  <SftpView
                    sessionId={sessionMap[activeTab.linkedSessionId]}
                    sftpId={
                      sftpSessions[sessionMap[activeTab.linkedSessionId]].sftpId
                    }
                    homePath={
                      sftpSessions[sessionMap[activeTab.linkedSessionId]]
                        .homePath
                    }
                    availableSessions={tabs
                      .filter(
                        (t) =>
                          t.type === "ssh" &&
                          sessionMap[t.id] &&
                          sftpSessions[sessionMap[t.id]],
                      )
                      .map((t) => ({
                        id: sessionMap[t.id],
                        sftpId: sftpSessions[sessionMap[t.id]]?.sftpId || "",
                        label: t.title,
                        homePath:
                          sftpSessions[sessionMap[t.id]]?.homePath || "/",
                      }))}
                  />
                )}
              {activeTab?.type === "sftp" && (!activeTab.linkedSessionId || !sessionMap[activeTab.linkedSessionId]) && (
                <p className="disconnected-tab-notice">
                  The linked SSH session has closed. Open SFTP from a connected session to continue.
                </p>
              )}
              <div
                style={{
                  display:
                    activeTabId === "connections" ||
                    activeTab?.type === "sftp"
                      ? "none"
                      : "contents",
                }}
              >
                {tabs
                  .filter((t) => t.type !== "sftp" && t.type !== "mcp" && t.type !== "rdp")
                  .map((tab) => (
                    <Terminal
                      key={tab.id}
                      tabId={tab.id}
                      type={tab.type as "local" | "ssh" | "telnet" | "serial"}
                      sshConfig={tab.sshConfig}
                      telnetConfig={tab.telnetConfig}
                      serialConfig={tab.serialConfig}
                      isActive={tab.id === activeTabId}
                      onSessionCreated={handleSessionCreated}
                      onSessionStatus={handleSessionStatus}
                      onTitleChange={handleTitleChange}
                      onRegisterCapturePath={handleRegisterCapturePath}
                      onRegisterBufferCheck={handleRegisterBufferCheck}
                      onCwdChanged={handleCwdChanged}
                      onShellIntegrationChange={handleShellIntegrationChange}
                    />
                  ))}
                {tabs.filter((tab) => tab.type === "mcp" && tab.execution).map((tab) => (
                  <McpTerminal key={tab.id} tabId={tab.id} job={tab.execution!}
                    isActive={tab.id === activeTabId} onSessionStatus={handleSessionStatus} onJobStatus={handleMcpJobStatus} />
                ))}
                {tabs.filter((tab) => tab.type === "rdp").map((tab) => (
                  <RdpSession key={tab.id} tabId={tab.id} isActive={tab.id === activeTabId}
                    onSessionStatus={handleSessionStatus} onTitleChange={handleTitleChange} />
                ))}
              </div>
            </div>
            {activeTabId && sshActive && (
              <ResizablePanel
                side="right"
                defaultWidth={280}
                minWidth={240}
                maxWidth={420}
                collapsed={rightCollapsed}
              >
                <FileTree
                  sessionId={sessionMap[activeTabId]}
                  key={activeTabId}
                  navigateToPath={cdTrackingEnabled ? cwdByTab[activeTabId] ?? null : null}
                  cdTrackingEnabled={cdTrackingEnabled}
                  onCdTrackingChange={setCdTrackingEnabled}
                  shellIntegration={
                    shellIntegrationByTab[activeTabId] ?? "unknown"
                  }
                  onCollapse={() => setRightCollapsed(true)}
                  onOpenSftpView={() =>
                    openSftpPopout(activeTabId, activeTitle)
                  }
                  transferChannel={transferChannel}
                  refreshTrigger={fileTreeRefreshKey}
                />
              </ResizablePanel>
            )}
          </div>
        </main>
      </div>
      <StatusBar
        sessionLabel={
          sshActive
            ? activeTitle
            : activeTab?.type === "rdp"
              ? `${activeTitle} · ${activeStatus}`
            : activeTab?.type === "local"
              ? `Local · ${activeStatus}`
              : null
        }
        sshActive={sshActive}
        monitorAvailable={monitorAvailable}
        logsAvailable={logsAvailable}
        showIis={showIis}
        iisAvailable={iisAvailable}
        unavailableReason={unavailableReason}
        stats={serverStats}
        transferJobs={transferJobs}
        activeDrawer={visibleDrawer}
        onToggleDrawer={setDrawerTab}
        onOpenPalette={() => setShowPalette(true)}
      >
        {visibleDrawer === "monitor" && (
          <MonitorPanel stats={serverStats} error={statsError} />
        )}
        {visibleDrawer === "iis" && currentSshSessionId && (
          <IisPanel key={currentSshSessionId} sessionId={currentSshSessionId} />
        )}
        {visibleDrawer === "transfers" && (
          <TransferDock
            jobs={transferJobs}
            onCancel={handleCancelTransfer}
            onClearCompleted={handleClearCompletedTransfers}
            headless
          />
        )}
        {visibleDrawer === "logs" && currentSshSessionId && (
          <LogViewer
            key={currentSshSessionId}
            sessionId={currentSshSessionId}
            onClose={() => setDrawerTab(null)}
            onPopout={openLogPopout}
          />
        )}
      </StatusBar>
      {showConnectDialog && connectionProtocol === "ssh" && (
        <ConnectDialog
          onProtocolChange={setConnectionProtocol}
          onConnect={createSshTab}
          onCancel={() => {
            setShowConnectDialog(false);
            setEditProfile(null);
          }}
          onSaved={handleProfileSaved}
          editProfile={editProfile}
        />
      )}
      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)} />
      )}

      {showSnippets && (
        <div
          className="sn-modal-overlay"
          onMouseDown={() => setShowSnippets(false)}
        >
          <div
            className="sn-modal-body"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="sn-modal-head">
              <span className="sn-modal-title">Snippets</span>
              <button
                className="sn-modal-close"
                onClick={() => setShowSnippets(false)}
              >
                ✕
              </button>
            </div>
            <SnippetsView
              onExecute={(cmd) => {
                handleExecuteCommand(cmd);
                setShowSnippets(false);
              }}
            />
          </div>
        </div>
      )}

      {showVault && <VaultView onClose={() => setShowVault(false)} />}

      <CommandPalette
        isOpen={showPalette}
        onClose={() => setShowPalette(false)}
        items={paletteItems}
      />

      {showConnectDialog && connectionProtocol !== "ssh" && (
        <TransportConnectDialog
          key={`${connectionProtocol}-${editProfile?.id ?? "new"}`}
          protocol={connectionProtocol}
          editProfile={editProfile}
          onProtocolChange={setConnectionProtocol}
          onSaved={handleProfileSaved}
          onCancel={() => {
            setShowConnectDialog(false);
            setEditProfile(null);
          }}
          onConnect={(config) =>
            connectionProtocol === "telnet"
              ? createTelnetTab(config.host, config.port, config.profileId)
              : handleSerialConnect(
                  config.host,
                  config.baudRate,
                  config.profileId,
                )
          }
        />
      )}

      {hostKeyPrompts.length > 0 && (
        <HostKeyPrompt
          prompt={hostKeyPrompts[0]}
          onClose={() => setHostKeyPrompts((prev) => prev.slice(1))}
        />
      )}
    </div>
  );
}

export default App;
