import { useState } from "react";
import { setLocale, t, useLocale, type Locale } from "../../../i18n";
import Select from "../Select";

export default function GeneralTab() {
  const locale = useLocale();
  const [error, setError] = useState(false);
  return <div className="settings-section">
    <h3 className="settings-section-title">{t("Language")}</h3>
    <p className="settings-desc">{t("Choose the app language. Changes apply immediately to all windows and are remembered next time.")}</p>
    <Select aria-label={t("Language")} value={locale} onValueChange={(value) => {
      try { setLocale(value as Locale); setError(false); } catch { setError(true); }
    }}>
      <option value="en">English</option>
      <option value="ko">한국어</option>
    </Select>
    {error && <p className="settings-desc" role="alert">{t("Could not save the language setting. Try again.")}</p>}
  </div>;
}
