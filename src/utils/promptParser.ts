/**
 * 터미널 라인에서 shell prompt 부분을 제외하고 명령어 텍스트만 추출한다.
 *
 * Right-most match 전략: `.*` greedy 가 라인의 가장 오른쪽 prompt 종결 문자(`$ # > % ❯ →`)까지
 * 흡수한 뒤 그 다음 공백 + 명령어를 잡는다. 이렇게 해야 Amazon Linux 같은
 * `[ec2-user@ip-172-16-0-87 ~]$ ls` 형식에서 prompt 안의 `~]$` 가 명령어에 섞이지 않는다.
 *
 * 매치되지 않으면 null.
 */
export function extractCommand(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const m = trimmed.match(/.*[$#>%❯→]\s+(.+)$/);
  if (m) {
    const cmd = m[1].trim();
    return cmd.length > 0 ? cmd : null;
  }
  return null;
}
