import { useCallback, useState } from "react";
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";

/**
 * `invoke` 호출 결과를 상태로 보관하는 훅. try/catch + setState 보일러플레이트를 흡수한다.
 *
 * @example
 *   const { data: forwards, reload } = useInvokeState<PortForward[]>("forward_list", []);
 *   useEffect(() => { reload(); }, [reload]);
 */
export function useInvokeState<T>(command: string, initial: T) {
  const [data, setData] = useState<T>(initial);

  const reload = useCallback(
    async (args?: InvokeArgs): Promise<T | undefined> => {
      try {
        const result = await invoke<T>(command, args);
        setData(result);
        return result;
      } catch (err) {
        console.error(`invoke ${command} failed:`, err);
        return undefined;
      }
    },
    [command]
  );

  return { data, setData, reload };
}
