import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ServerStats {
  cpu_usage: number;
  mem_total: number;
  mem_used: number;
  mem_usage: number;
  disk_total: number;
  disk_used: number;
  disk_usage: number;
  load_avg: string;
  uptime: string;
}

/**
 * SSH session 의 서버 stats 를 5초 주기로 폴링. enabled 가 false 면 monitor 시작 안 함.
 * StatusBar summary 와 MonitorPanel drawer 가 같은 hook 인스턴스를 쓰도록 App 레벨에서 호출.
 */
export function useServerStats(
  sessionId: string | null | undefined,
  enabled: boolean,
): { stats: ServerStats | null; error: string | null } {
  const [monitorId, setMonitorId] = useState<string | null>(null);
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 세션/enabled 변할 때 monitor 시작
  useEffect(() => {
    if (!sessionId || !enabled) {
      setMonitorId(null);
      setStats(null);
      setError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const id = await invoke<string>("monitor_start", { sessionId });
        if (!cancelled) setMonitorId(id);
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled]);

  // 주기 폴링
  useEffect(() => {
    if (!monitorId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await invoke<ServerStats>("monitor_get_stats", { monitorId });
        if (!cancelled) {
          setStats(s);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    };
    poll();
    const iv = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [monitorId]);

  // cleanup
  useEffect(() => {
    return () => {
      if (monitorId) invoke("monitor_stop", { monitorId }).catch(() => {});
    };
  }, [monitorId]);

  return { stats, error };
}
