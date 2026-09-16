import type { ConnectionProtocol } from "../../types";

export default function ProtocolPicker({
  value,
  onChange,
}: {
  value: ConnectionProtocol;
  onChange?: (protocol: ConnectionProtocol) => void;
}) {
  return (
    <div
      className="protocol-picker"
      role="group"
      aria-label="Connection protocol"
    >
      {(["ssh", "telnet", "serial"] as const).map((protocol) => (
        <button
          key={protocol}
          type="button"
          aria-pressed={value === protocol}
          disabled={!onChange && value !== protocol}
          onClick={() => onChange?.(protocol)}
        >
          {protocol === "serial" ? "Serial" : protocol.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
