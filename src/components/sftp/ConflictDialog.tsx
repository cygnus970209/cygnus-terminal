import { t, useLocale } from "../../i18n";
import { useEscapeDismiss } from "../../hooks/useEscapeDismiss";
import { useState } from "react";
import "./ConflictDialog.css";

export type ConflictAction = "replace" | "keep-both" | "skip";

export interface ConflictResolution {
  action: ConflictAction;
  applyToAll: boolean;
}

interface Props {
  fileName: string;
  remaining: number; // 뒤에 줄 서있는 잠재 충돌 개수 (정보용)
  onResolve: (resolution: ConflictResolution) => void;
}

export default function ConflictDialog({ fileName, remaining, onResolve }: Props) {
  useLocale();
  const [applyToAll, setApplyToAll] = useState(false);
  useEscapeDismiss(() => onResolve({ action: "skip", applyToAll }), true, 2000);


  return (
    <div className="conflict-overlay">
      <div className="conflict-dialog" role="dialog" aria-modal="true" aria-label={t("File conflict")}>
        <div className="cd-title">{t("File already exists")}</div>
        <div className="cd-message">
          <span className="cd-filename">&quot;{fileName}&quot;</span>{t(" already exists at the destination.")}</div>

        {remaining > 0 && (
          <label className="cd-apply-all">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
            />
            <span>{t("Apply to all (")}{remaining}{t(" more pending)")}</span>
          </label>
        )}

        <div className="cd-actions">
          <button
            className="cd-btn cd-btn-skip"
            onClick={() => onResolve({ action: "skip", applyToAll })}
          >{t("Skip")}</button>
          <button
            className="cd-btn cd-btn-keep"
            onClick={() => onResolve({ action: "keep-both", applyToAll })}
          >{t("Keep Both")}</button>
          <button
            className="cd-btn cd-btn-replace"
            onClick={() => onResolve({ action: "replace", applyToAll })}
          >{t("Replace")}</button>
        </div>
      </div>
    </div>
  );
}
