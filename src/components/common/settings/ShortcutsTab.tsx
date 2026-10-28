import { t, useLocale } from "../../../i18n";
interface Shortcut {
  keys: string;
  label: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: "Esc", label: "Close topmost dialog" },
  { keys: "⌘ / Ctrl N", label: "New SSH connection" },
  { keys: "⌘ / Ctrl T", label: "New Local shell" },
  { keys: "⌘ ,", label: "Settings" },
  { keys: "⌘ K", label: "Command Palette" },
  { keys: "F10", label: "Pin / unpin active tab (Fn + F10 on some keyboards)" },
  { keys: "Shift F10", label: "Open focused tab menu" },
];

export default function ShortcutsTab() {
  useLocale();
  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("Keyboard Shortcuts")}</h3>
      <div className="settings-shortcuts">
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="settings-shortcut">
            <span className="settings-key">{s.keys}</span>
            <span>{t(s.label)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
