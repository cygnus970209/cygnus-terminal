import { ReactNode, useState } from "react";
import ThemeTab from "./settings/ThemeTab";
import DataTab from "./settings/DataTab";
import ShortcutsTab from "./settings/ShortcutsTab";
import AboutTab from "./settings/AboutTab";
import "./SettingsDialog.css";

interface SettingsDialogProps {
  onClose: () => void;
}

interface TabDef {
  id: string;
  label: string;
  render: () => ReactNode;
}

/** 새 설정 영역 추가는 이 배열에 entry 1개 + 컴포넌트 1개. */
const TABS: TabDef[] = [
  { id: "theme", label: "Theme", render: () => <ThemeTab /> },
  { id: "data", label: "Data", render: () => <DataTab /> },
  { id: "shortcuts", label: "Shortcuts", render: () => <ShortcutsTab /> },
  { id: "about", label: "About", render: () => <AboutTab /> },
];

export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [activeId, setActiveId] = useState<string>(TABS[0].id);
  const active = TABS.find((t) => t.id === activeId) ?? TABS[0];

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2 className="settings-title">Settings</h2>
          <button className="settings-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={activeId === t.id}
                className={`settings-tab ${activeId === t.id ? "settings-tab-active" : ""}`}
                onClick={() => setActiveId(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="settings-content" role="tabpanel">
            {active.render()}
          </div>
        </div>
      </div>
    </div>
  );
}
