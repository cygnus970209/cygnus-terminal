import { t, useLocale } from "../../i18n";
import { useEffect, useRef } from "react";
import "./TerminalClipboardMenu.css";

export default function TerminalClipboardMenu({ position, canCopy, canPaste, onCopy, onPaste, onClose }: {
  position: { x: number; y: number }; canCopy: boolean; canPaste: boolean;
  onCopy: () => void; onPaste: () => void; onClose: (restoreFocus?: boolean) => void;
}) {
  useLocale();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const blur = () => onClose();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("blur", blur);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("blur", blur); };
  }, [onClose]);
  return <div ref={ref} className="terminal-clipboard-menu" role="menu" aria-label={t("Terminal clipboard")}
    style={{ left: Math.max(8, Math.min(position.x, window.innerWidth - 188)), top: Math.max(8, Math.min(position.y, window.innerHeight - 100)) }}
    onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); onClose(true); }
      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    }}>
    <button role="menuitem" disabled={!canCopy} onClick={onCopy}>{t("Copy")}</button>
    <button role="menuitem" disabled={!canPaste} onClick={onPaste}>{t("Paste")}</button>
  </div>;
}
