import { useCallback, useRef, useState } from "react";
import { findFreeName } from "../services/transferService";
import type {
  ConflictAction,
  ConflictResolution,
} from "../components/sftp/ConflictDialog";

interface ConflictState {
  fileName: string;
  remaining: number;
  resolve: (r: ConflictResolution) => void;
}

/**
 * 파일 전송 충돌 해결 로직 캡슐화.
 * - resolveConflict: 사용자에게 묻기 (blanket 적용 시 자동 응답)
 * - resolvePath: 충돌 체크 + 사용자 결정 + 자유 이름 탐색을 한 번에
 * - resetBlanket: 새 transfer 작업 시작 시 "Apply to all" 상태 초기화
 * - conflict: ConflictDialog 렌더용 state
 */
export function useConflictResolver() {
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  // "Apply to all" 동안 유지되는 선택. null 이면 매번 묻는다.
  const blanketRef = useRef<ConflictAction | null>(null);

  const resolveConflict = useCallback(
    (fileName: string, remaining: number): Promise<ConflictResolution> => {
      if (blanketRef.current) {
        return Promise.resolve({
          action: blanketRef.current,
          applyToAll: true,
        });
      }
      return new Promise((resolve) => {
        setConflict({
          fileName,
          remaining,
          resolve: (r) => {
            if (r.applyToAll) blanketRef.current = r.action;
            setConflict(null);
            resolve(r);
          },
        });
      });
    },
    [],
  );

  // 충돌 체크 후 최종 경로 결정. checker 만 바뀌면 remote/local 모두 재사용 가능.
  // null 반환 → skip.
  const resolvePath = useCallback(
    async (
      checker: (path: string) => Promise<boolean>,
      desiredPath: string,
      displayName: string,
      remainingHint: number,
    ): Promise<string | null> => {
      const exists = await checker(desiredPath);
      if (!exists) return desiredPath;
      const res = await resolveConflict(displayName, remainingHint);
      if (res.action === "skip") return null;
      if (res.action === "replace") return desiredPath;
      return await findFreeName(checker, desiredPath);
    },
    [resolveConflict],
  );

  const resetBlanket = useCallback(() => {
    blanketRef.current = null;
  }, []);

  return { conflict, resolveConflict, resolvePath, resetBlanket };
}
