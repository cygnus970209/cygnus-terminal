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
export type RdpEvent =
  | { type: "connecting" | "authenticating" | "ended" }
  | RdpCertificate
  | { type: "connected"; width: number; height: number }
  | { type: "display_control"; max_area: number }
  | { type: "resize_result"; applied: boolean }
  | { type: "error"; message: string };
export type RdpInput =
  | { type: "text"; text: string }
  | { type: "key"; code: number; down: boolean }
  | { type: "pointer"; x: number; y: number; button: number | null; down: boolean }
  | { type: "wheel"; x: number; y: number; delta: number }
  | { type: "release_all" };

export interface RdpProfile { id: number; name: string; config: RdpConfig; }
export interface RdpApproval {
  fingerprint: string;
  password: string;
  expected_saved_fingerprint: string | null;
  remember: boolean;
  accept_changed: boolean;
}
