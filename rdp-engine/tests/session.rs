//! Exercises the actual bundled client against a loopback RDP/NLA server.
use cygnus_rdp_protocol::{frame_header, ConnectConfig, Event, Input, Request, MAX_FRAME_BYTES};
use ironrdp_server::{
    BitmapUpdate, Credentials, DesktopSize, DisplayUpdate, KeyboardEvent, MouseEvent, PixelFormat,
    RdpServer, RdpServerDisplay, RdpServerDisplayUpdates, RdpServerInputHandler,
};
use std::{
    num::{NonZeroU16, NonZeroUsize},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
    task::JoinHandle,
};
use tokio_rustls::{
    rustls::{self, pki_types::PrivatePkcs8KeyDer},
    TlsAcceptor,
};
use x509_cert::der::Decode;

#[derive(Clone)]
struct Display(Arc<Mutex<Vec<String>>>);
impl RdpServerInputHandler for Display {
    fn keyboard(&mut self, event: KeyboardEvent) {
        self.0.lock().unwrap().push(format!("key:{event:?}"));
    }
    fn mouse(&mut self, event: MouseEvent) {
        self.0.lock().unwrap().push(format!("mouse:{event:?}"));
    }
}
struct Updates;
#[async_trait::async_trait]
impl RdpServerDisplayUpdates for Updates {
    async fn next_update(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        tokio::time::sleep(Duration::from_millis(100)).await;
        // Constant red bitmap in the top-left corner; the client must decode BGRA -> RGBA.
        Ok(Some(DisplayUpdate::Bitmap(BitmapUpdate {
            x: 0,
            y: 0,
            width: NonZeroU16::new(32).unwrap(),
            height: NonZeroU16::new(32).unwrap(),
            format: PixelFormat::BgrA32,
            data: [0u8, 0, 255, 255].repeat(32 * 32).into(),
            stride: NonZeroUsize::new(32 * 4).unwrap(),
        })))
    }
}
#[async_trait::async_trait]
impl RdpServerDisplay for Display {
    async fn size(&mut self) -> DesktopSize {
        DesktopSize {
            width: 640,
            height: 480,
        }
    }
    async fn updates(&mut self) -> anyhow::Result<Box<dyn RdpServerDisplayUpdates>> {
        Ok(Box::new(Updates))
    }
}
struct Fixture {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    server: JoinHandle<()>,
    inputs: Arc<Mutex<Vec<String>>>,
    port: u16,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Fixture {
    async fn new() -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let public_key = x509_cert::Certificate::from_der(cert.cert.der())
            .unwrap()
            .tbs_certificate
            .subject_public_key_info
            .subject_public_key
            .as_bytes()
            .unwrap()
            .to_vec();
        let tls = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.cert.der().clone()],
                PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()).into(),
            )
            .unwrap();
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = socket.local_addr().unwrap();
        drop(socket);
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let display = Display(inputs.clone());
        let mut server = RdpServer::builder()
            .with_addr(addr)
            .with_hybrid(TlsAcceptor::from(Arc::new(tls)), public_key)
            .with_input_handler(display.clone())
            .with_display_handler(display)
            .build();
        server.set_credentials(Some(Credentials {
            username: "test-user".into(),
            password: "test-password".into(),
            domain: None,
        }));
        let server = tokio::task::spawn_local(async move {
            let _ = server.run().await;
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        // Test-only override also exercises the engine copied into a packaged app.
        let binary = std::env::var_os("CYGNUS_RDP_TEST_BINARY")
            .unwrap_or_else(|| env!("CARGO_BIN_EXE_cygnus-rdp").into());
        let mut child = Command::new(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        Self {
            child,
            stdin,
            stdout,
            server,
            inputs,
            port: addr.port(),
        }
    }
    async fn send(&mut self, request: Request) {
        let bytes = serde_json::to_vec(&request).unwrap();
        self.stdin.write_u32_le(bytes.len() as u32).await.unwrap();
        self.stdin.write_all(&bytes).await.unwrap();
        self.stdin.flush().await.unwrap();
    }
    async fn read(&mut self) -> (u8, Vec<u8>) {
        tokio::time::timeout(Duration::from_secs(10), async {
            let kind = self.stdout.read_u8().await.unwrap();
            let length = self.stdout.read_u32_le().await.unwrap() as usize;
            assert!(length <= MAX_FRAME_BYTES);
            let mut body = vec![0; length];
            self.stdout.read_exact(&mut body).await.unwrap();
            (kind, body)
        })
        .await
        .expect("client response timeout")
    }
    async fn event(&mut self) -> Event {
        let (kind, bytes) = self.read().await;
        assert_eq!(kind, 0);
        assert!(!String::from_utf8_lossy(&bytes).contains("test-password"));
        serde_json::from_slice(&bytes).unwrap()
    }
    async fn begin(&mut self) -> String {
        self.send(Request::Connect {
            config: ConnectConfig {
                host: "127.0.0.1".into(),
                port: self.port,
                username: "test-user".into(),
                domain: String::new(),
                width: 640,
                height: 480,
            },
        })
        .await;
        assert!(matches!(self.event().await, Event::Connecting));
        match self.event().await {
            Event::Certificate { fingerprint, .. } => fingerprint,
            Event::Error { message } => panic!("{message}"),
            _ => panic!("expected certificate"),
        }
    }
}

#[tokio::test]
async fn real_nla_session_waits_for_approval_then_decodes_pixels_sends_input_and_disconnects() {
    tokio::task::LocalSet::new().run_until(real_nla_session_waits_for_approval_then_decodes_pixels_sends_input_and_disconnects_inner()).await;
}
async fn real_nla_session_waits_for_approval_then_decodes_pixels_sends_input_and_disconnects_inner()
{
    let mut f = Fixture::new().await;
    let fingerprint = f.begin().await;
    // Nothing beyond the certificate is returned before explicit approval/password.
    assert!(
        tokio::time::timeout(Duration::from_millis(150), f.stdout.read_u8())
            .await
            .is_err()
    );
    assert!(f.inputs.lock().unwrap().is_empty());
    f.send(Request::Authenticate {
        fingerprint,
        password: "test-password".into(),
    })
    .await;
    assert!(matches!(f.event().await, Event::Authenticating));
    match f.event().await {
        Event::Connected { width, height } => assert_eq!((width, height), (640, 480)),
        Event::Error { message } => panic!("{message}"),
        _ => panic!("expected connected"),
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
    f.send(Request::Frame).await;
    let (kind, bytes) = f.read().await;
    assert_eq!(kind, 1);
    assert_eq!(
        frame_header(&bytes).map(|(w, h, _)| (w, h)),
        Some((640, 480))
    );
    // RemoteFX uses lossy color conversion; allow a small red-channel error.
    assert!((250..=255).contains(&bytes[16]));
    assert_eq!(&bytes[17..20], &[0, 0, 255]);
    f.send(Request::Input {
        events: vec![
            Input::Key {
                code: 0x1e,
                down: true,
            },
            Input::Pointer {
                x: 20,
                y: 30,
                button: Some(0),
                down: true,
            },
            Input::ReleaseAll,
        ],
    })
    .await;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if f.inputs.lock().unwrap().len() >= 4 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let inputs = f.inputs.lock().unwrap().clone();
    assert!(inputs.iter().any(|s| s.starts_with("key:")));
    assert!(inputs.iter().any(|s| s.starts_with("mouse:")));
    f.send(Request::Disconnect).await;
    assert!(matches!(f.event().await, Event::Ended));
    assert!(tokio::time::timeout(Duration::from_secs(2), f.child.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
}

#[tokio::test]
async fn wrong_certificate_approval_never_authenticates() {
    tokio::task::LocalSet::new()
        .run_until(wrong_certificate_approval_never_authenticates_inner())
        .await;
}
async fn wrong_certificate_approval_never_authenticates_inner() {
    let mut f = Fixture::new().await;
    f.begin().await;
    f.send(Request::Authenticate {
        fingerprint: "wrong".into(),
        password: "test-password".into(),
    })
    .await;
    assert!(matches!(f.event().await, Event::Error { .. }));
    assert!(f.inputs.lock().unwrap().is_empty());
    assert!(tokio::time::timeout(Duration::from_secs(2), f.child.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
}

#[tokio::test]
async fn incorrect_password_is_a_failure_without_echoing_the_secret() {
    tokio::task::LocalSet::new()
        .run_until(incorrect_password_is_a_failure_without_echoing_the_secret_inner())
        .await;
}
async fn incorrect_password_is_a_failure_without_echoing_the_secret_inner() {
    let mut f = Fixture::new().await;
    let fingerprint = f.begin().await;
    f.send(Request::Authenticate {
        fingerprint,
        password: "wrong-password".into(),
    })
    .await;
    assert!(matches!(f.event().await, Event::Authenticating));
    match f.event().await {
        Event::Error { message } => assert!(!message.contains("wrong-password")),
        _ => panic!("bad credentials must fail"),
    }
    assert!(f.inputs.lock().unwrap().is_empty());
}
