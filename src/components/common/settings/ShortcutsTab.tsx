interface Shortcut {
  keys: string;
  label: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: "⌘ ,", label: "Settings" },
  { keys: "⌘ K", label: "Command Palette" },
];

export default function ShortcutsTab() {
  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Keyboard Shortcuts</h3>
      <div className="settings-shortcuts">
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="settings-shortcut">
            <span className="settings-key">{s.keys}</span>
            <span>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
