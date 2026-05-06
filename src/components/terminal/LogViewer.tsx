import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { detectLogLevel, type LogLevel } from "../../utils/logLevel";
import { useAlertRules, isValidPattern } from "../../hooks/useAlertRules";
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

type StreamMode = "tail" | "journal";

interface LogStream {
  tailId: string;
  /** Tail 은 file path, Journal 은 args 자체 (e.g. "-fu nginx"). UI 라벨에 사용. */
  path: string;
  mode: StreamMode;
  lines: string[];
  /** 알림 매치된 라인 인덱스 집합 — Set 으로 O(1) 조회. */
  alertedIndexes: Set<number>;
}

interface LogViewerProps {
  sessionId: string;
  onClose: () => void;
  /** popout 에서 사용 시 height: 100% 차지 (default: 250px 고정 패널) */
  fullHeight?: boolean;
  /** 정의된 경우 헤더에 "Pop out" 버튼 노출. popout 안에서는 undefined 로 두어 버튼 숨김. */
  onPopout?: () => void;
}

const MAX_LINES = 1000;

/** 레벨 필터 상태. "other" = detectLogLevel 매치 안 된 라인. */
type LevelFilter = Record<LogLevel | "other", boolean>;

const LEVEL_CHIPS: { key: LogLevel | "other"; label: string }[] = [
  { key: "error", label: "ERROR" },
  { key: "warn", label: "WARN" },
  { key: "info", label: "INFO" },
  { key: "debug", label: "DEBUG" },
  { key: "other", label: "OTHER" },
];

/**
 * 한 라인을 search match 또는 logLevel 토큰으로 분할.
 * 검색 활성 시 검색 매치 우선 (모든 매치 강조), 아니면 logLevel 첫 매치만 강조.
 */
function renderLine(
  line: string,
  searchQuery: string,
  alerted: boolean,
): { lineClass: string; segments: { text: string; cls?: string }[] } {
  const levelMatch = detectLogLevel(line);
  let lineClass = "lv-line";
  if (alerted) lineClass += " lv-line-alert";
  else if (levelMatch) lineClass += ` lv-line-${levelMatch.level}`;

  // 검색 활성 시 매치 토큰 모두 강조
  if (searchQuery && searchQuery.length > 0) {
    const segments: { text: string; cls?: string }[] = [];
    const lower = line.toLowerCase();
    const lowerQuery = searchQuery.toLowerCase();
    let i = 0;
    while (i < line.length) {
      const idx = lower.indexOf(lowerQuery, i);
      if (idx === -1) {
        segments.push({ text: line.slice(i) });
        break;
      }
      if (idx > i) segments.push({ text: line.slice(i, idx) });
      segments.push({
        text: line.slice(idx, idx + searchQuery.length),
        cls: "lv-tok-search",
      });
      i = idx + searchQuery.length;
    }
    if (i < line.length && segments[segments.length - 1]?.text.includes(line.slice(i))) {
      // 위 while 끝에서 처리됨
    }
    return { lineClass, segments };
  }

  // 검색 없으면 logLevel 첫 토큰 강조
  if (levelMatch) {
    return {
      lineClass,
      segments: [
        { text: line.slice(0, levelMatch.start) },
        { text: levelMatch.token, cls: `lv-tok lv-tok-${levelMatch.level}` },
        { text: line.slice(levelMatch.end) },
      ],
    };
  }

  return { lineClass, segments: [{ text: line }] };
}

