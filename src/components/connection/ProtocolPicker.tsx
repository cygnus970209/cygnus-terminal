import type { ConnectionChoice } from "../../types/connection";

export default function ProtocolPicker({
  value,
  onChange,
}: {
  value: ConnectionChoice;
  onChange?: (protocol: ConnectionChoice) => void;
}) {
  return (
    <div
      className="protocol-picker"
      role="group"
      aria-label="Connection protocol"
    >
      {(["ssh", "rdp", "telnet", "serial"] as const).map((protocol) => (
        <button
          key={protocol}
          type="button"
          aria-pressed={value === protocol}
          disabled={!onChange && value !== protocol}
          onClick={() => onChange?.(protocol)}
        >
          {protocol === "rdp" ? "RDP (Beta)" : protocol === "serial" ? "Serial" : protocol.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
