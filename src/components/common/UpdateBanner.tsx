import { useEffect, useRef, useState } from "react";
import { check, Update, DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import "./UpdateBanner.css";

type Phase = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

/**
 * 앱 시작 시 1 회 자동으로 업데이트 체크.
 * 있으면 상단 배너로 안내. [설치 및 재시작] 누르면 다운로드 → 재시작.
 * View 메뉴의 "Check for updates" 이벤트(`updater-check`)도 수신해 수동 체크 지원.
 */
export default function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<{ downloaded: number; total: number }>({
    downloaded: 0,
    total: 0,
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // 이미 한 번 자동 체크했는지
  const autoChecked = useRef(false);

  const runCheck = async (manual: boolean) => {
    setPhase("checking");
    setErrorMsg(null);
    setDismissed(false);
    try {
      const u = await check();
      if (u) {
        setUpdate(u);
        setPhase("available");
      } else {
        setPhase("idle");
        if (manual) {
          // 수동 체크인데 업데이트 없을 때는 잠깐 배너로 알림
          setErrorMsg("You're on the latest version.");
          setPhase("error");
          setTimeout(() => setPhase("idle"), 2200);
        }
      }
    } catch (err) {
      setPhase("error");
      setErrorMsg(String(err));
    }
  };

  // 시작 시 자동 체크
  useEffect(() => {
    if (autoChecked.current) return;
    autoChecked.current = true;
    const t = setTimeout(() => runCheck(false), 1500);
    return () => clearTimeout(t);
  }, []);

  // View 메뉴의 "Check for updates" 이벤트 구독 (수동)
  useEffect(() => {
    const un = listen("updater-check", () => runCheck(true));
    return () => {
      un.then((f) => f());
    };
  }, []);

  const handleInstall = async () => {
    if (!update) return;
    setPhase("downloading");
    setProgress({ downloaded: 0, total: 0 });
    try {
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          setProgress({ downloaded: 0, total });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress({ downloaded, total });
        } else if (event.event === "Finished") {
          setPhase("ready");
        }
      });
      // macOS/Linux 는 자동 재시작 안 됨 → relaunch 호출
      await relaunch();
    } catch (err) {
      setPhase("error");
      setErrorMsg(String(err));
    }
  };

  if (dismissed || phase === "idle") return null;

  const pct =
    progress.total > 0
      ? Math.min(100, Math.floor((progress.downloaded / progress.total) * 100))
      : 0;

  return (
    <div className={`ub-bar ub-phase-${phase}`}>
      {phase === "checking" && <span className="ub-text">Checking for updates...</span>}

      {phase === "available" && update && (
        <>
          <span className="ub-text">
            Update available: <strong>v{update.version}</strong>
            {update.date && <span className="ub-meta"> · {update.date}</span>}
          </span>
          <div className="ub-actions">
            <button className="ub-btn ub-btn-primary" onClick={handleInstall}>
              Install & relaunch
            </button>
            <button
              className="ub-btn ub-btn-ghost"
              onClick={() => setDismissed(true)}
              title="Dismiss (until next launch)"
            >
              Later
            </button>
          </div>
        </>
      )}

      {phase === "downloading" && (
        <>
          <span className="ub-text">
            Downloading update... {pct}%
            {progress.total > 0 && (
              <span className="ub-meta">
                {" "}
                · {(progress.downloaded / 1024 / 1024).toFixed(1)} / {(progress.total / 1024 / 1024).toFixed(1)} MB
              </span>
            )}
          </span>
          <div className="ub-progress">
            <div className="ub-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </>
      )}

      {phase === "ready" && <span className="ub-text">Restarting...</span>}

      {phase === "error" && errorMsg && (
        <>
          <span className="ub-text ub-err">{errorMsg}</span>
          <button className="ub-btn ub-btn-ghost" onClick={() => setDismissed(true)}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
