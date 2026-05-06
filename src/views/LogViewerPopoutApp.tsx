import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useTauriListener } from "../hooks/useTauriListener";
import LogViewer from "../components/terminal/LogViewer";
import "../App.css";
import "./LogViewerPopoutApp.css";

interface Props {
  sshSessionId: string;
  label: string;
}

interface AvailableSession {
  id: string;
  sftpId: string; // 사용 안 함 (sftp-sessions 채널 재사용 — payload 그대로)
  label: string;
  homePath: string;
}

interface ActiveSession {
  id: string;
  label: string;
}

export default function LogViewerPopoutApp({
  sshSessionId: initialSessionId,
  label: initialLabel,
}: Props) {
  const [session, setSession] = useState<ActiveSession | null>(
    initialSessionId ? { id: initialSessionId, label: initialLabel } : null,
  );
  const [available, setAvailable] = useState<AvailableSession[]>([]);

  useEffect(() => {
    document.title = session ? `Logs — ${session.label}` : "Logs";
  }, [session]);

  // 메인 윈도우의 SSH 세션 broadcast 구독 (SFTP popout 과 동일 채널)
  useTauriListener<AvailableSession[]>("sftp-sessions", (event) => {
    setAvailable(event.payload);
  });
  useEffect(() => {
    import("@tauri-apps/api/event").then(({ emit }) => {
      emit("sftp-sessions-request", {});
    });
  }, []);

  const closeWindow = () => {
    getCurrentWebviewWindow().close().catch(() => {});
  };

  if (!session) {
    return (
      <div className="app log-popout-select">
        <h2>Select SSH Session</h2>
        {available.length === 0 ? (
          <p className="log-popout-empty">
            No active SSH sessions. Connect first in the main window.
          </p>
        ) : (
          <div className="log-popout-list">
            {available.map((s) => (
              <button
                key={s.id}
                className="log-popout-item"
                onClick={() => setSession({ id: s.id, label: s.label })}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app log-popout-app">
      <LogViewer
        sessionId={session.id}
        onClose={closeWindow}
        fullHeight
      />
    </div>
  );
}
