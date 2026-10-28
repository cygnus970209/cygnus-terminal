//! Local HTTPS WS-Man fixture: validates our lifecycle without a Windows host.
//! The committed key is exclusively for this loopback test certificate.
use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, sync::atomic::AtomicUsize};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Notify,
};
use tokio_rustls::{
    rustls::{
        self,
        pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    },
    server::TlsStream,
    TlsAcceptor,
};

struct TlsListener {
    tcp: TcpListener,
    acceptor: TlsAcceptor,
}
impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let (tcp, addr) = self.tcp.accept().await.unwrap();
            if let Ok(tls) = self.acceptor.accept(tcp).await {
                return (tls, addr);
            }
        }
    }
    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.tcp.local_addr()
    }
}
#[derive(Default)]
struct Mock {
    requests: Mutex<Vec<String>>,
    slow: AtomicBool,
    deny: AtomicBool,
    output_size: AtomicUsize,
    receiving: Notify,
}
async fn response(State(mock): State<Arc<Mock>>, headers: HeaderMap, body: String) -> Response {
    if mock.deny.load(Ordering::Acquire)
        || headers.get("authorization").and_then(|v| v.to_str().ok())
            != Some("Basic YWRtaW46c2VjcmV0")
    {
        return (
            StatusCode::UNAUTHORIZED,
            [("www-authenticate", "Basic realm=\"WinRM\"")],
            "Unauthorized",
        )
            .into_response();
    }
    mock.requests.lock().await.push(body.clone());
    let response = if body.contains("/transfer/Create</wsa:Action>") {
        "<rsp:Shell><rsp:ShellId>S1</rsp:ShellId></rsp:Shell>".to_owned()
    } else if body.contains("/shell/Command</wsa:Action>") {
        "<rsp:CommandResponse><rsp:CommandId>C1</rsp:CommandId></rsp:CommandResponse>".to_owned()
    } else if body.contains("/shell/Receive</wsa:Action>") {
        mock.receiving.notify_one();
        if mock.slow.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        let size = mock.output_size.load(Ordering::Acquire);
        let out = if size == 0 {
            "안녕하세요\n".as_bytes().to_vec()
        } else {
            vec![b'a'; size]
        };
        format!(
            r#"<rsp:ReceiveResponse><rsp:Stream Name="stdout" CommandId="C1">{}</rsp:Stream><rsp:CommandState CommandId="C1" State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done"><rsp:ExitCode>0</rsp:ExitCode></rsp:CommandState></rsp:ReceiveResponse>"#,
            STANDARD.encode(out)
        )
    } else {
        String::new()
    };
    ([("content-type", "application/soap+xml;charset=UTF-8")], format!(r#"<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell"><s:Body>{response}</s:Body></s:Envelope>"#)).into_response()
}
struct Fixture {
    config: Config,
    mock: Arc<Mock>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn fixture() -> Fixture {
    let der = include_bytes!("fixtures/server.der").to_vec();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(der.clone())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                include_bytes!("fixtures/server-key.der").to_vec(),
            )),
        )
        .unwrap();
    let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = tcp.local_addr().unwrap().port();
    let listener = TlsListener {
        tcp,
        acceptor: TlsAcceptor::from(Arc::new(tls)),
    };
    let mock = Arc::new(Mock::default());
    let router = Router::new()
        .route("/wsman", post(response))
        .with_state(mock.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let mut config = config();
    config.host = "127.0.0.1".into();
    config.port = port;
    config.domain.clear();
    config.authentication = Authentication::Basic;
    config.certificate_pin = format!("{:x}", Sha256::digest(&der));
    Fixture {
        config,
        mock,
        server,
    }
}

#[tokio::test]
async fn https_executes_encoded_powershell_and_deletes_every_remote_shell() {
    let fixture = fixture().await;
    let manager = WinrmManager::default();
    let id = uuid::Uuid::new_v4().to_string();
    manager
        .connect(
            id.clone(),
            fixture.config.clone(),
            Zeroizing::new("secret".into()),
        )
        .await
        .unwrap();
    let script = "Write-Output '한글 & < >'";
    let out = manager.run(&id, script).await.unwrap();
    assert_eq!(out.stdout, "안녕하세요\n");
    assert!(out.stderr.is_empty());
    assert_eq!(out.exit_code, 0);
    let requests = fixture.mock.requests.lock().await;
    assert!(requests
        .iter()
        .any(|r| r.contains(&winrm_rs::encode_powershell_command(script))));
    assert_eq!(
        requests
            .iter()
            .filter(|r| r.contains("/transfer/Create</wsa:Action>"))
            .count(),
        2
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r.contains("/transfer/Delete</wsa:Action>"))
            .count(),
        2
    );
    assert!(requests
        .iter()
        .filter(|r| r.contains("/shell/Command</wsa:Action>"))
        .all(|r| r.contains("-NonInteractive")));
    drop(requests);
    manager.close(&id).await;
    assert!(manager.sessions.lock().await.is_empty());
}

#[tokio::test]
async fn cancellation_rejects_overlapping_commands_and_releases_the_session() {
    let fixture = fixture().await;
    let manager = Arc::new(WinrmManager::default());
    let id = uuid::Uuid::new_v4().to_string();
    manager
        .connect(
            id.clone(),
            fixture.config.clone(),
            Zeroizing::new("secret".into()),
        )
        .await
        .unwrap();
    fixture.mock.receiving.notified().await; // consume the connection probe's notification
    fixture.mock.slow.store(true, Ordering::Release);
    let task_manager = manager.clone();
    let task_id = id.clone();
    let task = tokio::spawn(async move { task_manager.run(&task_id, "Start-Sleep 300").await });
    tokio::time::timeout(Duration::from_secs(5), fixture.mock.receiving.notified())
        .await
        .unwrap();
    assert!(manager
        .run(&id, "Get-Process")
        .await
        .unwrap_err()
        .contains("already running"));
    manager.cancel(&id).await;
    let error = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .err()
        .unwrap();
    assert!(error.to_lowercase().contains("cancel"), "{error}");
    fixture.mock.slow.store(false, Ordering::Release);
    assert!(manager.run(&id, "Get-Process").await.is_ok());
    manager.close(&id).await;
    assert!(manager.run(&id, "Get-Process").await.is_err());
    let requests = fixture.mock.requests.lock().await;
    assert_eq!(
        requests
            .iter()
            .filter(|r| r.contains("/transfer/Delete</wsa:Action>"))
            .count(),
        3
    );
}

#[tokio::test]
async fn failed_authentication_or_untrusted_tls_never_creates_a_connected_session() {
    let fixture = fixture().await;
    let manager = WinrmManager::default();
    let mut untrusted = fixture.config.clone();
    untrusted.certificate_pin.clear();
    assert!(manager
        .connect(
            uuid::Uuid::new_v4().to_string(),
            untrusted,
            Zeroizing::new("secret".into())
        )
        .await
        .is_err());
    assert!(fixture.mock.requests.lock().await.is_empty());
    fixture.mock.deny.store(true, Ordering::Release);
    assert!(manager
        .connect(
            uuid::Uuid::new_v4().to_string(),
            fixture.config.clone(),
            Zeroizing::new("secret".into())
        )
        .await
        .is_err());
    assert!(manager.sessions.lock().await.is_empty());
}
