import type { Tab } from "../types";

export type TabCloseAction = "single" | "others" | "left" | "right";
export type TabDropSide = "before" | "after";

export function toggleTabPin<T extends Tab>(tabs: T[], id: string): T[] {
  const tab = tabs.find((item) => item.id === id);
  if (!tab) return tabs;
  const remaining = tabs.filter((item) => item.id !== id);
  // Pin at the end of the pinned group; unpin at the start of regular tabs.
  const boundary = remaining.filter((item) => item.pinned).length;
  remaining.splice(boundary, 0, { ...tab, pinned: !tab.pinned });
  return remaining;
}

export function moveTab<T extends Tab>(
  tabs: T[], id: string, targetId: string, side: TabDropSide,
): T[] {
  const tab = tabs.find((item) => item.id === id);
  const target = tabs.find((item) => item.id === targetId);
  // Dragging changes order, never the pin state.
  if (!tab || !target || id === targetId || !!tab.pinned !== !!target.pinned) return tabs;
  const remaining = tabs.filter((item) => item.id !== id);
  const index = remaining.findIndex((item) => item.id === targetId);
  remaining.splice(index + (side === "after" ? 1 : 0), 0, tab);
  return remaining;
}

export function tabsToClose(tabs: Tab[], id: string, action: TabCloseAction): Set<string> {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return new Set();
  const closing = new Set(tabs.filter((tab, i) => {
    if (action === "single") return tab.id === id;
    if (tab.pinned || tab.id === id) return false;
    return action === "others" || (action === "left" ? i < index : i > index);
  }).map((tab) => tab.id));

  // Bulk closing must also preserve the SSH connection behind any retained SFTP tab.
  if (action !== "single") {
    for (const tab of tabs) {
      if (tab.linkedSessionId && !closing.has(tab.id)) closing.delete(tab.linkedSessionId);
    }
  }
  for (const tab of tabs) {
    if (tab.linkedSessionId && closing.has(tab.linkedSessionId) && !tab.pinned) {
      closing.add(tab.id);
    }
  }
  return closing;
}

export function activeTabAfterClose(tabs: Tab[], activeId: string | null, closing: Set<string>): string | null {
  if (!activeId || !closing.has(activeId)) return activeId;
  const index = tabs.findIndex((tab) => tab.id === activeId);
  // Prefer the nearest surviving tab on the right, then on the left.
  return tabs.slice(index + 1).find((tab) => !closing.has(tab.id))?.id
    ?? tabs.slice(0, index).reverse().find((tab) => !closing.has(tab.id))?.id
    ?? "connections";
}
