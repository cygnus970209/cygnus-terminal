export interface WinrmConfig {
  host: string;
  port: number;
  username: string;
  domain: string;
  transport: "https" | "http";
  authentication: "ntlm" | "basic";
  certificate_pin: string;
}
export interface WinrmProfile {
  id: number;
  name: string;
  group_name: string;
  config: WinrmConfig;
  has_password: boolean;
}
export interface WinrmLaunch {
  name: string;
  config: WinrmConfig;
  profileId?: number;
  password?: string;
  hasPassword?: boolean;
}
export interface WinrmOutput { stdout: string; stderr: string; exit_code: number; }
export const DEFAULT_WINRM_CONFIG: WinrmConfig = {
  host: "", port: 5986, username: "", domain: "", transport: "https", authentication: "ntlm", certificate_pin: "",
};
export function winrmEndpoint(config: WinrmConfig): string {
  const host = config.host.includes(":") && !config.host.startsWith("[") ? `[${config.host}]` : config.host;
  const account = `${config.domain ? config.domain + "\\" : ""}${config.username}`;
  return `${account}@${host}:${config.port}`;
}
