interface FormatBytesOptions {
  /** 소수 자릿수 (기본 1) */
  precision?: number;
  /** 단위를 짧게 (B/K/M/G) — 좁은 컬럼용 */
  short?: boolean;
}

export function formatBytes(bytes: number, opts: FormatBytesOptions = {}): string {
  const { precision = 1, short = false } = opts;
  const units = short ? ["B", "K", "M", "G"] : ["B", "KB", "MB", "GB"];
  if (bytes < 1024) return `${bytes} ${units[0]}`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(precision)} ${units[1]}`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(precision)} ${units[2]}`;
  return `${(bytes / 1024 ** 3).toFixed(precision)} ${units[3]}`;
}

export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

export function formatEta(remainingBytes: number, speedBps: number): string {
  if (speedBps === 0 || remainingBytes <= 0) return "";
  const secs = remainingBytes / speedBps;
  if (!isFinite(secs)) return "";
  if (secs < 60) return `${Math.ceil(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.ceil(secs % 60)}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

export function formatDate(epoch: number | null): string {
  if (!epoch) return "";
  return new Date(epoch * 1000).toLocaleString();
}
