//! The bundled helper isolates IronRDP's crypto dependencies from SSH. Private pipes only.
use cygnus_rdp_protocol::{
    frame_header, ConnectConfig, Event, Input, Request, MAX_CONTROL_BYTES, MAX_FRAME_BYTES,
    MAX_INPUT_BATCH,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Command,
    sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore},
};
use tokio_util::sync::CancellationToken;
use zeroize::{Zeroize, Zeroizing};

type FrameReply = oneshot::Sender<Result<Vec<u8>, String>>;
type Notify = Arc<dyn Fn(Event) -> bool + Send + Sync>;
struct Session {
    cancel: CancellationToken,
    tx: mpsc::Sender<Request>,
    phase: AtomicU8,
    fingerprint: Mutex<Option<String>>,
    frame: Mutex<Option<FrameReply>>,
}
struct Inner {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    capacity: Arc<Semaphore>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        for session in self.sessions.get_mut().unwrap().values() {
            session.cancel.cancel();
        }
    }
}
#[derive(Clone)]
pub struct RdpManager(Arc<Inner>);
impl Default for RdpManager {
    fn default() -> Self {
        Self::new()
    }
}
impl RdpManager {
    pub fn new() -> Self {
        Self(Arc::new(Inner {
            sessions: Mutex::new(HashMap::new()),
            capacity: Arc::new(Semaphore::new(4)),
        }))
    }
    pub fn open(&self, config: ConnectConfig, notify: Notify) -> Result<String, String> {
        config.validate()?;
        let slot = self
            .0
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Up to four RDP sessions can run at once")?;
        let (tx, rx) = mpsc::channel(16);
        let session = Arc::new(Session {
            cancel: CancellationToken::new(),
            tx,
            phase: AtomicU8::new(0),
            fingerprint: Mutex::new(None),
            frame: Mutex::new(None),
        });
        let id = uuid::Uuid::new_v4().to_string();
        self.0
            .sessions
            .lock()
            .unwrap()
            .insert(id.clone(), session.clone());
        let manager = self.clone();
        let task_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = run(config, &session, rx, &notify, slot).await;
            session.phase.store(4, Ordering::Release);
            if let Some(reply) = session.frame.lock().unwrap().take() {
                let _ = reply.send(Err("RDP session ended".into()));
            }
            manager.0.sessions.lock().unwrap().remove(&task_id);
            if !session.cancel.is_cancelled() {
                if let Err(message) = outcome {
                    notify(Event::Error { message });
                }
            }
        });
        Ok(id)
    }
    fn session(&self, id: &str) -> Result<Arc<Session>, String> {
        self.0
            .sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "RDP session is closed".into())
    }
    pub fn authenticate(
        &self,
        id: &str,
        fingerprint: String,
        mut password: String,
    ) -> Result<(), String> {
        let result = (|| {
            if password.is_empty() || password.len() > 4096 || password.contains('\0') {
                return Err("Enter a valid RDP password".into());
            }
            let session = self.session(id)?;
            let mut expected = session.fingerprint.lock().unwrap();
            if expected.as_deref() != Some(fingerprint.as_str())
                || session
                    .phase
                    .compare_exchange(1, 2, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
            {
                return Err("Certificate approval is no longer valid".into());
            }
            expected.take();
            session
                .tx
                .try_send(Request::Authenticate {
                    fingerprint,
                    password: std::mem::take(&mut password),
                })
                .map_err(|error| {
                    let mut request = error.into_inner();
                    if let Request::Authenticate { password, .. } = &mut request {
                        password.zeroize();
                    }
                    session.cancel.cancel();
                    "RDP authentication request could not be sent".to_string()
                })
        })();
        password.zeroize();
        result
    }
    pub fn input(&self, id: &str, events: Vec<Input>) -> Result<(), String> {
        if events.len() > MAX_INPUT_BATCH || events.iter().any(|e| !e.validate()) {
            return Err("Invalid RDP input".into());
        }
        let session = self.session(id)?;
        if session.phase.load(Ordering::Acquire) != 3 {
            return Err("RDP is not connected".into());
        }
        session.tx.try_send(Request::Input { events }).map_err(|_| {
            session.cancel.cancel();
            "RDP input queue is full; the session was closed to release pressed keys".into()
        })
    }
    pub async fn frame(&self, id: &str) -> Result<Vec<u8>, String> {
        let session = self.session(id)?;
        if session.phase.load(Ordering::Acquire) != 3 {
            return Err("RDP is not connected".into());
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = session.frame.lock().unwrap();
            if pending.is_some() {
                return Err("An RDP frame request is already pending".into());
            }
            *pending = Some(tx);
        }
        if session.tx.try_send(Request::Frame).is_err() {
            session.frame.lock().unwrap().take();
            return Err("RDP frame queue is full".into());
        }
        match tokio::time::timeout(Duration::from_secs(25), rx).await {
            Ok(Ok(result)) => result,
            _ => {
                session.cancel.cancel();
                Err("RDP display stopped responding".into())
            }
        }
    }
    pub fn close(&self, id: &str) {
        if let Some(session) = self.0.sessions.lock().unwrap().remove(id) {
            session.cancel.cancel();
        }
    }
    pub fn close_all(&self) {
        for (_, session) in self.0.sessions.lock().unwrap().drain() {
            session.cancel.cancel();
        }
    }
}

fn engine_path() -> Result<PathBuf, String> {
    let app = std::env::current_exe().map_err(|_| "Could not locate the application")?;
    Ok(app
        .parent()
        .ok_or("Could not locate the application folder")?
        .join(if cfg!(windows) {
            "cygnus-rdp.exe"
        } else {
            "cygnus-rdp"
        }))
}

