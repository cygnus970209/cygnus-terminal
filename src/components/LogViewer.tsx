import { useState, useEffect, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import "./LogViewer.css";

interface TailLine {
  tail_id: string;
  path: string;
  content: string;
}

type TailEvent =
  | { type: "Line"; data: TailLine }
  | { type: "Error"; data: string }
  | { type: "Closed"; data: string };

interface LogStream {
  tailId: string;
  path: string;
  lines: string[];
}

interface LogViewerProps {
  sessionId: string;
  onClose: () => void;
}

const MAX_LINES = 1000;

export default function LogViewer({ sessionId, onClose }: LogViewerProps) {
  const [streams, setStreams] = useState<LogStream[]>([]);
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  // 자동 스크롤
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  });

  const handleAddTail = useCallback(async () => {
    if (!newPath.trim()) return;
    try {
      const onEvent = new Channel<TailEvent>();

      const tailId = await invoke<string>("tail_start", {
        sessionId,
        path: newPath.trim(),
        lines: 50,
        onEvent,
      });

      const stream: LogStream = {
        tailId,
        path: newPath.trim(),
        lines: [],
      };

      setStreams((prev) => [...prev, stream]);
      setActiveStreamId(tailId);
      setNewPath("");
      setShowAdd(false);

      onEvent.onmessage = (event) => {
        if (event.type === "Line") {
          setStreams((prev) =>
            prev.map((s) => {
              if (s.tailId !== event.data.tail_id) return s;
              const newLines = [...s.lines, ...event.data.content.split("\n").filter(Boolean)];
              return {
                ...s,
                lines: newLines.slice(-MAX_LINES),
              };
            })
          );
        } else if (event.type === "Error") {
          setStreams((prev) =>
            prev.map((s) => {
              if (s.tailId !== tailId) return s;
              return { ...s, lines: [...s.lines, `[ERROR] ${event.data}`] };
            })
          );
        }
      };
    } catch (err) {
      console.error("Failed to start tail:", err);
    }
  }, [sessionId, newPath]);

  const handleStopTail = useCallback(async (tailId: string) => {
    try {
      await invoke("tail_stop", { tailId });
    } catch (err) {
      console.error("Failed to stop tail:", err);
    }
    setStreams((prev) => {
      const next = prev.filter((s) => s.tailId !== tailId);
      if (activeStreamId === tailId) {
        setActiveStreamId(next[0]?.tailId ?? null);
      }
      return next;
    });
  }, [activeStreamId]);

  // 클린업
  useEffect(() => {
    return () => {
      streams.forEach((s) => invoke("tail_stop", { tailId: s.tailId }));
    };
  }, []);

  const activeStream = streams.find((s) => s.tailId === activeStreamId);

  return (
    <div className="logviewer">
      <div className="lv-header">
        <span className="lv-title">Log Viewer</span>
        <button
          className="lv-btn"
          onClick={() => setShowAdd(!showAdd)}
        >
          {showAdd ? "Cancel" : "+ Tail"}
        </button>
        <label className="lv-auto-scroll">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          Auto-scroll
        </label>
        <button className="lv-close" onClick={onClose}>×</button>
      </div>

      {showAdd && (
        <div className="lv-add-form">
          <input
            type="text"
            placeholder="/var/log/syslog"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddTail()}
            autoFocus
          />
          <button className="lv-add-btn" onClick={handleAddTail}>
            Start
          </button>
        </div>
      )}

      {streams.length > 0 && (
        <div className="lv-tabs">
          {streams.map((s) => (
            <div
              key={s.tailId}
              className={`lv-tab ${s.tailId === activeStreamId ? "lv-tab-active" : ""}`}
              onClick={() => setActiveStreamId(s.tailId)}
            >
              <span className="lv-tab-name">
                {s.path.split("/").pop()}
              </span>
              <button
                className="lv-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  handleStopTail(s.tailId);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="lv-content" ref={logRef}>
        {activeStream ? (
          activeStream.lines.map((line, i) => (
            <div key={i} className="lv-line">
              {line}
            </div>
          ))
        ) : (
          <div className="lv-empty">
            {streams.length === 0
              ? 'Click "+ Tail" to start monitoring a log file.'
              : "Select a tab above."}
          </div>
        )}
      </div>
    </div>
  );
}
