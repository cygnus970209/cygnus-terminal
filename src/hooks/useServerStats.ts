import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface WindowsDisk {
  name: string;
  total_bytes: number;
  free_bytes: number;
}

export interface WindowsProcess {
  pid: number;
  name: string;
  memory_bytes: number;
}

export interface ServerStats {
  platform: "linux" | "windows";
  cpu_usage: number | null;
  mem_total: number | null;
  mem_used: number | null;
  mem_usage: number | null;
  disk_total: number | null;
  disk_used: number | null;
  disk_usage: number | null;
  load_avg: string | null;
  uptime: string | null;
  windows: {
    powershell_version: string;
    disks: WindowsDisk[] | null;
    processes: WindowsProcess[] | null;
  } | null;
}

/**
 * SSH session 의 서버 stats 를 5초 주기로 폴링. enabled 가 false 면 monitor 시작 안 함.
 * StatusBar summary 와 MonitorPanel drawer 가 같은 hook 인스턴스를 쓰도록 App 레벨에서 호출.
 */
export function useServerStats(
  sessionId: string | null | undefined,
  enabled: boolean,
): { stats: ServerStats | null; error: string | null } {
  const [state, setState] = useState<{
    sessionId: string;
    stats: ServerStats | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    setState(null);
    if (!sessionId || !enabled) return;
    let cancelled = false;
    let monitorId: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (id: string) => invoke("monitor_stop", { monitorId: id }).catch(() => {});
    const poll = async (id: string) => {
      try {
        const stats = await invoke<ServerStats | null>("monitor_get_stats", { monitorId: id });
        if (!cancelled) setState({ sessionId, stats, error: null });
      } catch (err) {
        if (!cancelled) setState({ sessionId, stats: null, error: String(err) });
      }
      if (!cancelled) timer = setTimeout(() => { void poll(id); }, 5000);
    };
    invoke<string>("monitor_start", { sessionId }).then(
      (id) => {
        if (cancelled) {
          void stop(id);
          return;
        }
        monitorId = id;
        void poll(id);
      },
      (err) => {
        if (!cancelled) setState({ sessionId, stats: null, error: String(err) });
      },
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (monitorId) void stop(monitorId);
    };
  }, [sessionId, enabled]);

  const current = enabled && state?.sessionId === sessionId ? state : null;
  return { stats: current?.stats ?? null, error: current?.error ?? null };
}
