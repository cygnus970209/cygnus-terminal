import { t, useLocale } from "../../i18n";
import { useEscapeDismiss } from "../../hooks/useEscapeDismiss";
import type { ConnectionChoice } from "../../types/connection";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "../../services/secureInvoke";
import type { Profile } from "../../types";
import Icon from "../common/Icon";
import ProtocolPicker from "./ProtocolPicker";
import GroupPicker from "./GroupPicker";
import "./ConnectDialog.css";

interface Props {
  protocol: "telnet" | "serial";
  editProfile: Profile | null;
  onProtocolChange: (protocol: ConnectionChoice) => void;
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
  useLocale();
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
  const dismissed = useRef(false);
  useEffect(() => {
    dismissed.current = false;
    return () => { dismissed.current = true; };
  }, []);
  useEscapeDismiss(() => { dismissed.current = true; onCancel(); });
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
      if (dismissed.current) return;
      if (connect)
        onConnect({
          host: host.trim(),
          port: serial ? 0 : number,
          baudRate: serial ? number : 115200,
          profileId,
        });
      else onCancel();
    } catch (err) {
      setError(t("Could not save connection: {v0}", { v0: String(err) }));
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
            <span className="connection-dialog-eyebrow">{t("CONNECTION DETAILS")}</span>
            <h2 className="dialog-title" id="transport-dialog-title">
              {editProfile ? t("Edit") : t("New")} {serial ? t("Serial") : "Telnet"}{" "}{t("connection")}</h2>
            <p>
              {serial
                ? t("Save your device and console settings.")
                : t("Connect to a network device or legacy host.")}
            </p>
          </div>
          <button
            className="icon-button"
            disabled={busy}
            aria-label={t("Close connection dialog")}
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
            <label className="dialog-row">{t("Name")}<input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={serial ? t("Router console") : t("Lab switch")}
              />
            </label>
            <label className="dialog-row">
              {serial ? t("Device path") : t("Host")}
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
                        : t("No ports detected. You can save a device path before plugging it in."))}
                  </span>
                  <button
                    type="button"
                    className="dialog-browse-btn"
                    onClick={() => void refreshPorts()}
                  >{t("Refresh")}</button>
                </div>
              </>
            )}
            <label className="dialog-row">
              {serial ? t("Baud rate") : t("Port")}
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
              <p className="transport-note">{t("Telnet is unencrypted. Log in through the terminal after connecting.")}</p>
            )}
            {!editProfile && (
              <label className="dialog-checkbox">
                <input
                  type="checkbox"
                  checked={save}
                  onChange={(e) => setSave(e.target.checked)}
                />{t("Save connection")}</label>
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
              >{t("Cancel")}</button>
              {(save || editProfile) && (
                <button
                  type="submit"
                  value="save"
                  className="dialog-btn dialog-btn-save"
                >{t("Save")}</button>
              )}
              <button
                type="submit"
                value="connect"
                className="dialog-btn dialog-btn-connect"
              >
                {busy
                  ? t("Saving…")
                  : save || editProfile
                    ? t("Save & Connect")
                    : t("Connect")}
              </button>
            </div>
          </fieldset>
        </form>
      </div>
    </div>
  );
}
