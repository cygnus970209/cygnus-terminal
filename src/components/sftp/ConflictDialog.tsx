import { useEffect, useState } from "react";
import "./ConflictDialog.css";

export type ConflictAction = "replace" | "keep-both" | "skip";

export interface ConflictResolution {
  action: ConflictAction;
  applyToAll: boolean;
}

interface Props {
  fileName: string;
  remaining: number; // 뒤에 줄 서있는 잠재 충돌 개수 (정보용)
  onResolve: (resolution: ConflictResolution) => void;
}

export default function ConflictDialog({ fileName, remaining, onResolve }: Props) {
  const [applyToAll, setApplyToAll] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onResolve({ action: "skip", applyToAll });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyToAll, onResolve]);

  return (
    <div className="conflict-overlay">
      <div className="conflict-dialog">
        <div className="cd-title">File already exists</div>
        <div className="cd-message">
          <span className="cd-filename">&quot;{fileName}&quot;</span> already exists at
          the destination.
        </div>

        {remaining > 0 && (
          <label className="cd-apply-all">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
            />
            <span>Apply to all ({remaining} more pending)</span>
          </label>
        )}

        <div className="cd-actions">
          <button
            className="cd-btn cd-btn-skip"
            onClick={() => onResolve({ action: "skip", applyToAll })}
          >
            Skip
          </button>
          <button
            className="cd-btn cd-btn-keep"
            onClick={() => onResolve({ action: "keep-both", applyToAll })}
          >
            Keep Both
          </button>
          <button
            className="cd-btn cd-btn-replace"
            onClick={() => onResolve({ action: "replace", applyToAll })}
          >
            Replace
          </button>
        </div>
      </div>
    </div>
  );
}
