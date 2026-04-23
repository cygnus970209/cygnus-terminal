import { useEffect, useRef, useState } from "react";
import "./InputDialog.css";

interface Props {
  title: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export default function InputDialog({
  title,
  initial = "",
  placeholder,
  confirmLabel = "OK",
  onConfirm,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <div className="input-dialog-overlay" onMouseDown={onCancel}>
      <div className="input-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="id-title">{title}</div>
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
          <button className="id-btn id-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="id-btn id-btn-primary" onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
