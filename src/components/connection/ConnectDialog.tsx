import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Profile, SshConfig, JumpHostConfig } from "../../types";
import "./ConnectDialog.css";

interface ConnectDialogProps {
  onConnect: (config: SshConfig) => void;
  onCancel: () => void;
  onSaved?: () => void;
  editProfile?: Profile | null;
}

export default function ConnectDialog({
  onConnect,
  onCancel,
  onSaved,
  editProfile,
}: ConnectDialogProps) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authType, setAuthType] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [groupName, setGroupName] = useState("");
  const [saveProfile, setSaveProfile] = useState(true);
  const [useJumpHost, setUseJumpHost] = useState(false);
  const [jumpHost, setJumpHost] = useState("");
  const [jumpPort, setJumpPort] = useState("22");
  const [jumpUsername, setJumpUsername] = useState("");
  const [jumpAuthType, setJumpAuthType] = useState<"password" | "key">("password");
  const [jumpPassword, setJumpPassword] = useState("");
  const [jumpKeyPath, setJumpKeyPath] = useState("");
  const [agentForward, setAgentForward] = useState(false);

  const isEdit = !!editProfile;

  useEffect(() => {
    if (editProfile) {
      setName(editProfile.name);
      setHost(editProfile.host);
      setPort(String(editProfile.port));
      setUsername(editProfile.username);
      setAuthType(editProfile.auth_type);
      setKeyPath(editProfile.key_path || "");
      setGroupName(editProfile.group_name || "");
      setPassword("");
      setSaveProfile(true);
      setAgentForward(editProfile.agent_forward || false);
      if (editProfile.jump_host) {
        try {
          const jh = JSON.parse(editProfile.jump_host);
          setUseJumpHost(true);
          setJumpHost(jh.host || "");
          setJumpPort(String(jh.port || 22));
          setJumpUsername(jh.username || "");
          setJumpAuthType(jh.auth_type || "password");
          setJumpKeyPath(jh.key_path || "");
        } catch (e) {
          console.error("Failed to parse jump host config:", e);
        }
      } else {
        setUseJumpHost(false);
      }
    }
  }, [editProfile]);

  const buildJumpHostJson = (): string | undefined => {
    if (!useJumpHost || !jumpHost) return undefined;
    return JSON.stringify({
      host: jumpHost,
      port: parseInt(jumpPort) || 22,
      username: jumpUsername,
      auth_type: jumpAuthType,
      password: jumpAuthType === "password" ? jumpPassword : undefined,
      key_path: jumpAuthType === "key" ? jumpKeyPath : undefined,
    });
  };

  const buildJumpHostConfig = (): JumpHostConfig | undefined => {
    if (!useJumpHost || !jumpHost) return undefined;
    return {
      host: jumpHost,
      port: parseInt(jumpPort) || 22,
      username: jumpUsername,
      auth_type: jumpAuthType,
      password: jumpAuthType === "password" ? jumpPassword : undefined,
      key_path: jumpAuthType === "key" ? jumpKeyPath : undefined,
    };
  };

  const handleSave = async (): Promise<Profile | null> => {
    if (!saveProfile) return null;

    const jumpHostJson = buildJumpHostJson();

    try {
      if (isEdit && editProfile) {
        const updated = await invoke<Profile>("update_profile", {
          id: editProfile.id,
          req: {
            name: name || `${username}@${host}`,
            host,
            port: parseInt(port) || 22,
            username,
            auth_type: authType,
            password: authType === "password" && password ? password : undefined,
            key_path: authType === "key" ? keyPath : undefined,
            group_name: groupName || undefined,
            jump_host: jumpHostJson ?? null,
            agent_forward: agentForward,
          },
        });
        onSaved?.();
        return updated;
      } else {
        const created = await invoke<Profile>("create_profile", {
          req: {
            name: name || `${username}@${host}`,
            host,
            port: parseInt(port) || 22,
            username,
            auth_type: authType,
            password: authType === "password" ? password : undefined,
            key_path: authType === "key" ? keyPath : undefined,
            group_name: groupName || undefined,
            jump_host: jumpHostJson,
            agent_forward: agentForward,
          },
        });
        onSaved?.();
        return created;
      }
    } catch (err) {
      console.error("Failed to save profile:", err);
      return null;
    }
  };

  const handleConnect = async (e?: React.FormEvent | React.MouseEvent) => {
    e?.preventDefault?.();
    if (!host || !username) return;

    await handleSave();

    onConnect({
      host,
      port: parseInt(port) || 22,
      username,
      authType,
      password: authType === "password" ? password : undefined,
      keyPath: authType === "key" ? keyPath : undefined,
      jumpHost: buildJumpHostConfig(),
      agentForward,
    });
  };

  const handleSaveOnly = async () => {
    if (!host || !username) return;
    await handleSave();
    onCancel();
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">
          {isEdit ? "Edit Profile" : "New Connection"}
        </h2>
        <form onSubmit={handleConnect}>
          <div className="dialog-row">
            <label>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Server"
              autoFocus
            />
          </div>
          <div className="dialog-row-pair">
            <div className="dialog-row" style={{ flex: 1 }}>
              <label>Host</label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.1"
              />
            </div>
            <div className="dialog-row" style={{ width: 80 }}>
              <label>Port</label>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="22"
              />
            </div>
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
              <label>Password{isEdit && " (leave empty to keep current)"}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          ) : (
            <div className="dialog-row">
              <label>Key Path</label>
              <div className="dialog-input-with-btn">
                <input
                  type="text"
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_rsa"
                />
                <button
                  type="button"
                  className="dialog-browse-btn"
                  onClick={async () => {
                    const selected = await open({
                      title: "Select SSH Private Key",
                      defaultPath: "~/.ssh",
                      multiple: false,
                      directory: false,
                    });
                    if (selected) setKeyPath(selected);
                  }}
                >
                  Browse
                </button>
              </div>
            </div>
          )}
          <div className="dialog-row">
            <label>Group</label>
            <input
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Production"
            />
          </div>
          <div className="dialog-row">
            <label className="dialog-checkbox">
              <input
                type="checkbox"
                checked={useJumpHost}
                onChange={(e) => setUseJumpHost(e.target.checked)}
              />
              Use Jump Host (ProxyJump)
            </label>
          </div>
          <div className="dialog-row">
            <label className="dialog-checkbox">
              <input
                type="checkbox"
                checked={agentForward}
                onChange={(e) => setAgentForward(e.target.checked)}
              />
              SSH Agent Forwarding
            </label>
            {agentForward && (
              <div className="dialog-warn">
                ⚠ Only enable for servers you fully trust. Root on the remote host
                can read your SSH agent socket and authenticate as you to any
                other server.
              </div>
            )}
          </div>
          {useJumpHost && (
            <div className="dialog-jump-host">
              <div className="dialog-row-pair">
                <div className="dialog-row" style={{ flex: 1 }}>
                  <label>Jump Host</label>
                  <input
                    type="text"
                    value={jumpHost}
                    onChange={(e) => setJumpHost(e.target.value)}
                    placeholder="bastion.example.com"
                  />
                </div>
                <div className="dialog-row" style={{ width: 80 }}>
                  <label>Port</label>
                  <input
                    type="text"
                    value={jumpPort}
                    onChange={(e) => setJumpPort(e.target.value)}
                  />
                </div>
              </div>
              <div className="dialog-row">
                <label>Username</label>
                <input
                  type="text"
                  value={jumpUsername}
                  onChange={(e) => setJumpUsername(e.target.value)}
                  placeholder="admin"
                />
              </div>
              <div className="dialog-row">
                <label>Auth</label>
                <div className="dialog-radio-group">
                  <label className="dialog-radio">
                    <input
                      type="radio"
                      checked={jumpAuthType === "password"}
                      onChange={() => setJumpAuthType("password")}
                    />
                    Password
                  </label>
                  <label className="dialog-radio">
                    <input
                      type="radio"
                      checked={jumpAuthType === "key"}
                      onChange={() => setJumpAuthType("key")}
                    />
                    Key
                  </label>
                </div>
              </div>
              {jumpAuthType === "password" ? (
                <div className="dialog-row">
                  <label>Password</label>
                  <input
                    type="password"
                    value={jumpPassword}
                    onChange={(e) => setJumpPassword(e.target.value)}
                  />
                </div>
              ) : (
                <div className="dialog-row">
                  <label>Key Path</label>
                  <input
                    type="text"
                    value={jumpKeyPath}
                    onChange={(e) => setJumpKeyPath(e.target.value)}
                    placeholder="~/.ssh/id_rsa"
                  />
                </div>
              )}
            </div>
          )}
          {!isEdit && (
            <div className="dialog-row">
              <label className="dialog-checkbox">
                <input
                  type="checkbox"
                  checked={saveProfile}
                  onChange={(e) => setSaveProfile(e.target.checked)}
                />
                Save to profiles
              </label>
            </div>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="dialog-btn dialog-btn-cancel"
              onClick={onCancel}
            >
              Cancel
            </button>
            {isEdit && (
              <button
                type="button"
                className="dialog-btn dialog-btn-save"
                onClick={handleSaveOnly}
              >
                Save
              </button>
            )}
            <button
              type="button"
              className="dialog-btn dialog-btn-connect"
              onClick={() => handleConnect()}
            >
              {isEdit ? "Save & Connect" : "Connect"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
