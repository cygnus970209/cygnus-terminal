import { t, useLocale } from "../../i18n";
import { useEscapeDismiss } from "../../hooks/useEscapeDismiss";
import Icon from "../common/Icon";
import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { invoke, keychainNotice } from "../../services/secureInvoke";
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

type VaultPromptPickerProps = {
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
} & (
  | { sessionId: string; onInject?: never; onSubmitPassword?: never }
  | {
    sessionId?: never;
    /** MCP uses its job's local-only input queue instead of an SSH shell session. */
    onInject: (vaultItemId: number) => Promise<void>;
    /** One-time input. This does not create a Vault item. */
    onSubmitPassword: (password: string) => Promise<void>;
  }
);

export default function VaultPromptPicker({
  sessionId,
  onInject,
  onSubmitPassword,
  serverId,
  anchorTop,
  anchorLeft,
  promptLabel,
  onClose,
  onInjected,
}: VaultPromptPickerProps) {
  useLocale();
  const [items, setItems] = useState<VaultItem[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const injectingRef = useRef(false);
  const [injecting, setInjecting] = useState(false);
  const [mode, setMode] = useState<"list" | "add" | "manual">("list");
  const [password, setPassword] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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
    else if (mode === "manual") passwordRef.current?.focus();
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
      if (injectingRef.current) return;
      injectingRef.current = true;
      setInjecting(true);
      setError(null);
      try {
        if (onInject) await onInject(item.id);
        else if (sessionId) await invoke("vault_inject", { sessionId, vaultItemId: item.id });
        else throw new Error("No terminal is available for input");
        if (!mounted.current) return;
        onInjected();
        onClose();
      } catch (e) {
        if (mounted.current) setError(String(e));
      } finally {
        injectingRef.current = false;
        if (mounted.current) setInjecting(false);
      }
    },
    [sessionId, onInject, onInjected, onClose],
  );

  const submitPassword = async () => {
    if (!onSubmitPassword || injectingRef.current || !password) return;
    if (new TextEncoder().encode(password).length > 65535 || /[\p{Cc}]/u.test(password)) {
      setError(t("줄바꿈 없는 65535바이트 이하의 비밀번호를 입력하세요."));
      return;
    }
    injectingRef.current = true;
    setInjecting(true);
    setError(null);
    const value = password;
    setPassword("");
    try {
      await onSubmitPassword(value);
      if (!mounted.current) return;
      onInjected();
      onClose();
    } catch {
      if (mounted.current) setError(t("전송하지 못했습니다. 터미널 상태를 확인한 뒤 다시 입력하세요."));
    } finally {
      injectingRef.current = false;
      if (mounted.current) setInjecting(false);
    }
  };

  const handleCreate = useCallback(async () => {
    if (!newValue || saving) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("vault_create", {
        req: {
          label: newLabel.trim() || t("비밀번호"),
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

  useEscapeDismiss(onClose, true, 1000);

  // 키보드 — window capture 로 확실히 가로챈다 (input focus 누수/xterm 간섭 회피).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keychainNotice.getSnapshot() || e.key === "Escape") return;
      if (e.isComposing || e.keyCode === 229) return;
      if (mode !== "list") return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => Math.min(i + 1, sorted.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        if (e.target instanceof HTMLElement && e.target.closest("button"))
          return;
        e.preventDefault();
        e.stopPropagation();
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
        role="dialog"
        aria-modal="true"
        aria-label={t("Vault password input")}
        style={{ top: pos.top, left: pos.left }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="vpp-header" onMouseDown={onHeaderMouseDown}>
          <span className="vpp-grip">⠿</span>
          <span className="vpp-title">
            <Icon name="vault" size={16} />{t("Vault")}</span>
          <span className="vpp-sub">
            {mode === "add" ? t("새 비밀번호") : mode === "manual" ? t("직접 입력") : promptLabel}
          </span>
          <button className="vpp-x" onClick={onClose} title={t("닫기 (Esc)")}>
            ×
          </button>
        </div>

        {mode === "list" ? (
          <>
            <input
              ref={searchRef}
              className="vpp-search"
              aria-label={t("볼트 검색")}
              placeholder={t("비밀번호 검색…")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
            <div className="vpp-list">
              {error && <div className="vpp-error">{error}</div>}
              {!error && sorted.length === 0 && (
                <div className="vpp-empty">{t("저장된 항목이 없어요. 아래에서 추가하세요.")}</div>
              )}
              {sorted.map((item, idx) => (
                <button
                  type="button"
                  disabled={injecting}
                  key={item.id}
                  className={`vpp-row ${idx === active ? "vpp-row-active" : ""}`}
                  onMouseEnter={() => setActive(idx)}
                  onFocus={() => setActive(idx)}
                  onClick={() => void inject(item)}
                >
                  <span className="vpp-label">{item.label}</span>
                  {isMapped(item) && <span className="vpp-badge">{t("매핑됨")}</span>}
                  <span className="vpp-kind">{item.kind}</span>
                </button>
              ))}
            </div>
            <div className="vpp-foot">
              <button className="vpp-add-btn" onClick={() => setMode("add")}>{t("+ 새 비밀번호")}</button>
              {onSubmitPassword ? (
                <button className="vpp-add-btn" disabled={injecting}
                  onClick={() => { setError(null); setMode("manual"); }}>{t("직접 입력")}</button>
              ) : <span className="vpp-hint">↑↓ · Enter · Esc</span>}
            </div>
            {onSubmitPassword && <div className="vpp-note">{t("선택한 비밀번호는 이 서버로 전송됩니다. Esc로 닫으면 터미널에 직접 입력할 수 있어요.")}</div>}
          </>
        ) : mode === "manual" ? (
          <form className="vpp-add" onSubmit={(event) => { event.preventDefault(); void submitPassword(); }}>
            {error && <div className="vpp-error" role="alert">{error}</div>}
            <label className="vpp-field">
              <span className="vpp-flabel">{t("비밀번호")}</span>
              <input ref={passwordRef} className="vpp-input" type="password" autoComplete="off"
                spellCheck={false} value={password} disabled={injecting} maxLength={65535}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
            </label>
            <div className="vpp-note">{t("이번 입력에만 사용하며 Vault에 저장하지 않습니다. 입력 후 출력은 AI 응답·실행기록에서 제외됩니다.")}</div>
            <div className="vpp-add-actions">
              <button type="button" className="vpp-cancel" onClick={() => { setPassword(""); setError(null); setMode("list"); }}>{t("취소")}</button>
              <button type="submit" className="vpp-save" disabled={!password || injecting}>
                {injecting ? t("전송 중…") : t("전송")}
              </button>
            </div>
          </form>
        ) : (
          <div className="vpp-add">
            {error && <div className="vpp-error">{error}</div>}
            <label className="vpp-field">
              <span className="vpp-flabel">{t("라벨")}</span>
              <input
                ref={labelInputRef}
                className="vpp-input"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t("예: master sudo")}
              />
            </label>
            <label className="vpp-field">
              <span className="vpp-flabel">{t("비밀번호")}</span>
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
                  placeholder={t("비밀번호")}
                  autoComplete="off"
                />
                <button
                  className="vpp-eye"
                  type="button"
                  onClick={() => setShowValue((v) => !v)}
                  title={showValue ? t("숨기기") : t("보기")}
                >
                  {showValue ? t("숨기기") : t("보기")}
                </button>
              </div>
            </label>
            {serverId != null && (
              <div className="vpp-note">{t("이 서버에 자동으로 연결돼요")}</div>
            )}
            <div className="vpp-add-actions">
              <button className="vpp-cancel" onClick={() => setMode("list")}>{t("취소")}</button>
              <button
                className="vpp-save"
                onClick={() => void handleCreate()}
                disabled={!newValue || saving}
              >
                {saving ? t("저장 중…") : t("저장")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
