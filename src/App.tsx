import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Profile, SshConfig, Tab } from "./types";
import TransferDock from "./components/sftp/TransferDock";
import { TransferJob } from "./types/sftp";
import TabBar from "./components/common/TabBar";
import ResizablePanel from "./components/common/ResizablePanel";
import SettingsDialog from "./components/common/SettingsDialog";
import Terminal from "./components/terminal/Terminal";
import LogViewer from "./components/terminal/LogViewer";
import MonitorPanel from "./components/terminal/MonitorPanel";
import StatusBar, { DrawerTab } from "./components/common/StatusBar";
import { useServerStats } from "./hooks/useServerStats";
import { useInvokeState } from "./hooks/useInvokeState";
import { useTauriListener } from "./hooks/useTauriListener";
import { useTransferChannel } from "./hooks/useTransferChannel";
import { type ShellIntegrationStatus } from "./utils/osc7";
import CommandPalette, { PaletteItem } from "./components/common/CommandPalette";
import InputDialog from "./components/sftp/InputDialog";
import SerialConnectDialog, { SerialPortInfo } from "./components/common/SerialConnectDialog";
import UpdateBanner from "./components/common/UpdateBanner";
import HostKeyPrompt, { HostKeyPromptPayload } from "./components/common/HostKeyPrompt";
import { message } from "@tauri-apps/plugin-dialog";
import ConnectionsView from "./components/connection/ConnectionsView";
import ConnectDialog from "./components/connection/ConnectDialog";
import ServerContext from "./components/connection/ServerContext";
import FileTree from "./components/files/FileTree";
import SnippetsView from "./components/snippets/SnippetsView";
import SftpView from "./components/sftp/SftpView";
import "./App.css";

let tabCounter = 1;

const connectionsTab: Tab = {
  id: "connections",
  title: "Connections",
  type: "connections",
};

const initialLocalTab: Tab & { sshConfig?: SshConfig } = {
  id: "tab-1",
  title: "Local Shell",
  type: "local",
};

