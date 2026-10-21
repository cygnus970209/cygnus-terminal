import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerEnvironment } from "../types/serverEnvironment";

/** Discovery is cached by the backend SSH session; never carry capabilities across tabs. */
export function useServerEnvironment(sessionId: string | null | undefined) {
  const [state, setState] = useState<{
    sessionId: string;
    environment: ServerEnvironment | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (sessionId) {
      setState(null);
      invoke<ServerEnvironment>("ssh_server_environment", { sessionId }).then(
        (environment) => {
          if (!cancelled) setState({ sessionId, environment, error: null });
        },
        (err) => {
          if (!cancelled) setState({ sessionId, environment: null, error: String(err) });
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const current = sessionId && state?.sessionId === sessionId ? state : null;
  return { environment: current?.environment ?? null, error: current?.error ?? null };
}
