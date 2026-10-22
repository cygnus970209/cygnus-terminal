use super::*;

fn fixture(phase: u8) -> (RdpManager, Arc<Session>, mpsc::Receiver<Request>) {
    let manager = RdpManager::new();
    let (tx, rx) = mpsc::channel(16);
    let session = Arc::new(Session {
        cancel: CancellationToken::new(),
        tx,
        phase: AtomicU8::new(phase),
        fingerprint: Mutex::new(Some("approved-fingerprint".into())),
        frame: Mutex::new(None),
    });
    manager
        .0
        .sessions
        .lock()
        .unwrap()
        .insert("test".into(), session.clone());
    (manager, session, rx)
}

#[test]
fn approval_is_bound_to_certificate_and_can_only_be_used_once() {
    let (manager, session, mut rx) = fixture(1);
    assert!(manager
        .authenticate("test", "other".into(), "test-secret".into())
        .is_err());
    assert_eq!(session.phase.load(Ordering::Acquire), 1);
    assert!(rx.try_recv().is_err());
    manager
        .authenticate("test", "approved-fingerprint".into(), "test-secret".into())
        .unwrap();
    assert!(
        matches!(rx.try_recv().unwrap(), Request::Authenticate { fingerprint, password } if fingerprint == "approved-fingerprint" && password == "test-secret")
    );
    assert!(manager
        .authenticate("test", "approved-fingerprint".into(), "test-secret".into())
        .is_err());
    assert!(session.fingerprint.lock().unwrap().is_none());
}

#[test]
fn authentication_requires_waiting_phase_and_bounded_password() {
    for phase in [0, 2, 3, 4] {
        let (manager, _, mut rx) = fixture(phase);
        assert!(manager
            .authenticate("test", "approved-fingerprint".into(), "test-secret".into())
            .is_err());
        assert!(rx.try_recv().is_err());
    }
    for password in [String::new(), "x".repeat(4097), "bad\0password".into()] {
        let (manager, session, _) = fixture(1);
        assert!(manager
            .authenticate("test", "approved-fingerprint".into(), password)
            .is_err());
        assert_eq!(session.phase.load(Ordering::Acquire), 1);
    }
}

#[test]
fn input_requires_connection_and_overflow_closes_instead_of_dropping_releases() {
    let (manager, session, _rx) = fixture(0);
    assert!(manager.input("test", vec![Input::ReleaseAll]).is_err());
    session.phase.store(3, Ordering::Release);
    assert!(manager
        .input(
            "test",
            vec![Input::Key {
                code: 0xffff,
                down: true
            }]
        )
        .is_err());
    assert!(manager
        .input("test", vec![Input::ReleaseAll; MAX_INPUT_BATCH + 1])
        .is_err());
    for _ in 0..16 {
        manager.input("test", vec![Input::ReleaseAll]).unwrap();
    }
    assert!(manager.input("test", vec![Input::ReleaseAll]).is_err());
    assert!(session.cancel.is_cancelled());
}

#[tokio::test]
async fn display_allows_one_pending_frame_per_session() {
    let (manager, session, mut rx) = fixture(3);
    let cloned = manager.clone();
    let first = tokio::spawn(async move { cloned.frame("test").await });
    assert!(matches!(rx.recv().await, Some(Request::Frame)));
    assert!(manager
        .frame("test")
        .await
        .unwrap_err()
        .contains("already pending"));
    session
        .frame
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .send(Ok(Vec::new()))
        .unwrap();
    assert!(first.await.unwrap().unwrap().is_empty());
    manager.close("test");
    assert!(session.cancel.is_cancelled());
    assert!(manager.frame("test").await.is_err());
}

#[tokio::test]
async fn pipe_parser_rejects_oversized_or_invalid_frames_before_reading_payload() {
    for (kind, length) in [(0, MAX_CONTROL_BYTES + 1), (1, MAX_FRAME_BYTES + 1), (9, 0)] {
        let mut bytes = vec![kind];
        bytes.extend_from_slice(&(length as u32).to_le_bytes());
        let error = read_packet(&mut bytes.as_slice()).await.unwrap_err();
        assert!(error.contains("size limit") || error.contains("Invalid RDP engine response"));
    }
    let invalid = [1, 1, 0, 0, 0, 0];
    assert!(read_packet(&mut invalid.as_slice())
        .await
        .unwrap_err()
        .contains("Invalid RDP frame"));
    let unchanged = [1, 0, 0, 0, 0];
    assert!(read_packet(&mut unchanged.as_slice())
        .await
        .unwrap()
        .1
        .is_empty());
}

#[tokio::test]
async fn fragmented_pipe_packets_keep_boundaries() {
    let (mut writer, mut reader) = tokio::io::duplex(8);
    let task = tokio::spawn(async move {
        for byte in [0, 2, 0, 0, 0, b'{', b'}', 1, 0, 0, 0, 0] {
            writer.write_u8(byte).await.unwrap();
            tokio::task::yield_now().await;
        }
    });
    assert_eq!(read_packet(&mut reader).await.unwrap(), (0, b"{}".to_vec()));
    assert_eq!(read_packet(&mut reader).await.unwrap(), (1, Vec::new()));
    task.await.unwrap();
}

#[test]
fn connection_and_frame_dimensions_are_bounded() {
    let config = ConnectConfig {
        host: "::1".into(),
        port: 3389,
        username: "user".into(),
        domain: String::new(),
        width: 1280,
        height: 720,
    };
    assert!(config.validate().is_ok());
    for host in ["", "server/path", "user@server", "server\n", " server"] {
        assert!(ConnectConfig {
            host: host.into(),
            ..config.clone()
        }
        .validate()
        .is_err());
    }
    assert!(ConnectConfig {
        width: 65535,
        ..config
    }
    .validate()
    .is_err());
    let mut frame = [1u32, 1, 1, 9]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect::<Vec<_>>();
    frame.extend_from_slice(&[255, 0, 0, 255]);
    assert_eq!(frame_header(&frame), Some((1, 1, 9)));
    frame[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(frame_header(&frame).is_none());
}
