import { useEffect, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Profile, SshConfig, JumpHostConfig } from "../../types";
import { DEFAULT_SSH_PORT } from "../../constants";
import "./ConnectDialog.css";
import Icon from "../common/Icon";
import ProtocolPicker from "./ProtocolPicker";
import GroupPicker from "./GroupPicker";
import type { ConnectionProtocol } from "../../types";

interface ConnectDialogProps {
  onConnect: (config: SshConfig) => void;
  onCancel: () => void;
  onSaved?: () => void;
  editProfile?: Profile | null;
  onProtocolChange?: (protocol: ConnectionProtocol) => void;
}

interface FormState {
  name: string;
  host: string;
  port: string;
  username: string;
  authType: "password" | "key";
  password: string;
  keyPath: string;
  groupName: string;
  saveProfile: boolean;
  useJumpHost: boolean;
  jumpHost: string;
  jumpPort: string;
  jumpUsername: string;
  jumpAuthType: "password" | "key";
  jumpPassword: string;
  jumpKeyPath: string;
  agentForward: boolean;
}

const initialFormState: FormState = {
  name: "",
  host: "",
  port: String(DEFAULT_SSH_PORT),
  username: "",
  authType: "password",
  password: "",
  keyPath: "",
  groupName: "",
  saveProfile: true,
  useJumpHost: false,
  jumpHost: "",
  jumpPort: String(DEFAULT_SSH_PORT),
  jumpUsername: "",
  jumpAuthType: "password",
  jumpPassword: "",
  jumpKeyPath: "",
  agentForward: false,
};

type FormAction =
  | { type: "set"; field: keyof FormState; value: FormState[keyof FormState] }
  | { type: "populate"; profile: Profile };

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "set":
      return { ...state, [action.field]: action.value };
    case "populate": {
      const p = action.profile;
      let jump: Partial<FormState> = { useJumpHost: false };
      if (p.jump_host) {
        try {
          const jh = JSON.parse(p.jump_host);
          jump = {
            useJumpHost: true,
            jumpHost: jh.host || "",
            jumpPort: String(jh.port || DEFAULT_SSH_PORT),
            jumpUsername: jh.username || "",
            jumpAuthType: jh.auth_type || "password",
            jumpKeyPath: jh.key_path || "",
            jumpPassword: "",
          };
        } catch (e) {
          console.error("Failed to parse jump host config:", e);
        }
      }
      return {
        ...initialFormState,
        name: p.name,
        host: p.host,
        port: String(p.port),
        username: p.username,
        authType: p.auth_type,
        keyPath: p.key_path || "",
        groupName: p.group_name || "",
        password: "",
        saveProfile: true,
        agentForward: p.agent_forward || false,
        ...jump,
      };
    }
  }
}

