import { t, useLocale } from "../../i18n";
import Select from "../common/Select";
import type { RdpConfig } from "../../types/rdp";

export default function RdpConfigFields({ config, onChange }: { config: RdpConfig; onChange: (config: RdpConfig) => void }) {
  useLocale();
  return <div className="rdp-config-fields">
      <div className="rdp-fields">
        <label>{t("Server")}<input autoComplete="off" required maxLength={253} placeholder="server.example.com" value={config.host} onChange={(e) => onChange({ ...config, host: e.target.value })} /></label>
        <label>{t("Port")}<input type="number" required min={1} max={65535} value={config.port || ""} onChange={(e) => onChange({ ...config, port: Number(e.target.value) })} /></label>
      </div>
      <label>{t("Username")}<input autoComplete="off" required maxLength={256} value={config.username} onChange={(e) => onChange({ ...config, username: e.target.value })} /></label>
      <label>{t("Domain ")}<span className="rdp-note">{t("Optional")}</span><input autoComplete="off" maxLength={256} value={config.domain} onChange={(e) => onChange({ ...config, domain: e.target.value })} /></label>
      <label>{t("Desktop size")}<Select aria-label={t("RDP desktop size")} value={`${config.width}x${config.height}`} onValueChange={(value) => { const [width, height] = value.split("x").map(Number); onChange({ ...config, width, height }); }}>
        <option value="1280x720">1280 × 720</option><option value="1600x900">1600 × 900</option><option value="1920x1080">1920 × 1080</option>
        {!["1280x720", "1600x900", "1920x1080"].includes(`${config.width}x${config.height}`) && <option value={`${config.width}x${config.height}`}>{config.width} × {config.height}</option>}
      </Select></label>
      <label>{t("Windows scale (DPI)")}<Select aria-label={t("RDP Windows scale")} value={String(config.desktop_scale_factor)} onValueChange={(value) => onChange({ ...config, desktop_scale_factor: Number(value) })}>
        <option value="0">{t("Server default")}</option>
        {[100, 125, 150, 175, 200, 250, 300, 400, 500].map((scale) => <option key={scale} value={String(scale)}>{scale}%</option>)}
        {config.desktop_scale_factor !== 0 && ![100, 125, 150, 175, 200, 250, 300, 400, 500].includes(config.desktop_scale_factor) && <option value={String(config.desktop_scale_factor)}>{config.desktop_scale_factor}%</option>}
      </Select></label>
  </div>;
}
