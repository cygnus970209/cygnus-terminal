import { t, useLocale } from "../../../i18n";
import { version } from "../../../../package.json";

export default function AboutTab() {
  useLocale();
  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("About")}</h3>
      <p className="settings-desc">
        Cygnus Terminal v{version}
        <br />{t("개발자를 위한 올인원 터미널.")}</p>
    </div>
  );
}
