import "./TabBar.css";

export interface Tab {
  id: string;
  title: string;
  type: "local" | "ssh";
}

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewLocalTab: () => void;
  onNewSshTab: () => void;
}

export default function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewLocalTab,
  onNewSshTab,
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
            <span className="tab-icon">
              {tab.type === "ssh" ? "⬡" : "▸"}
            </span>
            <span className="tab-title">{tab.title}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              ×
            </button>
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
      </div>
    </div>
  );
}
