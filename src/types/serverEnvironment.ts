import {
  REMOTE_SHELL_LABELS,
  SERVER_OS_LABELS,
  type RemoteShell,
  type TargetOs,
} from "./profile";

export interface ServerEnvironment {
  configured: { target_os: TargetOs; remote_shell: RemoteShell };
  detected_os: Exclude<TargetOs, "auto"> | null;
  detected_shell: Exclude<RemoteShell, "auto"> | null;
  os: Exclude<TargetOs, "auto"> | "unknown";
  shell: Exclude<RemoteShell, "auto"> | "unknown";
  capabilities: { monitor: boolean; file_logs: boolean; journal: boolean };
  notice: string | null;
  powershell: { engine: "powershell" | "pwsh"; version: string; cim: boolean } | null;
}

export function environmentLabel(env: ServerEnvironment): string {
  const os = env.os === "unknown" ? "Unknown OS" : SERVER_OS_LABELS[env.os];
  const shell = env.shell === "unknown" ? "Unknown shell" : REMOTE_SHELL_LABELS[env.shell];
  return `${os} · ${shell}`;
}

export function environmentDetails(env: ServerEnvironment): string {
  return [
    `Saved: ${SERVER_OS_LABELS[env.configured.target_os]} / ${REMOTE_SHELL_LABELS[env.configured.remote_shell]}`,
    `Detected: ${env.detected_os ? SERVER_OS_LABELS[env.detected_os] : "Unknown"} / ${env.detected_shell ? REMOTE_SHELL_LABELS[env.detected_shell] : "Unknown"}`,
    env.powershell ? `PowerShell runtime: ${env.powershell.version}` : null,
    env.notice,
  ].filter(Boolean).join("\n");
}

export function capabilityReason(
  env: ServerEnvironment | null,
  error: string | null,
  connected: boolean,
): string {
  if (!connected) return "Connect an SSH session first";
  if (error) return "Remote environment could not be verified. Reconnect to try again.";
  if (!env) return "Checking the remote environment…";
  return env.notice ?? "The required tools were not found in this SSH command environment.";
}
