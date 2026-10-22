export type IisState = "Starting" | "Started" | "Stopping" | "Stopped" | "Unknown";

export interface IisOverview {
  schema: 1;
  status: "available" | "not_installed" | "unavailable";
  sites: {
    id: number;
    name: string;
    state: IisState | null;
    bindings: { protocol: string; address: string }[];
    applications: { path: string; pool: string }[];
    log_enabled: boolean;
  }[] | null;
  pools: { name: string; state: IisState | null; runtime: string; pipeline: string }[] | null;
  truncated: boolean;
}

export interface IisSiteLog {
  schema: 1;
  site_id: number;
  status: "available" | "unavailable" | "site_missing" | "disabled" | "unsupported_format" | "unsupported_path" | "no_logs" | "too_many_files";
  file: string | null;
  lines: string[];
  truncated: boolean;
}

export interface WindowsEvents {
  schema: 1;
  logs: {
    name: "Application" | "System";
    events: {
      record_id: number;
      id: number;
      level: number;
      provider: string;
      time: string | null;
      message: string | null;
      message_truncated: boolean;
    }[] | null;
  }[];
}
