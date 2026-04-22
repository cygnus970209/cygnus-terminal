use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::sync::{mpsc, Mutex};

use crate::pty::PtyEvent;

#[derive(Debug, Clone, Serialize)]
pub struct SerialPortInfo {
    pub name: String,
    pub port_type: String,
}

enum SerialCommand {
    Data(Vec<u8>),
    Close,
}

pub struct SerialSession {
    cmd_tx: mpsc::Sender<SerialCommand>,
}

pub struct SerialManager {
    sessions: Arc<Mutex<HashMap<String, SerialSession>>>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 사용 가능한 시리얼 포트 목록 조회
    pub fn list_ports() -> Result<Vec<SerialPortInfo>, String> {
        let ports = serialport::available_ports()
            .map_err(|e| format!("Failed to list ports: {e}"))?;

        Ok(ports
            .into_iter()
            .map(|p| {
                let port_type = match p.port_type {
                    serialport::SerialPortType::UsbPort(info) => {
                        format!(
                            "USB ({})",
                            info.product.unwrap_or_else(|| "Unknown".into())
                        )
                    }
                    serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
                    serialport::SerialPortType::PciPort => "PCI".into(),
                    _ => "Unknown".into(),
                };
                SerialPortInfo {
                    name: p.port_name,
                    port_type,
                }
            })
            .collect())
    }

    pub async fn connect(
        &self,
        session_id: &str,
        port_name: &str,
        baud_rate: u32,
        channel: Channel<PtyEvent>,
    ) -> Result<(), String> {
        eprintln!("[Serial] Opening {} at {} baud", port_name, baud_rate);

        let port = serialport::new(port_name, baud_rate)
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(|e| format!("Failed to open serial port: {e}"))?;

        let mut reader = port
            .try_clone()
            .map_err(|e| format!("Failed to clone port: {e}"))?;

        let writer = Arc::new(std::sync::Mutex::new(port));

        let (cmd_tx, mut cmd_rx) = mpsc::channel::<SerialCommand>(256);

        // Reader thread (blocking I/O)
        let channel_clone = channel.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = channel_clone.send(PtyEvent::Exit(()));
                        break;
                    }
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        if channel_clone.send(PtyEvent::Output(text)).is_err() {
                            break;
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                        continue;
                    }
                    Err(_) => {
                        let _ = channel_clone.send(PtyEvent::Exit(()));
                        break;
                    }
                }
            }
        });

        // Writer task
        let writer_clone = Arc::clone(&writer);
        tokio::spawn(async move {
            loop {
                match cmd_rx.recv().await {
                    Some(SerialCommand::Data(data)) => {
                        if let Ok(mut port) = writer_clone.lock() {
                            use std::io::Write;
                            let _ = port.write_all(&data);
                        }
                    }
                    Some(SerialCommand::Close) | None => {
                        break;
                    }
                }
            }
        });

        let session = SerialSession { cmd_tx };
        self.sessions
            .lock()
            .await
            .insert(session_id.to_string(), session);

        Ok(())
    }

    pub async fn write_to_session(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(session_id) {
            session
                .cmd_tx
                .send(SerialCommand::Data(data.to_vec()))
                .await
                .map_err(|e| format!("Send error: {e}"))?;
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    }

    pub async fn close_session(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.remove(session_id) {
            let _ = session.cmd_tx.send(SerialCommand::Close).await;
        }
        Ok(())
    }
}
