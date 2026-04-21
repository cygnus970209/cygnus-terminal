import { Tab } from "../../types";
import "./TabBar.css";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewLocalTab: () => void;
  onNewSshTab: () => void;
  onOpenSettings?: () => void;
}

function tabIcon(type: Tab["type"]) {
  switch (type) {
    case "connections": return "☰";
    case "snippets": return "{ }";
    case "sftp": return "📂";
    case "ssh": return "⬡";
    default: return "▸";
  }
}

export default function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewLocalTab,
  onNewSshTab,
  onOpenSettings,
}: TabBarProps) {
  return (
    <div className="tabbar">
      <div className="tabbar-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? "tab-active" : ""}`}
            onClick={() => onSelectTab(tab.id)}
          >
            <span className="tab-icon">{tabIcon(tab.type)}</span>
            <span className="tab-title">{tab.title}</span>
            {tab.type !== "connections" && tab.type !== "snippets" && (
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="tabbar-actions">
        <button className="tabbar-btn" onClick={onNewLocalTab} title="New Local Shell">
          +
        </button>
        <button className="tabbar-btn tabbar-btn-ssh" onClick={onNewSshTab} title="New SSH Connection">
          SSH
        </button>
        {onOpenSettings && (
          <button className="tabbar-btn" onClick={onOpenSettings} title="Settings">
            ⚙
          </button>
        )}
      </div>
    </div>
  );
}
