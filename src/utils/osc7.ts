/**
 * 셸 통합 (shell integration) 상태.
 * - unknown: 아직 첫 prompt 수신 전 (또는 timeout 직전)
 * - detected: OSC 7 escape 가 감지됨 → cwd 자동 추적 가능
 * - timeout: 일정 시간 내 OSC 7 수신 못함 → pwd fallback 사용
 */
export type ShellIntegrationStatus = "unknown" | "detected" | "timeout";

/** OSC 7 감지를 기다리는 최대 시간 (ms). 이 시간 동안 못 받으면 timeout. */
export const SHELL_INTEGRATION_TIMEOUT_MS = 5000;

/**
 * OSC 7 payload 를 파싱해 절대경로를 반환.
 *
 * 형식: `file://hostname/encoded%20path`
 * - hostname 은 무시 (SSH 세션이라 어차피 원격 호스트).
 * - path 는 URL 디코딩 후 반환.
 *
 * @returns 디코딩된 절대경로 또는 파싱 실패 시 null.
 *
 * @example
 *   parseOsc7Path("file://ubuntu/home/me/projects") // "/home/me/projects"
 *   parseOsc7Path("file:///var/log")                 // "/var/log"
 *   parseOsc7Path("file://host/path%20with%20space") // "/path with space"
 */
export function parseOsc7Path(data: string): string | null {
  if (!data.startsWith("file://")) return null;
  const rest = data.slice("file://".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return null;
  const encoded = rest.slice(slashIdx);
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.startsWith("/") ? decoded : null;
  } catch {
    return null;
  }
}
