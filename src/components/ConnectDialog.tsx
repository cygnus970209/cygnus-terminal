import { useState } from "react";
import "./ConnectDialog.css";

interface ConnectDialogProps {
  onConnect: (config: SshConfig) => void;
  onCancel: () => void;
}

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  password?: string;
  keyPath?: string;
}

export default function ConnectDialog({ onConnect, onCancel }: ConnectDialogProps) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authType, setAuthType] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");

  const handleSubmit = (e?: React.FormEvent | React.MouseEvent) => {
    e?.preventDefault?.();
    if (!host || !username) return;
    onConnect({
      host,
      port: parseInt(port) || 22,
      username,
      authType,
      password: authType === "password" ? password : undefined,
      keyPath: authType === "key" ? keyPath : undefined,
    });
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">SSH Connection</h2>
        <form onSubmit={handleSubmit}>
          <div className="dialog-row">
            <label>Host</label>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.1"
              autoFocus
            />
          </div>
          <div className="dialog-row">
            <label>Port</label>
            <input
              type="text"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="22"
            />
          </div>
          <div className="dialog-row">
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root"
            />
          </div>
          <div className="dialog-row">
            <label>Auth</label>
            <div className="dialog-radio-group">
              <label className="dialog-radio">
                <input
                  type="radio"
                  checked={authType === "password"}
                  onChange={() => setAuthType("password")}
                />
                Password
              </label>
              <label className="dialog-radio">
                <input
                  type="radio"
                  checked={authType === "key"}
                  onChange={() => setAuthType("key")}
                />
                Private Key
              </label>
            </div>
          </div>
          {authType === "password" ? (
            <div className="dialog-row">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          ) : (
            <div className="dialog-row">
              <label>Key Path</label>
              <input
                type="text"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="~/.ssh/id_rsa"
              />
            </div>
          )}
          <div className="dialog-actions">
            <button type="button" className="dialog-btn dialog-btn-cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="dialog-btn dialog-btn-connect"
              onClick={handleSubmit as any}
            >
              Connect
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
