import { useEffect, useMemo, useRef, useState } from "react";
import "./CommandPalette.css";

export type PaletteKind = "snippet" | "tab" | "action" | "profile" | "history";

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  title: string;
  subtitle?: string;
  hint?: string; // 우측에 표시 (category / session label / etc.)
  onSelect: () => void;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  items: PaletteItem[];
  placeholder?: string;
}

const KIND_LABEL: Record<PaletteKind, string> = {
  snippet: "Snippet",
  tab: "Tab",
  action: "Action",
  profile: "Profile",
  history: "History",
};

const KIND_ICON: Record<PaletteKind, string> = {
  snippet: "📋",
  tab: "📑",
  action: "⚡",
  profile: "🖥",
  history: "⏱",
};

/**
 * 단순 substring match + 제목 매치 우선순위. fuzzy 라이브러리 없이 구현.
 * 입력 비어있으면 items 를 kind 별로 묶어 그대로 반환.
 */
function filter(items: PaletteItem[], q: string): PaletteItem[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  const tokens = needle.split(/\s+/);
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    const hay = `${item.title} ${item.subtitle ?? ""} ${item.hint ?? ""}`.toLowerCase();
    const titleHay = item.title.toLowerCase();
    let score = 0;
    let matchedAll = true;
    for (const t of tokens) {
      const titleIdx = titleHay.indexOf(t);
      const hayIdx = hay.indexOf(t);
      if (titleIdx !== -1) {
        score += 10 - Math.min(titleIdx, 8);
      } else if (hayIdx !== -1) {
        score += 3;
      } else {
        matchedAll = false;
        break;
      }
    }
    if (matchedAll) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

export default function CommandPalette({
  isOpen,
  onClose,
  items,
  placeholder = "Search snippets, tabs, actions... (⌘K)",
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => filter(items, query), [items, query]);

  // open/close 에 따라 리셋 + focus
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIdx(0);
      // 다음 tick 에 focus (모달 mount 후)
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // 선택 idx 가 리스트 길이 밖으로 안 나가게 clamp
  useEffect(() => {
    if (selectedIdx >= filtered.length) setSelectedIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, selectedIdx]);

  // 선택 행이 보이도록 scroll
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`);
    if (el) {
      const elTop = el.offsetTop;
      const elBottom = elTop + el.offsetHeight;
      const viewTop = list.scrollTop;
      const viewBottom = viewTop + list.clientHeight;
      if (elTop < viewTop) list.scrollTop = elTop;
      else if (elBottom > viewBottom) list.scrollTop = elBottom - list.clientHeight;
    }
  }, [selectedIdx]);

  if (!isOpen) return null;

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[selectedIdx];
      if (item) {
        item.onSelect();
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="cp-overlay" onMouseDown={onClose}>
      <div
        className="cp-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKey}
      >
        <input
          ref={inputRef}
          className="cp-input"
          type="text"
          value={query}
          placeholder={placeholder}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="cp-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cp-empty">No matches</div>
          ) : (
            filtered.map((item, i) => (
              <div
                key={item.id}
                data-idx={i}
                className={`cp-item ${i === selectedIdx ? "selected" : ""}`}
                onMouseEnter={() => setSelectedIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  item.onSelect();
                  onClose();
                }}
              >
                <span className="cp-icon">{KIND_ICON[item.kind]}</span>
                <div className="cp-main">
                  <div className="cp-title">{item.title}</div>
                  {item.subtitle && (
                    <div className="cp-subtitle">{item.subtitle}</div>
                  )}
                </div>
                <div className="cp-meta">
                  {item.hint && <span className="cp-hint">{item.hint}</span>}
                  <span className={`cp-kind cp-kind-${item.kind}`}>
                    {KIND_LABEL[item.kind]}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="cp-foot">
          <span className="cp-kbd">↑↓</span> navigate
          <span className="cp-kbd">⏎</span> select
          <span className="cp-kbd">esc</span> close
        </div>
      </div>
    </div>
  );
}
