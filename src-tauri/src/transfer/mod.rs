use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::sftp::SftpManager;

const CHUNK_SIZE: usize = 64 * 1024;
const PROGRESS_THROTTLE_MS: u64 = 100;

#[derive(Debug, Clone, Serialize)]
pub struct TransferJob {
    pub id: String,
    pub job_type: String, // "upload" | "download" | "server_to_server"
    pub source_path: String,
    pub dest_path: String,
    pub file_name: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub status: String, // "pending" | "running" | "completed" | "failed" | "cancelled"
    pub error: Option<String>,
    pub speed_bps: u64,
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

#[derive(Clone)]
enum JobSpec {
    Upload {
        sftp_id: String,
        local_path: String,
        remote_path: String,
    },
    Download {
        sftp_id: String,
        remote_path: String,
        local_path: String,
    },
    ServerToServer {
        src_sftp_id: String,
        src_path: String,
        dst_sftp_id: String,
        dst_path: String,
    },
}

struct InternalJob {
    info: TransferJob,
    spec: JobSpec,
    transferred: Arc<AtomicU64>,
    cancelled: Arc<AtomicBool>,
    handle: Option<tokio::task::JoinHandle<()>>,
    // enqueue 한 호출자의 channel. pump 이 이 job 을 실행할 때 이 channel 로 Progress 를
    // 발행하기 때문에 "다른 enqueue 의 channel 로 남의 이벤트가 섞이는" 문제가 없다.
    channel: Channel<TransferEvent>,
}

#[derive(Clone)]
pub struct TransferManager {
    jobs: Arc<Mutex<HashMap<String, InternalJob>>>,
    queue: Arc<Mutex<Vec<String>>>,
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
        let total_bytes = std::fs::metadata(local_path).map(|m| m.len()).unwrap_or(0);

        let spec = JobSpec::Upload {
            sftp_id: sftp_id.to_string(),
            local_path: local_path.to_string(),
            remote_path: remote_path.to_string(),
        };
        self.insert_and_pump(
            job_id.clone(),
            "upload",
            local_path,
            remote_path,
            &file_name,
            total_bytes,
            spec,
            sftp_manager,
            event_channel,
        )
        .await;
        Ok(job_id)
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
        let total_bytes = sftp_manager
            .file_size(sftp_id, remote_path)
            .await
            .unwrap_or(0);

        let spec = JobSpec::Download {
            sftp_id: sftp_id.to_string(),
            remote_path: remote_path.to_string(),
            local_path: local_path.to_string(),
        };
        self.insert_and_pump(
            job_id.clone(),
            "download",
            remote_path,
            local_path,
            &file_name,
            total_bytes,
            spec,
            sftp_manager,
            event_channel,
        )
        .await;
        Ok(job_id)
    }

