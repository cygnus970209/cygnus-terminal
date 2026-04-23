import { useEffect, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { Profile } from "../types";
import "./SftpConnectView.css";

interface Props {
  onConnected: (args: {
    sftpId: string;
    homePath: string;
    sshSessionId: string;
    label: string;
  }) => void;
}

type ConnectState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "connecting"; profile: Profile }
  | { kind: "error"; profile: Profile; message: string };

/**
 * sftp popout 이 sftpId 없이 열린 경우 보여주는 "프로필 선택 → 연결" 뷰.
 * 프로필 목록을 DB 에서 읽어 리스트로 띄우고, 사용자가 Connect 누르면
 * create_ssh_session → sftp_open → sftp_get_home_dir 순으로 세션을 띄운다.
 */
export default function SftpConnectView({ onConnected }: Props) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [state, setState] = useState<ConnectState>({ kind: "loading" });
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const list = await invoke<Profile[]>("list_profiles");
        setProfiles(list);
        setState({ kind: "idle" });
      } catch (err) {
        setState({ kind: "error", profile: null as unknown as Profile, message: String(err) });
      }
    })();
  }, []);

  const handleConnect = async (p: Profile) => {
    setState({ kind: "connecting", profile: p });
    try {
      // list_profiles 는 보안상 password 를 항상 None 으로 내려주므로, 연결 직전
      // get_profile(id) 로 복호화된 full profile 을 다시 읽는다. 메인 앱의
      // handleConnectProfile 과 동일한 패턴.
      const full = await invoke<Profile>("get_profile", { id: p.id });

      // PTY output 은 SFTP popout 에서 쓸 일 없지만 create_ssh_session 이 Channel 요구
      const onEvent = new Channel();
      const jumpHost = full.jump_host
        ? (() => {
            try {
              return JSON.parse(full.jump_host as unknown as string) as {
                host: string;
                port: number;
                username: string;
                auth_type: string;
                password?: string;
                key_path?: string;
              };
            } catch {
              return null;
            }
          })()
        : null;

      const sshSessionId = await invoke<string>("create_ssh_session", {
        host: full.host,
        port: full.port,
        username: full.username,
        authType: full.auth_type,
        password: full.password || null,
        keyPath: full.key_path || null,
        jumpHost,
        agentForward: full.agent_forward || false,
        onEvent,
      });

      const sftpId = await invoke<string>("sftp_open", { sessionId: sshSessionId });
      const homePath = await invoke<string>("sftp_get_home_dir", { sftpId });

      onConnected({
        sftpId,
        homePath,
        sshSessionId,
        label: `${full.username}@${full.host}`,
      });
    } catch (err) {
      setState({ kind: "error", profile: p, message: String(err) });
    }
  };

  const filtered = profiles.filter((p) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.host.toLowerCase().includes(q) ||
      p.username.toLowerCase().includes(q) ||
      p.group_name?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="sc-view">
      <div className="sc-head">
        <h2 className="sc-title">Connect via SFTP</h2>
        <p className="sc-sub">Pick a saved profile to start a new SFTP session in this window.</p>
      </div>

      <input
        className="sc-search"
        type="text"
        placeholder="Search by name, host, user..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {state.kind === "loading" && <div className="sc-msg">Loading profiles...</div>}

      {state.kind !== "loading" && filtered.length === 0 && (
        <div className="sc-msg">
          {profiles.length === 0
            ? "No saved profiles yet. Add one from the Connections tab in the main window."
            : "No profile matches your search."}
        </div>
      )}

      <div className="sc-list">
        {filtered.map((p) => {
          const connecting = state.kind === "connecting" && state.profile.id === p.id;
          const errored = state.kind === "error" && state.profile?.id === p.id;
          return (
            <div key={p.id} className={`sc-row ${connecting ? "sc-connecting" : ""}`}>
              <div className="sc-row-main">
                <span className="sc-name">{p.name}</span>
                <span className="sc-host mono">
                  {p.username}@{p.host}
                  {p.port !== 22 && `:${p.port}`}
                </span>
                {p.group_name && <span className="sc-group">{p.group_name}</span>}
                {errored && <span className="sc-err">{state.message}</span>}
              </div>
              <button
                className="sc-connect-btn"
                disabled={connecting}
                onClick={() => handleConnect(p)}
              >
                {connecting ? "Connecting..." : "Connect"}
              </button>
            </div>
          );
        })}
      </div>

      <div className="sc-foot">
        <span className="mono">Tip:</span> once connected, use the dropdown at the top of each
        panel to add another server or switch to Local.
      </div>
    </div>
  );
}
