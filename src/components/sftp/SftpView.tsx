import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import FilePanel, { DragPayload, FilePanelHandle } from "./FilePanel";
import { bumpName, joinPath } from "../../utils/path";
import TransferDock from "./TransferDock";
import Toolbar from "./Toolbar";
import ContextMenu, { MenuItem } from "./ContextMenu";
import ConflictDialog, { ConflictAction, ConflictResolution } from "./ConflictDialog";
import InputDialog from "./InputDialog";
import SyncDialog from "./SyncDialog";
import { Profile } from "../../types";
import { FileEntry, TransferEvent, TransferJob } from "../../types/sftp";
import "./SftpView.css";

interface SftpViewProps {
  sessionId: string;
  sftpId: string;
  homePath: string;
  availableSessions?: {
    id: string;
    sftpId: string;
    label: string;
    homePath: string;
  }[];
}

type PanelSource =
  | { mode: "local"; sftpId: null; homePath: string; label: string }
  | { mode: "remote"; sftpId: string; homePath: string; label: string };


// 원격 디렉토리를 재귀 탐색해 파일 전체 목록을 만든다.
async function listRemoteRecursive(
  sftpId: string,
  basePath: string,
): Promise<{ path: string; relative: string }[]> {
  const out: { path: string; relative: string }[] = [];
  async function walk(cur: string, relPrefix: string) {
    const children = await invoke<FileEntry[]>("sftp_list_dir", {
      sftpId,
      path: cur,
    });
    for (const c of children) {
      const rel = relPrefix ? `${relPrefix}/${c.name}` : c.name;
      if (c.is_dir) {
        await walk(c.path, rel);
      } else {
        out.push({ path: c.path, relative: rel });
      }
    }
  }
  await walk(basePath, "");
  return out;
}

async function findFreeName(
  checker: (path: string) => Promise<boolean>,
  candidate: string,
): Promise<string> {
  let path = candidate;
  // 과도한 반복 방지 (999 개 정도면 충분히 상식적)
  for (let i = 0; i < 1000; i++) {
    const exists = await checker(path);
    if (!exists) return path;
    path = bumpName(path);
  }
  return path;
}

const remoteExists = (sftpId: string) => (path: string) =>
  invoke<boolean>("sftp_exists", { sftpId, path });
const localExists = () => (path: string) =>
  invoke<boolean>("local_exists", { path });

async function listLocalRecursive(
  basePath: string,
): Promise<{ path: string; relative: string }[]> {
  const out: { path: string; relative: string }[] = [];
  async function walk(cur: string, relPrefix: string) {
    const children = await invoke<FileEntry[]>("list_local_dir", { path: cur });
    for (const c of children) {
      const rel = relPrefix ? `${relPrefix}/${c.name}` : c.name;
      if (c.is_dir) {
        await walk(c.path, rel);
      } else {
        out.push({ path: c.path, relative: rel });
      }
    }
  }
  await walk(basePath, "");
  return out;
}

