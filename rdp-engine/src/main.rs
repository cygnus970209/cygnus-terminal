#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
mod connection;
mod tls;
mod transport;

use cygnus_rdp_protocol::{
    Event, Input, Request, MAX_CONTROL_BYTES, MAX_HEIGHT, MAX_INPUT_BATCH, MAX_WIDTH, WIRE_VERSION,
};
use ironrdp::{
    connector::{
        connection_activation::{ConnectionActivationSequence, ConnectionActivationState},
        ClientConnector,
    },
    graphics::image_processing::PixelFormat,
    input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations},
    pdu::RDP_HINT,
    session::{image::DecodedImage, ActiveStageBuilder, ActiveStageOutput},
};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
};
use transport::Framed;
use zeroize::{Zeroize, Zeroizing};

type Result<T> = std::result::Result<T, &'static str>;

async fn packet(kind: u8, bytes: &[u8]) -> Result<()> {
    let mut out = tokio::io::stdout();
    out.write_u8(kind).await.map_err(|_| "App pipe closed")?;
    out.write_u32_le(bytes.len() as u32)
        .await
        .map_err(|_| "App pipe closed")?;
    out.write_all(bytes).await.map_err(|_| "App pipe closed")?;
    out.flush().await.map_err(|_| "App pipe closed")
}
async fn event(value: Event) -> Result<()> {
    let bytes = serde_json::to_vec(&value).map_err(|_| "Invalid engine event")?;
    packet(0, &bytes).await
}
async fn requests(tx: mpsc::Sender<Request>) {
    let mut input = tokio::io::stdin();
    loop {
        let Ok(length) = input.read_u32_le().await else {
            return;
        };
        if length == 0 || length as usize > MAX_CONTROL_BYTES {
            return;
        }
        let mut body = Zeroizing::new(vec![0; length as usize]);
        if input.read_exact(&mut body).await.is_err() {
            return;
        }
        let Ok(request) = serde_json::from_slice::<Request>(&body) else {
            return;
        };
        if tx.send(request).await.is_err() {
            return;
        }
    }
}
fn valid_size(width: u16, height: u16) -> Result<()> {
    if width == 0 || height == 0 || width > MAX_WIDTH || height > MAX_HEIGHT {
        return Err("Server desktop exceeds the supported 1920×1080 size");
    }
    Ok(())
}

