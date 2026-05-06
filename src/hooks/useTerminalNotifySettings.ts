import { useCallback, useEffect, useState } from "react";

export interface TerminalNotifySettings {
  /** 데스크톱 알림 활성화 */
  enabled: boolean;
  /** 알림 발송 임계값 (초). 이보다 짧은 명령은 알림 안 함. */
  thresholdSeconds: number;
}

const STORAGE_KEY = "cygnus.terminal-notify";
const CHANGE_EVENT = "cygnus-terminal-notify-change";

const DEFAULT_SETTINGS: TerminalNotifySettings = {
  enabled: false, // 사용자가 명시적으로 켜야 — 권한 요청 동선 자연스럽게
  thresholdSeconds: 10,
};

function load(): TerminalNotifySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : DEFAULT_SETTINGS.enabled,
      thresholdSeconds:
        typeof parsed?.thresholdSeconds === "number" && parsed.thresholdSeconds > 0
          ? parsed.thresholdSeconds
          : DEFAULT_SETTINGS.thresholdSeconds,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * 장시간 명령 완료 시 desktop notification 설정.
 * useTheme 와 동일한 동기화 패턴 (storage 이벤트 + CustomEvent).
 */
export function useTerminalNotifySettings() {
  const [settings, setSettings] = useState<TerminalNotifySettings>(load);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setSettings(load());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<TerminalNotifySettings>).detail;
      if (detail) setSettings(detail);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const update = useCallback((patch: Partial<TerminalNotifySettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
      return next;
    });
  }, []);

  return { settings, update };
}
