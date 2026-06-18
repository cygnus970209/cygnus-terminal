import { useCallback, useEffect, useState } from "react";

export interface VaultPromptRule {
  id: string;
  /** 정규식 source. 커서 줄(plain text)에 test 한다. RegExp 생성 시 가드 처리. */
  pattern: string;
  /** UI 표시명. 비어있으면 pattern 자체가 라벨. */
  label: string;
  /** false 면 매치 검사 skip. */
  enabled: boolean;
}

const STORAGE_KEY = "cygnus.vault-prompts";
const CHANGE_EVENT = "cygnus-vault-prompts-change";

/**
 * 기본 시드 패턴 — localStorage 가 비어있을 때 제공.
 * 모두 "줄 끝이 `:` 로 끝나는 입력 대기" 형태로 좁게 잡아 오탐을 막는다.
 * id 는 고정 prefix(`seed-`) 라 사용자가 지워도 재시드되지 않는다(빈 배열은 명시적 선택).
 */
const SEED_RULES: VaultPromptRule[] = [
  {
    id: "seed-sudo",
    pattern: "^\\[sudo\\] password for \\S+:\\s*$",
    label: "sudo",
    enabled: true,
  },
  {
    id: "seed-password",
    pattern: "[Pp]assword:\\s*$",
    label: "Password 프롬프트",
    enabled: true,
  },
  {
    id: "seed-passphrase",
    pattern: "[Pp]assphrase[^:]*:\\s*$",
    label: "SSH key passphrase",
    enabled: false,
  },
];

function sanitize(parsed: unknown): VaultPromptRule[] | null {
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(
    (r): r is VaultPromptRule =>
      typeof r?.id === "string" &&
      typeof r?.pattern === "string" &&
      typeof r?.label === "string" &&
      typeof r?.enabled === "boolean",
  );
}

function load(): VaultPromptRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // 키 자체가 없으면 최초 실행 — 기본 패턴 시드.
    // 빈 배열("[]")은 사용자가 전부 지운 상태이므로 그대로 존중.
    if (raw === null) return SEED_RULES;
    const cleaned = sanitize(JSON.parse(raw));
    return cleaned ?? SEED_RULES;
  } catch {
    return SEED_RULES;
  }
}

function save(rules: VaultPromptRule[]) {
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
 * `.*` 처럼 거의 모든 줄에 매치되는 위험하게 넓은 패턴인지 휴리스틱 판정.
 * 등록은 막지 않되 UI 에서 경고를 띄우는 용도.
 */
export function isTooBroadPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  // 줄 끝 앵커(`:` + 선택적 공백 + `$`)가 없으면 임의 출력에 튈 위험이 크다.
  const hasEndAnchor = /:\s*(\\s\*)?\$?\s*$/.test(trimmed) || trimmed.includes(":");
  const broad = trimmed === ".*" || trimmed === ".+" || trimmed === ".";
  return broad || !hasEndAnchor;
}

/**
 * 비밀번호 프롬프트 감지 규칙 CRUD + localStorage 영속화.
 * useAlertRules 와 동일한 동기화 패턴 (storage + CustomEvent).
 */
export function useVaultPromptRules() {
  const [rules, setRules] = useState<VaultPromptRule[]>(load);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setRules(load());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<VaultPromptRule[]>).detail;
      if (Array.isArray(detail)) setRules(detail);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const add = useCallback((pattern: string, label: string) => {
    if (!isValidPattern(pattern)) return false;
    const rule: VaultPromptRule = {
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
