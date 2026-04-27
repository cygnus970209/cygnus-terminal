export interface Tab {
  id: string;
  title: string;
  type: "local" | "ssh" | "telnet" | "serial" | "connections" | "snippets" | "sftp";
  /** SFTP 탭이 어떤 SSH 세션과 연결되는지 */
  linkedSessionId?: string;
}
