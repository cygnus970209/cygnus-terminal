use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::pty::PtyEvent;
use crate::registry::CommandRegistry;

// Telnet IAC constants
const IAC: u8 = 255;
const WILL: u8 = 251;
const WONT: u8 = 252;
const DO: u8 = 253;
const DONT: u8 = 254;
const SB: u8 = 250;
const SE: u8 = 240;

// Telnet options
const OPT_ECHO: u8 = 1;
const OPT_SUPPRESS_GO_AHEAD: u8 = 3;
const OPT_TERMINAL_TYPE: u8 = 24;
const OPT_NAWS: u8 = 31; // Negotiate About Window Size

enum TelnetCommand {
    Data(Vec<u8>),
    Resize(u16, u16),
    Close,
}

pub struct TelnetManager {
    sessions: CommandRegistry<TelnetCommand>,
}

impl Default for TelnetManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TelnetManager {
    pub fn new() -> Self {
        Self {
            sessions: CommandRegistry::new(),
        }
    }

    pub async fn connect(
        &self,
        session_id: &str,
        host: &str,
        port: u16,
        channel: Channel<PtyEvent>,
    ) -> Result<(), String> {
        eprintln!("[Telnet] Connecting to {}:{}", host, port);

        let stream = TcpStream::connect((host, port))
            .await
            .map_err(|e| format!("Connection failed: {e}"))?;

        let (mut reader, mut writer) = tokio::io::split(stream);

        eprintln!("[Telnet] Connected");

        let (cmd_tx, mut cmd_rx) = mpsc::channel::<TelnetCommand>(256);

        // Reader task: TCP → frontend
        let channel_clone = channel.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            let mut iac_state = IacParser::new();

            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => {
                        let _ = channel_clone.send(PtyEvent::Exit(()));
                        break;
                    }
                    Ok(n) => {
                        let (output, responses) = iac_state.process(&buf[..n]);
                        if !output.is_empty() {
                            let text = String::from_utf8_lossy(&output).into_owned();
                            if channel_clone.send(PtyEvent::Output(text)).is_err() {
                                break;
                            }
                        }
                        // IAC 응답은 별도 채널로 보내야 하지만, 간단히 여기서 무시
                        // (응답은 writer가 처리)
                        let _ = responses; // TODO: writer에 보내기
                    }
                    Err(_) => {
                        let _ = channel_clone.send(PtyEvent::Exit(()));
                        break;
                    }
                }
            }
        });

        // Writer task: frontend → TCP + IAC negotiation
        tokio::spawn(async move {
            // 초기 IAC 협상
            let init_responses = vec![
                vec![IAC, WILL, OPT_TERMINAL_TYPE],
                vec![IAC, WILL, OPT_NAWS],
                vec![IAC, DO, OPT_ECHO],
                vec![IAC, DO, OPT_SUPPRESS_GO_AHEAD],
            ];
            for resp in init_responses {
                let _ = writer.write_all(&resp).await;
            }

            // 초기 윈도우 크기
            let naws = build_naws(80, 24);
            let _ = writer.write_all(&naws).await;

            loop {
                match cmd_rx.recv().await {
                    Some(TelnetCommand::Data(data)) => {
                        if writer.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                    Some(TelnetCommand::Resize(cols, rows)) => {
                        let naws = build_naws(cols, rows);
                        let _ = writer.write_all(&naws).await;
                    }
                    Some(TelnetCommand::Close) | None => {
                        let _ = writer.shutdown().await;
                        break;
                    }
                }
            }
        });

        self.sessions.insert(session_id, cmd_tx).await;

        Ok(())
    }

    pub async fn write_to_session(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        self.sessions
            .send(session_id, TelnetCommand::Data(data.to_vec()))
            .await
    }

    pub async fn resize_session(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        self.sessions
            .send(session_id, TelnetCommand::Resize(cols, rows))
            .await
    }

    pub async fn close_session(&self, session_id: &str) -> Result<(), String> {
        self.sessions
            .remove_and_send(session_id, TelnetCommand::Close)
            .await;
        Ok(())
    }
}

fn build_naws(cols: u16, rows: u16) -> Vec<u8> {
    vec![
        IAC, SB, OPT_NAWS,
        (cols >> 8) as u8, (cols & 0xFF) as u8,
        (rows >> 8) as u8, (rows & 0xFF) as u8,
        IAC, SE,
    ]
}

/// Simple IAC parser: strips IAC sequences from data, returns clean output + responses
struct IacParser {
    state: IacState,
}

enum IacState {
    Normal,
    GotIac,
    GotVerb(u8),
    InSub(Vec<u8>),
    InSubIac(Vec<u8>),
}

impl IacParser {
    fn new() -> Self {
        Self {
            state: IacState::Normal,
        }
    }

    fn process(&mut self, data: &[u8]) -> (Vec<u8>, Vec<Vec<u8>>) {
        let mut output = Vec::new();
        let mut responses = Vec::new();

        for &byte in data {
            match &mut self.state {
                IacState::Normal => {
                    if byte == IAC {
                        self.state = IacState::GotIac;
                    } else {
                        output.push(byte);
                    }
                }
                IacState::GotIac => match byte {
                    IAC => {
                        output.push(IAC); // escaped IAC
                        self.state = IacState::Normal;
                    }
                    WILL | WONT | DO | DONT => {
                        self.state = IacState::GotVerb(byte);
                    }
                    SB => {
                        self.state = IacState::InSub(Vec::new());
                    }
                    _ => {
                        self.state = IacState::Normal;
                    }
                },
                IacState::GotVerb(verb) => {
                    let verb = *verb;
                    // Auto-negotiate: respond to requests
                    match verb {
                        DO => {
                            match byte {
                                OPT_TERMINAL_TYPE | OPT_NAWS | OPT_SUPPRESS_GO_AHEAD => {
                                    responses.push(vec![IAC, WILL, byte]);
                                }
                                _ => {
                                    responses.push(vec![IAC, WONT, byte]);
                                }
                            }
                        }
                        WILL => {
                            match byte {
                                OPT_ECHO | OPT_SUPPRESS_GO_AHEAD => {
                                    responses.push(vec![IAC, DO, byte]);
                                }
                                _ => {
                                    responses.push(vec![IAC, DONT, byte]);
                                }
                            }
                        }
                        _ => {}
                    }
                    self.state = IacState::Normal;
                }
                IacState::InSub(ref mut buf) => {
                    if byte == IAC {
                        self.state = IacState::InSubIac(std::mem::take(buf));
                    } else {
                        buf.push(byte);
                    }
                }
                IacState::InSubIac(ref mut buf) => {
                    if byte == SE {
                        // Handle subnegotiation
                        if !buf.is_empty() && buf[0] == OPT_TERMINAL_TYPE {
                            // Terminal type request: respond with xterm-256color
                            let mut resp = vec![IAC, SB, OPT_TERMINAL_TYPE, 0]; // IS
                            resp.extend_from_slice(b"xterm-256color");
                            resp.push(IAC);
                            resp.push(SE);
                            responses.push(resp);
                        }
                        self.state = IacState::Normal;
                    } else {
                        buf.push(byte);
                        self.state = IacState::InSub(std::mem::take(buf));
                    }
                }
            }
        }

        (output, responses)
    }
}
