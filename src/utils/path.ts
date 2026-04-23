/**
 * 같은 이름 충돌 회피용으로 파일명에 ` (N)` suffix 를 추가/증가시킨다.
 *
 * 규칙:
 * - 마지막 `.` 이후를 단일 확장자로 보고 보존한다 (`archive.tar.gz` → `archive.tar (1).gz`).
 *   대다수 UI 패턴과 일치하고 구현이 단순하다. 다중 확장자 완전 분해는 하지 않는다.
 * - 선두 `.` 으로 시작하는 dotfile (`.bashrc`) 은 확장자 없는 걸로 본다.
 * - 이미 ` (N)` 으로 끝나면 N+1 로 증가 (`foo (1).txt` → `foo (2).txt`).
 * - 경로가 없는 베어 파일명도 처리한다 (`foo.txt` → `foo (1).txt`).
 */
export function bumpName(remotePath: string): string {
  const lastSlash = remotePath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? remotePath.substring(0, lastSlash) : "";
  const base = lastSlash >= 0 ? remotePath.substring(lastSlash + 1) : remotePath;
  const dot = base.lastIndexOf(".");
  // dot > 0 — 선두 dotfile 의 dot(=0) 은 확장자로 취급하지 않는다.
  const name = dot > 0 ? base.substring(0, dot) : base;
  const ext = dot > 0 ? base.substring(dot) : "";
  const match = name.match(/^(.*) \((\d+)\)$/);
  const nextName = match
    ? `${match[1]} (${parseInt(match[2], 10) + 1})`
    : `${name} (1)`;
  return dir ? `${dir}/${nextName}${ext}` : `${nextName}${ext}`;
}

/** `base/name` 결합. `base` 가 `/` 로 끝나는 경우도 안전. */
export function joinPath(base: string, name: string): string {
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}
