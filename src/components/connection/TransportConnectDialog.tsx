import { useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionProtocol, Profile } from "../../types";
import Icon from "../common/Icon";
import ProtocolPicker from "./ProtocolPicker";
import GroupPicker from "./GroupPicker";
import "./ConnectDialog.css";

interface Props {
  protocol: "telnet" | "serial";
  editProfile: Profile | null;
  onProtocolChange: (protocol: ConnectionProtocol) => void;
  onCancel: () => void;
  onSaved: () => void;
  onConnect: (config: {
    host: string;
    port: number;
    baudRate: number;
    profileId?: number;
  }) => void;
}
export default function TransportConnectDialog({
  protocol,
  editProfile,
  onProtocolChange,
  onCancel,
  onSaved,
  onConnect,
}: Props) {
  const serial = protocol === "serial";
  const [name, setName] = useState(editProfile?.name ?? "");
  const [host, setHost] = useState(editProfile?.host ?? "");
  const [port, setPort] = useState(String(editProfile?.port ?? 23));
  const [baud, setBaud] = useState(String(editProfile?.baud_rate ?? 115200));
  const [group, setGroup] = useState(editProfile?.group_name ?? "");
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ports, setPorts] = useState<{ name: string; port_type: string }[]>([]);
  const [portError, setPortError] = useState("");
  const refreshPorts = async () => {
    try {
      setPortError("");
      setPorts(await invoke("list_serial_ports"));
    } catch {
      setPortError(
        "Could not scan ports. Enter a device path manually or try Refresh.",
      );
    }
  };
  useEffect(() => {
    if (serial) void refreshPorts();
  }, [serial]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const connect =
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") !==
      "save";
    const number = Number(serial ? baud : port);
    if (
      !host.trim() ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > (serial ? 4294967295 : 65535)
    ) {
      setError(
        serial
          ? "Enter a device path and a positive baud rate."
          : "Enter a host and a port between 1 and 65535.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      let profileId = editProfile?.id;
      if (save || editProfile) {
        const req = {
          protocol,
          name: name.trim() || host.trim(),
          host: host.trim(),
          port: serial ? 0 : number,
          baud_rate: serial ? number : undefined,
          username: "",
          auth_type: "password",
          group_name: group.trim(),
        };
        const profile = await invoke<Profile>(
          editProfile ? "update_profile" : "create_profile",
          editProfile ? { id: editProfile.id, req } : { req },
        );
        profileId = profile.id;
        onSaved();
      }
      if (connect)
        onConnect({
          host: host.trim(),
          port: serial ? 0 : number,
          baudRate: serial ? number : 115200,
          profileId,
        });
      else onCancel();
    } catch (err) {
      setError(`Could not save connection: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dialog-overlay" onClick={() => !busy && onCancel()}>
      <div
        className="dialog connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transport-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="connection-dialog-heading">
          <div>
            <span className="connection-dialog-eyebrow">
              CONNECTION DETAILS
            </span>
            <h2 className="dialog-title" id="transport-dialog-title">
              {editProfile ? "Edit" : "New"} {serial ? "Serial" : "Telnet"}{" "}
              connection
            </h2>
            <p>
              {serial
                ? "Save your device and console settings."
                : "Connect to a network device or legacy host."}
            </p>
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
          value={protocol}
          onChange={editProfile || busy ? undefined : onProtocolChange}
        />
        <form onSubmit={submit}>
          <fieldset disabled={busy} className="transport-fields">
            <label className="dialog-row">
              Name
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={serial ? "Router console" : "Lab switch"}
              />
            </label>
            <label className="dialog-row">
              {serial ? "Device path" : "Host"}
              <input
                required
                value={host}
                list={serial ? "serial-devices" : undefined}
                onChange={(e) => setHost(e.target.value)}
                placeholder={
                  serial ? "/dev/tty.usbserial or COM3" : "192.168.1.1"
                }
              />
            </label>
            {serial && (
              <>
                <datalist id="serial-devices">
                  {ports.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.port_type}
                    </option>
                  ))}
                </datalist>
                <div className="serial-device-hint">
                  <span>
                    {portError ||
                      (ports.length
                        ? `${ports.length} available ports. You can also enter a path.`
                        : "No ports detected. You can save a device path before plugging it in.")}
                  </span>
                  <button
                    type="button"
                    className="dialog-browse-btn"
                    onClick={() => void refreshPorts()}
                  >
                    Refresh
                  </button>
                </div>
              </>
            )}
            <label className="dialog-row">
              {serial ? "Baud rate" : "Port"}
              <input
                required
                type="number"
                min="1"
                max={serial ? 4294967295 : 65535}
                step="1"
                value={serial ? baud : port}
                onChange={(e) =>
                  serial ? setBaud(e.target.value) : setPort(e.target.value)
                }
                list={serial ? "serial-bauds" : undefined}
              />
            </label>
            {serial && (
              <datalist id="serial-bauds">
                {[
                  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
                ].map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            )}
            <GroupPicker value={group} onChange={setGroup} />
            {!serial && (
              <p className="transport-note">
                Telnet is unencrypted. Log in through the terminal after
                connecting.
              </p>
            )}
            {!editProfile && (
              <label className="dialog-checkbox">
                <input
                  type="checkbox"
                  checked={save}
                  onChange={(e) => setSave(e.target.checked)}
                />
                Save connection
              </label>
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
              {(save || editProfile) && (
                <button
                  type="submit"
                  value="save"
                  className="dialog-btn dialog-btn-save"
                >
                  Save
                </button>
              )}
              <button
                type="submit"
                value="connect"
                className="dialog-btn dialog-btn-connect"
              >
                {busy
                  ? "Saving…"
                  : save || editProfile
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
