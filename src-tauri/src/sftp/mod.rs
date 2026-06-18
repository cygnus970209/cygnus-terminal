use russh_sftp::client::{fs::File, SftpSession};
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
}

/// 디렉토리 우선, 이름순(case-insensitive) 정렬 — 로컬/원격 파일 패널 공통 규칙.
pub fn sort_file_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

#[derive(Clone)]
pub struct SftpManager {
    /// `Arc<SftpSession>` 로 저장 — SftpSession 자체는 Clone 이 아니지만, Arc 로
    /// 감싸면 lock 해제 후에도 여러 호출자가 공유 참조로 동시에 사용할 수 있다.
    /// 이게 병렬 stripe 전송의 전제.
    sessions: Arc<Mutex<HashMap<String, Arc<SftpSession>>>>,
}

impl Default for SftpManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn open(
        &self,
        sftp_id: &str,
        sftp: SftpSession,
    ) -> Result<(), String> {
        self.sessions
            .lock()
            .await
            .insert(sftp_id.to_string(), Arc::new(sftp));
        Ok(())
    }

    pub async fn exists(&self, sftp_id: &str) -> bool {
        self.sessions.lock().await.contains_key(sftp_id)
    }

    pub async fn get_home_dir(&self, sftp_id: &str) -> Result<String, String> {
        let sftp = self.get_session(sftp_id).await?;
        sftp.canonicalize(".")
            .await
            .map_err(|e| format!("Failed to get home directory: {e}"))
    }

    pub async fn list_dir(&self, sftp_id: &str, path: &str) -> Result<Vec<FileEntry>, String> {
        let sftp = self.get_session(sftp_id).await?;
        let entries = sftp
            .read_dir(path)
            .await
            .map_err(|e| format!("Failed to list directory: {e}"))?;

        let mut result = Vec::new();
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let file_path = if path.ends_with('/') {
                format!("{}{}", path, name)
            } else {
                format!("{}/{}", path, name)
            };
            let attrs = entry.metadata();
            let is_dir = attrs.is_dir();
            let size = attrs.size.unwrap_or(0);
            let modified = attrs.mtime.map(|t| t as u64);
            let permissions = attrs.permissions;

            result.push(FileEntry {
                name,
                path: file_path,
                is_dir,
                size,
                modified,
                permissions,
            });
        }

        sort_file_entries(&mut result);

        Ok(result)
    }

    pub async fn read_file(&self, sftp_id: &str, path: &str) -> Result<Vec<u8>, String> {
        let sftp = self.get_session(sftp_id).await?;
        sftp.read(path)
            .await
            .map_err(|e| format!("Failed to read file: {e}"))
    }

    pub async fn write_file(
        &self,
        sftp_id: &str,
        path: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let sftp = self.get_session(sftp_id).await?;
        sftp.write(path, data)
            .await
            .map_err(|e| format!("Failed to write file: {e}"))
    }

    pub async fn delete(&self, sftp_id: &str, path: &str, is_dir: bool) -> Result<(), String> {
        let sftp = self.get_session(sftp_id).await?;
        if is_dir {
            sftp.remove_dir(path)
                .await
                .map_err(|e| format!("Failed to remove directory: {e}"))
        } else {
            sftp.remove_file(path)
                .await
                .map_err(|e| format!("Failed to remove file: {e}"))
        }
    }

    pub async fn rename(
        &self,
        sftp_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), String> {
        let sftp = self.get_session(sftp_id).await?;
        sftp.rename(old_path, new_path)
            .await
            .map_err(|e| format!("Failed to rename: {e}"))
    }

    pub async fn create_dir(&self, sftp_id: &str, path: &str) -> Result<(), String> {
        let sftp = self.get_session(sftp_id).await?;
        sftp.create_dir(path)
            .await
            .map_err(|e| format!("Failed to create directory: {e}"))
    }

    /// 세션의 `Arc<SftpSession>` 복제본을 반환. 짧게 락을 잡고 clone 후 바로 해제하므로
    /// 호출자가 `.await` 하는 동안 다른 요청들이 `Mutex<HashMap>` 에 막히지 않는다
    /// (pipelining 의 전제).
    async fn get_session(&self, sftp_id: &str) -> Result<Arc<SftpSession>, String> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(sftp_id)
            .cloned()
            .ok_or_else(|| format!("SFTP session not found: {sftp_id}"))
    }

    pub async fn file_size(&self, sftp_id: &str, path: &str) -> Result<u64, String> {
        let sftp = self.get_session(sftp_id).await?;
        let metadata = sftp
            .metadata(path)
            .await
            .map_err(|e| format!("Failed to get file metadata: {e}"))?;
        Ok(metadata.size.unwrap_or(0))
    }

    /// Open a remote file for reading. Returns a handle implementing AsyncRead + AsyncSeek
    /// so callers can stream in chunks (see transfer::TransferManager).
    /// 여러 번 호출해서 같은 파일에 대한 복수 handle 을 받을 수 있고, 각 handle 은
    /// 독립적인 offset 을 유지하므로 병렬 stripe 다운로드에 쓰인다.
    pub async fn open_read(&self, sftp_id: &str, path: &str) -> Result<File, String> {
        let sftp = self.get_session(sftp_id).await?;
        sftp.open(path)
            .await
            .map_err(|e| format!("Failed to open for read: {e}"))
    }

    /// Open a remote file for writing (CREATE | TRUNCATE | WRITE).
    /// 병렬 업로드의 "초기화" 단계에서 1회 호출 — 파일을 0 byte 로 truncate 하고 닫는다.
    pub async fn open_write(&self, sftp_id: &str, path: &str) -> Result<File, String> {
        let sftp = self.get_session(sftp_id).await?;
        sftp.create(path)
            .await
            .map_err(|e| format!("Failed to open for write: {e}"))
    }

    /// 기존에 존재하는 파일을 WRITE 모드로 열되 truncate 하지 않는다.
    /// 병렬 업로드 worker 용: 먼저 `open_write` 로 빈 파일 생성 후, 각 worker 는
    /// 이 메서드로 자기 handle 을 열어 자기 offset range 에 쓴다.
    pub async fn open_write_existing(&self, sftp_id: &str, path: &str) -> Result<File, String> {
        let sftp = self.get_session(sftp_id).await?;
        sftp.open_with_flags(path, OpenFlags::WRITE)
            .await
            .map_err(|e| format!("Failed to open for parallel write: {e}"))
    }

    /// Server-to-server copy using 64KB chunk streaming.
    /// Holds two open SFTP file handles (one per session) and pipes bytes through
    /// a client-side buffer, so memory usage stays bounded regardless of file size.
    pub async fn copy_between(
        &self,
        src_sftp_id: &str,
        src_path: &str,
        dst_sftp_id: &str,
        dst_path: &str,
    ) -> Result<u64, String> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut src = self.open_read(src_sftp_id, src_path).await?;
        let mut dst = self.open_write(dst_sftp_id, dst_path).await?;

        let mut buf = vec![0u8; 64 * 1024];
        let mut total: u64 = 0;
        loop {
            let n = src
                .read(&mut buf)
                .await
                .map_err(|e| format!("Failed to read source chunk: {e}"))?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n])
                .await
                .map_err(|e| format!("Failed to write dest chunk: {e}"))?;
            total += n as u64;
        }
        dst.shutdown()
            .await
            .map_err(|e| format!("Failed to close dest: {e}"))?;
        Ok(total)
    }

    pub fn clone_sessions(&self) -> Arc<Mutex<HashMap<String, Arc<SftpSession>>>> {
        Arc::clone(&self.sessions)
    }

    pub async fn close(&self, sftp_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(sftp) = sessions.remove(sftp_id) {
            // Arc<SftpSession> 은 close 를 직접 호출할 수 없으니 inner 에 대해 호출.
            // 다른 Arc 참조자가 아직 있으면 TCP 세션은 그들에게 맡겨진다.
            if let Some(inner) = Arc::into_inner(sftp) {
                let _ = inner.close().await;
            }
        }
    }
}
