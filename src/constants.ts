export const DEFAULT_SSH_PORT = 22;

/** ServerContext 명령 히스토리 자동 새로고침 주기. */
export const HISTORY_REFRESH_INTERVAL_MS = 3000;

/**
 * 터미널이 메모리에 보관하는 스크롤백(위로 스크롤해 다시 볼 수 있는) 줄 수.
 * xterm 기본값은 1000 줄이라 로그가 쏟아지면 금방 잘려나간다 — 넉넉히 늘린다.
 * (줄당 메모리는 작아 1만 줄도 수 MB 수준)
 */
export const TERMINAL_SCROLLBACK_LINES = 10000;
