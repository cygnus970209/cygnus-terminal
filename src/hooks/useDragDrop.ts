import { useCallback, useEffect, useRef } from "react";
import type { DragPayload } from "../components/sftp/FilePanel";

/**
 * SFTP 드래그-드롭 ref 관리.
 * - dragPayloadRef: drop 시점에 최신 값을 읽어야 하므로 state 가 아닌 ref.
 *   state 는 리렌더 타이밍상 drop 이벤트와 엇갈릴 수 있다.
 * - preparedDragsRef: 우클릭 "Drag to desktop" 으로 temp 다운로드한 파일 (remote → tempPath)
 * - pendingDragJobsRef: drag-out 준비 중인 transfer job (jobId → remotePath)
 *
 * dragend 이벤트가 발화되면 50ms 지연 후 dragPayloadRef 를 정리한다.
 * (native drop 이벤트가 dragend 이후 발화될 수 있어 약간 지연 필요)
 */
export function useDragDrop() {
  const dragPayloadRef = useRef<DragPayload | null>(null);
  const setDragPayload = useCallback((p: DragPayload | null) => {
    dragPayloadRef.current = p;
  }, []);

  const preparedDragsRef = useRef<Map<string, string>>(new Map());
  const pendingDragJobsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const onEnd = () => {
      setTimeout(() => {
        dragPayloadRef.current = null;
      }, 50);
    };
    window.addEventListener("dragend", onEnd);
    return () => window.removeEventListener("dragend", onEnd);
  }, []);

  return {
    dragPayloadRef,
    setDragPayload,
    preparedDragsRef,
    pendingDragJobsRef,
  };
}
