import { useTheme } from "../../../hooks/useTheme";
import type { TerminalTheme } from "../../../themes";
import "./ThemeTab.css";

/** 카드에 노출할 핵심 색상 swatch 6개 (background/foreground/cursor + ANSI 3색). */
function pickSwatches(theme: TerminalTheme): string[] {
  const c = theme.colors;
  return [
    c.background ?? "#000",
    c.foreground ?? "#fff",
    c.cursor ?? c.foreground ?? "#fff",
    c.red ?? "#f00",
    c.green ?? "#0f0",
    c.blue ?? "#00f",
  ];
}

export default function ThemeTab() {
  const { themeId, setThemeId, presets } = useTheme();

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Terminal Theme</h3>
      <p className="settings-desc">
        터미널의 색상 테마를 선택합니다. 변경 즉시 모든 터미널 탭에 반영됩니다.
      </p>
      <div className="theme-grid" role="radiogroup">
        {presets.map((preset) => {
          const selected = preset.id === themeId;
          const swatches = pickSwatches(preset);
          return (
            <button
              key={preset.id}
              role="radio"
              aria-checked={selected}
              className={`theme-card ${selected ? "theme-card-selected" : ""}`}
              onClick={() => setThemeId(preset.id)}
              style={{
                backgroundColor: preset.colors.background,
                color: preset.colors.foreground,
              }}
            >
              <div className="theme-card-preview">
                <span
                  className="theme-card-prompt"
                  style={{ color: preset.colors.green }}
                >
                  $
                </span>
                <span
                  className="theme-card-cmd"
                  style={{ color: preset.colors.foreground }}
                >
                  echo&nbsp;
                </span>
                <span
                  className="theme-card-arg"
                  style={{ color: preset.colors.yellow }}
                >
                  hello
                </span>
                <span
                  className="theme-card-cursor"
                  style={{
                    backgroundColor: preset.colors.cursor,
                  }}
                />
              </div>
              <div className="theme-card-name">{preset.name}</div>
              <div className="theme-card-swatches">
                {swatches.map((c, i) => (
                  <span
                    key={i}
                    className="theme-card-swatch"
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