function LogLine({
  line,
  searchQuery,
  alerted,
}: {
  line: string;
  searchQuery: string;
  alerted: boolean;
}) {
  const { lineClass, segments } = renderLine(line, searchQuery, alerted);
  return (
    <div className={lineClass}>
      {segments.map((s, i) =>
        s.cls ? (
          <span key={i} className={s.cls}>
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </div>
  );
}

export default function LogViewer({
  sessionId,
  onClose,
  fullHeight,
  onPopout,
}: LogViewerProps) {
  const [streams, setStreams] = useState<LogStream[]>([]);
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("");
  const [newJournalArgs, setNewJournalArgs] = useState("-fu ");
  const [addMode, setAddMode] = useState<"none" | "tail" | "journal">("none");
  const [autoScroll, setAutoScroll] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>({
    error: true,
    warn: true,
    info: true,
    debug: true,
    other: true,
  });
  const [showAlerts, setShowAlerts] = useState(false);
  const [alertNotice, setAlertNotice] = useState<string | null>(null);
  const [newAlertPattern, setNewAlertPattern] = useState("");
  const [newAlertLabel, setNewAlertLabel] = useState("");

  const logRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // dedup — 같은 라인이 여러 패턴에 매치돼도 토스트는 한 번만
  const recentNoticeRef = useRef<{ key: string; ts: number } | null>(null);

  const { rules: alertRules, add: addAlert, remove: removeAlert, toggle: toggleAlert } =
    useAlertRules();
  // 매 매치 검사마다 재컴파일 비용 줄이기 — rules 바뀔 때만 컴파일
  const compiledAlerts = useMemo(
    () =>
      alertRules
        .filter((r) => r.enabled)
        .map((r) => {
          try {
            return { rule: r, regex: new RegExp(r.pattern) };
          } catch {
            return null;
          }
        })
        .filter((x): x is { rule: typeof alertRules[number]; regex: RegExp } => x !== null),
    [alertRules],
  );
  // 진행 중인 tail 의 onmessage closure 가 stale alert 규칙을 잡지 않도록 ref 로 노출.
  const compiledAlertsRef = useRef(compiledAlerts);
  compiledAlertsRef.current = compiledAlerts;

  // 자동 스크롤
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  });

  // Ctrl+F / Cmd+F → 검색 input focus, Esc → 클리어
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyF") {
        // LogViewer 가 마운트된 상태일 때만 — 다른 곳의 native find 가로채면 곤란
        if (logRef.current?.isConnected) {
          e.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const handleSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setSearchQuery("");
      searchInputRef.current?.blur();
    }
  };

  const triggerAlertNotice = useCallback((label: string, line: string) => {
    // 같은 라인 텍스트가 5초 내 또 매치되면 dedup
    const key = `${label}::${line}`;
    const now = Date.now();
    if (
      recentNoticeRef.current &&
      recentNoticeRef.current.key === key &&
      now - recentNoticeRef.current.ts < 5000
    ) {
      return;
    }
    recentNoticeRef.current = { key, ts: now };
    setAlertNotice(`Alert: ${label}`);
    setTimeout(() => {
      setAlertNotice((cur) => (cur === `Alert: ${label}` ? null : cur));
    }, 3000);
  }, []);

  /** TailEvent 채널의 onmessage 핸들러 — tail/journal 공통. */
  const attachStreamMessages = useCallback(
    (onEvent: Channel<TailEvent>, tailId: string) => {
      onEvent.onmessage = (event) => {
        if (event.type === "Line") {
          const incoming = event.data.content.split("\n").filter(Boolean);
          if (incoming.length === 0) return;

          // 알림 매치 검사 — 새로 들어온 라인만. ref 로 항상 최신 규칙 참조.
          let firstAlert: { label: string; line: string } | null = null;
          const newAlertedSet = new Set<number>();
          const currentAlerts = compiledAlertsRef.current;
          for (let i = 0; i < incoming.length; i++) {
            const l = incoming[i];
            for (const c of currentAlerts) {
              if (c.regex.test(l)) {
                newAlertedSet.add(i);
                if (!firstAlert) firstAlert = { label: c.rule.label, line: l };
                break;
              }
            }
          }
          if (firstAlert) {
            triggerAlertNotice(firstAlert.label, firstAlert.line);
          }

          setStreams((prev) =>
            prev.map((s) => {
              if (s.tailId !== event.data.tail_id) return s;
              const baseIndex = s.lines.length;
              const merged = [...s.lines, ...incoming];
              const mergedAlerted = new Set(s.alertedIndexes);
              newAlertedSet.forEach((relIdx) =>
                mergedAlerted.add(baseIndex + relIdx),
              );

              if (merged.length > MAX_LINES) {
                const drop = merged.length - MAX_LINES;
                const shifted = new Set<number>();
                mergedAlerted.forEach((idx) => {
                  if (idx >= drop) shifted.add(idx - drop);
                });
                return {
                  ...s,
                  lines: merged.slice(-MAX_LINES),
                  alertedIndexes: shifted,
                };
              }
              return { ...s, lines: merged, alertedIndexes: mergedAlerted };
            }),
          );
        } else if (event.type === "Error") {
          setStreams((prev) =>
            prev.map((s) =>
              s.tailId === tailId
                ? { ...s, lines: [...s.lines, `[ERROR] ${event.data}`] }
                : s,
            ),
          );
        }
      };
    },
    [triggerAlertNotice],
  );

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

      setStreams((prev) => [
        ...prev,
        {
          tailId,
          path: newPath.trim(),
          mode: "tail",
          lines: [],
          alertedIndexes: new Set(),
        },
      ]);
      setActiveStreamId(tailId);
      attachStreamMessages(onEvent, tailId);
      setNewPath("");
      setAddMode("none");
    } catch (err) {
      console.error("Failed to start tail:", err);
    }
  }, [sessionId, newPath, attachStreamMessages]);

  const handleAddJournal = useCallback(async () => {
    const args = newJournalArgs.trim();
    if (!args) return;
    try {
      const onEvent = new Channel<TailEvent>();
      const tailId = await invoke<string>("journal_start", {
        sessionId,
        args,
        onEvent,
      });

      setStreams((prev) => [
        ...prev,
        {
          tailId,
          path: args,
          mode: "journal",
          lines: [],
          alertedIndexes: new Set(),
        },
      ]);
      setActiveStreamId(tailId);
      attachStreamMessages(onEvent, tailId);
      setNewJournalArgs("-fu ");
      setAddMode("none");
    } catch (err) {
      console.error("Failed to start journal:", err);
    }
  }, [sessionId, newJournalArgs, attachStreamMessages]);

  const handleStopTail = useCallback(
    async (tailId: string) => {
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
    },
    [activeStreamId],
  );

  // 클린업
  useEffect(() => {
    return () => {
      streams.forEach((s) => invoke("tail_stop", { tailId: s.tailId }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAddAlertRule = () => {
    if (!isValidPattern(newAlertPattern)) return;
    if (addAlert(newAlertPattern, newAlertLabel)) {
      setNewAlertPattern("");
      setNewAlertLabel("");
    }
  };

  const activeStream = streams.find((s) => s.tailId === activeStreamId);

  // 필터링된 라인 (인덱스 보존)
  const filteredEntries = useMemo(() => {
    if (!activeStream) return [];
    const q = searchQuery.toLowerCase();
    return activeStream.lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => {
        const m = detectLogLevel(line);
        const lvl: LogLevel | "other" = m?.level ?? "other";
        if (!levelFilter[lvl]) return false;
        if (q && !line.toLowerCase().includes(q)) return false;
        return true;
      });
  }, [activeStream, searchQuery, levelFilter]);

  return (
    <div className={`logviewer ${fullHeight ? "logviewer-full" : ""}`}>
      <div className="lv-header">
        <span className="lv-title">Log Viewer</span>

        <input
          ref={searchInputRef}
          type="text"
          className="lv-search"
          placeholder="Search... (⌘F)"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
        />

        <div className="lv-chips">
          {LEVEL_CHIPS.map((c) => (
            <button
              key={c.key}
              className={`lv-chip lv-chip-${c.key} ${levelFilter[c.key] ? "lv-chip-on" : ""}`}
              onClick={() =>
                setLevelFilter((prev) => ({ ...prev, [c.key]: !prev[c.key] }))
              }
              title={`Toggle ${c.label}`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {activeStream && (
          <span className="lv-count">
            {filteredEntries.length} / {activeStream.lines.length}
          </span>
        )}

        <button
          className={`lv-btn ${showAlerts ? "lv-btn-on" : ""}`}
          onClick={() => setShowAlerts(!showAlerts)}
          title="Manage alert rules"
        >
          Alerts ({alertRules.length})
        </button>
        <button
          className={`lv-btn ${addMode === "tail" ? "lv-btn-on" : ""}`}
          onClick={() => setAddMode(addMode === "tail" ? "none" : "tail")}
        >
          + Tail
        </button>
        <button
          className={`lv-btn ${addMode === "journal" ? "lv-btn-on" : ""}`}
          onClick={() => setAddMode(addMode === "journal" ? "none" : "journal")}
        >
          + Journal
        </button>
        <label className="lv-auto-scroll">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          Auto-scroll
        </label>
        {onPopout && (
          <button
            className="lv-btn"
            onClick={onPopout}
            title="Open in separate window"
          >
            Pop out
          </button>
        )}
        <button className="lv-close" onClick={onClose}>
          ×
        </button>
      </div>

      {addMode === "tail" && (
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

      {addMode === "journal" && (
        <div className="lv-add-form">
          <input
            type="text"
            placeholder="-fu nginx  (or -f, -fp err, -fu systemd-* ...)"
            value={newJournalArgs}
            onChange={(e) => setNewJournalArgs(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddJournal()}
            autoFocus
          />
          <button
            className="lv-add-btn"
            onClick={handleAddJournal}
            title="Run: journalctl <args>"
          >
            Start
          </button>
        </div>
      )}

      {showAlerts && (
        <div className="lv-alerts-panel">
          <div className="lv-alerts-form">
            <input
              type="text"
              placeholder="Pattern (regex, e.g. 5\d\d|timeout)"
              value={newAlertPattern}
              onChange={(e) => setNewAlertPattern(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddAlertRule()}
            />
            <input
              type="text"
              placeholder="Label (optional)"
              value={newAlertLabel}
              onChange={(e) => setNewAlertLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddAlertRule()}
            />
            <button
              className="lv-add-btn"
              onClick={handleAddAlertRule}
              disabled={!isValidPattern(newAlertPattern)}
            >
              Add
            </button>
          </div>
          {alertRules.length === 0 ? (
            <div className="lv-alerts-empty">
              No alerts yet. Patterns matching new lines will show a toast.
            </div>
          ) : (
            <div className="lv-alerts-list">
              {alertRules.map((r) => (
                <div key={r.id} className="lv-alert-item">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={() => toggleAlert(r.id)}
                  />
                  <span className="lv-alert-label">{r.label}</span>
                  <code className="lv-alert-pattern">/{r.pattern}/</code>
                  <button
                    className="lv-alert-del"
                    onClick={() => removeAlert(r.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
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
                {s.mode === "journal" ? `journalctl ${s.path}` : s.path.split("/").pop()}
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
          filteredEntries.length > 0 ? (
            filteredEntries.map(({ line, idx }) => (
              <LogLine
                key={idx}
                line={line}
                searchQuery={searchQuery}
                alerted={activeStream.alertedIndexes.has(idx)}
              />
            ))
          ) : (
            <div className="lv-empty">
              {activeStream.lines.length === 0
                ? "Waiting for log lines..."
                : "No lines match the current filter."}
            </div>
          )
        ) : (
          <div className="lv-empty">
            {streams.length === 0
              ? 'Click "+ Tail" to start monitoring a log file.'
              : "Select a tab above."}
          </div>
        )}
      </div>

      {alertNotice && <div className="lv-toast">{alertNotice}</div>}
    </div>
  );
}
