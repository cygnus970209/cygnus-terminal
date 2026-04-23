import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import SftpView from "../components/sftp/SftpView";
import SftpConnectView from "./SftpConnectView";
import "../App.css";

interface Props {
  sftpId: string;
  homePath: string;
  sshSessionId: string;
  label: string;
}

interface AvailableSession {
  id: string;
  sftpId: string;
  label: string;
  homePath: string;
}

interface Session {
  sftpId: string;
  homePath: string;
  sshSessionId: string;
  label: string;
}

export default function SftpPopoutApp({
  sftpId: initialSftpId,
  homePath: initialHomePath,
  sshSessionId: initialSshSessionId,
  label,
}: Props) {
  // URL params 로 세션이 들어왔으면 바로 연결 상태. 비어있으면 connect view 부터.
  const [session, setSession] = useState<Session | null>(
    initialSftpId && initialSshSessionId
      ? {
          sftpId: initialSftpId,
          homePath: initialHomePath,
          sshSessionId: initialSshSessionId,
          label,
        }
      : null,
  );
  const [available, setAvailable] = useState<AvailableSession[]>([]);

  useEffect(() => {
    document.title = session ? `SFTP — ${session.label}` : "SFTP";
  }, [session]);

  // 메인 윈도우가 emit 하는 세션 목록 구독
  useEffect(() => {
    const unlistenP = listen<AvailableSession[]>("sftp-sessions", (event) => {
      setAvailable(event.payload);
    });
    import("@tauri-apps/api/event").then(({ emit }) => {
      emit("sftp-sessions-request", {});
    });
    return () => {
      unlistenP.then((un) => un());
    };
  }, []);

  if (!session) {
    return (
      <div className="app" style={{ height: "100vh" }}>
        <SftpConnectView onConnected={setSession} />
      </div>
    );
  }

  return (
    <div className="app" style={{ height: "100vh" }}>
      <SftpView
        sessionId={session.sshSessionId}
        sftpId={session.sftpId}
        homePath={session.homePath}
        availableSessions={available}
      />
    </div>
  );
}
