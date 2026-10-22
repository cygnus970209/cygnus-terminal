export interface RdpConfig {
  host: string;
  port: number;
  username: string;
  domain: string;
  width: number;
  height: number;
}
export interface RdpCertificate {
  type: "certificate";
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
  | { type: "error"; message: string };
export type RdpInput =
  | { type: "key"; code: number; down: boolean }
  | { type: "pointer"; x: number; y: number; button: number | null; down: boolean }
  | { type: "wheel"; x: number; y: number; delta: number }
  | { type: "release_all" };
