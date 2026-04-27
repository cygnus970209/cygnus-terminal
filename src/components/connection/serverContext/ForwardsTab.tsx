import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useInvokeState } from "../../../hooks/useInvokeState";
import { PortForward } from "../../../types/server-context";

interface Props {
  sessionId: string;
  showToast: (msg: string) => void;
}

export default function ForwardsTab({ sessionId, showToast }: Props) {
  const [showAdd, setShowAdd] = useState(false);
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("localhost");
  const [remotePort, setRemotePort] = useState("");

  const { data: forwards, reload } = useInvokeState<PortForward[]>(
    "forward_list",
    []
  );

  useEffect(() => {
    reload();
  }, [reload]);

  const handleAdd = async () => {
    const lp = parseInt(localPort);
    const rp = parseInt(remotePort);
    if (!lp || !rp || !remoteHost) return;
    try {
      await invoke("forward_add", {
        sessionId,
        localPort: lp,
        remoteHost,
        remotePort: rp,
      });
      setLocalPort("");
      setRemotePort("");
      setRemoteHost("localhost");
      setShowAdd(false);
      reload();
      showToast(`Forward: localhost:${lp} → ${remoteHost}:${rp}`);
    } catch (err) {
      showToast(`Failed: ${err}`);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await invoke("forward_remove", { id });
      reload();
    } catch (err) {
      console.error("Failed to remove forward:", err);
    }
  };

  return (
    <>
      <div className="sc-header-row">
        <button className="sc-add-btn" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "+ Add"}
        </button>
      </div>
      {showAdd && (
        <div className="sc-add-form">
          <div className="sc-fwd-row">
            <input
              type="text"
              placeholder="Local port"
              value={localPort}
              onChange={(e) => setLocalPort(e.target.value)}
              style={{ width: 80 }}
              autoFocus
            />
            <span className="sc-fwd-arrow">→</span>
            <input
              type="text"
              placeholder="Host"
              value={remoteHost}
              onChange={(e) => setRemoteHost(e.target.value)}
              style={{ flex: 1 }}
            />
            <span className="sc-fwd-arrow">:</span>
            <input
              type="text"
              placeholder="Port"
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              style={{ width: 60 }}
            />
          </div>
          <button className="sc-save-btn" onClick={handleAdd}>
            Start
          </button>
        </div>
      )}
      <div className="sc-list">
        {forwards.map((fwd) => (
          <div key={fwd.id} className="sc-item sc-item-bookmark">
            <div className="sc-item-main">
              <span
                className="sc-fwd-status"
                style={{
                  color: fwd.status === "active" ? "#a6e3a1" : "#f38ba8",
                }}
              >
                ●
              </span>
              <div className="sc-item-info">
                <span className="sc-item-text">
                  :{fwd.local_port} → {fwd.remote_host}:{fwd.remote_port}
                </span>
              </div>
            </div>
            <button
              className="sc-delete-btn"
              onClick={() => handleRemove(fwd.id)}
              style={{ opacity: 1 }}
            >
              ×
            </button>
          </div>
        ))}
        {forwards.length === 0 && !showAdd && (
          <div className="sc-empty">
            No port forwards.
            <br />
            Click + Add to create one.
          </div>
        )}
      </div>
    </>
  );
}
