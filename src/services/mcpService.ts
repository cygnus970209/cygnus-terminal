import { invoke } from "./secureInvoke";

export interface McpConfig {
  port: number;
  profile_ids: number[];
  allow_execution: boolean;
  allow_sftp_read: boolean;
  allow_sftp_write: boolean;
  acknowledge_risks: boolean;
}

export interface McpStatus {
  running: boolean;
  endpoint: string | null;
  token: string | null;
  config: McpConfig | null;
}

export const getMcpStatus = () => invoke<McpStatus>("mcp_status");
export const startMcp = (config: McpConfig) => invoke<McpStatus>("mcp_start", { config });
export const stopMcp = () => invoke<void>("mcp_stop");
export const unlockMcpCredentials = () => invoke<void>("mcp_require_credentials");
