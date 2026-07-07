import { invoke, type Channel } from "@tauri-apps/api/core";
import { FileEntry, TransferEvent } from "../types/sftp";
import { bumpName, joinPath } from "../utils/path";

interface RecursiveEntry {
  path: string;
  relative: string;
}

/** 원격 디렉토리를 재귀 탐색해 파일 전체 목록을 만든다. */
async function listRemoteRecursive(
  sftpId: string,
  basePath: string,
): Promise<RecursiveEntry[]> {
  const out: RecursiveEntry[] = [];
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

/** 로컬 디렉토리를 재귀 탐색해 파일 전체 목록을 만든다. */
async function listLocalRecursive(
  basePath: string,
): Promise<RecursiveEntry[]> {
  const out: RecursiveEntry[] = [];
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

/** checker 가 false 를 반환할 때까지 이름을 bump 해 자유 이름을 찾는다. */
export async function findFreeName(
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

interface EnqueuerOptions {
  channel: Channel<TransferEvent>;
  onError: (msg: string) => void;
}

/**
 * Transfer 큐에 작업을 enqueue 하는 헬퍼 묶음.
 * channel + 에러 핸들러를 한 번 바인드해 upload/download/s2s 를 반환한다.
 */
export function createEnqueuers({ channel, onError }: EnqueuerOptions) {
  return {
    upload: async (local: string, remote: string, dstSftpId: string) => {
      try {
        await invoke("sftp_transfer_upload", {
          sftpId: dstSftpId,
          localPath: local,
          remotePath: remote,
          onEvent: channel,
        });
      } catch (err) {
        onError(`Enqueue upload failed: ${err}`);
      }
    },
    download: async (remote: string, local: string, srcSftpId: string) => {
      try {
        await invoke("sftp_transfer_download", {
          sftpId: srcSftpId,
          remotePath: remote,
          localPath: local,
          onEvent: channel,
        });
      } catch (err) {
        onError(`Enqueue download failed: ${err}`);
      }
    },
    s2s: async (
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
          onEvent: channel,
        });
      } catch (err) {
        onError(`Enqueue copy failed: ${err}`);
      }
    },
  };
}

type ResolvePathFn = (
  checker: (path: string) => Promise<boolean>,
  desiredPath: string,
  displayName: string,
  remainingHint: number,
) => Promise<string | null>;

export interface DispatchResult {
  queued: number;
  skipped: number;
}

interface DispatchContext {
  resolvePath: ResolvePathFn;
  enqueuers: ReturnType<typeof createEnqueuers>;
}

/**
 * local → remote 업로드 디스패치. 폴더는 재귀 탐색하며 각 파일 충돌을 resolvePath 로 해결.
 * 업로드/s2s 는 대상 부모 디렉토리가 없을 수 있어 sftp_mkdir_p 로 보장.
 */
export async function dispatchUpload(
  entries: FileEntry[],
  targetSftpId: string,
  targetPath: string,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  let queued = 0;
  let skipped = 0;
  const checker = remoteExists(targetSftpId);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const destChild = joinPath(targetPath, entry.name);
    const finalChild = await ctx.resolvePath(
      checker,
      destChild,
      entry.name,
      entries.length - i - 1,
    );
    if (finalChild === null) {
      skipped++;
      continue;
    }

    if (entry.is_dir) {
      // 폴더: 내부 파일 각각 원격 존재 체크.
      // 최상위에서 Keep Both → finalChild=`project (1)/` 라 내부는 자연스럽게 충돌 없음.
      // 최상위에서 Replace → finalChild=`project/` 이면 내부 파일만 충돌 가능. blanket 정책이
      // dispatch 동안 유지되므로 "Apply to all" 체크 시 반복 묻지 않는다.
      const files = await listLocalRecursive(entry.path);
      for (let j = 0; j < files.length; j++) {
        const f = files[j];
        const remotePath = `${finalChild}/${f.relative}`;
        const resolved = await ctx.resolvePath(
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
          await invoke("sftp_mkdir_p", { sftpId: targetSftpId, path: parent });
        } catch {
          // ignore — 이미 존재할 수 있음
        }
        await ctx.enqueuers.upload(f.path, resolved, targetSftpId);
        queued++;
      }
    } else {
      await ctx.enqueuers.upload(entry.path, finalChild, targetSftpId);
      queued++;
    }
  }
  return { queued, skipped };
}

/**
 * remote → local 다운로드 디스패치. 폴더는 재귀 탐색.
 */
export async function dispatchDownload(
  entries: FileEntry[],
  sourceSftpId: string,
  targetPath: string,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  let queued = 0;
  let skipped = 0;
  const checker = localExists();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const destChild = joinPath(targetPath, entry.name);
    const finalChild = await ctx.resolvePath(
      checker,
      destChild,
      entry.name,
      entries.length - i - 1,
    );
    if (finalChild === null) {
      skipped++;
      continue;
    }

    if (entry.is_dir) {
      const files = await listRemoteRecursive(sourceSftpId, entry.path);
      for (let j = 0; j < files.length; j++) {
        const f = files[j];
        const localPath = `${finalChild}/${f.relative}`;
        const resolved = await ctx.resolvePath(
          checker,
          localPath,
          f.relative,
          files.length - j - 1,
        );
        if (resolved === null) {
          skipped++;
          continue;
        }
        await ctx.enqueuers.download(f.path, resolved, sourceSftpId);
        queued++;
      }
    } else {
      await ctx.enqueuers.download(entry.path, finalChild, sourceSftpId);
      queued++;
    }
  }
  return { queued, skipped };
}

/**
 * remote → remote (server-to-server) 디스패치. 폴더는 재귀 탐색.
 */
export async function dispatchS2S(
  entries: FileEntry[],
  sourceSftpId: string,
  targetSftpId: string,
  targetPath: string,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  let queued = 0;
  let skipped = 0;
  const checker = remoteExists(targetSftpId);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const destChild = joinPath(targetPath, entry.name);
    const finalChild = await ctx.resolvePath(
      checker,
      destChild,
      entry.name,
      entries.length - i - 1,
    );
    if (finalChild === null) {
      skipped++;
      continue;
    }

    if (entry.is_dir) {
      const files = await listRemoteRecursive(sourceSftpId, entry.path);
      for (let j = 0; j < files.length; j++) {
        const f = files[j];
        const dstPath = `${finalChild}/${f.relative}`;
        const resolved = await ctx.resolvePath(
          checker,
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
          await invoke("sftp_mkdir_p", { sftpId: targetSftpId, path: parent });
        } catch {
          // ignore
        }
        await ctx.enqueuers.s2s(sourceSftpId, f.path, targetSftpId, resolved);
        queued++;
      }
    } else {
      await ctx.enqueuers.s2s(sourceSftpId, entry.path, targetSftpId, finalChild);
      queued++;
    }
  }
  return { queued, skipped };
}
