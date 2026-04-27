import { useCallback, useState } from "react";
import HistoryTab from "./serverContext/HistoryTab";
import CommandsTab from "./serverContext/CommandsTab";
import PathsTab from "./serverContext/PathsTab";
import ForwardsTab from "./serverContext/ForwardsTab";
import "./ServerContext.css";

interface ServerContextProps {
  profileId: number;
  sessionId: string;
  onExecuteCommand: (command: string) => void;
  onCaptureCurrentPath?: () => Promise<string | null>;
}

type TabType = "history" | "commands" | "paths" | "forwards";

export default function ServerContext({
  profileId,
  sessionId,
  onExecuteCommand,
  onCaptureCurrentPath,
}: ServerContextProps) {
  const [activeTab, setActiveTab] = useState<TabType>("history");
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  return (
    <div className="server-context">
      <div className="sc-tabs">
        <button
          className={`sc-tab ${activeTab === "history" ? "sc-tab-active" : ""}`}
          onClick={() => setActiveTab("history")}
        >
          History
        </button>
        <button
          className={`sc-tab ${activeTab === "commands" ? "sc-tab-active" : ""}`}
          onClick={() => setActiveTab("commands")}
        >
          Commands
        </button>
        <button
          className={`sc-tab ${activeTab === "paths" ? "sc-tab-active" : ""}`}
          onClick={() => setActiveTab("paths")}
        >
          Paths
        </button>
        <button
          className={`sc-tab ${activeTab === "forwards" ? "sc-tab-active" : ""}`}
          onClick={() => setActiveTab("forwards")}
        >
          Ports
        </button>
      </div>

      <div className="sc-content">
        {activeTab === "history" && (
          <HistoryTab profileId={profileId} onExecuteCommand={onExecuteCommand} />
        )}
        {activeTab === "commands" && (
          <CommandsTab profileId={profileId} onExecuteCommand={onExecuteCommand} />
        )}
        {activeTab === "paths" && (
          <PathsTab
            profileId={profileId}
            onExecuteCommand={onExecuteCommand}
            onCaptureCurrentPath={onCaptureCurrentPath}
            showToast={showToast}
          />
        )}
        {activeTab === "forwards" && (
          <ForwardsTab sessionId={sessionId} showToast={showToast} />
        )}
      </div>

      {toast && <div className="sc-toast">{toast}</div>}
    </div>
  );
}
