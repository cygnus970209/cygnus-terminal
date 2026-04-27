import { useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { TransferEvent, TransferJob } from "../types/sftp";

interface TransferCallbacks {
  /** Job 이 Completed 상태로 마킹된 직후 호출. (drag-out 알림, 디렉토리 새로고침 등) */
  onCompleted?: (jobId: string) => void;
  /** Job 이 Failed 상태로 마킹된 직후 호출. */
  onFailed?: (jobId: string, error: string) => void;
}

/**
 * SFTP transfer Channel + jobs 상태를 한 묶음으로 제공.
 * App.tsx 와 SftpView.tsx 가 동일한 onmessage 보일러플레이트를 공유하기 위해 추출됨.
 */
export function useTransferChannel(callbacks: TransferCallbacks = {}) {
  const [transferJobs, setTransferJobs] = useState<TransferJob[]>([]);

  // callbacks 는 매 렌더 새로 만들어지므로 최신 ref 로 호출.
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const transferChannel = useMemo(() => {
    const ch = new Channel<TransferEvent>();
    ch.onmessage = (event) => {
      if (event.type === "QueueUpdate") {
        setTransferJobs(event.data);
      } else if (event.type === "Progress") {
        const { job_id, transferred_bytes, speed_bps } = event.data;
        setTransferJobs((prev) =>
          prev.map((j) =>
            j.id === job_id
              ? { ...j, transferred_bytes, speed_bps, status: "running" }
              : j,
          ),
        );
      } else if (event.type === "Completed") {
        setTransferJobs((prev) =>
          prev.map((j) =>
            j.id === event.data ? { ...j, status: "completed" } : j,
          ),
        );
        cbRef.current.onCompleted?.(event.data);
      } else if (event.type === "Failed") {
        setTransferJobs((prev) =>
          prev.map((j) =>
            j.id === event.data.job_id
              ? { ...j, status: "failed", error: event.data.error }
              : j,
          ),
        );
        cbRef.current.onFailed?.(event.data.job_id, event.data.error);
      }
    };
    return ch;
  }, []);

  return { transferJobs, setTransferJobs, transferChannel };
}
