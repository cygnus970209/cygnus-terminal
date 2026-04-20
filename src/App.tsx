import { useState, useCallback } from "react";
import TabBar, { Tab } from "./components/TabBar";
import Terminal from "./components/Terminal";
import ConnectDialog, { SshConfig } from "./components/ConnectDialog";
import "./App.css";

let tabCounter = 0;

function App() {
  const [tabs, setTabs] = useState<(Tab & { sshConfig?: SshConfig })[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showConnectDialog, setShowConnectDialog] = useState(false);

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

  // Auto-create first local tab
  if (tabs.length === 0) {
    const id = `tab-${++tabCounter}`;
    const firstTab: Tab = { id, title: "Local Shell", type: "local" };
    setTabs([firstTab]);
    setActiveTabId(id);
  }

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onCloseTab={closeTab}
        onNewLocalTab={createLocalTab}
        onNewSshTab={() => setShowConnectDialog(true)}
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
      {showConnectDialog && (
        <ConnectDialog
          onConnect={createSshTab}
          onCancel={() => setShowConnectDialog(false)}
        />
      )}
    </div>
  );
}

export default App;
