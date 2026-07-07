import {
  classifyLevel,
  LEVEL_PATTERN_SOURCE,
  type LogLevel,
} from "./logLevel";

export interface HighlightOptions {
  logLevels: boolean;
  ips: boolean;
}

const ANSI_RESET = "\x1b[0m";

/** SGR 코드 — 표준 8색. terminal 마다 약간 색감 다르지만 호환성 가장 좋음. */
const LEVEL_ANSI: Record<LogLevel, string> = {
  error: "\x1b[31m", // red
  warn: "\x1b[33m", // yellow
  info: "\x1b[34m", // blue
  debug: "\x1b[2m", // dim
};

const IP_ANSI = "\x1b[36m"; // cyan

/**
 * IPv4 주소 — 0~255 범위 정확히 매치. 앞뒤로 숫자/점이 더 있으면 매치 안 됨
 * (1.2.3.4.5 같은 부분 매치 방지). 모든 매치를 잡기 위해 `g` 플래그 사용.
 */
const IPV4_PATTERN_SOURCE =
  "(?<![\\d.])((?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)(?![\\d.])";

/** 라인이 이미 ANSI escape (`\x1b[`) 를 포함하면 우리가 다시 색칠하지 않는다. */
function hasExistingAnsi(line: string): boolean {
  return line.indexOf("\x1b[") !== -1;
}

/**
 * 한 라인 안의 모든 ERROR/WARN/INFO/DEBUG 키워드 + IPv4 주소를 ANSI escape 로 wrap.
 *
 * 안전 정책:
 *  - 이미 ANSI 가 있는 라인은 통째로 그대로 반환 (이중 색칠/충돌 방지).
 *  - 옵션 둘 다 꺼져 있으면 입력 그대로.
 */
function transformLine(line: string, opts: HighlightOptions): string {
  if (!opts.logLevels && !opts.ips) return line;
  if (hasExistingAnsi(line)) return line;

  let result = line;

  // 1) 로그 레벨 단어 — 매치된 토큰을 SGR 로 wrap
  if (opts.logLevels) {
    const levelRegex = new RegExp(LEVEL_PATTERN_SOURCE, "gi");
    result = result.replace(levelRegex, (token) => {
      const level = classifyLevel(token);
      return `${LEVEL_ANSI[level]}${token}${ANSI_RESET}`;
    });
  }

  // 2) IPv4 주소
  if (opts.ips) {
    const ipRegex = new RegExp(IPV4_PATTERN_SOURCE, "g");
    result = result.replace(ipRegex, (m) => `${IP_ANSI}${m}${ANSI_RESET}`);
  }

  return result;
}

/**
 * PTY 청크를 라인 단위로 분리해 transform.
 *  - 마지막 newline 뒤의 미완성 부분은 그대로 둔다 (prompt / progress bar 보호).
 *  - 다음 청크에서 \n 이 와도 그땐 이미 화면에 출력되어 transform 못 함 — trade-off.
 *    실제 stream 출력은 거의 \n 으로 끝나므로 영향 최소.
 */
export function transformChunk(data: string, opts: HighlightOptions): string {
  if (!opts.logLevels && !opts.ips) return data;
  if (data.indexOf("\n") === -1) return data; // 단일 미완성 청크 — 그대로

  // 마지막 \n 위치 찾아 그 앞까지만 transform
  const lastNl = data.lastIndexOf("\n");
  const head = data.slice(0, lastNl); // \n 으로 끝나지 않음
  const tail = data.slice(lastNl); // "\n..." (미완성 부분 포함)

  // head 의 라인들 transform
  const transformed = head.split("\n").map((l) => transformLine(l, opts)).join("\n");
  return transformed + tail;
}
