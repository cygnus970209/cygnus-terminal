/**
 * 터미널 라인에서 shell prompt 부분을 제외하고 명령어 텍스트만 추출한다.
 *
 * 첫 프롬프트 경계까지만 제거한다. 가장 오른쪽 `$ # > % ❯ →`를 찾으면
 * 명령어 안의 리다이렉션·주석·문자열까지 프롬프트로 오인해 잘라 버린다.
 * 대괄호 프롬프트는 경로에 공백이나 `>`가 있어도 닫는 괄호까지 함께 읽는다.
 *
 * 빈 프롬프트나 경계를 찾지 못한 라인은 null. 호출부에서 원문으로 대체하지 않는다.
 */
export function extractCommand(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const prompt = trimmed.match(/^(?:\[[^\]\r\n]*\]|[^\r\n]*?)[$#>%❯→](?:[ \t]+|$)/);
  if (!prompt) return null;
  let command = trimmed.slice(prompt[0].length).trim();

  // 사용자가 다른 프롬프트를 붙여 넣은 경우도 제거한다. 명령어 안의 기호를
  // 다시 검색하지 않고, 맨 앞의 명확한 user@host / [user@host ...] / shell만 확인한다.
  const nestedPrompt = /^(?:\[[^\]\r\n]*@[^\]\r\n]*\]|[^\s@]+@[^\s:$#>%]+(?::[^\r\n]*?)?|(?:bash|zsh|ksh|sh)(?:-\d[\d.]*)?)[$#>%](?:[ \t]+|$)/;
  let nested: RegExpMatchArray | null;
  while ((nested = command.match(nestedPrompt))) {
    command = command.slice(nested[0].length).trim();
  }
  return command || null;
}