    pub async fn enqueue_server_to_server(
        &self,
        src_sftp_id: &str,
        src_path: &str,
        dst_sftp_id: &str,
        dst_path: &str,
        sftp_manager: &SftpManager,
        event_channel: Channel<TransferEvent>,
    ) -> Result<String, String> {
        let job_id = format!("s2s-{}", uuid::Uuid::new_v4());
        let file_name = Path::new(src_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| src_path.to_string());
        let total_bytes = sftp_manager
            .file_size(src_sftp_id, src_path)
            .await
            .unwrap_or(0);

        let spec = JobSpec::ServerToServer {
            src_sftp_id: src_sftp_id.to_string(),
            src_path: src_path.to_string(),
            dst_sftp_id: dst_sftp_id.to_string(),
            dst_path: dst_path.to_string(),
        };
        self.insert_and_pump(
            job_id.clone(),
            "server_to_server",
            src_path,
            dst_path,
            &file_name,
            total_bytes,
            spec,
            sftp_manager,
            event_channel,
        )
        .await;
        Ok(job_id)
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_and_pump(
        &self,
        job_id: String,
        job_type: &str,
        source_path: &str,
        dest_path: &str,
        file_name: &str,
        total_bytes: u64,
        spec: JobSpec,
        sftp_manager: &SftpManager,
        event_channel: Channel<TransferEvent>,
    ) {
        let info = TransferJob {
            id: job_id.clone(),
            job_type: job_type.to_string(),
            source_path: source_path.to_string(),
            dest_path: dest_path.to_string(),
            file_name: file_name.to_string(),
            total_bytes,
            transferred_bytes: 0,
            status: "pending".to_string(),
            error: None,
            speed_bps: 0,
        };
        let internal = InternalJob {
            info,
            spec,
            transferred: Arc::new(AtomicU64::new(0)),
            cancelled: Arc::new(AtomicBool::new(false)),
            handle: None,
            channel: event_channel.clone(),
        };
        {
            let mut jobs = self.jobs.lock().await;
            jobs.insert(job_id.clone(), internal);
            let mut queue = self.queue.lock().await;
            queue.push(job_id);
        }
        // QueueUpdate 는 enqueue 호출자의 channel 로만 broadcast 해도 충분. 각자 polling
        // (sftp_transfer_list) 이 있어서 다른 viewer 도 2초 내 동기화됨.
        self.send_queue_update(&event_channel).await;
        self.clone().pump(sftp_manager.clone()).await;
    }

    /// Start as many pending jobs as we have slots for. Non-blocking: each job runs in its own task.
    /// Returns a boxed, type-erased future so recursive calls (pump → spawn → pump) don't blow up
    /// the compiler's Send inference with an unbounded generic type.
    fn pump(
        self,
        sftp: SftpManager,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>> {
        Box::pin(async move {
            loop {
                // Step 1: snapshot queue order (drop queue guard before taking jobs guard)
                let queue_snapshot: Vec<String> = self.queue.lock().await.clone();

                // Step 2: under jobs guard only, find the next pending and mark it running.
                // 각 job 은 자기 enqueue 시 저장된 channel 을 쓰기 때문에 pump 이 channel 을
                // 파라미터로 들고 다닐 필요가 없다 — 호출자 channel 이 남의 job 에 새는 문제 방지.
                let next = {
                    let mut jobs = self.jobs.lock().await;
                    let running = jobs
                        .values()
                        .filter(|j| j.info.status == "running")
                        .count();
                    if running >= self.max_concurrent {
                        return;
                    }
                    let candidate = queue_snapshot.iter().find(|id| {
                        jobs.get(*id)
                            .map(|j| j.info.status == "pending")
                            .unwrap_or(false)
                    });
                    let Some(id) = candidate.cloned() else { return };
                    let j = jobs.get_mut(&id).expect("just found");
                    j.info.status = "running".to_string();
                    let transferred = Arc::clone(&j.transferred);
                    let cancelled = Arc::clone(&j.cancelled);
                    let spec = j.spec.clone();
                    let total = j.info.total_bytes;
                    let channel = j.channel.clone();
                    (id, spec, transferred, cancelled, total, channel)
                };

                let (job_id, spec, transferred, cancelled, total_bytes, channel_clone) = next;

                let jobs_arc = Arc::clone(&self.jobs);
                let sftp_clone = sftp.clone();
                let mgr_clone = self.clone();
                let job_id_task = job_id.clone();

                let handle = tokio::spawn(async move {
                    let result = execute_job(
                        &job_id_task,
                        spec,
                        total_bytes,
                        Arc::clone(&transferred),
                        Arc::clone(&cancelled),
                        &sftp_clone,
                        &channel_clone,
                    )
                    .await;

                    {
                        let mut jobs = jobs_arc.lock().await;
                        if let Some(j) = jobs.get_mut(&job_id_task) {
                            if cancelled.load(Ordering::Relaxed) {
                                j.info.status = "cancelled".to_string();
                            } else {
                                match &result {
                                    Ok(_) => {
                                        j.info.status = "completed".to_string();
                                        j.info.transferred_bytes =
                                            transferred.load(Ordering::Relaxed);
                                    }
                                    Err(e) => {
                                        j.info.status = "failed".to_string();
                                        j.info.error = Some(e.clone());
                                    }
                                }
                            }
                            j.handle = None;
                        }
                    }

                    match &result {
                        Ok(_) if !cancelled.load(Ordering::Relaxed) => {
                            let _ = channel_clone
                                .send(TransferEvent::Completed(job_id_task.clone()));
                        }
                        Err(e) => {
                            let _ = channel_clone.send(TransferEvent::Failed(TransferError {
                                job_id: job_id_task.clone(),
                                error: e.clone(),
                            }));
                        }
                        _ => {}
                    }
                    mgr_clone.send_queue_update(&channel_clone).await;
                    // Recurse via the boxed dyn Future returned by pump — the trait object
                    // erases the generic, so spawning this does not require the compiler to
                    // expand a self-referential Future type.
                    tokio::spawn(mgr_clone.pump(sftp_clone));
                });

                let mut jobs = self.jobs.lock().await;
                if let Some(j) = jobs.get_mut(&job_id) {
                    j.handle = Some(handle);
                }
            }
        })
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
        let mut queue = self.queue.lock().await;
        queue.retain(|id| id != job_id);
        Ok(())
    }

    pub async fn list_jobs(&self) -> Vec<TransferJob> {
        let jobs = self.jobs.lock().await;
        let mut result: Vec<TransferJob> = jobs
            .values()
            .map(|j| {
                let mut info = j.info.clone();
                info.transferred_bytes = j.transferred.load(Ordering::Relaxed);
                info
            })
            .collect();
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
        let mut queue = self.queue.lock().await;
        let active_ids: std::collections::HashSet<_> = jobs.keys().cloned().collect();
        queue.retain(|id| active_ids.contains(id));
    }

    async fn send_queue_update(&self, event_channel: &Channel<TransferEvent>) {
        let jobs = self.list_jobs().await;
        let _ = event_channel.send(TransferEvent::QueueUpdate(jobs));
    }
}

/// Executes one transfer job. Runs the chunk loop and emits throttled Progress events.
/// Returns Ok(()) on success (or cancellation), Err(msg) on failure.
async fn execute_job(
    job_id: &str,
    spec: JobSpec,
    total_bytes: u64,
    transferred: Arc<AtomicU64>,
    cancelled: Arc<AtomicBool>,
    sftp: &SftpManager,
    channel: &Channel<TransferEvent>,
) -> Result<(), String> {
    let started = Instant::now();
    let mut last_emit = Instant::now()
        .checked_sub(Duration::from_millis(PROGRESS_THROTTLE_MS))
        .unwrap_or_else(Instant::now);

    let emit_progress = |now: Instant, last: &mut Instant, force: bool| {
        if !force && now.duration_since(*last) < Duration::from_millis(PROGRESS_THROTTLE_MS) {
            return;
        }
        *last = now;
        let done = transferred.load(Ordering::Relaxed);
        let elapsed = now.duration_since(started).as_secs_f64().max(0.001);
        let speed_bps = (done as f64 / elapsed) as u64;
        let _ = channel.send(TransferEvent::Progress(TransferProgress {
            job_id: job_id.to_string(),
            transferred_bytes: done,
            total_bytes,
            speed_bps,
        }));
    };

    match spec {
        JobSpec::Upload {
            sftp_id,
            local_path,
            remote_path,
        } => {
            let mut src = tokio::fs::File::open(&local_path)
                .await
                .map_err(|e| format!("Failed to open local file: {e}"))?;
            let mut dst = sftp.open_write(&sftp_id, &remote_path).await?;
            let mut buf = vec![0u8; CHUNK_SIZE];
            loop {
                if cancelled.load(Ordering::Relaxed) {
                    return Ok(());
                }
                let n = src
                    .read(&mut buf)
                    .await
                    .map_err(|e| format!("Local read failed: {e}"))?;
                if n == 0 {
                    break;
                }
                dst.write_all(&buf[..n])
                    .await
                    .map_err(|e| format!("Remote write failed: {e}"))?;
                transferred.fetch_add(n as u64, Ordering::Relaxed);
                emit_progress(Instant::now(), &mut last_emit, false);
            }
            dst.shutdown()
                .await
                .map_err(|e| format!("Remote close failed: {e}"))?;
        }
        JobSpec::Download {
            sftp_id,
            remote_path,
            local_path,
        } => {
            let mut src = sftp.open_read(&sftp_id, &remote_path).await?;
            if let Some(parent) = Path::new(&local_path).parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let mut dst = tokio::fs::File::create(&local_path)
                .await
                .map_err(|e| format!("Failed to create local file: {e}"))?;
            let mut buf = vec![0u8; CHUNK_SIZE];
            loop {
                if cancelled.load(Ordering::Relaxed) {
                    return Ok(());
                }
                let n = src
                    .read(&mut buf)
                    .await
                    .map_err(|e| format!("Remote read failed: {e}"))?;
                if n == 0 {
                    break;
                }
                dst.write_all(&buf[..n])
                    .await
                    .map_err(|e| format!("Local write failed: {e}"))?;
                transferred.fetch_add(n as u64, Ordering::Relaxed);
                emit_progress(Instant::now(), &mut last_emit, false);
            }
            dst.flush()
                .await
                .map_err(|e| format!("Local flush failed: {e}"))?;
        }
        JobSpec::ServerToServer {
            src_sftp_id,
            src_path,
            dst_sftp_id,
            dst_path,
        } => {
            let mut src = sftp.open_read(&src_sftp_id, &src_path).await?;
            let mut dst = sftp.open_write(&dst_sftp_id, &dst_path).await?;
            let mut buf = vec![0u8; CHUNK_SIZE];
            loop {
                if cancelled.load(Ordering::Relaxed) {
                    return Ok(());
                }
                let n = src
                    .read(&mut buf)
                    .await
                    .map_err(|e| format!("Source read failed: {e}"))?;
                if n == 0 {
                    break;
                }
                dst.write_all(&buf[..n])
                    .await
                    .map_err(|e| format!("Dest write failed: {e}"))?;
                transferred.fetch_add(n as u64, Ordering::Relaxed);
                emit_progress(Instant::now(), &mut last_emit, false);
            }
            dst.shutdown()
                .await
                .map_err(|e| format!("Dest close failed: {e}"))?;
        }
    }

    emit_progress(Instant::now(), &mut last_emit, true);
    Ok(())
}
