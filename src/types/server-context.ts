export interface CommandHistoryEntry {
  id: number;
  profile_id: number;
  command: string;
  executed_at: string;
}

export interface CommandBookmark {
  id: number;
  profile_id: number;
  command: string;
  label: string | null;
  sort_order: number;
  created_at: string;
}

export interface PathBookmark {
  id: number;
  profile_id: number;
  path: string;
  label: string | null;
  created_at: string;
}

export interface PortForward {
  id: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  status: string;
}