export default function ConnectDialog({
  onConnect,
  onCancel,
  onSaved,
  editProfile,
  onProtocolChange,
}: ConnectDialogProps) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, dispatch] = useReducer(formReducer, initialFormState);
  const setField = <K extends keyof FormState>(field: K, value: FormState[K]) =>
    dispatch({ type: "set", field, value });

  const isEdit = !!editProfile;

  useEffect(() => {
    if (editProfile) dispatch({ type: "populate", profile: editProfile });
  }, [editProfile]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const buildJumpHostJson = (): string | undefined => {
    if (!form.useJumpHost || !form.jumpHost) return undefined;
    return JSON.stringify({
      host: form.jumpHost,
      port: parseInt(form.jumpPort) || DEFAULT_SSH_PORT,
      username: form.jumpUsername,
      auth_type: form.jumpAuthType,
      password:
        form.jumpAuthType === "password" ? form.jumpPassword : undefined,
      key_path: form.jumpAuthType === "key" ? form.jumpKeyPath : undefined,
    });
  };

  const buildJumpHostConfig = (): JumpHostConfig | undefined => {
    if (!form.useJumpHost || !form.jumpHost) return undefined;
    return {
      host: form.jumpHost,
      port: parseInt(form.jumpPort) || DEFAULT_SSH_PORT,
      username: form.jumpUsername,
      auth_type: form.jumpAuthType,
      password:
        form.jumpAuthType === "password" ? form.jumpPassword : undefined,
      key_path: form.jumpAuthType === "key" ? form.jumpKeyPath : undefined,
    };
  };

  const handleSave = async (): Promise<Profile | null> => {
    if (!form.saveProfile) return null;

    setBusy(true);
    setError("");
    const jumpHostJson = buildJumpHostJson();

    try {
      if (isEdit && editProfile) {
        const updated = await invoke<Profile>("update_profile", {
          id: editProfile.id,
          req: {
            name: form.name || `${form.username}@${form.host}`,
            host: form.host,
            port: parseInt(form.port) || DEFAULT_SSH_PORT,
            username: form.username,
            auth_type: form.authType,
            password:
              form.authType === "password" && form.password
                ? form.password
                : undefined,
            key_path: form.authType === "key" ? form.keyPath : undefined,
            group_name: form.groupName.trim(),
            // 빈 문자열 = jump host 제거 (null 은 "변경 없음"으로 역직렬화되어 해제가 안 됨)
            jump_host: jumpHostJson ?? "",
            agent_forward: form.agentForward,
          },
        });
        onSaved?.();
        return updated;
      } else {
        const created = await invoke<Profile>("create_profile", {
          req: {
            name: form.name || `${form.username}@${form.host}`,
            host: form.host,
            port: parseInt(form.port) || DEFAULT_SSH_PORT,
            username: form.username,
            auth_type: form.authType,
            password: form.authType === "password" ? form.password : undefined,
            key_path: form.authType === "key" ? form.keyPath : undefined,
            group_name: form.groupName.trim(),
            jump_host: jumpHostJson,
            agent_forward: form.agentForward,
          },
        });
        onSaved?.();
        return created;
      }
    } catch (err) {
      setError(`Could not save connection: ${String(err)}`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = async (e?: React.FormEvent | React.MouseEvent) => {
    e?.preventDefault?.();
    if (busy) return;
    if (
      !form.host.trim() ||
      !form.username.trim() ||
      !Number.isInteger(Number(form.port)) ||
      Number(form.port) < 1 ||
      Number(form.port) > 65535
    ) {
      setError("Enter a host, username and a port between 1 and 65535.");
      return;
    }

    // 새 프로필을 저장한 경우 그 id 를 SshConfig 에 실어 보낸다.
    // profileId 가 비면 App 의 ServerContext (left sidebar) 가 conditional render
    // 단계에서 떨어져 첫 접속 시 패널이 안 뜨는 회귀를 만든다.
    const saved = await handleSave();
    if (form.saveProfile && !saved) return;

    onConnect({
      host: form.host,
      port: parseInt(form.port) || DEFAULT_SSH_PORT,
      username: form.username,
      authType: form.authType,
      password:
        form.authType === "password"
          ? (saved?.password ?? form.password)
          : undefined,
      keyPath:
        form.authType === "key" ? (saved?.key_path ?? form.keyPath) : undefined,
      profileId: isEdit ? editProfile?.id : saved?.id,
      jumpHost: saved?.jump_host
        ? JSON.parse(saved.jump_host)
        : buildJumpHostConfig(),
      agentForward: form.agentForward,
    });
  };

  const handleSaveOnly = async () => {
    if (busy) return;
    if (
      !form.host.trim() ||
      !form.username.trim() ||
      !Number.isInteger(Number(form.port)) ||
      Number(form.port) < 1 ||
      Number(form.port) > 65535
    ) {
      setError("Enter a host, username and a port between 1 and 65535.");
      return;
    }
    if (await handleSave()) onCancel();
  };

  return (
    <div className="dialog-overlay" onClick={() => !busy && onCancel()}>
      <div
        className="dialog connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="connection-dialog-heading">
          <div>
            <span className="connection-dialog-eyebrow">
              CONNECTION DETAILS
            </span>
            <h2 id="connection-dialog-title" className="dialog-title">
              {isEdit ? "Edit SSH connection" : "New SSH connection"}
            </h2>
            <p>Secure access to your server.</p>
          </div>
          <button
            className="icon-button"
            disabled={busy}
            aria-label="Close connection dialog"
            onClick={onCancel}
          >
            <Icon name="close" />
          </button>
        </div>
        <ProtocolPicker
          value="ssh"
          onChange={isEdit || busy ? undefined : onProtocolChange}
        />
        <form onSubmit={handleConnect}>
          <fieldset className="transport-fields" disabled={busy}>
            <div className="dialog-row-pair connection-name-group">
              <div className="dialog-row">
                <label>Name</label>
                <input
                  aria-label="Name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                  placeholder="My Server"
                  autoFocus
                />
              </div>
              <GroupPicker
                value={form.groupName}
                onChange={(value) => setField("groupName", value)}
              />
            </div>
            <div className="dialog-row-pair">
              <div className="dialog-row" style={{ flex: 1 }}>
                <label>Host</label>
                <input
                  aria-label="Host"
                  type="text"
                  value={form.host}
                  onChange={(e) => setField("host", e.target.value)}
                  placeholder="192.168.1.1"
                />
              </div>
              <div className="dialog-row" style={{ width: 80 }}>
                <label>Port</label>
                <input
                  aria-label="Port"
                  type="text"
                  value={form.port}
                  onChange={(e) => setField("port", e.target.value)}
                  placeholder="22"
                />
              </div>
            </div>
            <div className="dialog-row">
              <label>Username</label>
              <input
                aria-label="Username"
                type="text"
                value={form.username}
                onChange={(e) => setField("username", e.target.value)}
                placeholder="root"
              />
            </div>
            <div className="dialog-row">
              <label>Auth</label>
              <div className="dialog-radio-group">
                <label className="dialog-radio">
                  <input
                    type="radio"
                    checked={form.authType === "password"}
                    onChange={() => setField("authType", "password")}
                  />
                  Password
                </label>
                <label className="dialog-radio">
                  <input
                    type="radio"
                    checked={form.authType === "key"}
                    onChange={() => setField("authType", "key")}
                  />
                  Private Key
                </label>
              </div>
            </div>
            {form.authType === "password" ? (
              <div className="dialog-row">
                <label>
                  Password{isEdit && " (leave empty to keep current)"}
                </label>
                <input
                  aria-label="Password"
                  type="password"
                  value={form.password}
                  onChange={(e) => setField("password", e.target.value)}
                />
              </div>
            ) : (
              <div className="dialog-row">
                <label>Key Path</label>
                <div className="dialog-input-with-btn">
                  <input
                    aria-label="Key path"
                    type="text"
                    value={form.keyPath}
                    onChange={(e) => setField("keyPath", e.target.value)}
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
                      if (selected) setField("keyPath", selected as string);
                    }}
                  >
                    Browse
                  </button>
                </div>
              </div>
            )}
            <details className="connection-advanced">
              <summary>
                Advanced SSH options <span>Jump host · Agent forwarding</span>
              </summary>
              <div className="dialog-row">
                <label className="dialog-checkbox">
                  <input
                    type="checkbox"
                    checked={form.useJumpHost}
                    onChange={(e) => setField("useJumpHost", e.target.checked)}
                  />
                  Use Jump Host (ProxyJump)
                </label>
              </div>
              <div className="dialog-row">
                <label className="dialog-checkbox">
                  <input
                    type="checkbox"
                    checked={form.agentForward}
                    onChange={(e) => setField("agentForward", e.target.checked)}
                  />
                  SSH Agent Forwarding
                </label>
                {form.agentForward && (
                  <div className="dialog-warn">
                    ⚠ Only enable for servers you fully trust. Root on the
                    remote host can read your SSH agent socket and authenticate
                    as you to any other server.
                  </div>
                )}
              </div>
              {form.useJumpHost && (
                <div className="dialog-jump-host">
                  <div className="dialog-row-pair">
                    <div className="dialog-row" style={{ flex: 1 }}>
                      <label>Jump Host</label>
                      <input
                        aria-label="Jump host"
                        type="text"
                        value={form.jumpHost}
                        onChange={(e) => setField("jumpHost", e.target.value)}
                        placeholder="bastion.example.com"
                      />
                    </div>
                    <div className="dialog-row" style={{ width: 80 }}>
                      <label>Port</label>
                      <input
                        aria-label="Jump port"
                        type="text"
                        value={form.jumpPort}
                        onChange={(e) => setField("jumpPort", e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="dialog-row">
                    <label>Username</label>
                    <input
                      aria-label="Jump username"
                      type="text"
                      value={form.jumpUsername}
                      onChange={(e) => setField("jumpUsername", e.target.value)}
                      placeholder="admin"
                    />
                  </div>
                  <div className="dialog-row">
                    <label>Auth</label>
                    <div className="dialog-radio-group">
                      <label className="dialog-radio">
                        <input
                          type="radio"
                          checked={form.jumpAuthType === "password"}
                          onChange={() => setField("jumpAuthType", "password")}
                        />
                        Password
                      </label>
                      <label className="dialog-radio">
                        <input
                          type="radio"
                          checked={form.jumpAuthType === "key"}
                          onChange={() => setField("jumpAuthType", "key")}
                        />
                        Key
                      </label>
                    </div>
                  </div>
                  {form.jumpAuthType === "password" ? (
                    <div className="dialog-row">
                      <label>
                        Password{isEdit && " (leave empty to keep current)"}
                      </label>
                      <input
                        aria-label="Jump password"
                        type="password"
                        value={form.jumpPassword}
                        onChange={(e) =>
                          setField("jumpPassword", e.target.value)
                        }
                      />
                    </div>
                  ) : (
                    <div className="dialog-row">
                      <label>Key Path</label>
                      <input
                        aria-label="Jump key path"
                        type="text"
                        value={form.jumpKeyPath}
                        onChange={(e) =>
                          setField("jumpKeyPath", e.target.value)
                        }
                        placeholder="~/.ssh/id_rsa"
                      />
                    </div>
                  )}
                </div>
              )}
            </details>
            {!isEdit && (
              <div className="dialog-row">
                <label className="dialog-checkbox">
                  <input
                    type="checkbox"
                    checked={form.saveProfile}
                    onChange={(e) => setField("saveProfile", e.target.checked)}
                  />
                  Save to profiles
                </label>
              </div>
            )}
            {error && (
              <p className="connection-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="dialog-btn dialog-btn-cancel"
                onClick={onCancel}
              >
                Cancel
              </button>
              {form.saveProfile && (
                <button
                  type="button"
                  disabled={busy}
                  className="dialog-btn dialog-btn-save"
                  onClick={handleSaveOnly}
                >
                  Save
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                className="dialog-btn dialog-btn-connect"
                onClick={() => handleConnect()}
              >
                {busy
                  ? "Saving…"
                  : form.saveProfile
                    ? "Save & Connect"
                    : "Connect"}
              </button>
            </div>
          </fieldset>
        </form>
      </div>
    </div>
  );
}
