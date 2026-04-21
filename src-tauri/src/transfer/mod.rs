use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::Mutex;

use crate::sftp::SftpManager;

#[derive(Debug, Clone, Serialize)]
pub struct TransferJob {
    pub id: String,
    pub job_type: String, // "upload" | "download"
    pub source_path: String,
    pub dest_path: String,
    pub file_name: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub status: String, // "pending" | "running" | "completed" | "failed" | "cancelled"
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum TransferEvent {
    Progress(TransferProgress),
    Completed(String),  // job_id
    Failed(TransferError),
    QueueUpdate(Vec<TransferJob>),
}

#[derive(Clone, Serialize)]
pub struct TransferProgress {
    pub job_id: String,
    pub transferred_bytes: u64,
    pub total_bytes: u64,
    pub speed_bps: u64,
}

#[derive(Clone, Serialize)]
pub struct TransferError {
    pub job_id: String,
    pub error: String,
}

struct InternalJob {
    info: TransferJob,
    transferred: Arc<AtomicU64>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

pub struct TransferManager {
    jobs: Arc<Mutex<HashMap<String, InternalJob>>>,
    queue: Arc<Mutex<Vec<String>>>, // job_id 순서
    max_concurrent: usize,
}

impl TransferManager {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
            queue: Arc::new(Mutex::new(Vec::new())),
            max_concurrent: 3,
        }
    }

    pub async fn enqueue_download(
        &self,
        sftp_id: &str,
        remote_path: &str,
        local_path: &str,
        sftp_manager: &SftpManager,
        event_channel: Channel<TransferEvent>,
    ) -> Result<String, String> {
        let job_id = format!("dl-{}", uuid::Uuid::new_v4());
        let file_name = Path::new(remote_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| remote_path.to_string());

        // 파일 크기 조회
        let total_bytes = sftp_manager
            .file_size(sftp_id, remote_path)
            .await
            .unwrap_or(0);

        let transferred = Arc::new(AtomicU64::new(0));
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let job = TransferJob {
            id: job_id.clone(),
            job_type: "download".to_string(),
            source_path: remote_path.to_string(),
            dest_path: local_path.to_string(),
            file_name,
            total_bytes,
            transferred_bytes: 0,
            status: "pending".to_string(),
            error: None,
        };

        let internal = InternalJob {
            info: job,
            transferred: Arc::clone(&transferred),
            cancelled: Arc::clone(&cancelled),
            handle: None,
        };

        self.jobs.lock().await.insert(job_id.clone(), internal);
        self.queue.lock().await.push(job_id.clone());

        self.send_queue_update(&event_channel).await;
        self.process_queue(sftp_manager, &event_channel).await;

        Ok(job_id)
    }

    pub async fn enqueue_upload(
        &self,
        sftp_id: &str,
        local_path: &str,
        remote_path: &str,
        sftp_manager: &SftpManager,
        event_channel: Channel<TransferEvent>,
    ) -> Result<String, String> {
        let job_id = format!("ul-{}", uuid::Uuid::new_v4());
        let file_name = Path::new(local_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| local_path.to_string());

        let total_bytes = std::fs::metadata(local_path)
            .map(|m| m.len())
            .unwrap_or(0);

        let transferred = Arc::new(AtomicU64::new(0));
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let job = TransferJob {
            id: job_id.clone(),
            job_type: "upload".to_string(),
            source_path: local_path.to_string(),
            dest_path: remote_path.to_string(),
            file_name,
            total_bytes,
            transferred_bytes: 0,
            status: "pending".to_string(),
            error: None,
        };

        let internal = InternalJob {
            info: job,
            transferred: Arc::clone(&transferred),
            cancelled: Arc::clone(&cancelled),
            handle: None,
        };

        self.jobs.lock().await.insert(job_id.clone(), internal);
        self.queue.lock().await.push(job_id.clone());

        self.send_queue_update(&event_channel).await;
        self.process_queue(sftp_manager, &event_channel).await;

        Ok(job_id)
    }

    pub async fn cancel_job(&self, job_id: &str) -> Result<(), String> {
        let mut jobs = self.jobs.lock().await;
        if let Some(job) = jobs.get_mut(job_id) {
            job.cancelled.store(true, Ordering::Relaxed);
            if let Some(handle) = job.handle.take() {
                handle.abort();
            }
            job.info.status = "cancelled".to_string();
        }
        // 큐에서도 제거
        let mut queue = self.queue.lock().await;
        queue.retain(|id| id != job_id);
        Ok(())
    }

    pub async fn list_jobs(&self) -> Vec<TransferJob> {
        let jobs = self.jobs.lock().await;
        let queue = self.queue.lock().await;

        let mut result = Vec::new();
        // 큐 순서대로 + running 우선
        for (_, job) in jobs.iter() {
            let mut info = job.info.clone();
            info.transferred_bytes = job.transferred.load(Ordering::Relaxed);
            result.push(info);
        }
        // status 기준 정렬: running > pending > completed > failed > cancelled
        result.sort_by_key(|j| match j.status.as_str() {
            "running" => 0,
            "pending" => 1,
            "completed" => 2,
            "failed" => 3,
            _ => 4,
        });
        result
    }

    pub async fn clear_completed(&self) {
        let mut jobs = self.jobs.lock().await;
        jobs.retain(|_, j| {
            j.info.status != "completed"
                && j.info.status != "failed"
                && j.info.status != "cancelled"
        });
    }

    async fn process_queue(
        &self,
        _sftp_manager: &SftpManager,
        _event_channel: &Channel<TransferEvent>,
    ) {
        // 현재 실행 중인 job 수 확인
        let jobs = self.jobs.lock().await;
        let running_count = jobs
            .values()
            .filter(|j| j.info.status == "running")
            .count();

        if running_count >= self.max_concurrent {
            return;
        }

        // 다음 pending job 찾기
        let queue = self.queue.lock().await;
        let _next_pending: Vec<String> = queue
            .iter()
            .filter(|id| {
                jobs.get(*id)
                    .map(|j| j.info.status == "pending")
                    .unwrap_or(false)
            })
            .take(self.max_concurrent - running_count)
            .cloned()
            .collect();

        // Note: 실제 전송 실행은 sftp_manager의 chunk API가 리팩토링된 후 구현
        // 현재는 기존 read_file/write_file로 단순 전송
        drop(queue);
        drop(jobs);
    }

    async fn send_queue_update(&self, event_channel: &Channel<TransferEvent>) {
        let jobs = self.list_jobs().await;
        let _ = event_channel.send(TransferEvent::QueueUpdate(jobs));
    }
}