export default function SftpView({
  sftpId,
  homePath,
  availableSessions,
}: SftpViewProps) {
  const [localHome, setLocalHome] = useState<string>("/");
  useEffect(() => {
    invoke<string>("get_local_home_dir")
      .then(setLocalHome)
      .catch(() => {});
  }, []);

  // 저장된 profiles — source selector 의 "connect new server" 옵션 제공용.
  const [profiles, setProfiles] = useState<Profile[]>([]);
  useEffect(() => {
    invoke<Profile[]>("list_profiles")
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  // 양쪽 패널의 소스 (Local / Server A / Server B / ...)
  const [leftSrc, setLeftSrc] = useState<PanelSource>({
    mode: "remote",
    sftpId,
    homePath,
    label: "Remote",
  });
  const [rightSrc, setRightSrc] = useState<PanelSource>(() => ({
    mode: "local",
    sftpId: null,
    homePath: "/",
    label: "Local",
  }));
  useEffect(() => {
    // localHome 로드 완료 후 오른쪽이 local이면 경로 보정
    if (rightSrc.mode === "local" && rightSrc.homePath === "/") {
      setRightSrc((prev) =>
        prev.mode === "local" ? { ...prev, homePath: localHome } : prev,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localHome]);

  const [focused, setFocused] = useState<"left" | "right">("left");
  const [transferJobs, setTransferJobs] = useState<TransferJob[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [showSync, setShowSync] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const [conflict, setConflict] = useState<{
    fileName: string;
    remaining: number;
    resolve: (r: ConflictResolution) => void;
  } | null>(null);
  // "Apply to all" 동안 유지되는 선택. null 이면 매번 묻는다.
  const blanketRef = useRef<ConflictAction | null>(null);
  const [inputDialog, setInputDialog] = useState<{
    title: string;
    initial: string;
    placeholder?: string;
    confirmLabel?: string;
    resolve: (value: string | null) => void;
  } | null>(null);

  // prompt() 대체. Tauri webview 에서 native prompt 가 차단되므로 커스텀 모달로 입력받는다.
  const askInput = useCallback(
    (
      title: string,
      initial = "",
      options?: { placeholder?: string; confirmLabel?: string },
    ): Promise<string | null> =>
      new Promise((resolve) => {
        setInputDialog({
          title,
          initial,
          placeholder: options?.placeholder,
          confirmLabel: options?.confirmLabel,
          resolve: (v) => {
            setInputDialog(null);
            resolve(v);
          },
        });
      }),
    [],
  );

  // dispatchTransfer 내부에서 호출. 업로드 대상이 이미 존재하면 어떻게 할지 결정.
  const resolveConflict = useCallback(
    (fileName: string, remaining: number): Promise<ConflictResolution> => {
      if (blanketRef.current) {
        return Promise.resolve({ action: blanketRef.current, applyToAll: true });
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

  // 충돌 체크 후 최종 경로 결정. 대상이 remote 든 local 든 checker 만 바뀐다.
  // Returns null → skip. 컴포넌트 레벨이라 dispatchTransfer / handleExternalDrop 모두 재사용.
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

  // dragPayload 는 drop 시점에 최신 값을 확실히 읽어야 하므로 ref 로 관리.
  // state 는 리렌더 타이밍상 drop 이벤트와 엇갈릴 수 있다.
  const dragPayloadRef = useRef<DragPayload | null>(null);
  const setDragPayload = useCallback((p: DragPayload | null) => {
    dragPayloadRef.current = p;
  }, []);

  // Drag-out 준비 상태. 우클릭 "Drag to desktop" 으로 temp 에 다운로드해 둔 파일은
  // 사용자 HTML5 drag 제스처가 시작되는 순간 plugin.startDrag(tempPath) 를 호출해서
  // OS native drag 로 넘긴다. plugin.startDrag 는 macOS 에서 마우스 제스처 컨텍스트
  // 안에서만 drag session 을 시작할 수 있으므로 이 시점 분리가 필수다.
  const preparedDragsRef = useRef<Map<string, string>>(new Map()); // remotePath → tempPath
  const pendingDragJobsRef = useRef<Map<string, string>>(new Map()); // jobId → remotePath

  // drop 없이 drag 제스처가 끝났을 때 ref 정리 — 다음 drag 가 stale payload 를 쓰지 않도록.
  // 단, native drop 이벤트는 dragend 이후에 발화될 수 있어서 약간 지연 정리한다.
  useEffect(() => {
    const onEnd = () => {
      setTimeout(() => {
        dragPayloadRef.current = null;
      }, 50);
    };
    window.addEventListener("dragend", onEnd);
    return () => window.removeEventListener("dragend", onEnd);
  }, []);

  const leftHandle = useRef<FilePanelHandle | null>(null);
  const rightHandle = useRef<FilePanelHandle | null>(null);
  const dualPanelsRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  // Transfer Channel (컴포넌트 생애 동안 유지)
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
        // drag-out 준비 완료 알림
        const remotePath = pendingDragJobsRef.current.get(event.data);
        if (remotePath) {
          pendingDragJobsRef.current.delete(event.data);
          const name = remotePath.split("/").pop() || remotePath;
          showToast(`Drag ready: ${name} — drag it now from the list`);
        }
        leftHandle.current?.refresh();
        rightHandle.current?.refresh();
      } else if (event.type === "Failed") {
        setTransferJobs((prev) =>
          prev.map((j) =>
            j.id === event.data.job_id
              ? { ...j, status: "failed", error: event.data.error }
              : j,
          ),
        );
        showToast(`Failed: ${event.data.error}`);
      }
    };
    return ch;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCancelTransfer = useCallback(async (jobId: string) => {
    try {
      await invoke("sftp_transfer_cancel", { jobId });
    } catch (err) {
      showToast(`Cancel failed: ${err}`);
    }
  }, [showToast]);

  // Channel 이벤트가 끊길 수 있는 환경(HMR reload 등)에서 UI 상태를
  // backend 의 실제 transfer 상태로 복구하기 위한 polling fallback.
  // Channel 이 정상이면 중복 업데이트지만 값이 같아서 문제없다.
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const jobs = await invoke<TransferJob[]>("sftp_transfer_list");
        setTransferJobs(jobs);
      } catch {
        // ignore — backend 재시작 중일 수도 있음
      }
    }, 2000);
    return () => clearInterval(iv);
  }, []);

  const handleClearCompleted = useCallback(async () => {
    try {
      await invoke("sftp_transfer_clear_completed");
      setTransferJobs((prev) =>
        prev.filter(
          (j) =>
            j.status !== "completed" &&
            j.status !== "failed" &&
            j.status !== "cancelled",
        ),
      );
    } catch (err) {
      showToast(`Clear failed: ${err}`);
    }
  }, [showToast]);

  // 소스 변경 셀렉터
  const sessionsList = useMemo(() => {
    const list: PanelSource[] = [
      { mode: "local", sftpId: null, homePath: localHome, label: "Local" },
      { mode: "remote", sftpId, homePath, label: "Remote" },
    ];
    if (availableSessions) {
      for (const s of availableSessions) {
        if (s.sftpId === sftpId) continue;
        list.push({
          mode: "remote",
          sftpId: s.sftpId,
          homePath: s.homePath,
          label: s.label,
        });
      }
    }
    return list;
  }, [localHome, sftpId, homePath, availableSessions]);

  // 프로필에서 on-demand 로 SSH+SFTP 세션을 만들고 해당 side 에 attach.
  const connectProfile = useCallback(
    async (side: "left" | "right", profileId: number) => {
      try {
        const full = await invoke<Profile>("get_profile", { id: profileId });
        const onEvent = new Channel();
        const jumpHost = full.jump_host
          ? (() => {
              try {
                return JSON.parse(full.jump_host as unknown as string);
              } catch {
                return null;
              }
            })()
          : null;
        const sshSessionId = await invoke<string>("create_ssh_session", {
          host: full.host,
          port: full.port,
          username: full.username,
          authType: full.auth_type,
          password: full.password || null,
          keyPath: full.key_path || null,
          jumpHost,
          agentForward: full.agent_forward || false,
          onEvent,
        });
        const newSftpId = await invoke<string>("sftp_open", {
          sessionId: sshSessionId,
        });
        const newHome = await invoke<string>("sftp_get_home_dir", {
          sftpId: newSftpId,
        });
        const src: PanelSource = {
          mode: "remote",
          sftpId: newSftpId,
          homePath: newHome,
          label: `${full.username}@${full.host}`,
        };
        if (side === "left") setLeftSrc(src);
        else setRightSrc(src);
        showToast(`Connected: ${full.username}@${full.host}`);
      } catch (err) {
        showToast(`Connect failed: ${err}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleSourceChange = useCallback(
    (side: "left" | "right", key: string) => {
      if (key.startsWith("profile:")) {
        const id = Number(key.slice("profile:".length));
        if (Number.isFinite(id)) connectProfile(side, id);
        return;
      }
      const found = sessionsList.find(
        (s) => (s.mode === "local" ? "local" : s.sftpId) === key,
      );
      if (!found) return;
      if (side === "left") setLeftSrc(found);
      else setRightSrc(found);
    },
    [sessionsList, connectProfile],
  );

  // 전송 enqueue 헬퍼
  const enqueueUpload = useCallback(
    async (local: string, remote: string, dstSftpId: string) => {
      try {
        await invoke("sftp_transfer_upload", {
          sftpId: dstSftpId,
          localPath: local,
          remotePath: remote,
          onEvent: transferChannel,
        });
      } catch (err) {
        showToast(`Enqueue upload failed: ${err}`);
      }
    },
    [transferChannel, showToast],
  );

  const enqueueDownload = useCallback(
    async (remote: string, local: string, srcSftpId: string) => {
      try {
        await invoke("sftp_transfer_download", {
          sftpId: srcSftpId,
          remotePath: remote,
          localPath: local,
          onEvent: transferChannel,
        });
      } catch (err) {
        showToast(`Enqueue download failed: ${err}`);
      }
    },
    [transferChannel, showToast],
  );

  const enqueueS2S = useCallback(
    async (
      srcId: string,
      srcPath: string,
      dstId: string,
      dstPath: string,
    ) => {
      try {
        await invoke("sftp_transfer_server_to_server", {
          srcSftpId: srcId,
          srcPath,
          dstSftpId: dstId,
          dstPath,
          onEvent: transferChannel,
        });
      } catch (err) {
        showToast(`Enqueue copy failed: ${err}`);
      }
    },
    [transferChannel, showToast],
  );

  // 드래그 드롭에서 호출되는 실제 전송 디스패처 (폴더 재귀 포함)
  //
  // Remote 쪽 충돌 처리: 업로드/s2s 의 대상 경로가 이미 존재하면 resolveConflict 로 사용자 선택.
  // - Replace: 덮어쓰기 (기존 경로로 enqueue)
  // - Keep Both: 빈 번호 찾아 `file (N).ext` 로 rename
  // - Skip: 그 파일만 건너뜀
  // "Apply to all" 이 체크되면 blanketRef 로 다음 충돌에도 같은 선택을 자동 적용.
  const dispatchTransfer = useCallback(
    async (
      source: DragPayload,
      target: { mode: "local" | "remote"; sftpId: string | null; path: string },
    ) => {
      // 한 번의 dispatch 가 끝나면 blanket 정책은 리셋 (다음 drag 에는 다시 물어봄)
      blanketRef.current = null;

      // 동일 패널 내부 드롭은 무시
      if (
        source.sourceMode === target.mode &&
        source.sourceSftpId === target.sftpId &&
        source.sourcePath === target.path
      ) {
        return;
      }


      let queued = 0;
      let skipped = 0;
      for (let i = 0; i < source.entries.length; i++) {
        const entry = source.entries[i];
        const destChild = joinPath(target.path, entry.name);
        const remainingHint = source.entries.length - i - 1;

        // CASE 1: local → remote
        if (source.sourceMode === "local" && target.mode === "remote" && target.sftpId) {
          const finalChild = await resolvePath(
            remoteExists(target.sftpId),
            destChild,
            entry.name,
            remainingHint,
          );
          if (finalChild === null) {
            skipped++;
            continue;
          }
          if (entry.is_dir) {
            // 폴더: 내부 파일 각각 원격 존재 체크.
            // 최상위에서 Keep Both → finalChild=`project (1)/` 라 내부는 자연스럽게 충돌 없음.
            // 최상위에서 Replace → finalChild=`project/` 이면 내부 파일만 충돌 가능. blanketRef 가
            // dispatch 동안 유지되므로 "Apply to all" 체크 시 반복 묻지 않는다.
            const files = await listLocalRecursive(entry.path);
            for (let j = 0; j < files.length; j++) {
              const f = files[j];
              const remotePath = `${finalChild}/${f.relative}`;
              const resolved = await resolvePath(
                remoteExists(target.sftpId),
                remotePath,
                f.relative,
                files.length - j - 1,
              );
              if (resolved === null) {
                skipped++;
                continue;
              }
              const parent = resolved.substring(0, resolved.lastIndexOf("/"));
              try {
                await invoke("sftp_mkdir_p", { sftpId: target.sftpId, path: parent });
              } catch {}
              await enqueueUpload(f.path, resolved, target.sftpId);
              queued++;
            }
          } else {
            await enqueueUpload(entry.path, finalChild, target.sftpId);
            queued++;
          }
        }
        // CASE 2: remote → local — 로컬 충돌도 같은 dialog 로 처리
        else if (source.sourceMode === "remote" && target.mode === "local" && source.sourceSftpId) {
          const finalChild = await resolvePath(
            localExists(),
            destChild,
            entry.name,
            remainingHint,
          );
          if (finalChild === null) {
            skipped++;
            continue;
          }
          if (entry.is_dir) {
            const files = await listRemoteRecursive(source.sourceSftpId, entry.path);
            for (let j = 0; j < files.length; j++) {
              const f = files[j];
              const localPath = `${finalChild}/${f.relative}`;
              const resolved = await resolvePath(
                localExists(),
                localPath,
                f.relative,
                files.length - j - 1,
              );
              if (resolved === null) {
                skipped++;
                continue;
              }
              await enqueueDownload(f.path, resolved, source.sourceSftpId);
              queued++;
            }
          } else {
            await enqueueDownload(entry.path, finalChild, source.sourceSftpId);
            queued++;
          }
        }
        // CASE 3: remote → remote (server-to-server)
        else if (source.sourceMode === "remote" && target.mode === "remote" && source.sourceSftpId && target.sftpId) {
          const finalChild = await resolvePath(
            remoteExists(target.sftpId),
            destChild,
            entry.name,
            remainingHint,
          );
          if (finalChild === null) {
            skipped++;
            continue;
          }
          if (entry.is_dir) {
            const files = await listRemoteRecursive(source.sourceSftpId, entry.path);
            for (let j = 0; j < files.length; j++) {
              const f = files[j];
              const dstPath = `${finalChild}/${f.relative}`;
              const resolved = await resolvePath(
                remoteExists(target.sftpId),
                dstPath,
                f.relative,
                files.length - j - 1,
              );
              if (resolved === null) {
                skipped++;
                continue;
              }
              const parent = resolved.substring(0, resolved.lastIndexOf("/"));
              try {
                await invoke("sftp_mkdir_p", { sftpId: target.sftpId, path: parent });
              } catch {}
              await enqueueS2S(source.sourceSftpId, f.path, target.sftpId, resolved);
              queued++;
            }
          } else {
            await enqueueS2S(source.sourceSftpId, entry.path, target.sftpId, finalChild);
            queued++;
          }
        }
        // CASE 4: local → local (지원 안 함)
        else {
          showToast("Local → local transfer not supported");
          return;
        }
      }

      if (queued > 0) {
        showToast(
          `Queued ${queued} file${queued > 1 ? "s" : ""}` +
            (skipped ? ` · ${skipped} skipped` : ""),
        );
      } else if (skipped > 0) {
        showToast(`Skipped ${skipped} conflict${skipped > 1 ? "s" : ""}`);
      }
    },
    [enqueueUpload, enqueueDownload, enqueueS2S, showToast, resolvePath],
  );

  // 패널 HTML5 드롭 핸들러. Tauri webview 에서 native drop 이 이벤트를 삼키는 환경이 많아
  // 실제론 거의 발화되지 않지만, 발화되는 환경을 위해 폴백 경로로 유지한다. dragPayload 는
  // state 가 아닌 ref 에서 읽어 drop 시점의 값을 그대로 쓴다.
  const handleLeftDrop = useCallback(
    (targetPath: string, _isDirTarget: boolean) => {
      const payload = dragPayloadRef.current;
      dragPayloadRef.current = null;
      if (!payload || payload.side === "left") return;
      dispatchTransfer(payload, {
        mode: leftSrc.mode,
        sftpId: leftSrc.sftpId,
        path: targetPath,
      });
    },
    [dispatchTransfer, leftSrc],
  );

  const handleRightDrop = useCallback(
    (targetPath: string, _isDirTarget: boolean) => {
      const payload = dragPayloadRef.current;
      dragPayloadRef.current = null;
      if (!payload || payload.side === "right") return;
      dispatchTransfer(payload, {
        mode: rightSrc.mode,
        sftpId: rightSrc.sftpId,
        path: targetPath,
      });
    },
    [dispatchTransfer, rightSrc],
  );

  // 더블클릭 (파일 열기 = 에디터로 열기: remote 원격 파일에 한해)
  const handleFileAction = useCallback(
    (action: string, entry: FileEntry, side: "left" | "right") => {
      if (action !== "open") return;
      const src = side === "left" ? leftSrc : rightSrc;
      if (src.mode !== "remote" || !src.sftpId) return;

      type WatchEvent =
        | { type: "Uploading"; data: string }
        | { type: "Uploaded"; data: string }
        | { type: "Error"; data: string };
      const onEvent = new Channel<WatchEvent>();
      onEvent.onmessage = (event) => {
        if (event.type === "Uploading") showToast(`Auto-uploading ${event.data}...`);
        else if (event.type === "Uploaded") showToast(`Uploaded: ${event.data}`);
        else if (event.type === "Error") showToast(`Editor: ${event.data}`);
      };

      showToast(`Opening ${entry.name}...`);
      invoke("open_in_editor", {
        sftpId: src.sftpId,
        remotePath: entry.path,
        onEvent,
      })
        .then(() => showToast(`${entry.name} opened. Save to auto-upload.`))
        .catch((err) => showToast(`Open failed: ${err}`));
    },
    [leftSrc, rightSrc, showToast],
  );

  // side 기반 헬퍼 — focused state 에 의존하지 않아 우클릭 메뉴에서 호출해도 stale closure 가 안 된다.
  const handleFor = useCallback(
    (side: "left" | "right") =>
      side === "left" ? leftHandle : rightHandle,
    [],
  );

  const uploadFromSide = useCallback(
    async (fromSide: "left" | "right") => {
      const fromSrc = fromSide === "left" ? leftSrc : rightSrc;
      const toSrc = fromSide === "left" ? rightSrc : leftSrc;
      const fromHandle = handleFor(fromSide);
      const toHandle = handleFor(fromSide === "left" ? "right" : "left");
      if (fromSrc.mode !== "local" || toSrc.mode !== "remote" || !toSrc.sftpId) {
        showToast("Upload: need Local → Remote");
        return;
      }
      const selected = fromHandle.current?.getSelected() || [];
      if (selected.length === 0) {
        showToast("Select files in the Local panel first");
        return;
      }
      const targetBase = toHandle.current?.currentPath || toSrc.homePath;
      await dispatchTransfer(
        {
          side: fromSide,
          entries: selected,
          sourcePath: fromHandle.current?.currentPath || fromSrc.homePath,
          sourceMode: "local",
          sourceSftpId: null,
        },
        { mode: "remote", sftpId: toSrc.sftpId, path: targetBase },
      );
    },
    [leftSrc, rightSrc, handleFor, dispatchTransfer, showToast],
  );

  const downloadFromSide = useCallback(
    async (fromSide: "left" | "right") => {
      const fromSrc = fromSide === "left" ? leftSrc : rightSrc;
      const toSrc = fromSide === "left" ? rightSrc : leftSrc;
      const fromHandle = handleFor(fromSide);
      const toHandle = handleFor(fromSide === "left" ? "right" : "left");
      if (fromSrc.mode !== "remote" || !fromSrc.sftpId) {
        showToast("Download: selected panel must be Remote");
        return;
      }
      const selected = fromHandle.current?.getSelected() || [];
      if (selected.length === 0) {
        showToast("No files selected");
        return;
      }
      if (toSrc.mode === "local") {
        const targetBase = toHandle.current?.currentPath || toSrc.homePath;
        await dispatchTransfer(
          {
            side: fromSide,
            entries: selected,
            sourcePath: fromHandle.current?.currentPath || fromSrc.homePath,
            sourceMode: "remote",
            sourceSftpId: fromSrc.sftpId,
          },
          { mode: "local", sftpId: null, path: targetBase },
        );
      } else if (toSrc.mode === "remote" && toSrc.sftpId) {
        // remote → remote: server-to-server
        const targetBase = toHandle.current?.currentPath || toSrc.homePath;
        await dispatchTransfer(
          {
            side: fromSide,
            entries: selected,
            sourcePath: fromHandle.current?.currentPath || fromSrc.homePath,
            sourceMode: "remote",
            sourceSftpId: fromSrc.sftpId,
          },
          { mode: "remote", sftpId: toSrc.sftpId, path: targetBase },
        );
      }
    },
    [leftSrc, rightSrc, handleFor, dispatchTransfer, showToast],
  );

  const newFolderInSide = useCallback(
    async (side: "left" | "right") => {
      const src = side === "left" ? leftSrc : rightSrc;
      const h = handleFor(side);
      const name = await askInput("New folder name", "", {
        placeholder: "e.g. deploy",
        confirmLabel: "Create",
      });
      if (!name) return;
      const base = h.current?.currentPath || src.homePath;
      const full = joinPath(base, name);
      try {
        if (src.mode === "remote" && src.sftpId) {
          await invoke("sftp_mkdir", { sftpId: src.sftpId, path: full });
          h.current?.refresh();
          showToast(`Created ${name}`);
        } else {
          showToast("Local mkdir not supported yet");
        }
      } catch (err) {
        showToast(`Mkdir failed: ${err}`);
      }
    },
    [leftSrc, rightSrc, handleFor, askInput, showToast],
  );

  const renameInSide = useCallback(
    async (side: "left" | "right") => {
      const src = side === "left" ? leftSrc : rightSrc;
      const h = handleFor(side);
      const selected = h.current?.getSelected() || [];
      if (selected.length !== 1) return;
      const entry = selected[0];
      const newName = await askInput("Rename", entry.name, {
        confirmLabel: "Rename",
      });
      if (!newName || newName === entry.name) return;
      const base = h.current?.currentPath || "/";
      const newPath = joinPath(base, newName);
      try {
        if (src.mode === "remote" && src.sftpId) {
          await invoke("sftp_rename", {
            sftpId: src.sftpId,
            oldPath: entry.path,
            newPath,
          });
          h.current?.refresh();
          showToast("Renamed");
        } else {
          showToast("Local rename not supported yet");
        }
      } catch (err) {
        showToast(`Rename failed: ${err}`);
      }
    },
    [leftSrc, rightSrc, handleFor, askInput, showToast],
  );

  const deleteInSide = useCallback(
    async (side: "left" | "right") => {
      const src = side === "left" ? leftSrc : rightSrc;
      const h = handleFor(side);
      const selected = h.current?.getSelected() || [];
      if (selected.length === 0) return;
      if (src.mode !== "remote" || !src.sftpId) {
        showToast("Local delete not supported yet");
        return;
      }
      const confirmed = await ask(`Delete ${selected.length} item(s)?`, {
        title: "Confirm Delete",
        kind: "warning",
      });
      if (!confirmed) return;
      let ok = 0;
      let fail = 0;
      for (const e of selected) {
        try {
          await invoke("sftp_delete", {
            sftpId: src.sftpId,
            path: e.path,
            isDir: e.is_dir,
          });
          ok++;
        } catch {
          fail++;
        }
      }
      h.current?.refresh();
      showToast(`Deleted ${ok}${fail ? `, ${fail} failed` : ""}`);
    },
    [leftSrc, rightSrc, handleFor, showToast],
  );

  const handleRefresh = useCallback(() => {
    leftHandle.current?.refresh();
    rightHandle.current?.refresh();
  }, []);

  // FilePanel 의 HTML5 drag 시작 시점을 가로챈다. 단일 파일이고 preparedDrags 에
  // temp 경로가 있으면 plugin.startDrag 로 OS native drag 를 시작 — 제스처 컨텍스트
  // 안에서만 가능하기 때문에 이 시점 외에는 OS drag 를 열 수 없다.
  const onPanelDragStart = useCallback((payload: DragPayload) => {
    setDragPayload(payload);
    if (payload.entries.length === 1) {
      const entry = payload.entries[0];
      const tempPath = preparedDragsRef.current.get(entry.path);
      if (tempPath) {
        startDrag({ item: [tempPath], icon: "" }).catch((err) => {
          showToast(`Drag out failed: ${err}`);
        });
      }
    }
  }, [setDragPayload, showToast]);

  // 외부(Finder / Explorer) → 창 드롭: Tauri native drag-drop 이벤트로 들어온다.
  // HTML5 drag-drop 이벤트는 Tauri webview 에서 외부 파일에 대해 파일 정보를 주지 않는다.
  //
  // macOS / 특정 환경에서 Tauri physical pixel 과 CSS getBoundingClientRect 간
  // 좌표 변환이 어긋나는 경우가 있어서 좌·우 패널별로 개별 rect 판정한다.
  // dpr 로 나눈 값이 패널 rect 안에 들지 않으면 nativeY/nativeX(그대로도) 를 한 번 더 시도.
  const pickSideByPosition = useCallback(
    (physicalX: number, physicalY: number): "left" | "right" | null => {
      const lr = leftHandle.current?.getRect?.() ?? null;
      const rr = rightHandle.current?.getRect?.() ?? null;
      const dpr = window.devicePixelRatio || 1;
      // Tauri physical position 의 실제 스케일이 환경마다 달라 (dpr 로 나눈 값 / raw 값) 둘 다 시도.
      const candidates = [
        { x: physicalX / dpr, y: physicalY / dpr },
        { x: physicalX, y: physicalY },
      ];
      for (const c of candidates) {
        if (lr && c.x >= lr.left && c.x <= lr.right && c.y >= lr.top && c.y <= lr.bottom) {
          return "left";
        }
        if (rr && c.x >= rr.left && c.x <= rr.right && c.y >= rr.top && c.y <= rr.bottom) {
          return "right";
        }
      }
      return null;
    },
    [],
  );

  const handleExternalDrop = useCallback(
    async (paths: string[], physicalX: number, physicalY: number) => {
      // 좌표 판정 실패 시 focused panel 로 fallback (사용자가 보고 있던 곳).
      const side = pickSideByPosition(physicalX, physicalY) || focused;
      const targetSrc = side === "left" ? leftSrc : rightSrc;
      const targetHandle = handleFor(side);
      if (targetSrc.mode !== "remote" || !targetSrc.sftpId) {
        showToast("Drop onto a Remote panel to upload");
        return;
      }
      const targetBase = targetHandle.current?.currentPath || targetSrc.homePath;
      blanketRef.current = null;
      let queued = 0;
      let skipped = 0;
      for (let i = 0; i < paths.length; i++) {
        const abs = paths[i];
        const name = abs.split("/").pop() || abs;
        const destChild = joinPath(targetBase, name);
        const remainingHint = paths.length - i - 1;

        // 충돌 체크
        const checker = remoteExists(targetSrc.sftpId);
        const exists = await checker(destChild);
        let finalChild = destChild;
        if (exists) {
          const res = await resolveConflict(name, remainingHint);
          if (res.action === "skip") {
            skipped++;
            continue;
          }
          if (res.action === "keep-both") {
            finalChild = await findFreeName(checker, destChild);
          }
        }

        let isDir = false;
        try {
          isDir = await invoke<boolean>("is_local_dir", { path: abs });
        } catch (err) {
          showToast(`Skip ${name}: ${err}`);
          continue;
        }
        if (isDir) {
          const files = await listLocalRecursive(abs);
          for (let j = 0; j < files.length; j++) {
            const f = files[j];
            const remotePath = `${finalChild}/${f.relative}`;
            const resolved = await resolvePath(
              checker,
              remotePath,
              f.relative,
              files.length - j - 1,
            );
            if (resolved === null) {
              skipped++;
              continue;
            }
            const parent = resolved.substring(0, resolved.lastIndexOf("/"));
            try {
              await invoke("sftp_mkdir_p", { sftpId: targetSrc.sftpId, path: parent });
            } catch {}
            await enqueueUpload(f.path, resolved, targetSrc.sftpId);
            queued++;
          }
        } else {
          await enqueueUpload(abs, finalChild, targetSrc.sftpId);
          queued++;
        }
      }
      if (queued > 0) {
        showToast(
          `Queued ${queued} file${queued > 1 ? "s" : ""}` +
            (skipped ? ` · ${skipped} skipped` : ""),
        );
      } else if (skipped > 0) {
        showToast(`Skipped ${skipped} conflict${skipped > 1 ? "s" : ""}`);
      }
    },
    [leftSrc, rightSrc, handleFor, pickSideByPosition, enqueueUpload, showToast, focused, resolveConflict, resolvePath],
  );

  // 내부 drag 도 native drop 이벤트로 귀결된다. paths 가 비어있으면 내부 drag (HTML5
   // dragstart 로 ref 에 심어둔 payload 로 source 판단), paths 가 채워져 있으면 외부 drop.
  const handleInternalNativeDrop = useCallback(
    (physicalX: number, physicalY: number) => {
      const payload = dragPayloadRef.current;
      dragPayloadRef.current = null;
      if (!payload) return;
      // 위치 판정 실패 시 source 반대편으로 보낸다 — 대개 사용자 의도.
      const side =
        pickSideByPosition(physicalX, physicalY) ||
        (payload.side === "left" ? "right" : "left");
      if (payload.side === side) return;
      const targetSrc = side === "left" ? leftSrc : rightSrc;
      const targetHandle = handleFor(side);
      const hoverDir = targetHandle.current?.getDragHoverDir?.() ?? null;
      const targetPath =
        hoverDir || targetHandle.current?.currentPath || targetSrc.homePath;
      dispatchTransfer(payload, {
        mode: targetSrc.mode,
        sftpId: targetSrc.sftpId,
        path: targetPath,
      });
    },
    [leftSrc, rightSrc, handleFor, pickSideByPosition, dispatchTransfer],
  );

  // Tauri native drag-drop 이벤트 구독
  useEffect(() => {
    const unlistenP = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const { paths, position } = event.payload;
        if (paths.length === 0) {
          handleInternalNativeDrop(position.x, position.y);
        } else {
          handleExternalDrop(paths, position.x, position.y);
        }
      }
    });
    return () => { unlistenP.then((un) => un()); };
  }, [handleExternalDrop, handleInternalNativeDrop]);

  // Toolbar 는 focused 기반. 우클릭은 side 명시.
  const focusedHandle = focused === "left" ? leftHandle : rightHandle;
  const focusedSrc = focused === "left" ? leftSrc : rightSrc;
  const selectedCount = focusedHandle.current?.getSelected().length ?? 0;

  const handleUpload = useCallback(() => {
    // focus 가 local 이면 거기서 업로드, remote 면 다른 쪽(local) 에서 업로드
    const fromSide: "left" | "right" =
      focusedSrc.mode === "local"
        ? focused
        : focused === "left"
          ? "right"
          : "left";
    uploadFromSide(fromSide);
  }, [focused, focusedSrc, uploadFromSide]);

  const handleDownload = useCallback(() => {
    // focus 가 remote 여야 함. local 이면 반대편이 remote 일 때 그쪽에서 받기
    const fromSide: "left" | "right" =
      focusedSrc.mode === "remote"
        ? focused
        : focused === "left"
          ? "right"
          : "left";
    downloadFromSide(fromSide);
  }, [focused, focusedSrc, downloadFromSide]);

  const handleNewFolder = useCallback(
    () => newFolderInSide(focused),
    [focused, newFolderInSide],
  );
  const handleRename = useCallback(
    () => renameInSide(focused),
    [focused, renameInSide],
  );
  const handleDelete = useCallback(
    () => deleteInSide(focused),
    [focused, deleteInSide],
  );

  // 컨텍스트 메뉴 빌더 — side 기반 함수를 직접 호출 (focused 의존 없음)
  const buildContextMenu = useCallback(
    (
      selection: FileEntry[],
      side: "left" | "right",
      src: PanelSource,
      pos: { x: number; y: number },
    ) => {
      const single = selection.length === 1 ? selection[0] : null;
      const items: MenuItem[] = [];

      if (single && !single.is_dir && src.mode === "remote" && src.sftpId) {
        items.push({
          label: "Open in editor",
          icon: "✎",
          onClick: () => handleFileAction("open", single, side),
        });
      }

      if (src.mode === "remote" && selection.length > 0) {
        items.push({
          label: "Download to other panel",
          icon: "↓",
          onClick: () => downloadFromSide(side),
        });
      }
      // Remote 단일 파일을 OS 어디든 저장 — Save dialog 로 경로 선택 후 TransferManager 큐.
      if (single && !single.is_dir && src.mode === "remote" && src.sftpId) {
        const srcSftpId = src.sftpId;
        items.push({
          label: "Save to...",
          icon: "💾",
          onClick: async () => {
            try {
              const localPath = await save({
                title: "Save File",
                defaultPath: single.name,
              });
              if (!localPath) return;
              await invoke("sftp_transfer_download", {
                sftpId: srcSftpId,
                remotePath: single.path,
                localPath,
                onEvent: transferChannel,
              });
              showToast(`Queued: ${single.name}`);
            } catch (err) {
              showToast(`Save failed: ${err}`);
            }
          },
        });

        // Drag-out: temp 에 다운로드 후 사용자가 해당 파일을 drag 하면 OS native drag 시작.
        // macOS 제약상 native drag session 은 사용자 마우스 제스처 안에서만 열리기 때문에
        // 2 단계 (Prepare → Drag) UX.
        items.push({
          label: "Drag to desktop (prepare)",
          icon: "🡭",
          onClick: async () => {
            try {
              const tempPath = await invoke<string>("drag_temp_path", {
                fileName: single.name,
              });
              preparedDragsRef.current.set(single.path, tempPath);
              const jobId = await invoke<string>("sftp_transfer_download", {
                sftpId: srcSftpId,
                remotePath: single.path,
                localPath: tempPath,
                onEvent: transferChannel,
              });
              pendingDragJobsRef.current.set(jobId, single.path);
              showToast(`Preparing drag-out: ${single.name}`);
            } catch (err) {
              showToast(`Prepare failed: ${err}`);
            }
          },
        });
      }
      if (src.mode === "local" && selection.length > 0) {
        items.push({
          label: "Upload to other panel",
          icon: "↑",
          onClick: () => uploadFromSide(side),
        });
      }

      items.push({ divider: true, label: "" });

      if (single) {
        items.push({
          label: "Copy path",
          icon: "⎘",
          onClick: () => {
            navigator.clipboard.writeText(single.path).catch(() => {});
            showToast("Path copied");
          },
        });
      }

      if (single) {
        items.push({
          label: "Rename",
          icon: "✎",
          onClick: () => renameInSide(side),
        });
      }

      if (selection.length > 0) {
        items.push({
          label: `Delete${selection.length > 1 ? ` (${selection.length})` : ""}`,
          icon: "🗑",
          danger: true,
          onClick: () => deleteInSide(side),
        });
      }

      if (items.length === 0) {
        items.push({ label: "Refresh", icon: "↻", onClick: handleRefresh });
      }

      setCtxMenu({ x: pos.x, y: pos.y, items });
    },
    [handleFileAction, downloadFromSide, uploadFromSide, renameInSide, deleteInSide, handleRefresh, showToast, transferChannel],
  );

  const handleLeftContextMenu = useCallback(
    (selection: FileEntry[], _path: string, pos: { x: number; y: number }) => {
      buildContextMenu(selection, "left", leftSrc, pos);
    },
    [leftSrc, buildContextMenu],
  );

  const handleRightContextMenu = useCallback(
    (selection: FileEntry[], _path: string, pos: { x: number; y: number }) => {
      buildContextMenu(selection, "right", rightSrc, pos);
    },
    [rightSrc, buildContextMenu],
  );

  // 소스 셀렉터 key
  const srcKey = (s: PanelSource) => (s.mode === "local" ? "local" : s.sftpId);

  return (
    <div className="sftp-view">
      <Toolbar
        selectedCount={selectedCount}
        focusedSide={focused}
        onUpload={handleUpload}
        onDownload={handleDownload}
        onNewFolder={handleNewFolder}
        onRename={handleRename}
        onDelete={handleDelete}
        onRefresh={handleRefresh}
        onSync={() => setShowSync(true)}
      />

      <div className="sftp-dual-header">
        <div className="sftp-panel-header">
          <select
            className="sftp-source-select"
            value={srcKey(leftSrc)}
            onChange={(e) => handleSourceChange("left", e.target.value)}
          >
            <optgroup label="Active">
              {sessionsList.map((s) => (
                <option key={srcKey(s)} value={srcKey(s)}>
                  {s.label}
                </option>
              ))}
            </optgroup>
            {profiles.length > 0 && (
              <optgroup label="Connect to...">
                {profiles.map((p) => (
                  <option key={`profile:${p.id}`} value={`profile:${p.id}`}>
                    {p.name} — {p.username}@{p.host}
                    {p.port !== 22 ? `:${p.port}` : ""}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="sftp-panel-divider" />
        <div className="sftp-panel-header">
          <select
            className="sftp-source-select"
            value={srcKey(rightSrc)}
            onChange={(e) => handleSourceChange("right", e.target.value)}
          >
            <optgroup label="Active">
              {sessionsList.map((s) => (
                <option key={srcKey(s)} value={srcKey(s)}>
                  {s.label}
                </option>
              ))}
            </optgroup>
            {profiles.length > 0 && (
              <optgroup label="Connect to...">
                {profiles.map((p) => (
                  <option key={`profile:${p.id}`} value={`profile:${p.id}`}>
                    {p.name} — {p.username}@{p.host}
                    {p.port !== 22 ? `:${p.port}` : ""}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      </div>

      <div className="sftp-dual-panels" ref={dualPanelsRef}>
        <FilePanel
          key={`left-${srcKey(leftSrc)}`}
          side="left"
          mode={leftSrc.mode}
          sftpId={leftSrc.sftpId}
          initialPath={leftSrc.homePath}
          sourceLabel={leftSrc.label}
          isFocused={focused === "left"}
          onFocus={() => setFocused("left")}
          registerHandle={(h) => { leftHandle.current = h; }}
          onFileAction={(action, entry) => handleFileAction(action, entry, "left")}
          onDragStart={onPanelDragStart}
          onDrop={handleLeftDrop}
          onContextMenu={handleLeftContextMenu}
        />
        <div className="sftp-panel-divider" />
        <FilePanel
          key={`right-${srcKey(rightSrc)}`}
          side="right"
          mode={rightSrc.mode}
          sftpId={rightSrc.sftpId}
          initialPath={rightSrc.homePath}
          sourceLabel={rightSrc.label}
          isFocused={focused === "right"}
          onFocus={() => setFocused("right")}
          registerHandle={(h) => { rightHandle.current = h; }}
          onFileAction={(action, entry) => handleFileAction(action, entry, "right")}
          onDragStart={onPanelDragStart}
          onDrop={handleRightDrop}
          onContextMenu={handleRightContextMenu}
        />
      </div>

      <TransferDock
        jobs={transferJobs}
        onCancel={handleCancelTransfer}
        onClearCompleted={handleClearCompleted}
      />

      {toast && <div className="sftp-toast">{toast}</div>}

      {showSync && leftSrc.mode === "remote" && leftSrc.sftpId && (
        <SyncDialog
          sftpId={leftSrc.sftpId}
          remoteBasePath={leftHandle.current?.currentPath || leftSrc.homePath}
          onClose={() => {
            setShowSync(false);
            leftHandle.current?.refresh();
          }}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {conflict && (
        <ConflictDialog
          fileName={conflict.fileName}
          remaining={conflict.remaining}
          onResolve={conflict.resolve}
        />
      )}

      {inputDialog && (
        <InputDialog
          title={inputDialog.title}
          initial={inputDialog.initial}
          placeholder={inputDialog.placeholder}
          confirmLabel={inputDialog.confirmLabel}
          onConfirm={(v) => inputDialog.resolve(v)}
          onCancel={() => inputDialog.resolve(null)}
        />
      )}
    </div>
  );
}
