import type { ExecutionSummary } from "./execution";
import type { RdpLaunch } from "./rdp";
import type { WinrmLaunch } from "./winrm";

export type SessionStatus = "connecting" | "connected" | "ended" | "error";

export interface Tab {
  id: string;
  profileId?: number;
  rdpProfileId?: number;
  rdpLaunch?: RdpLaunch;
  winrmLaunch?: WinrmLaunch;
  telnetConfig?: { host: string; port: number };
  serialConfig?: { portName: string; baudRate: number };
  title: string;
  type: "local" | "ssh" | "telnet" | "serial" | "sftp" | "mcp" | "rdp" | "winrm";
  execution?: ExecutionSummary;
  pinned?: boolean;
  /** SFTP 탭이 어떤 SSH 세션과 연결되는지 */
  linkedSessionId?: string;
}
