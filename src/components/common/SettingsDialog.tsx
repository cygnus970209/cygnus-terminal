import { t, useLocale } from "../../i18n";
import { useEscapeDismiss } from "../../hooks/useEscapeDismiss";
import { ReactNode, useState } from "react";
import GeneralTab from "./settings/GeneralTab";
import ThemeTab from "./settings/ThemeTab";
import TerminalTab from "./settings/TerminalTab";
import VaultPromptsTab from "./settings/VaultPromptsTab";
import DataTab from "./settings/DataTab";
import ShortcutsTab from "./settings/ShortcutsTab";
import McpTab from "./settings/McpTab";
import AboutTab from "./settings/AboutTab";
import "./SettingsDialog.css";

interface SettingsDialogProps {
  onClose: () => void;
  initialTab?: string;
}

interface TabDef {
  id: string;
  label: string;
  render: () => ReactNode;
}

/** 새 설정 영역 추가는 이 배열에 entry 1개 + 컴포넌트 1개. */
const TABS: TabDef[] = [
  { id: "general", label: "General", render: () => <GeneralTab /> },
  { id: "theme", label: "Theme", render: () => <ThemeTab /> },
  { id: "terminal", label: "Terminal", render: () => <TerminalTab /> },
  { id: "autofill", label: "Autofill", render: () => <VaultPromptsTab /> },
  { id: "mcp", label: "MCP", render: () => <McpTab /> },
  { id: "data", label: "Data", render: () => <DataTab /> },
  { id: "shortcuts", label: "Shortcuts", render: () => <ShortcutsTab /> },
  { id: "about", label: "About", render: () => <AboutTab /> },
];

export default function SettingsDialog({ onClose, initialTab = "general" }: SettingsDialogProps) {
  useLocale();
  useEscapeDismiss(onClose);
  const [activeId, setActiveId] = useState<string>(initialTab);
  const active = TABS.find((t) => t.id === activeId) ?? TABS[0];

  return (
    <div className="dialog-overlay" onMouseDown={(event) => {
      // A drag ending outside the dialog can produce a click on the overlay.
      if (event.button === 0 && event.target === event.currentTarget) onClose();
    }}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-label={t("Settings")} onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2 className="settings-title">{t("Settings")}</h2>
          <button className="settings-close" aria-label={t("Close")} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-tabs" role="tablist">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeId === tab.id}
                className={`settings-tab ${activeId === tab.id ? "settings-tab-active" : ""}`}
                onClick={() => setActiveId(tab.id)}
              >
                {t(tab.label)}
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
