import { useEffect, useRef } from "react";
import { listen, type EventCallback } from "@tauri-apps/api/event";

/**
 * Tauri 이벤트를 구독하고 언마운트 시 자동 해제한다.
 * handler 는 ref 를 통해 항상 최신값으로 호출되므로 deps 를 신경쓸 필요가 없다.
 *
 * @example
 *   useTauriListener("open-settings", () => setShowSettings(true));
 *   useTauriListener<HostKeyPromptPayload>("ssh-host-key-prompt", (e) => {
 *     setPrompts((prev) => [...prev, e.payload]);
 *   });
 */
export function useTauriListener<T = unknown>(
  event: string,
  handler: EventCallback<T>
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const unlisten = listen<T>(event, (e) => handlerRef.current(e));
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, [event]);
}
