import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { TabDropSide } from "../utils/tabs";

interface DropTarget {
  id: string;
  side: TabDropSide;
}
interface Drag {
  id: string;
  pointerId: number;
  pinned: boolean;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
  target: DropTarget | null;
}

/** Pointer capture avoids native file-drag interception in Tauri's Windows WebView. */
export function useTabDrag(
  listRef: RefObject<HTMLDivElement | null>,
  onMove: (id: string, targetId: string, side: TabDropSide) => void,
) {
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  function updateTarget() {
    const current = drag.current;
    const list = listRef.current;
    if (!current || !list) return;
    const bounds = list.getBoundingClientRect();
    let target: DropTarget | null = null;
    if (current.y >= bounds.top - 24 && current.y <= bounds.bottom + 24 &&
      current.x >= bounds.left - 24 && current.x <= bounds.right + 24) {
      const elements = Array.from(list.querySelectorAll<HTMLElement>('[data-tab-id]'));
      const hit = elements.find((el) => {
        const rect = el.getBoundingClientRect();
        return current.x >= rect.left && current.x <= rect.right;
      }) ?? (current.x < bounds.left ? elements[0] : elements[elements.length - 1]);
      if (hit && hit.dataset.pinned === String(current.pinned) && hit.dataset.tabId !== current.id) {
        const rect = hit.getBoundingClientRect();
        target = { id: hit.dataset.tabId!, side: current.x < rect.left + rect.width / 2 ? "before" : "after" };
      }
    }
    current.target = target;
    setDropTarget((prev) => prev?.id === target?.id && prev?.side === target?.side ? prev : target);
  }

  function scrollWhileDragging() {
    const current = drag.current;
    const list = listRef.current;
    if (!current?.moved || !list) return;
    const bounds = list.getBoundingClientRect();
    if (current.y >= bounds.top - 24 && current.y <= bounds.bottom + 24) {
      const edge = 32;
      const direction = current.x < bounds.left + edge ? -1 : current.x > bounds.right - edge ? 1 : 0;
      if (direction) {
        list.scrollLeft += direction * 8;
        updateTarget();
      }
    }
    frame.current = requestAnimationFrame(scrollWhileDragging);
  }

  function cancel() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    drag.current = null;
    setDraggingId(null);
    setDropTarget(null);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag.current?.moved) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  return {
    draggingId,
    dropTarget,
    onPointerDown(event: PointerEvent<HTMLButtonElement>, id: string, pinned: boolean) {
      if (event.button !== 0 || event.ctrlKey || !event.isPrimary) return;
      suppressClick.current = false;
      drag.current = { id, pinned, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        x: event.clientX, y: event.clientY, moved: false, target: null };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      current.x = event.clientX;
      current.y = event.clientY;
      if (!current.moved && Math.hypot(current.x - current.startX, current.y - current.startY) >= 6) {
        current.moved = true;
        suppressClick.current = true;
        setDraggingId(current.id);
        frame.current = requestAnimationFrame(scrollWhileDragging);
      }
      if (current.moved) {
        event.preventDefault();
        updateTarget();
      }
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (current?.moved) {
        updateTarget();
        if (current.target) onMove(current.id, current.target.id, current.target.side);
      }
      cancel();
    },
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
    consumeClick() {
      const consumed = suppressClick.current;
      suppressClick.current = false;
      return consumed;
    },
  };
}
