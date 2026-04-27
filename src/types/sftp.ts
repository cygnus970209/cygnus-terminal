export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
}

export interface TransferJob {
  id: string;
  job_type: string;
  source_path: string;
  dest_path: string;
  file_name: string;
  total_bytes: number;
  transferred_bytes: number;
  status: string;
  error: string | null;
  speed_bps: number;
}

export type TransferEvent =
  | { type: "QueueUpdate"; data: TransferJob[] }
  | {
      type: "Progress";
      data: {
        job_id: string;
        transferred_bytes: number;
        total_bytes: number;
        speed_bps: number;
      };
    }
  | { type: "Completed"; data: string }
  | { type: "Failed"; data: { job_id: string; error: string } };
