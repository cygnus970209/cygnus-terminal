use russh_sftp::client::{fs::File, SftpSession};
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

#[derive(Clone)]
pub struct SftpManager {
    sessions: Arc<Mutex<HashMap<String, SftpSession>>>,
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
            .insert(sftp_id.to_string(), sftp);
        Ok(())
    }

    pub async fn exists(&self, sftp_id: &str) -> bool {
        self.sessions.lock().await.contains_key(sftp_id)
    }

    pub async fn get_home_dir(&self, sftp_id: &str) -> Result<String, String> {
        let sessions = self.sessions.lock().await;
        let sftp = sessions
            .get(sftp_id)
            .ok_or_else(|| format!("SFTP session not found: {sftp_id}"))?;

        sftp.canonicalize(".")
            .await
            .map_err(|e| format!("Failed to get home directory: {e}"))
    }

    pub async fn list_dir(&self, sftp_id: &str, path: &str) -> Result<Vec<FileEntry>, String> {
        let sessions = self.sessions.lock().await;
        let sftp = sessions
            .get(sftp_id)
            .ok_or_else(|| format!("SFTP session not found: {sftp_id}"))?;

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

        // 디렉토리 우선, 이름순 정렬
        result.sort_by(|a, b| {
            b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(result)
    }

    pub async fn read_file(&self, sftp_id: &str, path: &str) -> Result<Vec<u8>, String> {
        let sessions = self.sessions.lock().await;
        let sftp = sessions
            .get(sftp_id)
            .ok_or_else(|| format!("SFTP session not found: {sftp_id}"))?;

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
        let sessions = self.sessions.lock().await;
        let sftp = sessions
            .get(sftp_id)
            .ok_or_else(|| format!("SFTP session not found: {sftp_id}"))?;

        sftp.write(path, data)
            .await
            .map_err(|e| format!("Failed to write file: {e}"))
    }

    pub async fn delete(&self, sftp_id: &str, path: &str, is_dir: bool) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        let sftp = sessions
            .get(sftp_id)
            .ok_or_else(|| format!("SFTP session not found: {sftp_id}"))?;

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
        let sessions = self.sessions.lock().await;
        let sftp = sessions
            .get(sftp_id)
            .ok_or_else(|| format!("SFTP session not found: {sftp_id}"))?;

        sftp.rename(old_path, new_path)
            .await
            .map_err(|e| format!("Failed to rename: {e}"))
    }

    pub async fn create_dir(&self, sftp_id: &str, path: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        let sftp = sessions
            .get(sftp_id)
            .ok_or_else(|| format!("SFTP session not found: {sftp_id}"))?;

        sftp.create_dir(path)
            .await
            .map_err(|e| format!("Failed to create directory: {e}"))
    }

    pub async fn file_size(&self, sftp_id: &str, path: &str) -> Result<u64, String> {
        let sessions = self.sessions.lock().await;
        let sftp = sessions
            .get(sftp_id)
            .ok_or_else(|| format!("SFTP session not found: {sftp_id}"))?;

        let metadata = sftp
            .metadata(path)
            .await
            .map_err(|e| format!("Failed to get file metadata: {e}"))?;

        Ok(metadata.size.unwrap_or(0))
    }

    /// Open a remote file for reading. Returns a handle implementing AsyncRead + AsyncSeek
    /// so callers can stream in chunks (see transfer::TransferManager).
    pub async fn open_read(&self, sftp_id: &str, path: &str) -> Result<File, String> {
        let sessions = self.sessions.lock().await;
        let sftp = sessions
            .get(sftp_id)
            .ok_or_else(|| format!("SFTP session not found: {sftp_id}"))?;
        sftp.open(path)
            .await
            .map_err(|e| format!("Failed to open for read: {e}"))
    }

    /// Open a remote file for writing (CREATE | TRUNCATE | WRITE).
    pub async fn open_write(&self, sftp_id: &str, path: &str) -> Result<File, String> {
        let sessions = self.sessions.lock().await;
        let sftp = sessions
            .get(sftp_id)
            .ok_or_else(|| format!("SFTP session not found: {sftp_id}"))?;
        sftp.create(path)
            .await
            .map_err(|e| format!("Failed to open for write: {e}"))
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

    pub fn clone_sessions(&self) -> Arc<Mutex<HashMap<String, SftpSession>>> {
        Arc::clone(&self.sessions)
    }

    pub async fn close(&self, sftp_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(sftp) = sessions.remove(sftp_id) {
            let _ = sftp.close().await;
        }
    }
}
