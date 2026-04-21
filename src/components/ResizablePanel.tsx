import { useState, useRef, useEffect } from "react";
import "./ResizablePanel.css";

interface ResizablePanelProps {
  children: React.ReactNode;
  side: "left" | "right";
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  collapsed: boolean;
}

export default function ResizablePanel({
  children,
  side,
  defaultWidth,
  minWidth,
  maxWidth,
  collapsed,
}: ResizablePanelProps) {
  const [width, setWidth] = useState(defaultWidth);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta =
        side === "left"
          ? e.clientX - startX.current
          : startX.current - e.clientX;
      const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth.current + delta));
      setWidth(newWidth);
    };

    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [side, minWidth, maxWidth]);

  if (collapsed) return null;

  return (
    <div
      className={`rp-panel rp-${side}`}
      style={{ width }}
    >
      <div className="rp-content">{children}</div>
      <div
        className={`rp-handle rp-handle-${side}`}
        onMouseDown={(e) => {
          e.preventDefault();
          dragging.current = true;
          startX.current = e.clientX;
          startWidth.current = width;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
      />
    </div>
  );
}
