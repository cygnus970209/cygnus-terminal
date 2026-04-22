import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Profile, SshConfig, Tab } from "./types";
import TabBar from "./components/common/TabBar";
import ResizablePanel from "./components/common/ResizablePanel";
import SettingsDialog from "./components/common/SettingsDialog";
import Terminal from "./components/terminal/Terminal";
import MonitorBar from "./components/terminal/MonitorBar";
import LogViewer from "./components/terminal/LogViewer";
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

const snippetsTab: Tab & { sshConfig?: SshConfig } = {
  id: "snippets",
  title: "Snippets",
  type: "snippets",
};

const initialLocalTab: Tab & { sshConfig?: SshConfig } = {
  id: "tab-1",
  title: "Local Shell",
  type: "local",
};

function App() {
  const [tabs, setTabs] = useState<(Tab & { sshConfig?: SshConfig })[]>([
    connectionsTab,
    snippetsTab,
    initialLocalTab,
  ]);
  const [activeTabId, setActiveTabId] = useState<string | null>("tab-1");
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [editProfile, setEditProfile] = useState<Profile | null>(null);
  const [sessionMap, setSessionMap] = useState<Record<string, string>>({});
  const [profileReloadKey, setProfileReloadKey] = useState(0);
  const capturePathFns = useRef<Record<string, () => Promise<string | null>>>({});
  const bufferCheckFns = useRef<Record<string, () => boolean>>({});

  const [cdTrackingEnabled, setCdTrackingEnabled] = useState(true);
  const [fileTreePath, setFileTreePath] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [monitorVisible, setMonitorVisible] = useState(true);
  const [logViewerVisible, setLogViewerVisible] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // macOS 메뉴 "Preferences" 이벤트 수신
  useEffect(() => {
    const unlisten = listen("open-settings", () => setShowSettings(true));
    return () => { unlisten.then((f) => f()); };
  }, []);

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

  const createSerialTab = useCallback(async () => {
    try {
      const ports = await invoke<{ name: string; port_type: string }[]>("list_serial_ports");
      if (ports.length === 0) {
        alert("No serial ports found");
        return;
      }
      const portList = ports.map((p, i) => `${i + 1}) ${p.name} (${p.port_type})`).join("\n");
      const choice = prompt(`Select port:\n${portList}\n\nEnter number:`);
      if (!choice) return;
      const idx = parseInt(choice) - 1;
      if (idx < 0 || idx >= ports.length) return;

      const baudStr = prompt("Baud rate:", "115200");
      const baudRate = parseInt(baudStr || "115200") || 115200;

      const id = `tab-${++tabCounter}`;
      setTabs((prev) => [...prev, {
        id,
        title: ports[idx].name,
        type: "serial" as const,
        serialConfig: { portName: ports[idx].name, baudRate },
      } as any]);
      setActiveTabId(id);
    } catch (err) {
      alert(`Failed: ${err}`);
    }
  }, []);

  const [sftpSessions, setSftpSessions] = useState<Record<string, { sftpId: string; homePath: string }>>({});

  const openSftpTab = useCallback(async (sshTabId: string, sshTabTitle: string) => {
    const sftpTabId = `sftp-${sshTabId}`;
    const sshSessionId = sessionMap[sshTabId];
    if (!sshSessionId) return;

    // SFTP 세션이 없으면 열기
    if (!sftpSessions[sshSessionId]) {
      try {
        const sftpId = await invoke<string>("sftp_open", { sessionId: sshSessionId });
        const homePath = await invoke<string>("sftp_get_home_dir", { sftpId });
        setSftpSessions((prev) => ({ ...prev, [sshSessionId]: { sftpId, homePath } }));
      } catch (err) {
        console.error("Failed to open SFTP:", err);
        return;
      }
    }

    setTabs((prev) => {
      if (prev.find((t) => t.id === sftpTabId)) return prev;
      return [...prev, {
        id: sftpTabId,
        title: `SFTP: ${sshTabTitle}`,
        type: "sftp" as const,
        linkedSessionId: sshTabId,
      }];
    });
    setActiveTabId(sftpTabId);
  }, [sessionMap, sftpSessions]);

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
    // cd 실행 후 잠시 대기 → pwd 캡처 → 파일 트리 이동
    await new Promise((r) => setTimeout(r, 800));
    const fn = capturePathFns.current[activeTabId];
    if (!fn) return;
    const path = await fn();
    if (path) setFileTreePath(path);
  }, [cdTrackingEnabled, activeTabId]);

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

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onCloseTab={closeTab}
        onNewLocalTab={createLocalTab}
        onNewSshTab={handleNewProfile}
        onNewSerialTab={createSerialTab}
        onNewTelnetTab={() => {
          const input = prompt("Telnet host:port (e.g. 192.168.1.1:23)");
          if (!input) return;
          const [host, portStr] = input.includes(":") ? input.split(":") : [input, "23"];
          createTelnetTab(host.trim(), parseInt(portStr) || 23);
        }}
        onOpenSettings={() => setShowSettings(true)}
      />
      <div className="app-body">
        {activeProfileId && (
          <>
            {leftCollapsed && (
              <button
                className="panel-show-btn panel-show-left"
                onClick={() => setLeftCollapsed(false)}
                title="Show server context"
              >
                ▸
              </button>
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
          {activeTabId === "snippets" && (
            <SnippetsView onExecute={handleExecuteCommand} />
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
              />
            ))}
          </div>
        </div>
        {activeTabId && activeTab?.type === "ssh" && sessionMap[activeTabId] && rightCollapsed && (
          <button
            className="panel-show-btn panel-show-right"
            onClick={() => setRightCollapsed(false)}
            title="Show file tree"
          >
            ◂
          </button>
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
              onCollapse={() => setRightCollapsed(true)}
              onOpenSftpView={() => openSftpTab(activeTabId!, activeTab?.title || "")}
            />
          </ResizablePanel>
        )}
      </div>
      {activeTabId && activeTab?.type === "ssh" && sessionMap[activeTabId] && logViewerVisible && (
        <LogViewer
          sessionId={sessionMap[activeTabId]}
          onClose={() => setLogViewerVisible(false)}
        />
      )}
      {activeTabId && activeTab?.type === "ssh" && sessionMap[activeTabId] && (
        <MonitorBar
          sessionId={sessionMap[activeTabId]}
          visible={monitorVisible}
          onToggle={() => setMonitorVisible((v) => !v)}
          onToggleLogs={() => setLogViewerVisible((v) => !v)}
          logViewerActive={logViewerVisible}
        />
      )}
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
    </div>
  );
}

export default App;
