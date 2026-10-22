import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** One bounded snapshot per request. Session/site changes immediately hide old results. */
export function useIisQuery<T>(
  command: "iis_overview" | "iis_site_log" | "windows_events",
  sessionId: string,
  siteId?: number,
  automatic = false,
) {
  const key = JSON.stringify([command, sessionId, siteId]);
  const [request, setRequest] = useState({ key, version: 0 });
  const version = request.key === key ? request.version : 0;
  const requested = automatic || version > 0;
  const resultKey = `${key}:${version}`;
  const [state, setState] = useState<{
    key: string; data: T | null; error: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (requested) {
      invoke<T>(command, { sessionId, ...(siteId === undefined ? {} : { siteId }) }).then(
        (data) => { if (!cancelled) setState({ key: resultKey, data, error: null }); },
        () => { if (!cancelled) setState({ key: resultKey, data: null, error: "Could not read this snapshot. Check the connection and account permissions, then retry." }); },
      );
    }
    return () => { cancelled = true; };
  }, [command, sessionId, siteId, requested, resultKey]);

  const current = state?.key === resultKey ? state : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: requested && !current,
    refresh: () => setRequest((old) => ({ key, version: old.key === key ? old.version + 1 : 1 })),
  };
}
