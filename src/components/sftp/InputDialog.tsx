import { t, useLocale } from "../../i18n";
import { useEscapeDismiss } from "../../hooks/useEscapeDismiss";
import { useEffect, useRef, useState } from "react";
import "./InputDialog.css";

interface Props {
  title: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** 타이틀 아래에 노출할 보조 설명 또는 경고. 색/아이콘은 호출하는 쪽이 문자열에 직접 넣음. */
  warning?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export default function InputDialog({
  title,
  initial = "",
  placeholder,
  confirmLabel = "OK",
  warning,
  onConfirm,
  onCancel,
}: Props) {
  useLocale();
  useEscapeDismiss(onCancel, true, 2000);
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);


  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <div className="input-dialog-overlay" onMouseDown={onCancel}>
      <div className="input-dialog" role="dialog" aria-modal="true" aria-label={t("Input")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="id-title">{title}</div>
        {warning && <div className="id-warn">{warning}</div>}
        <input
          ref={inputRef}
          className="id-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <div className="id-actions">
          <button className="id-btn id-btn-secondary" onClick={onCancel}>{t("Cancel")}</button>
          <button className="id-btn id-btn-primary" onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
