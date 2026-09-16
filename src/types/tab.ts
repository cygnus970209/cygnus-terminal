export type SessionStatus = "connecting" | "connected" | "ended" | "error";

export interface Tab {
  id: string;
  profileId?: number;
  telnetConfig?: { host: string; port: number };
  serialConfig?: { portName: string; baudRate: number };
  title: string;
  type:
    "local" | "ssh" | "telnet" | "serial" | "connections" | "snippets" | "sftp";
  /** SFTP 탭이 어떤 SSH 세션과 연결되는지 */
  linkedSessionId?: string;
}