async fn run(rx: &mut mpsc::Receiver<Request>) -> Result<()> {
    let Some(Request::Connect { config }) = rx.recv().await else {
        return Err("Missing RDP connection settings");
    };
    config.validate()?;
    event(Event::Connecting).await?;
    let (mut connector, mut framed, public_key, certificate, fingerprint) =
        tokio::time::timeout(Duration::from_secs(20), async {
            let stream = TcpStream::connect((config.host.as_str(), config.port))
                .await
                .map_err(|_| "Could not connect to the RDP server")?;
            stream
                .set_nodelay(true)
                .map_err(|_| "RDP socket setup failed")?;
            let address = stream.local_addr().map_err(|_| "RDP socket setup failed")?;
            let mut framed = Framed::new(stream);
            let mut connector = ClientConnector::new(connection::config(&config), address);
            while !connector.should_perform_security_upgrade() {
                framed.step(&mut connector).await?;
            }
            let (stream, public_key, certificate, fingerprint) =
                tls::upgrade(framed.into_stream()?, &config.host).await?;
            connector.mark_security_upgrade_as_done();
            Ok::<_, &'static str>((
                connector,
                Framed::new(stream),
                public_key,
                certificate,
                fingerprint,
            ))
        })
        .await
        .map_err(|_| "RDP connection timed out")??;
    event(certificate).await?;
    let approval = tokio::time::timeout(Duration::from_secs(180), rx.recv())
        .await
        .map_err(|_| "Certificate approval expired. Reconnect to try again.")?;
    let Some(Request::Authenticate {
        fingerprint: approved,
        mut password,
    }) = approval
    else {
        return Ok(());
    };
    if approved != fingerprint
        || password.is_empty()
        || password.len() > 4096
        || password.contains('\0')
    {
        password.zeroize();
        return Err("Invalid RDP certificate approval or password");
    }
    if let ironrdp::connector::Credentials::UsernamePassword {
        password: value, ..
    } = &mut connector.config.credentials
    {
        *value = password;
    }
    event(Event::Authenticating).await?;
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        connection::finalize(connector, &mut framed, &config.host, public_key),
    )
    .await
    .map_err(|_| "RDP authentication timed out")??;
    valid_size(result.desktop_size.width, result.desktop_size.height)?;
    let mut image = DecodedImage::new(
        PixelFormat::RgbA32,
        result.desktop_size.width,
        result.desktop_size.height,
    );
    let (io_channel_id, user_channel_id, message_channel_id, compression_type) = (
        result.io_channel_id,
        result.user_channel_id,
        result.message_channel_id,
        result.compression_type,
    );
    let mut stage = ActiveStageBuilder {
        static_channels: result.static_channels,
        io_channel_id,
        user_channel_id,
        message_channel_id,
        share_id: result.share_id,
        compression_type,
        enable_server_pointer: false,
        pointer_software_rendering: false,
    }
    .build();
    // Upstream's activation factory contains a credential-bearing Config. Use a fresh,
    // password-free configuration for reactivation and discard that factory now.
    drop(result.activation_factory);
    event(Event::Connected {
        width: image.width(),
        height: image.height(),
    })
    .await?;
    let mut input = Database::new();
    let mut revision: u32 = 1;
    let mut sent_revision = 0;
    loop {
        let outputs = tokio::select! {
            request = rx.recv() => match request {
                None | Some(Request::Disconnect) => {
                    if let Ok(outputs) = stage.graceful_shutdown() {
                        for out in outputs { if let ActiveStageOutput::ResponseFrame(bytes) = out { let _ = framed.write(&bytes).await; } }
                    }
                    return Ok(());
                }
                Some(Request::Frame) => {
                    if revision == sent_revision { packet(1, &[]).await?; }
                    else {
                        let mut bytes = Vec::with_capacity(16 + image.data().len());
                        for value in [WIRE_VERSION, u32::from(image.width()), u32::from(image.height()), revision] { bytes.extend_from_slice(&value.to_le_bytes()); }
                        bytes.extend_from_slice(image.data());
                        packet(1, &bytes).await?;
                        sent_revision = revision;
                    }
                    continue;
                }
                Some(Request::Input { events }) => {
                    if events.len() > MAX_INPUT_BATCH || events.iter().any(|e| !e.validate()) { return Err("Invalid RDP input"); }
                    let mut outputs = Vec::new();
                    for event in events {
                        let events = match event {
                            Input::ReleaseAll => input.release_all(),
                            _ => input.apply(operations(event, image.width(), image.height())),
                        };
                        outputs.extend(stage.process_fastpath_input(&mut image, &events).map_err(|_| "RDP input failed")?);
                    }
                    outputs
                }
                _ => return Err("Unexpected RDP request"),
            },
            bytes = framed.read(&RDP_HINT) => {
                let bytes = bytes?;
                let action = ironrdp::pdu::find_size(&bytes).map_err(|_| "Invalid RDP frame")?.ok_or("Incomplete RDP frame")?.action;
                stage.process(&mut image, action, &bytes).map_err(|_| "RDP display update failed")?
            }
        };
        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(bytes) => framed.write(&bytes).await?,
                ActiveStageOutput::GraphicsUpdate(_) => revision = revision.wrapping_add(1),
                ActiveStageOutput::Terminate(_) => return Ok(()),
                ActiveStageOutput::DeactivateAll => {
                    let mut activation = ConnectionActivationSequence::new(
                        connection::config(&config),
                        io_channel_id,
                        user_channel_id,
                    );
                    let (size, share_id, _pointer) =
                        tokio::time::timeout(Duration::from_secs(20), async {
                            loop {
                                framed.step(&mut activation).await?;
                                if let ConnectionActivationState::Finalized {
                                    desktop_size,
                                    share_id,
                                    enable_server_pointer,
                                    ..
                                } = activation.connection_activation_state()
                                {
                                    break Ok::<_, &'static str>((
                                        desktop_size,
                                        share_id,
                                        enable_server_pointer,
                                    ));
                                }
                            }
                        })
                        .await
                        .map_err(|_| "RDP desktop reactivation timed out")??;
                    valid_size(size.width, size.height)?;
                    image = DecodedImage::new(PixelFormat::RgbA32, size.width, size.height);
                    stage = ActiveStageBuilder {
                        static_channels: Default::default(),
                        io_channel_id,
                        user_channel_id,
                        message_channel_id,
                        share_id,
                        compression_type,
                        enable_server_pointer: false,
                        pointer_software_rendering: false,
                    }
                    .build();
                    input = Database::new();
                    revision = revision.wrapping_add(1);
                    event(Event::Connected {
                        width: size.width,
                        height: size.height,
                    })
                    .await?;
                }
                // No auxiliary transport, clipboard, drive, audio or smart-card channel is registered.
                _ => {}
            }
        }
    }
}
fn operations(event: Input, width: u16, height: u16) -> Vec<Operation> {
    let position = |x: u16, y: u16| {
        Operation::MouseMove(MousePosition {
            x: x.min(width - 1),
            y: y.min(height - 1),
        })
    };
    match event {
        Input::Key { code, down } => {
            let code = Scancode::from_u8(code & 0x100 != 0, (code & 0x7f) as u8);
            vec![if down {
                Operation::KeyPressed(code)
            } else {
                Operation::KeyReleased(code)
            }]
        }
        Input::Pointer { x, y, button, down } => {
            let mut result = vec![position(x, y)];
            if let Some(button) = button.and_then(MouseButton::from_web_button) {
                result.push(if down {
                    Operation::MouseButtonPressed(button)
                } else {
                    Operation::MouseButtonReleased(button)
                });
            }
            result
        }
        Input::Wheel { x, y, delta } => vec![
            position(x, y),
            Operation::WheelRotations(WheelRotations {
                is_vertical: true,
                rotation_units: delta,
            }),
        ],
        Input::ReleaseAll => Vec::new(),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let (tx, mut rx) = mpsc::channel(8);
    tokio::spawn(requests(tx));
    match run(&mut rx).await {
        Ok(()) => {
            let _ = event(Event::Ended).await;
        }
        Err(message) => {
            let _ = event(Event::Error {
                message: message.into(),
            })
            .await;
        }
    }
    // Tokio's stdin uses a blocking read; do not let it keep the helper alive after disconnect.
    std::process::exit(0);
}
