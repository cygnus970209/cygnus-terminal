import { t } from "../i18n";
import { profileEndpoint, profileEnvironmentLabel, type ConnectionProtocol, type Profile } from "./profile";
import type { RdpProfile } from "./rdp";
import { winrmEndpoint, type WinrmProfile } from "./winrm";

/** UI protocol choices; RDP keeps its own storage and never becomes an SSH profile. */
export type ConnectionChoice = ConnectionProtocol | "rdp" | "winrm";
export type ConnectionKey = number | `rdp:${number}` | `winrm:${number}`;
export type ConnectionEntry = {
  key: ConnectionKey; name: string; protocol: ConnectionChoice; group: string;
  endpoint: string; details: string; environment: string; search: string;
} & ({ kind: "terminal"; profile: Profile } | { kind: "rdp"; profile: RdpProfile } | { kind: "winrm"; profile: WinrmProfile });

export function connectionEntries(profiles: Profile[], rdpProfiles: RdpProfile[], winrmProfiles: WinrmProfile[] = []): ConnectionEntry[] {
  return [
    ...profiles.map((profile): ConnectionEntry => ({
      kind: "terminal", profile, key: profile.id, name: profile.name, protocol: profile.protocol ?? "ssh",
      group: profile.group_name, endpoint: profileEndpoint(profile), environment: profileEnvironmentLabel(profile),
      details: profile.protocol === "serial" ? `${profile.baud_rate ?? 115200} baud` : profile.protocol === "telnet" ? `${t("Port")} ${profile.port}` : `${profile.username} · ${profile.auth_type === "key" ? t("SSH key") : t("Password")}`,
      search: `${profile.name} ${profileEndpoint(profile)} ${profile.group_name} ${profile.protocol ?? "ssh"} ${profileEnvironmentLabel(profile)}`.toLowerCase(),
    })),
    ...rdpProfiles.map((profile): ConnectionEntry => {
      const host = profile.config.host.includes(":") && !profile.config.host.startsWith("[") ? `[${profile.config.host}]` : profile.config.host;
      const account = `${profile.config.domain ? profile.config.domain + "\\" : ""}${profile.config.username}`;
      return { kind: "rdp", profile, key: `rdp:${profile.id}`, name: profile.name, protocol: "rdp", group: "",
        endpoint: `${account}@${host}:${profile.config.port}`, details: `${profile.config.width} × ${profile.config.height} · ${t("Beta")}`, environment: t("Windows desktop"),
        search: `${profile.name} ${profile.config.host} ${account} rdp windows desktop`.toLowerCase() };
    }),
    ...winrmProfiles.map((profile): ConnectionEntry => ({
      kind: "winrm", profile, key: `winrm:${profile.id}`, name: profile.name, protocol: "winrm", group: profile.group_name,
      endpoint: winrmEndpoint(profile.config), environment: "Windows · PowerShell",
      details: `${profile.config.transport.toUpperCase()} · ${profile.config.authentication === "ntlm" ? "NTLM" : "Basic"}`,
      search: `${profile.name} ${winrmEndpoint(profile.config)} ${profile.group_name} winrm windows powershell`.toLowerCase(),
    })),
  ];
}

export function readConnectionFavorites(value: string | null): ConnectionKey[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((key): key is ConnectionKey =>
      (typeof key === "number" && Number.isSafeInteger(key) && key > 0) || (typeof key === "string" && /^(rdp|winrm):[1-9]\d*$/.test(key))) : [];
  } catch { return []; }
}
