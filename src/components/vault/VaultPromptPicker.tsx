import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import "./VaultPromptPicker.css";

interface VaultItem {
  id: number;
  label: string;
  kind: string;
  source: string;
  has_value: boolean;
  server_ids: number[];
  last_used_at: string | null;
}

interface VaultPromptPickerProps {
  /** 비밀번호를 주입할 SSH 세션 id. */
  sessionId: string;
  /** 현재 세션의 서버(profile) id — 매핑된 항목 우선 + 새 항목 자동 연결. */
  serverId?: number;
  /** 터미널 커서 줄 근처 viewport 좌표 (px) — 최초 위치. 이후 드래그로 이동. */
  anchorTop: number;
  anchorLeft: number;
  /** 매칭된 규칙 라벨 — 헤더에 표시. */
  promptLabel?: string;
  onClose: () => void;
  /** 주입 성공 시 호출 — 재트리거 가드 유지용. */
  onInjected: () => void;
}

export default function VaultPromptPicker({
  sessionId,
  serverId,
  anchorTop,
  anchorLeft,
  promptLabel,
  onClose,
  onInjected,
}: VaultPromptPickerProps) {
  const [items, setItems] = useState<VaultItem[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"list" | "add">("list");

  // 새 항목 추가 폼
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);

  // 드래그 위치
  const [pos, setPos] = useState({ top: anchorTop, left: anchorLeft });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const all = await invoke<VaultItem[]>("vault_list");
    // 주입 가능한 항목만: 로컬 암호화 값이 있는 cygnus 소스.
    setItems(all.filter((i) => i.source === "cygnus" && i.has_value));
  }, []);

  useEffect(() => {
    reload().catch((e) => setError(String(e)));
  }, [reload]);

  // 모드별 focus — xterm textarea 를 blur 시키고 픽커가 입력을 받게 한다.
  useEffect(() => {
    if (mode === "list") searchRef.current?.focus();
    else labelInputRef.current?.focus();
  }, [mode]);

  const isMapped = useCallback(
    (i: VaultItem) => serverId != null && i.server_ids.includes(serverId),
    [serverId],
  );

  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? items.filter((i) => i.label.toLowerCase().includes(q))
      : items;
    return [...filtered].sort(
      (a, b) => Number(isMapped(b)) - Number(isMapped(a)),
    );
  }, [items, query, isMapped]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const inject = useCallback(
    async (item: VaultItem) => {
      try {
        await invoke("vault_inject", { sessionId, vaultItemId: item.id });
        onInjected();
        onClose();
      } catch (e) {
        setError(String(e));
      }
    },
    [sessionId, onInjected, onClose],
  );

  const handleCreate = useCallback(async () => {
    if (!newValue || saving) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("vault_create", {
        req: {
          label: newLabel.trim() || "비밀번호",
          kind: "password",
          source: "cygnus",
          value: newValue,
          sensitive: true,
          scope: null,
          pair_id: null,
          // 현재 서버에 자동 연결 → 다음부터 "매핑됨"으로 위에 뜬다.
          server_ids: serverId != null ? [serverId] : [],
        },
      });
      setNewLabel("");
      setNewValue("");
      setShowValue(false);
      await reload();
      setMode("list");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [newLabel, newValue, serverId, saving, reload]);

  // 키보드 — window capture 로 확실히 가로챈다 (input focus 누수/xterm 간섭 회피).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode === "add") {
        if (e.key === "Escape") {
          e.preventDefault();
          setMode("list");
        }
        return; // 나머지 키는 폼 input 으로 통과.
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, sorted.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = sorted[active];
        if (item) void inject(item);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode, sorted, active, inject, onClose]);

  // 드래그 이동 — 헤더를 잡고 끈다.
  const onHeaderMouseDown = (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest(".vpp-x")) return; // 닫기 버튼 제외
    dragRef.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top };
    e.preventDefault();
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const left = Math.max(
        4,
        Math.min(e.clientX - dragRef.current.dx, window.innerWidth - 80),
      );
      const top = Math.max(
        4,
        Math.min(e.clientY - dragRef.current.dy, window.innerHeight - 40),
      );
      setPos({ left, top });
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  return (
    <div className="vpp-backdrop" onMouseDown={onClose}>
      <div
        className="vpp"
        style={{ top: pos.top, left: pos.left }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="vpp-header" onMouseDown={onHeaderMouseDown}>
          <span className="vpp-grip">⠿</span>
          <span className="vpp-title">🔑 Vault</span>
          <span className="vpp-sub">
            {mode === "add" ? "새 비밀번호" : promptLabel}
          </span>
          <button className="vpp-x" onClick={onClose} title="닫기 (Esc)">
            ×
          </button>
        </div>

        {mode === "list" ? (
          <>
            <input
              ref={searchRef}
              className="vpp-search"
              placeholder="검색…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
            <div className="vpp-list">
              {error && <div className="vpp-error">{error}</div>}
              {!error && sorted.length === 0 && (
                <div className="vpp-empty">
                  저장된 항목이 없어요. 아래에서 추가하세요.
                </div>
              )}
              {sorted.map((item, idx) => (
                <div
                  key={item.id}
                  className={`vpp-row ${idx === active ? "vpp-row-active" : ""}`}
                  onMouseEnter={() => setActive(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void inject(item);
                  }}
                >
                  <span className="vpp-label">{item.label}</span>
                  {isMapped(item) && <span className="vpp-badge">매핑됨</span>}
                  <span className="vpp-kind">{item.kind}</span>
                </div>
              ))}
            </div>
            <div className="vpp-foot">
              <button
                className="vpp-add-btn"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setMode("add");
                }}
              >
                + 새 비밀번호
              </button>
              <span className="vpp-hint">↑↓ · Enter · Esc</span>
            </div>
          </>
        ) : (
          <div className="vpp-add">
            {error && <div className="vpp-error">{error}</div>}
            <label className="vpp-field">
              <span className="vpp-flabel">라벨</span>
              <input
                ref={labelInputRef}
                className="vpp-input"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="예: master sudo"
              />
            </label>
            <label className="vpp-field">
              <span className="vpp-flabel">비밀번호</span>
              <div className="vpp-pw">
                <input
                  className="vpp-input"
                  type={showValue ? "text" : "password"}
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleCreate();
                    }
                  }}
                  placeholder="비밀번호"
                  autoComplete="off"
                />
                <button
                  className="vpp-eye"
                  type="button"
                  onClick={() => setShowValue((v) => !v)}
                  tabIndex={-1}
                  title={showValue ? "숨기기" : "보기"}
                >
                  {showValue ? "🙈" : "👁"}
                </button>
              </div>
            </label>
            {serverId != null && (
              <div className="vpp-note">이 서버에 자동으로 연결돼요</div>
            )}
            <div className="vpp-add-actions">
              <button className="vpp-cancel" onClick={() => setMode("list")}>
                취소
              </button>
              <button
                className="vpp-save"
                onClick={() => void handleCreate()}
                disabled={!newValue || saving}
              >
                {saving ? "저장 중…" : "저장"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
