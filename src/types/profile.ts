export type ConnectionProtocol = "ssh" | "telnet" | "serial";

export const SERVER_OS_LABELS = {
  auto: "Not specified",
  linux: "Linux",
  windows: "Windows",
  other: "Other",
} as const;

export const REMOTE_SHELL_LABELS = {
  auto: "Not specified",
  posix: "POSIX (Bash / Zsh / sh)",
  powershell: "Windows PowerShell",
  pwsh: "PowerShell 7+",
  cmd: "CMD",
} as const;

export type TargetOs = keyof typeof SERVER_OS_LABELS;
export type RemoteShell = keyof typeof REMOTE_SHELL_LABELS;

export interface Profile {
  protocol?: ConnectionProtocol;
  baud_rate?: number | null;
  /** User-supplied metadata; neither a detected capability nor a shell launch command. */
  target_os?: TargetOs;
  remote_shell?: RemoteShell;
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
  environment?: "development" | "staging" | "production";
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
  targetOs?: TargetOs;
  remoteShell?: RemoteShell;
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

/** Omit unspecified fields so legacy profiles do not appear to have a detected OS. */
export function profileEnvironmentLabel(
  profile: Pick<Profile, "target_os" | "remote_shell">,
): string {
  return [
    profile.target_os && profile.target_os !== "auto"
      ? SERVER_OS_LABELS[profile.target_os]
      : "",
    profile.remote_shell && profile.remote_shell !== "auto"
      ? REMOTE_SHELL_LABELS[profile.remote_shell]
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
