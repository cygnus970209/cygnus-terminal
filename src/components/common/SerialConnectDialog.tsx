import { useEffect, useState } from "react";
import "./SerialConnectDialog.css";

export interface SerialPortInfo {
  name: string;
  port_type: string;
}

interface Props {
  ports: SerialPortInfo[];
  onConnect: (portName: string, baudRate: number) => void;
  onCancel: () => void;
}

const COMMON_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export default function SerialConnectDialog({ ports, onConnect, onCancel }: Props) {
  const [selectedPort, setSelectedPort] = useState<string>(ports[0]?.name || "");
  const [baud, setBaud] = useState<number>(115200);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && selectedPort) onConnect(selectedPort, baud);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedPort, baud, onConnect, onCancel]);

  return (
    <div className="sd-overlay" onMouseDown={onCancel}>
      <div className="sd-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sd-title">Connect Serial Port</div>

        <label className="sd-label">Port</label>
        <select
          className="sd-input"
          value={selectedPort}
          onChange={(e) => setSelectedPort(e.target.value)}
        >
          {ports.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name} — {p.port_type}
            </option>
          ))}
        </select>

        <label className="sd-label">Baud rate</label>
        <div className="sd-baud-row">
          <input
            className="sd-input sd-baud-input"
            type="number"
            value={baud}
            onChange={(e) => setBaud(parseInt(e.target.value) || 115200)}
          />
          <div className="sd-baud-presets">
            {COMMON_BAUDS.map((b) => (
              <button
                key={b}
                className={`sd-preset ${b === baud ? "active" : ""}`}
                onClick={() => setBaud(b)}
              >
                {b}
              </button>
            ))}
          </div>
        </div>

        <div className="sd-actions">
          <button className="sd-btn sd-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="sd-btn sd-btn-primary"
            disabled={!selectedPort}
            onClick={() => onConnect(selectedPort, baud)}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
