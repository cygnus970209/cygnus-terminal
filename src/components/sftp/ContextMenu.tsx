import { useEffect, useRef } from "react";
import "./ContextMenu.css";

export interface MenuItem {
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
  onClick?: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 다음 tick 에 붙여서 열린 클릭 자체가 바로 close 시키는 것을 방지
    const t = setTimeout(() => {
      window.addEventListener("mousedown", handleOutside);
      window.addEventListener("keydown", handleKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", handleOutside);
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // 화면 경계 밖으로 넘어가지 않도록 약간 보정
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const overflowX = rect.right - window.innerWidth;
    const overflowY = rect.bottom - window.innerHeight;
    if (overflowX > 0) el.style.left = `${x - overflowX - 4}px`;
    if (overflowY > 0) el.style.top = `${y - overflowY - 4}px`;
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.divider ? (
          <div key={`div-${i}`} className="ctx-divider" />
        ) : (
          <button
            key={`item-${i}`}
            className={`ctx-item ${item.disabled ? "ctx-disabled" : ""} ${
              item.danger ? "ctx-danger" : ""
            }`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onClick?.();
              onClose();
            }}
          >
            <span className="ctx-icon">{item.icon || " "}</span>
            <span className="ctx-label">{item.label}</span>
            {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
