export interface Profile {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "key";
  password?: string;
  key_path?: string;
  group_name: string;
  sort_order: number;
  jump_host?: string;
  agent_forward?: boolean;
  created_at: string;
  updated_at: string;
}

export interface JumpHostConfig {
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "key";
  password?: string;
  key_path?: string;
}

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  password?: string;
  keyPath?: string;
  profileId?: number;
  jumpHost?: JumpHostConfig;
  agentForward?: boolean;
}

export interface Tab {
  id: string;
  title: string;
  type: "local" | "ssh" | "connections" | "snippets" | "sftp";
  linkedSessionId?: string; // SFTP 탭이 어떤 SSH 세션과 연결되는지
}
