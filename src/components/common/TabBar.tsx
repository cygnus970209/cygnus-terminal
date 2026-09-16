import { useEffect, useRef, useState } from "react";
import { Tab, type SessionStatus } from "../../types";
import Icon from "./Icon";
import "./TabBar.css";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  statuses: Record<string, SessionStatus>;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewLocalTab: () => void;
  onNewSshTab: () => void;
  onNewTelnetTab: () => void;
  onNewSerialTab: () => void;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
}

export default function TabBar(props: TabBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sessionTabs = props.tabs.filter(
    (tab) => tab.type !== "connections" && tab.type !== "snippets",
  );
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeTabId]);
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
      <button
        className={`connections-home-button ${props.activeTabId === "connections" ? "is-active" : ""}`}
        aria-pressed={props.activeTabId === "connections"}
        onClick={() => props.onSelectTab("connections")}
      >
        <Icon name="server" size={15} />
        Connections
      </button>
      {props.activeTabId !== "connections" && (
        <button
          className="tabbar-btn"
          onClick={props.onToggleSidebar}
          title={
            props.sidebarCollapsed ? "Show connections" : "Hide connections"
          }
          aria-label="Toggle connections sidebar"
          aria-expanded={!props.sidebarCollapsed}
        >
          <Icon name="panel" />
        </button>
      )}
      <div
        className="tabbar-tabs"
        role="tablist"
        aria-label="Terminal sessions"
      >
        {sessionTabs.map((tab, index) => {
          const active = tab.id === props.activeTabId;
          const status = props.statuses[tab.id] ?? "connecting";
          return (
            <div className={`tab ${active ? "tab-active" : ""}`} key={tab.id}>
              <button
                ref={active ? activeRef : undefined}
                className="tab-select"
                role="tab"
                aria-selected={active}
                tabIndex={
                  active ||
                  (!sessionTabs.some((t) => t.id === props.activeTabId) &&
                    index === 0)
                    ? 0
                    : -1
                }
                title={`${tab.title} · ${status}`}
                onClick={() => props.onSelectTab(tab.id)}
                onKeyDown={(event) => {
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
              </button>
              <button
                className="tab-close"
                onClick={() => props.onCloseTab(tab.id)}
                title={`Close ${tab.title}`}
                aria-label={`Close ${tab.title}`}
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
          onClick={() => setMenuOpen(!menuOpen)}
          aria-expanded={menuOpen}
          aria-controls="new-session-menu"
          title="New session"
          aria-label="New session"
        >
          <Icon name="plus" />
        </button>
        {menuOpen && (
          <div
            id="new-session-menu"
            className="session-menu"
            aria-label="New session options"
          >
            <span className="session-menu-label">NEW SESSION</span>
            {(
              [
                ["SSH connection", props.onNewSshTab, "server"],
                ["Local shell", props.onNewLocalTab, "terminal"],
                ["Telnet connection", props.onNewTelnetTab, "server"],
                ["Serial connection", props.onNewSerialTab, "terminal"],
              ] as const
            ).map(([label, action, icon]) => (
              <button
                key={label}
                onClick={() => {
                  setMenuOpen(false);
                  action();
                }}
              >
                <Icon name={icon} />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
