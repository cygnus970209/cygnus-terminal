export type ExecutionStatus =
  | "connecting"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export interface StartExecutionRequest {
  profile_id: number;
  command: string;
  timeout_seconds?: number;
  output_limit_bytes?: number;
}

export interface ExecutionSummary {
  id: string;
  profile_id: number;
  profile_name: string;
  host: string;
  port: number;
  username: string;
  environment: string;
  command: string;
  timeout_seconds: number;
  output_limit_bytes: number;
  status: ExecutionStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  exit_signal: string | null;
  output_truncated: boolean;
  remote_outcome_unknown: boolean;
  error: string | null;
  persistence_error: string | null;
}

export interface ExecutionJob extends ExecutionSummary {
  stdout: string;
  stderr: string;
}
