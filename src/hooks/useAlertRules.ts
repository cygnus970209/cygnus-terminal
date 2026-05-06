import { useCallback, useEffect, useState } from "react";

export interface AlertRule {
  id: string;
  /** 정규식 source. RegExp 인스턴스로 만들 때 가드 처리. */
  pattern: string;
  /** UI 표시명 — 토스트 메시지에 사용. 비어있으면 pattern 자체가 라벨. */
  label: string;
  /** false 면 매치 검사 skip. */
  enabled: boolean;
}

const STORAGE_KEY = "cygnus.alerts";
const CHANGE_EVENT = "cygnus-alerts-change";

function load(): AlertRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is AlertRule =>
        typeof r?.id === "string" &&
        typeof r?.pattern === "string" &&
        typeof r?.label === "string" &&
        typeof r?.enabled === "boolean",
    );
  } catch {
    return [];
  }
}

function save(rules: AlertRule[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: rules }));
}

/**
 * pattern 이 유효한 정규식인지 확인. 잘못된 입력 가드.
 */
export function isValidPattern(pattern: string): boolean {
  if (!pattern.trim()) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * 알림 규칙 CRUD + localStorage 영속화.
 * useTheme / useHighlightSettings 와 동일한 동기화 패턴.
 */
export function useAlertRules() {
  const [rules, setRules] = useState<AlertRule[]>(load);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setRules(load());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<AlertRule[]>).detail;
      if (Array.isArray(detail)) setRules(detail);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const add = useCallback((pattern: string, label: string) => {
    if (!isValidPattern(pattern)) return false;
    const rule: AlertRule = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pattern,
      label: label.trim() || pattern,
      enabled: true,
    };
    setRules((prev) => {
      const next = [...prev, rule];
      save(next);
      return next;
    });
    return true;
  }, []);

  const remove = useCallback((id: string) => {
    setRules((prev) => {
      const next = prev.filter((r) => r.id !== id);
      save(next);
      return next;
    });
  }, []);

  const toggle = useCallback((id: string) => {
    setRules((prev) => {
      const next = prev.map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled } : r,
      );
      save(next);
      return next;
    });
  }, []);

  return { rules, add, remove, toggle };
}
