import type { ITheme } from "@xterm/xterm";

/**
 * 터미널 테마 정의. xterm.js 의 ITheme 을 그대로 colors 에 담아
 * 라이브러리 업그레이드 시 자동으로 새 필드를 흡수한다.
 *
 * 새 프리셋 등록은 src/themes/presets.ts 의 PRESET_THEMES 배열에 entry 1개 추가만으로 끝난다.
 */
export interface TerminalTheme {
  /** 안정 식별자 (localStorage 키 값). 변경 금지. */
  id: string;
  /** UI 표시명 */
  name: string;
  /** xterm.js ITheme — background/foreground/cursor + ANSI 16색 */
  colors: ITheme;
}