async fn write_request(
    writer: &mut (impl AsyncWrite + Unpin),
    mut request: Request,
) -> Result<(), String> {
    let encoded = serde_json::to_vec(&request);
    if let Request::Authenticate { password, .. } = &mut request {
        password.zeroize();
    }
    let bytes = Zeroizing::new(encoded.map_err(|_| "Could not encode RDP request")?);
    if bytes.len() > MAX_CONTROL_BYTES {
        return Err("RDP request exceeds the size limit".into());
    }
    writer
        .write_u32_le(bytes.len() as u32)
        .await
        .map_err(|_| "RDP engine pipe closed")?;
    writer
        .write_all(&bytes)
        .await
        .map_err(|_| "RDP engine pipe closed")?;
    writer
        .flush()
        .await
        .map_err(|_| "RDP engine pipe closed".into())
}
async fn read_packet(reader: &mut (impl AsyncRead + Unpin)) -> Result<(u8, Vec<u8>), String> {
    let kind = reader.read_u8().await.map_err(|_| "RDP engine stopped")?;
    let length = reader
        .read_u32_le()
        .await
        .map_err(|_| "RDP engine stopped")? as usize;
    let limit = match kind {
        0 => MAX_CONTROL_BYTES,
        1 => MAX_FRAME_BYTES,
        _ => return Err("Invalid RDP engine response".into()),
    };
    if length > limit {
        return Err("RDP engine response exceeds the size limit".into());
    }
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|_| "Incomplete RDP engine response")?;
    if kind == 1 && !body.is_empty() && frame_header(&body).is_none() {
        return Err("Invalid RDP frame".into());
    }
    Ok((kind, body))
}

async fn run(
    config: ConnectConfig,
    session: &Session,
    mut requests: mpsc::Receiver<Request>,
    notify: &Notify,
    _slot: OwnedSemaphorePermit,
) -> Result<(), String> {
    let mut command = Command::new(engine_path()?);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .env_remove("SSLKEYLOGFILE");
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW; transport stays on inherited pipes.
    let mut child = command
        .spawn()
        .map_err(|_| "The bundled RDP engine could not start. Rebuild or reinstall the app.")?;
    let mut stdin = child.stdin.take().ok_or("RDP engine pipe is missing")?;
    let mut stdout = child.stdout.take().ok_or("RDP engine pipe is missing")?;
    let (tx, mut packets) = mpsc::channel(2);
    let reader = tokio::spawn(async move {
        loop {
            let packet = read_packet(&mut stdout).await;
            let failed = packet.is_err();
            if tx.send(packet).await.is_err() || failed {
                return;
            }
        }
    });
    let result = async {
        write_request(&mut stdin, Request::Connect { config }).await?;
        let deadline = tokio::time::sleep(Duration::from_secs(40));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                biased;
                _ = session.cancel.cancelled() => break Ok(()),
                _ = &mut deadline, if session.phase.load(Ordering::Acquire) != 3 => break Err("RDP connection or certificate approval timed out".into()),
                packet = packets.recv() => {
                    let (kind, body) = packet.ok_or("RDP engine stopped")??;
                    if kind == 1 {
                        if let Some(reply) = session.frame.lock().unwrap().take() { let _ = reply.send(Ok(body)); }
                        else { break Err("Unexpected RDP frame response".into()); }
                    } else {
                        let event: Event = serde_json::from_slice(&body).map_err(|_| "Invalid RDP engine event")?;
                        let ended = matches!(event, Event::Ended | Event::Error { .. });
                        match &event {
                            Event::Certificate { fingerprint, .. } => {
                                if session.phase.load(Ordering::Acquire) != 0 || fingerprint.len() != 95 { break Err("Invalid RDP certificate response".into()); }
                                *session.fingerprint.lock().unwrap() = Some(fingerprint.clone());
                                session.phase.store(1, Ordering::Release);
                                deadline.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(190));
                            }
                            Event::Authenticating => deadline.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(40)),
                            Event::Connected { width, height } => {
                                if *width == 0 || *height == 0 || *width > cygnus_rdp_protocol::MAX_WIDTH || *height > cygnus_rdp_protocol::MAX_HEIGHT || !matches!(session.phase.load(Ordering::Acquire), 2 | 3) { break Err("Invalid RDP connected state".into()); }
                                session.phase.store(3, Ordering::Release);
                            }
                            _ => {}
                        }
                        if !notify(event) || ended { break Ok(()); }
                    }
                }
                request = requests.recv() => {
                    let Some(request) = request else { break Ok(()); };
                    tokio::select! {
                        _ = session.cancel.cancelled() => break Ok(()),
                        result = tokio::time::timeout(Duration::from_secs(5), write_request(&mut stdin, request)) => result.map_err(|_| "RDP engine stopped responding")??,
                    }
                }
            }
        }
    }.await;
    // Give RDP a short graceful-disconnect window, then always reap the helper.
    let _ = tokio::time::timeout(
        Duration::from_millis(250),
        write_request(&mut stdin, Request::Disconnect),
    )
    .await;
    drop(stdin);
    if tokio::time::timeout(Duration::from_secs(1), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    reader.abort();
    while let Ok(mut request) = requests.try_recv() {
        if let Request::Authenticate { password, .. } = &mut request {
            password.zeroize();
        }
    }
    result
}

#[cfg(test)]
mod tests;