function App() {
  const [tabs, setTabs] = useState<(Tab & { sshConfig?: SshConfig })[]>([
    connectionsTab,
    initialLocalTab,
  ]);
  const [activeTabId, setActiveTabId] = useState<string | null>("tab-1");
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [editProfile, setEditProfile] = useState<Profile | null>(null);
  const [sessionMap, setSessionMap] = useState<Record<string, string>>({});
  const [sftpSessions, setSftpSessions] = useState<Record<string, { sftpId: string; homePath: string }>>({});
  const [profileReloadKey, setProfileReloadKey] = useState(0);
  const capturePathFns = useRef<Record<string, () => Promise<string | null>>>({});
  const bufferCheckFns = useRef<Record<string, () => boolean>>({});

  const [cdTrackingEnabled, setCdTrackingEnabled] = useState(true);
  const [fileTreePath, setFileTreePath] = useState<string | null>(null);
  // 탭별 shell integration 상태 (OSC 7 감지 여부). FileTree indicator 와 pwd fallback 게이트에 사용.
  const [shellIntegrationByTab, setShellIntegrationByTab] = useState<
    Record<string, ShellIntegrationStatus>
  >({});
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [telnetPromptOpen, setTelnetPromptOpen] = useState(false);
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[] | null>(null);
  // SSH host key 확인 큐. 연속 연결 시 여러 개가 쌓일 수 있어 FIFO 로 하나씩 처리.
  const [hostKeyPrompts, setHostKeyPrompts] = useState<HostKeyPromptPayload[]>([]);
  const { data: paletteSnippets, reload: reloadPaletteSnippets } =
    useInvokeState<{ id: number; title: string; command: string; category: string }[]>(
      "list_snippets",
      []
    );

  // 글로벌 단축키: Cmd/Ctrl+K 로 Command Palette 토글.
  // capturing phase 로 등록 — xterm textarea 같은 자식이 stopPropagation 해도 가로채인다.
  // e.code 사용 — 한영 IME 상태와 무관하게 물리 K 키를 잡는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  useTauriListener("toggle-server-ctx", () => setLeftCollapsed((v) => !v));
  useTauriListener("toggle-file-tree", () => setRightCollapsed((v) => !v));
  useTauriListener<string>("toggle-drawer", (e) => {
    const tab = e.payload as DrawerTab;
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
    currentTabForStats?.type === "ssh" && activeTabId ? sessionMap[activeTabId] : null;
  const sshActive = !!currentSshSessionId;
  const { stats: serverStats } = useServerStats(currentSshSessionId, sshActive);

  // 전역 Transfer state. FileTree 의 다운로드/업로드가 TransferManager 큐를 타게 하고
  // 진행률·속도·ETA 를 하단 Dock 에서 공유한다. SFTP popout 윈도우는 별도 인스턴스라
  // 자기 Channel 을 쓰고, 여기는 메인 윈도우 전용.
  // 업로드/다운로드 완료 시 FileTree 가 현재 디렉토리를 리로드하도록 증가시키는 카운터.
  const [fileTreeRefreshKey, setFileTreeRefreshKey] = useState(0);
  const { transferJobs, setTransferJobs, transferChannel } = useTransferChannel({
    onCompleted: () => setFileTreeRefreshKey((k) => k + 1),
  });

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
  // tabs/sessionMap/sftpSessions 변경 시마다 브로드캐스트.
  useEffect(() => {
    const list = tabs
      .filter((t) => t.type === "ssh" && sessionMap[t.id] && sftpSessions[sessionMap[t.id]])
      .map((t) => ({
        id: sessionMap[t.id],
        sftpId: sftpSessions[sessionMap[t.id]].sftpId,
        label: t.title,
        homePath: sftpSessions[sessionMap[t.id]].homePath,
      }));
    emit("sftp-sessions", list);
  }, [tabs, sessionMap, sftpSessions]);

  // popout이 뒤늦게 뜰 때 최신 스냅샷을 요청하면 재발송.
  useTauriListener("sftp-sessions-request", () => {
    const list = tabs
      .filter((t) => t.type === "ssh" && sessionMap[t.id] && sftpSessions[sessionMap[t.id]])
      .map((t) => ({
        id: sessionMap[t.id],
        sftpId: sftpSessions[sessionMap[t.id]].sftpId,
        label: t.title,
        homePath: sftpSessions[sessionMap[t.id]].homePath,
      }));
    emit("sftp-sessions", list);
  });

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeProfileId = activeTab?.sshConfig?.profileId ?? null;

  const createLocalTab = useCallback(() => {
    const id = `tab-${++tabCounter}`;
    const newTab: Tab = { id, title: "Local Shell", type: "local" };
    setTabs((prev) => [...prev, newTab]);
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

  const createTelnetTab = useCallback((host: string, port: number) => {
    const id = `tab-${++tabCounter}`;
    const newTab = {
      id,
      title: `telnet://${host}:${port}`,
      type: "telnet" as const,
      telnetConfig: { host, port },
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
    setShowConnectDialog(false);
  }, []);

  /** Serial 버튼 클릭 진입점 — 포트 목록 조회 후 SerialConnectDialog 를 띄운다.
   *  native prompt/alert 은 Tauri 2 webview 에서 차단되기 때문에 전용 모달 사용. */
  const createSerialTab = useCallback(async () => {
    try {
      const ports = await invoke<SerialPortInfo[]>("list_serial_ports");
      if (ports.length === 0) {
        await message("No serial ports found", { title: "Serial", kind: "info" });
        return;
      }
      setSerialPorts(ports);
    } catch (err) {
      await message(`Failed to list ports: ${err}`, { title: "Serial", kind: "error" });
    }
  }, []);

  const handleSerialConnect = useCallback(
    (portName: string, baudRate: number) => {
      const id = `tab-${++tabCounter}`;
      setTabs((prev) => [
        ...prev,
        {
          id,
          title: portName,
          type: "serial" as const,
          serialConfig: { portName, baudRate },
        } as Tab & { sshConfig?: SshConfig },
      ]);
      setActiveTabId(id);
      setSerialPorts(null);
    },
    [],
  );

  const handleTelnetInput = useCallback(
    (value: string) => {
      setTelnetPromptOpen(false);
      if (!value) return;
      const [host, portStr] = value.includes(":") ? value.split(":") : [value, "23"];
      createTelnetTab(host.trim(), parseInt(portStr) || 23);
    },
    [],
  );

  /** SFTP popout 열기. sshTabId 가 있으면 해당 세션으로, 없으면 빈 popout (내부에서 프로필 선택) */
  const openSftpPopout = useCallback(async (sshTabId?: string | null, sshTabTitle?: string) => {
    let label = "sftp-blank";
    let params = new URLSearchParams({ view: "sftp", label: sshTabTitle || "SFTP" });

    if (sshTabId) {
      const sshSessionId = sessionMap[sshTabId];
      if (sshSessionId) {
        let current = sftpSessions[sshSessionId];
        if (!current) {
          try {
            const sftpId = await invoke<string>("sftp_open", { sessionId: sshSessionId });
            const homePath = await invoke<string>("sftp_get_home_dir", { sftpId });
            current = { sftpId, homePath };
            setSftpSessions((prev) => ({ ...prev, [sshSessionId]: current! }));
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
  }, [sessionMap, sftpSessions]);

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

  const closeTab = useCallback(
    (id: string) => {
      if (id === "connections" || id === "snippets") return;

      setTabs((prev) => {
        const tab = prev.find((t) => t.id === id);

        // SSH 탭 닫을 때 연관 리소스 정리
        if (tab?.type === "ssh") {
          const sshSessionId = sessionMap[id];
          if (sshSessionId) {
            // SFTP 세션 정리
            const sftpInfo = sftpSessions[sshSessionId];
            if (sftpInfo) {
              invoke("sftp_close", { sftpId: sftpInfo.sftpId });
              setSftpSessions((p) => {
                const next = { ...p };
                delete next[sshSessionId];
                return next;
              });
            }
            // SSH 세션 정리
            invoke("close_ssh", { sessionId: sshSessionId });
          }

          // 연결된 SFTP 탭도 함께 제거
          const sftpTabId = `sftp-${id}`;
          const filtered = prev.filter((t) => t.id !== id && t.id !== sftpTabId);
          if (activeTabId === id || activeTabId === sftpTabId) {
            const idx = prev.findIndex((t) => t.id === id);
            const newActive = filtered[Math.min(idx, filtered.length - 1)]?.id ?? null;
            setActiveTabId(newActive);
          }
          return filtered;
        }

        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id) {
          const idx = prev.findIndex((t) => t.id === id);
          const newActive = next[Math.min(idx, next.length - 1)]?.id ?? null;
          setActiveTabId(newActive);
        }
        return next;
      });
    },
    [activeTabId, sessionMap, sftpSessions]
  );

  const handleTitleChange = useCallback((tabId: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, title } : t))
    );
  }, []);

  const handleSessionCreated = useCallback((tabId: string, sessionId: string) => {
    setSessionMap((prev) => ({ ...prev, [tabId]: sessionId }));
  }, []);

  const handleRegisterCapturePath = useCallback(
    (tabId: string, fn: () => Promise<string | null>) => {
      capturePathFns.current[tabId] = fn;
    },
    []
  );

  const handleRegisterBufferCheck = useCallback(
    (tabId: string, fn: () => boolean) => {
      bufferCheckFns.current[tabId] = fn;
    },
    []
  );

  const handleCaptureCurrentPath = useCallback(async (): Promise<string | null> => {
    if (!activeTabId) return null;
    const fn = capturePathFns.current[activeTabId];
    return fn ? fn() : null;
  }, [activeTabId]);

  const handleConnectProfile = useCallback(
    async (profile: Profile) => {
      try {
        const fullProfile = await invoke<Profile>("get_profile", { id: profile.id });
        createSshTab({
          host: fullProfile.host,
          port: fullProfile.port,
          username: fullProfile.username,
          authType: fullProfile.auth_type,
          password: fullProfile.password ?? undefined,
          keyPath: fullProfile.key_path ?? undefined,
          profileId: fullProfile.id,
          jumpHost: fullProfile.jump_host ? JSON.parse(fullProfile.jump_host) : undefined,
          agentForward: fullProfile.agent_forward || false,
        });
      } catch (err) {
        console.error("Failed to load profile:", err);
      }
    },
    [createSshTab]
  );

  const handleEditProfile = useCallback((profile: Profile) => {
    setEditProfile(profile);
    setShowConnectDialog(true);
  }, []);

  const handleNewProfile = useCallback(() => {
    setEditProfile(null);
    setShowConnectDialog(true);
  }, []);

  const handleProfileSaved = useCallback(() => {
    setProfileReloadKey((k) => k + 1);
  }, []);

  const handleCdDetected = useCallback(async () => {
    if (!cdTrackingEnabled || !activeTabId) return;
    // OSC 7 가 활성이면 셸이 prompt 마다 cwd 를 알려주므로 pwd 폴백 불필요 (race 방지).
    if (shellIntegrationByTab[activeTabId] === "detected") return;
    // cd 실행 후 잠시 대기 → pwd 캡처 → 파일 트리 이동 (fallback 경로)
    await new Promise((r) => setTimeout(r, 800));
    const fn = capturePathFns.current[activeTabId];
    if (!fn) return;
    const path = await fn();
    if (path) setFileTreePath(path);
  }, [cdTrackingEnabled, activeTabId, shellIntegrationByTab]);

  const handleCwdChanged = useCallback(
    (tabId: string, path: string) => {
      // 활성 탭의 cwd 변경만 FileTree 에 반영. 다른 탭은 무시 (사용자 보고 있는 화면이 아님).
      if (tabId !== activeTabId) return;
      if (!cdTrackingEnabled) return;
      setFileTreePath(path);
    },
    [activeTabId, cdTrackingEnabled],
  );

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
      invoke(writeCmd, { sessionId, data: command + "\r" });
    },
    [activeTabId, sessionMap, tabs]
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
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onCloseTab={closeTab}
        onNewLocalTab={createLocalTab}
        onNewSshTab={handleNewProfile}
        onNewSerialTab={createSerialTab}
        onNewTelnetTab={() => setTelnetPromptOpen(true)}
        onOpenSftp={() => openSftpPopout()}
        onOpenSettings={() => setShowSettings(true)}
      />
      <div className="app-body">
        {activeProfileId && (
          <>
            {leftCollapsed && (
              <button
                className="panel-strip panel-strip-left"
                onClick={() => setLeftCollapsed(false)}
                title="Show server context (⌘\)"
                aria-label="Show server context"
              />
            )}
            <ResizablePanel
              side="left"
              defaultWidth={220}
              minWidth={160}
              maxWidth={400}
              collapsed={leftCollapsed}
            >
              <div className="sidebar-wrapper">
                <div className="sidebar-header-ctx">
                  <span className="sidebar-title-ctx">Server</span>
                  <button
                    className="sidebar-collapse-btn-ctx"
                    onClick={() => setLeftCollapsed(true)}
                    title="Hide panel"
                  >
                    ◂
                  </button>
                </div>
                <ServerContext
                  profileId={activeProfileId}
                  sessionId={sessionMap[activeTabId!]}
                  onExecuteCommand={handleExecuteCommand}
                  onCaptureCurrentPath={handleCaptureCurrentPath}
                />
              </div>
            </ResizablePanel>
          </>
        )}
        <div className="terminal-container">
          {activeTabId === "connections" && (
            <ConnectionsView
              onConnect={handleConnectProfile}
              onEdit={handleEditProfile}
              onNew={handleNewProfile}
              reloadKey={profileReloadKey}
            />
          )}
          {activeTab?.type === "sftp" && activeTab.linkedSessionId && sessionMap[activeTab.linkedSessionId] && sftpSessions[sessionMap[activeTab.linkedSessionId]] && (
            <SftpView
              sessionId={sessionMap[activeTab.linkedSessionId]}
              sftpId={sftpSessions[sessionMap[activeTab.linkedSessionId]].sftpId}
              homePath={sftpSessions[sessionMap[activeTab.linkedSessionId]].homePath}
              availableSessions={
                tabs
                  .filter((t) => t.type === "ssh" && sessionMap[t.id] && sftpSessions[sessionMap[t.id]])
                  .map((t) => ({
                    id: sessionMap[t.id],
                    sftpId: sftpSessions[sessionMap[t.id]]?.sftpId || "",
                    label: t.title,
                    homePath: sftpSessions[sessionMap[t.id]]?.homePath || "/",
                  }))
              }
            />
          )}
          <div style={{ display: activeTabId === "connections" || activeTabId === "snippets" || activeTab?.type === "sftp" ? "none" : "contents" }}>
            {tabs.filter((t) => t.type !== "connections" && t.type !== "snippets" && t.type !== "sftp").map((tab) => (
              <Terminal
                key={tab.id}
                tabId={tab.id}
                type={tab.type as "local" | "ssh" | "telnet" | "serial"}
                sshConfig={tab.sshConfig}
                telnetConfig={(tab as any).telnetConfig}
                serialConfig={(tab as any).serialConfig}
                isActive={tab.id === activeTabId}
                onSessionCreated={handleSessionCreated}
                onTitleChange={handleTitleChange}
                onRegisterCapturePath={handleRegisterCapturePath}
                onRegisterBufferCheck={handleRegisterBufferCheck}
                onCdDetected={handleCdDetected}
                onCwdChanged={handleCwdChanged}
                onShellIntegrationChange={handleShellIntegrationChange}
              />
            ))}
          </div>
        </div>
        {activeTabId && activeTab?.type === "ssh" && sessionMap[activeTabId] && rightCollapsed && (
          <button
            className="panel-strip panel-strip-right"
            onClick={() => setRightCollapsed(false)}
            title="Show file tree (⌘⇧\)"
            aria-label="Show file tree"
          />
        )}
        {activeTabId && activeTab?.type === "ssh" && sessionMap[activeTabId] && (
          <ResizablePanel
            side="right"
            defaultWidth={250}
            minWidth={180}
            maxWidth={450}
            collapsed={rightCollapsed}
          >
            <FileTree
              sessionId={sessionMap[activeTabId]}
              navigateToPath={fileTreePath}
              cdTrackingEnabled={cdTrackingEnabled}
              onCdTrackingChange={setCdTrackingEnabled}
              shellIntegration={shellIntegrationByTab[activeTabId] ?? "unknown"}
              onCollapse={() => setRightCollapsed(true)}
              onOpenSftpView={() => openSftpPopout(activeTabId!, activeTab?.title || "")}
              transferChannel={transferChannel}
              refreshTrigger={fileTreeRefreshKey}
            />
          </ResizablePanel>
        )}
      </div>
      <StatusBar
        sessionLabel={sshActive ? activeTab?.title || null : null}
        sshActive={sshActive}
        stats={serverStats}
        transferJobs={transferJobs}
        activeDrawer={drawerTab}
        onToggleDrawer={setDrawerTab}
      >
        {drawerTab === "monitor" && (
          <MonitorPanel stats={serverStats} error={null} />
        )}
        {drawerTab === "transfers" && (
          <TransferDock
            jobs={transferJobs}
            onCancel={handleCancelTransfer}
            onClearCompleted={handleClearCompletedTransfers}
            headless
          />
        )}
        {drawerTab === "logs" && sshActive && activeTabId && (
          <LogViewer
            sessionId={sessionMap[activeTabId]}
            onClose={() => setDrawerTab(null)}
            onPopout={openLogPopout}
          />
        )}
      </StatusBar>
      {showConnectDialog && (
        <ConnectDialog
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

      <CommandPalette
        isOpen={showPalette}
        onClose={() => setShowPalette(false)}
        items={paletteItems}
      />

      {telnetPromptOpen && (
        <InputDialog
          title="New Telnet connection"
          placeholder="host:port (e.g. 192.168.1.1:23)"
          initial=""
          confirmLabel="Connect"
          warning="⚠ Telnet is unencrypted. Credentials and all terminal traffic travel in plain text. Use SSH for anything that crosses an untrusted network."
          onConfirm={handleTelnetInput}
          onCancel={() => setTelnetPromptOpen(false)}
        />
      )}

      {serialPorts && (
        <SerialConnectDialog
          ports={serialPorts}
          onConnect={handleSerialConnect}
          onCancel={() => setSerialPorts(null)}
        />
      )}

      {hostKeyPrompts.length > 0 && (
        <HostKeyPrompt
          prompt={hostKeyPrompts[0]}
          onClose={() =>
            setHostKeyPrompts((prev) => prev.slice(1))
          }
        />
      )}
    </div>
  );
}

export default App;
