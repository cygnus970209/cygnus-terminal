export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogLevelMatch {
  level: LogLevel;
  /** 매치된 토큰의 시작 인덱스 (라인 내) */
  start: number;
  /** 매치된 토큰의 끝 (exclusive) */
  end: number;
  /** 매치된 토큰 원문 (대소문자 보존) */
  token: string;
}

/**
 * 로그 레벨 키워드 정규식. 단어경계(\b) + case-insensitive.
 *
 * 지원 패턴 예:
 *  - `[ERROR] msg`, `(WARN) msg`, `<INFO> msg`
 *  - `ERROR: msg`, `2024-01-01 12:34:56 ERROR msg`
 *  - `level=error`, `severity=WARN`, `"level":"error"`
 *
 * `\b` 로 잡아 "errors" / "warning_count" 같은 단어 안의 부분 매치는 제외된다.
 * **공유 패턴이므로 사용 시 `new RegExp(LEVEL_PATTERN, "gi")` 등 자체 인스턴스를 만들 것**
 * (lastIndex 가 호출 간 공유되지 않게).
 */
export const LEVEL_PATTERN_SOURCE =
  "\\b(ERROR|FATAL|CRITICAL|CRIT|ERR|SEVERE|WARN(?:ING)?|INFO|NOTICE|DEBUG|TRACE|VERBOSE)\\b";

/** 토큰 한 개를 LogLevel 로 분류. case-insensitive 입력 OK. */
export function classifyLevel(token: string): LogLevel {
  const upper = token.toUpperCase();
  if (
    upper === "ERROR" ||
    upper === "FATAL" ||
    upper === "CRITICAL" ||
    upper === "CRIT" ||
    upper === "ERR" ||
    upper === "SEVERE"
  ) {
    return "error";
  }
  if (upper === "WARN" || upper === "WARNING") return "warn";
  if (upper === "INFO" || upper === "NOTICE") return "info";
  // DEBUG / TRACE / VERBOSE
  return "debug";
}

/**
 * 라인에서 첫 번째 레벨 키워드 위치를 찾는다 (LogViewer 의 라인 클래스 부여용).
 * 모든 매치를 색칠하려면 ansiHighlight.transformLine 을 사용할 것.
 *
 * @returns 매치된 LogLevelMatch 또는 null
 */
export function detectLogLevel(line: string): LogLevelMatch | null {
  const pattern = new RegExp(LEVEL_PATTERN_SOURCE, "i");
  const m = pattern.exec(line);
  if (!m) return null;
  return {
    level: classifyLevel(m[0]),
    start: m.index,
    end: m.index + m[0].length,
    token: m[0],
  };
}
