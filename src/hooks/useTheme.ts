import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_THEME_ID,
  PRESET_THEMES,
  getThemeById,
} from "../themes";

const STORAGE_KEY = "cygnus.theme.id";
const CHANGE_EVENT = "cygnus-theme-change";

/**
 * 터미널 테마 상태 + localStorage 영속화.
 *
 * 동기화 채널 두 가지:
 *  - 같은 윈도우 내 다른 컴포넌트: CustomEvent("cygnus-theme-change")
 *  - 다른 윈도우/popout: 표준 storage 이벤트
 *
 * @example
 *   const { theme, themeId, setThemeId, presets } = useTheme();
 *   xterm.options.theme = theme.colors;
 */
export function useTheme() {
  const [themeId, setThemeIdState] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME_ID;
  });

  // 다른 윈도우(popout) 의 변경
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        setThemeIdState(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // 같은 윈도우 내 다른 컴포넌트의 변경
  useEffect(() => {
    const onChange = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) setThemeIdState(id);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const setThemeId = useCallback((id: string) => {
    localStorage.setItem(STORAGE_KEY, id);
    setThemeIdState(id);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: id }));
  }, []);

  return {
    themeId,
    theme: getThemeById(themeId),
    setThemeId,
    presets: PRESET_THEMES,
  };
}
