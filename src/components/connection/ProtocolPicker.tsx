import { t, useLocale } from "../../i18n";
import type { ConnectionChoice } from "../../types/connection";

export default function ProtocolPicker({
  value,
  onChange,
}: {
  value: ConnectionChoice;
  onChange?: (protocol: ConnectionChoice) => void;
}) {
  useLocale();
  return (
    <div
      className="protocol-picker"
      role="group"
      aria-label={t("Connection protocol")}
    >
      {(["ssh", "rdp", "winrm", "telnet", "serial"] as const).map((protocol) => (
        <button
          key={protocol}
          type="button"
          aria-pressed={value === protocol}
          disabled={!onChange && value !== protocol}
          onClick={() => onChange?.(protocol)}
        >
          {protocol === "rdp" ? t("RDP (Beta)") : protocol === "winrm" ? "WinRM" : protocol === "serial" ? t("Serial") : protocol.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
