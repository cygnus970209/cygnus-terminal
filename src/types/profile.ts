export type ConnectionProtocol = "ssh" | "telnet" | "serial";

export interface Profile {
  protocol?: ConnectionProtocol;
  baud_rate?: number | null;
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

export function profileEndpoint(profile: Profile): string {
  if (profile.protocol === "serial")
    return `${profile.host} · ${profile.baud_rate ?? 115200} baud`;
  const host =
    profile.host.includes(":") && !profile.host.startsWith("[")
      ? `[${profile.host}]`
      : profile.host;
  if (profile.protocol === "telnet") return `${host}:${profile.port}`;
  return `${profile.username}@${host}:${profile.port}`;
}
