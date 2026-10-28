import { t, useLocale } from "../../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Tab, type SessionStatus } from "../../types";
import { type TabCloseAction, type TabDropSide } from "../../utils/tabs";
import { useTabDrag } from "../../hooks/useTabDrag";
import TabContextMenu from "./TabContextMenu";
import Icon from "./Icon";
import "./TabBar.css";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  statuses: Record<string, SessionStatus>;
  onSelectTab: (id: string) => void;
  onCloseTabs: (id: string, action: TabCloseAction) => void;
  onTogglePin: (id: string) => void;
  onMoveTab: (id: string, targetId: string, side: TabDropSide) => void;
  onNewLocalTab: () => void;
  onNewSshTab: () => void;
  onNewTelnetTab: () => void;
  onNewSerialTab: () => void;
  onNewRdpTab: () => void;
  onNewWinrmTab: () => void;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
}

export default function TabBar(props: TabBarProps) {
  useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const sessionTabs = props.tabs;
  const tabOrder = sessionTabs.map((tab) => tab.id).join(",");
  const contextTab = sessionTabs.find((tab) => tab.id === contextMenu?.id);
  const drag = useTabDrag(listRef, props.onMoveTab);
  const closeContextMenu = useCallback((restoreFocus = false) => {
    setContextMenu(null);
    if (restoreFocus) requestAnimationFrame(() => {
      const target = listRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
        ?? listRef.current?.querySelector<HTMLButtonElement>('[role="tab"]');
      (target ?? triggerRef.current)?.focus();
    });
  }, []);
  function openContextMenu(tab: Tab, x: number, y: number) {
    setMenuOpen(false);
    props.onSelectTab(tab.id);
    setContextMenu({ id: tab.id, x, y });
  }
  useEffect(() => {
    activeRef.current?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeTabId, tabOrder]);
  useEffect(() => {
    if (!menuOpen) return;
    const click = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", click);
      document.removeEventListener("keydown", key);
    };
  }, [menuOpen]);
  return (
    <div className="tabbar">
      {props.activeTabId !== "connections" && (
        <button
          className="tabbar-btn"
          onClick={props.onToggleSidebar}
          title={
            props.sidebarCollapsed ? t("Show connections") : t("Hide connections")
          }
          aria-label={t("Toggle connections sidebar")}
          aria-expanded={!props.sidebarCollapsed}
        >
          <Icon name="panel" />
        </button>
      )}
      <div
        ref={listRef}
        className="tabbar-tabs"
        role="tablist"
        aria-label={t("Terminal sessions")}
        onScroll={() => closeContextMenu()}
      >
        {sessionTabs.map((tab, index) => {
          const active = tab.id === props.activeTabId;
          const status = props.statuses[tab.id] ?? "connecting";
          return (
            <div
              className={`tab ${active ? "tab-active" : ""} ${tab.pinned ? "tab-pinned" : ""} ${drag.draggingId === tab.id ? "tab-dragging" : ""} ${drag.dropTarget?.id === tab.id ? `tab-drop-${drag.dropTarget.side}` : ""}`}
              key={tab.id} data-tab-id={tab.id} data-pinned={!!tab.pinned}
              onContextMenu={(event) => {
                event.preventDefault();
                openContextMenu(tab, event.clientX, event.clientY);
              }}
            >
              <button
                ref={active ? activeRef : undefined}
                className="tab-select"
                role="tab"
                aria-selected={active}
                aria-label={`${tab.title}${tab.pinned ? t(", pinned") : ""}, ${t(status)}`}
                aria-haspopup="menu"
                tabIndex={
                  active ||
                  (!sessionTabs.some((t) => t.id === props.activeTabId) &&
                    index === 0)
                    ? 0
                    : -1
                }
                title={`${tab.title} · ${t(status)}${tab.pinned ? t(" · Pinned") : ""}\n${t("Drag to reorder · Right-click for tab actions")}`}
                onPointerDown={(event) => {
                  closeContextMenu();
                  drag.onPointerDown(event, tab.id, !!tab.pinned);
                }}
                onPointerMove={drag.onPointerMove}
                onPointerUp={drag.onPointerUp}
                onPointerCancel={drag.onPointerCancel}
                onLostPointerCapture={drag.onLostPointerCapture}
                onClick={(event) => {
                  if (drag.consumeClick()) { event.preventDefault(); return; }
                  props.onSelectTab(tab.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openContextMenu(tab, rect.left, rect.bottom);
                    return;
                  }
                  const offset =
                    event.key === "ArrowRight"
                      ? 1
                      : event.key === "ArrowLeft"
                        ? -1
                        : 0;
                  const target =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? sessionTabs.length - 1
                        : offset
                          ? (index + offset + sessionTabs.length) %
                            sessionTabs.length
                          : -1;
                  if (target >= 0) {
                    event.preventDefault();
                    props.onSelectTab(sessionTabs[target].id);
                    requestAnimationFrame(() => activeRef.current?.focus());
                  }
                }}
              >
                {tab.type === "sftp" ? (
                  <Icon name="folder" size={14} />
                ) : (
                  <span
                    className={`session-dot session-dot-${status}`}
                    aria-label={status}
                  />
                )}
                <span className="tab-title">{tab.title}</span>
                {tab.pinned && <span className="tab-pin" title={t("Pinned · F10 to unpin")}><Icon name="pin" size={13} /></span>}
              </button>
              <button
                className="tab-close"
                onClick={() => props.onCloseTabs(tab.id, "single")}
                title={t("Close {v0}", { v0: tab.title })}
                aria-label={t("Close {v0}", { v0: tab.title })}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="tabbar-actions" ref={menuRef}>
        <button
          ref={triggerRef}
          className="tabbar-btn"
          onClick={() => { closeContextMenu(); setMenuOpen(!menuOpen); }}
          aria-expanded={menuOpen}
          aria-controls="new-session-menu"
          title={t("New session")}
          aria-label={t("New session")}
        >
          <Icon name="plus" />
        </button>
        {menuOpen && (
          <div
            id="new-session-menu"
            className="session-menu"
            aria-label={t("New session options")}
          >
            <span className="session-menu-label">{t("NEW SESSION")}</span>
            {(
              [
                ["SSH connection", props.onNewSshTab, "server"],
                ["RDP desktop (Beta)", props.onNewRdpTab, "monitor"],
                ["WinRM connection", props.onNewWinrmTab, "server"],
                ["Local shell", props.onNewLocalTab, "terminal"],
                ["Telnet connection", props.onNewTelnetTab, "server"],
                ["Serial connection", props.onNewSerialTab, "terminal"],
              ] as const
            ).map(([label, action, icon]) => (
              <button
                key={t(label)}
                onClick={() => {
                  setMenuOpen(false);
                  action();
                }}
              >
                <Icon name={icon} />
                {t(label)}
              </button>
            ))}
          </div>
        )}
      </div>
      {contextMenu && contextTab && (
        <TabContextMenu key={contextTab.id} tab={contextTab} tabs={sessionTabs}
          x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu}
          onCloseTabs={props.onCloseTabs} onTogglePin={props.onTogglePin} />
      )}
    </div>
  );
}
