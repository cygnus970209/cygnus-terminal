import { t, useLocale } from "../../i18n";
import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Tab } from "../../types";
import { tabsToClose, type TabCloseAction } from "../../utils/tabs";
import Icon from "./Icon";

interface Props {
  tab: Tab;
  tabs: Tab[];
  x: number;
  y: number;
  onClose: (restoreFocus?: boolean) => void;
  onCloseTabs: (id: string, action: TabCloseAction) => void;
  onTogglePin: (id: string) => void;
}

export default function TabContextMenu({ tab, tabs, x, y, onClose, onCloseTabs, onTogglePin }: Props) {
  useLocale();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current!;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose(false);
    };
    const dismiss = () => onClose(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="tab-context-menu" role="menu" aria-label={t("Tab actions: {v0}", { v0: tab.title })}
      style={{ left: x, top: y }} onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = Array.from(ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      <button role="menuitem" onClick={() => { onTogglePin(tab.id); onClose(true); }}>
        <Icon name="pin" size={14} />
        <span>{tab.pinned ? t("Unpin tab") : t("Pin tab")}</span><kbd>F10</kbd>
      </button>
      <div role="separator" className="tab-menu-divider" />
      {([
        ["single", "Close tab"], ["others", "Close other tabs"],
        ["left", "Close tabs to the left"], ["right", "Close tabs to the right"],
      ] as const).map(([action, label]) => (
        <button key={action} role="menuitem" disabled={!tabsToClose(tabs, tab.id, action).size}
          onClick={() => { onCloseTabs(tab.id, action); onClose(true); }}>
          <span>{t(label)}</span>
        </button>
      ))}
      <p className="tab-menu-hint">{t("Pinned tabs stay open when closing other tabs.")}</p>
    </div>, document.body,
  );
}
