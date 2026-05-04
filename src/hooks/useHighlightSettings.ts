import { useCallback, useEffect, useState } from "react";
import type { HighlightOptions } from "../utils/ansiHighlight";

const STORAGE_KEY = "cygnus.highlight";
const CHANGE_EVENT = "cygnus-highlight-change";

const DEFAULT_SETTINGS: HighlightOptions = {
  logLevels: true,
  ips: true,
};

function load(): HighlightOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * 터미널 출력 하이라이트 설정 (로그 레벨 / IP 주소).
 * useTheme 과 동일한 동기화 채널: storage 이벤트 + CustomEvent.
 */
export function useHighlightSettings() {
  const [settings, setSettings] = useState<HighlightOptions>(load);

  // 다른 윈도우(popout) 동기화
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(e.newValue) });
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // 같은 윈도우 내 다른 컴포넌트 동기화
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<HighlightOptions>).detail;
      if (detail) setSettings(detail);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const update = useCallback((patch: Partial<HighlightOptions>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
      return next;
    });
  }, []);

  return { settings, update };
}
