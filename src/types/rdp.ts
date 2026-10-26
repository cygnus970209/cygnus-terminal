export interface RdpConfig {
  host: string;
  port: number;
  username: string;
  domain: string;
  width: number;
  height: number;
  desktop_scale_factor: number;
}
export interface RdpCertificate {
  type: "certificate";
  saved_fingerprint?: string | null;
  fingerprint: string;
  subject: string;
  issuer: string;
  valid_from: string;
  valid_until: string;
}
export type RdpClipboardAction = { type: "enable" | "disable" | "read" } | { type: "send"; text: string };
export type RdpClipboardOutcome = { type: "enabled" | "disabled" | "offered" | "unavailable" } | { type: "received"; text: string };
export type RdpEvent =
  | { type: "connecting" | "authenticating" | "ended" }
  | RdpCertificate
  | { type: "connected"; width: number; height: number }
  | { type: "display_control"; max_area: number }
  | { type: "resize_result"; applied: boolean }
  | { type: "clipboard_state"; available: boolean; remote_text: boolean }
  | { type: "clipboard_result"; request_id: number; outcome: RdpClipboardOutcome }
  | { type: "error"; message: string };
export type RdpInput =
  | { type: "text"; text: string }
  | { type: "key"; code: number; down: boolean }
  | { type: "pointer"; x: number; y: number; button: number | null; down: boolean }
  | { type: "wheel"; x: number; y: number; delta: number }
  | { type: "release_all" };

export interface RdpProfile { id: number; name: string; config: RdpConfig; }
export interface RdpLaunch { config: RdpConfig; name: string; profileId?: number; }
export const DEFAULT_RDP_CONFIG: RdpConfig = { host: "", port: 3389, username: "", domain: "", width: 1280, height: 720, desktop_scale_factor: 0 };
export interface RdpApproval {
  fingerprint: string;
  password: string;
  expected_saved_fingerprint: string | null;
  remember: boolean;
  accept_changed: boolean;
}
