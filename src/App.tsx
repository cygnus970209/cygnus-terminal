import { useState, useCallback, useRef } from "react";
import TabBar, { Tab } from "./components/TabBar";
import Terminal from "./components/Terminal";
import Sidebar, { Profile } from "./components/Sidebar";
import ConnectDialog, { SshConfig } from "./components/ConnectDialog";
import "./App.css";

let tabCounter = 1;

const initialTab: Tab & { sshConfig?: SshConfig } = {
  id: "tab-1",
  title: "Local Shell",
  type: "local",
};

function App() {
  const [tabs, setTabs] = useState<(Tab & { sshConfig?: SshConfig })[]>([initialTab]);
  const [activeTabId, setActiveTabId] = useState<string | null>("tab-1");
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [editProfile, setEditProfile] = useState<Profile | null>(null);
  const sidebarRef = useRef<{ reload: () => void }>(null);

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

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id) {
          const idx = prev.findIndex((t) => t.id === id);
          const newActive = next[Math.min(idx, next.length - 1)]?.id ?? null;
          setActiveTabId(newActive);
        }
        return next;
      });
    },
    [activeTabId]
  );

  const handleTitleChange = useCallback((tabId: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, title } : t))
    );
  }, []);

  const handleConnectProfile = useCallback(
    async (profile: Profile) => {
      // 프로필에서 비밀번호를 가져와서 SSH 접속
      const { invoke } = await import("@tauri-apps/api/core");
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
    sidebarRef.current?.reload();
  }, []);

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onCloseTab={closeTab}
        onNewLocalTab={createLocalTab}
        onNewSshTab={handleNewProfile}
      />
      <div className="app-body">
        <Sidebar
          ref={sidebarRef}
          onConnectProfile={handleConnectProfile}
          onEditProfile={handleEditProfile}
          onNewProfile={handleNewProfile}
        />
        <div className="terminal-container">
          {tabs.map((tab) => (
            <Terminal
              key={tab.id}
              tabId={tab.id}
              type={tab.type}
              sshConfig={tab.sshConfig}
              isActive={tab.id === activeTabId}
              onTitleChange={handleTitleChange}
            />
          ))}
        </div>
      </div>
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
    </div>
  );
}

export default App;
