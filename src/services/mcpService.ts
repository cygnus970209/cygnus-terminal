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
  saved_config?: McpConfig | null;
}

export interface McpOAuthApproval {
  id: string;
  client_name: string;
  redirect_uri: string;
  verification_code: string;
  expires_at: number;
  profile_ids: number[];
  allow_execution: boolean;
  allow_sftp_read: boolean;
  allow_sftp_write: boolean;
}
export interface McpOAuthClient {
  id: string;
  name: string;
  approved_at: number;
  expires_at: number;
  profile_ids: number[];
  allow_execution: boolean;
  allow_sftp_read: boolean;
  allow_sftp_write: boolean;
}
export const getMcpOAuthApprovals = () => invoke<McpOAuthApproval[]>("mcp_oauth_approvals");
export const respondMcpOAuth = (id: string, accept: boolean) => invoke<void>("mcp_oauth_respond", { id, accept });
export const getMcpOAuthClients = () => invoke<McpOAuthClient[]>("mcp_oauth_clients");
export const revokeMcpOAuthClient = (id: string) => invoke<void>("mcp_oauth_revoke", { id });

export const getMcpStatus = () => invoke<McpStatus>("mcp_status");
export const startMcp = (config: McpConfig) => invoke<McpStatus>("mcp_start", { config });
export const stopMcp = () => invoke<void>("mcp_stop");
export const unlockMcpCredentials = () => invoke<void>("mcp_require_credentials");
