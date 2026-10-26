use super::*;
fn pin() -> String {
    ["AB"; 32].join(":")
}
fn approval(fingerprint: String, password: String) -> CertificateApproval {
    CertificateApproval {
        fingerprint,
        password,
        expected_saved_fingerprint: None,
        remember: false,
        accept_changed: false,
    }
}

fn fixture(phase: u8) -> (RdpManager, Arc<Session>, mpsc::Receiver<Request>) {
    let manager = RdpManager::new(Arc::new(Database::new_in_memory().unwrap()));
    let (tx, rx) = mpsc::channel(16);
    let session = Arc::new(Session {
        cancel: CancellationToken::new(),
        finished: CancellationToken::new(),
        tx,
        display_area: AtomicU32::new(0),
        resizing: AtomicBool::new(false),
        clipboard: Mutex::new(ClipboardGate::default()),
        phase: AtomicU8::new(phase),
        endpoint: Endpoint::new(&ConnectConfig {
            host: "test.local".into(),
            port: 3389,
            username: "user".into(),
            domain: String::new(),
            width: 1280,
            height: 720,
            desktop_scale_factor: 0,
        })
        .unwrap(),
        certificate: Mutex::new(Some(PendingCertificate {
            fingerprint: pin(),
            saved: None,
        })),
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

#[tokio::test]
async fn closing_keeps_ownership_until_cleanup_and_rejects_new_input() {
    let (manager, session, mut rx) = fixture(3);
    let cloned = manager.clone();
    let closing = tokio::spawn(async move { cloned.close_and_wait("test").await });
    session.cancel.cancelled().await;
    assert!(!closing.is_finished());
    assert!(manager.session("test").is_ok());
    assert!(manager.input("test", vec![Input::ReleaseAll]).is_err());
    assert!(manager.frame("test").await.is_err());
    assert!(rx.try_recv().is_err());
    // The worker signals this only after run() has waited for the child and released its slot.
    manager.0.sessions.lock().unwrap().remove("test");
    session.finished.cancel();
    closing.await.unwrap().unwrap();
    manager.close_and_wait("test").await.unwrap(); // idempotent after cleanup
}

#[tokio::test]
async fn simultaneous_close_waiters_and_close_all_wait_for_the_same_cleanup() {
    let (manager, session, _) = fixture(3);
    manager.close_all();
    assert!(session.cancel.is_cancelled());
    assert!(manager.session("test").is_ok());
    let (a, b) = (manager.clone(), manager.clone());
    let a = tokio::spawn(async move { a.close_and_wait("test").await });
    let b = tokio::spawn(async move { b.close_and_wait("test").await });
    tokio::task::yield_now().await;
    assert!(!a.is_finished() && !b.is_finished());
    manager.0.sessions.lock().unwrap().remove("test");
    session.finished.cancel();
    a.await.unwrap().unwrap();
    b.await.unwrap().unwrap();
}

#[tokio::test]
async fn close_timeout_preserves_ownership_until_the_worker_finishes() {
    let (manager, session, _) = fixture(3);
    assert!(manager.close_and_wait("test").await.is_err());
    assert!(session.cancel.is_cancelled());
    assert!(!session.finished.is_cancelled());
    assert!(manager.session("test").is_ok());
    session.finished.cancel();
    manager.close_and_wait("test").await.unwrap();
}

#[test]
fn approval_is_bound_to_certificate_and_can_only_be_used_once() {
    let (manager, session, mut rx) = fixture(1);
    assert!(manager
        .authenticate("test", approval("other".into(), "test-secret".into()))
        .is_err());
    assert_eq!(session.phase.load(Ordering::Acquire), 1);
    assert!(rx.try_recv().is_err());
    manager
        .authenticate("test", approval(pin(), "test-secret".into()))
        .unwrap();
    assert!(
        matches!(rx.try_recv().unwrap(), Request::Authenticate { fingerprint, password } if fingerprint == pin() && password == "test-secret")
    );
    assert!(manager
        .authenticate("test", approval(pin(), "test-secret".into()))
        .is_err());
    assert!(session.certificate.lock().unwrap().is_none());
}

#[test]
fn authentication_requires_waiting_phase_and_bounded_password() {
    for phase in [0, 2, 3, 4] {
        let (manager, _, mut rx) = fixture(phase);
        assert!(manager
            .authenticate("test", approval(pin(), "test-secret".into()))
            .is_err());
        assert!(rx.try_recv().is_err());
    }
    for password in [String::new(), "x".repeat(4097), "bad\0password".into()] {
        let (manager, session, _) = fixture(1);
        assert!(manager
            .authenticate("test", approval(pin(), password))
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
        desktop_scale_factor: 0,
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

#[test]
fn unicode_text_is_bounded_single_line_and_requires_a_connected_session() {
    let (manager, session, mut rx) = fixture(1);
    let text = || Input::Text {
        text: "한글🙂e\u{301}".into(),
    };
    assert!(manager.input("test", vec![text()]).is_err());
    session.phase.store(3, Ordering::Release);
    for invalid in [
        "".into(),
        "a\nB".into(),
        "\t".into(),
        "\0".into(),
        "\u{7f}".into(),
        "\u{85}".into(),
        "\u{2028}".into(),
        "x".repeat(257),
        "🙂".repeat(129),
    ] {
        assert!(manager
            .input("test", vec![Input::Text { text: invalid }])
            .is_err());
    }
    assert!(rx.try_recv().is_err());
    manager.input("test", vec![text()]).unwrap();
    assert!(
        matches!(rx.try_recv().unwrap(), Request::Input { events } if matches!(&events[0], Input::Text { text } if text == "한글🙂e\u{301}"))
    );
    assert!(Input::Text {
        text: "🙂".repeat(128)
    }
    .validate());
    assert!(serde_json::from_str::<Input>(r#"{"type":"text","text":"\ud800"}"#).is_err());
}

#[test]
fn changed_certificate_cannot_reach_engine_without_acknowledgement() {
    let (manager, session, mut rx) = fixture(1);
    let old = ["CD"; 32].join(":");
    manager
        .0
        .database
        .approve_rdp_certificate(&session.endpoint, &old, None, true, false)
        .unwrap();
    session.certificate.lock().unwrap().as_mut().unwrap().saved = Some(old.clone());
    let mut request = approval(pin(), "test-secret".into());
    request.expected_saved_fingerprint = Some(old.clone());
    assert!(manager.authenticate("test", request).is_err());
    assert!(rx.try_recv().is_err());
    let mut request = approval(pin(), "test-secret".into());
    request.expected_saved_fingerprint = Some(old.clone());
    request.accept_changed = true;
    manager.authenticate("test", request).unwrap();
    assert!(matches!(
        rx.try_recv().unwrap(),
        Request::Authenticate { .. }
    ));
    assert_eq!(
        manager
            .0
            .database
            .rdp_certificate(&session.endpoint)
            .unwrap(),
        Some(old)
    );
}
#[test]
fn stale_or_forged_saved_fingerprint_never_sends_password() {
    let (manager, session, mut rx) = fixture(1);
    let mut forged = approval(pin(), "test-secret".into());
    forged.expected_saved_fingerprint = Some(pin());
    assert!(manager.authenticate("test", forged).is_err());
    assert!(rx.try_recv().is_err());
    manager
        .0
        .database
        .approve_rdp_certificate(&session.endpoint, &["CD"; 32].join(":"), None, true, false)
        .unwrap();
    assert!(manager
        .authenticate("test", approval(pin(), "test-secret".into()))
        .is_err());
    assert!(rx.try_recv().is_err());
}
#[test]
fn forgetting_requires_the_displayed_saved_pin_and_closes_the_session() {
    let (manager, session, mut rx) = fixture(1);
    manager
        .0
        .database
        .approve_rdp_certificate(&session.endpoint, &pin(), None, true, false)
        .unwrap();
    session.certificate.lock().unwrap().as_mut().unwrap().saved = Some(pin());
    assert!(manager.forget_certificate("test", "wrong").is_err());
    manager.forget_certificate("test", &pin()).unwrap();
    assert!(session.cancel.is_cancelled());
    assert_eq!(session.phase.load(Ordering::Acquire), 4);
    assert!(manager.session("test").is_ok()); // retained until the worker is reaped
    assert!(manager
        .0
        .database
        .rdp_certificate(&session.endpoint)
        .unwrap()
        .is_none());
    assert!(rx.try_recv().is_err());
}
#[test]
fn certificate_event_exposes_only_public_pin_metadata() {
    let value = SessionEvent {
        event: Event::Certificate {
            fingerprint: pin(),
            subject: "test".into(),
            issuer: "test".into(),
            valid_from: "test".into(),
            valid_until: "test".into(),
        },
        saved_fingerprint: Some(pin()),
    };
    let json = serde_json::to_value(value).unwrap();
    assert_eq!(json["type"], "certificate");
    assert_eq!(json["saved_fingerprint"], pin());
    assert!(json.get("password").is_none());
}

#[test]
fn resize_requires_connected_capability_and_only_one_pending_request() {
    let size = DesktopSize {
        width: 1280,
        height: 720,
    };
    for phase in [0, 1, 2, 4] {
        let (manager, session, mut rx) = fixture(phase);
        session.display_area.store(1920 * 1080, Ordering::Release);
        assert!(manager.resize("test", size).is_err());
        assert!(rx.try_recv().is_err());
    }
    let (manager, session, mut rx) = fixture(3);
    assert!(manager.resize("test", size).is_err());
    session.display_area.store(640 * 480, Ordering::Release);
    assert!(manager.resize("test", size).is_err());
    session.display_area.store(1920 * 1080, Ordering::Release);
    for (width, height) in [(641, 480), (0, 0), (1922, 1080), (1920, 1081)] {
        assert!(manager
            .resize("test", DesktopSize { width, height })
            .is_err());
    }
    manager.resize("test", size).unwrap();
    assert!(manager.resize("test", size).is_err());
    assert!(matches!(
        rx.try_recv().unwrap(),
        Request::Resize {
            size: DesktopSize {
                width: 1280,
                height: 720
            }
        }
    ));
    assert!(rx.try_recv().is_err());
    session.resizing.store(false, Ordering::Release);
    manager.close("test");
    assert!(manager.resize("test", size).is_err());
}

#[test]
fn failed_resize_enqueue_releases_pending_slot_without_closing_connection() {
    let (manager, session, mut rx) = fixture(3);
    session.display_area.store(1920 * 1080, Ordering::Release);
    for _ in 0..16 {
        session.tx.try_send(Request::Frame).ok().unwrap();
    }
    let size = DesktopSize {
        width: 1280,
        height: 720,
    };
    assert!(manager.resize("test", size).is_err());
    assert!(!session.resizing.load(Ordering::Acquire));
    assert!(!session.cancel.is_cancelled());
    rx.try_recv().unwrap();
    manager.resize("test", size).unwrap();
}

#[test]
fn clipboard_requires_explicit_permission_bounded_text_and_fresh_request_ids() {
    use cygnus_rdp_protocol::ClipboardOutcome;
    let (manager, session, mut rx) = fixture(3);
    assert!(manager
        .clipboard("test", 1, ClipboardAction::Enable)
        .is_err());
    session.clipboard.lock().unwrap().set_available(true);
    assert!(manager.clipboard("test", 1, ClipboardAction::Read).is_err());
    manager
        .clipboard("test", 1, ClipboardAction::Enable)
        .unwrap();
    rx.try_recv().unwrap();
    assert!(manager.clipboard("test", 2, ClipboardAction::Read).is_err());
    session
        .clipboard
        .lock()
        .unwrap()
        .accept(1, &ClipboardOutcome::Enabled)
        .unwrap();
    for text in ["x".repeat(2049), "control\0text".into()] {
        assert!(manager
            .clipboard("test", 2, ClipboardAction::Send { text })
            .is_err());
    }
    manager
        .clipboard(
            "test",
            2,
            ClipboardAction::Send {
                text: "한글\r\n🙂".into(),
            },
        )
        .unwrap();
    assert!(matches!(
        rx.try_recv().unwrap(),
        Request::Clipboard { request_id: 2, .. }
    ));
    assert!(manager.clipboard("test", 3, ClipboardAction::Read).is_err());
    assert!(session
        .clipboard
        .lock()
        .unwrap()
        .accept(2, &ClipboardOutcome::Offered)
        .unwrap());
    assert!(manager.clipboard("test", 2, ClipboardAction::Read).is_err());
}
#[test]
fn stopping_clipboard_supersedes_a_pending_read_and_discards_late_secrets() {
    use cygnus_rdp_protocol::ClipboardOutcome;
    let (manager, session, _rx) = fixture(3);
    session.clipboard.lock().unwrap().set_available(true);
    manager
        .clipboard("test", 1, ClipboardAction::Enable)
        .unwrap();
    session
        .clipboard
        .lock()
        .unwrap()
        .accept(1, &ClipboardOutcome::Enabled)
        .unwrap();
    manager.clipboard("test", 2, ClipboardAction::Read).unwrap();
    manager
        .clipboard("test", 3, ClipboardAction::Disable)
        .unwrap();
    assert!(!session
        .clipboard
        .lock()
        .unwrap()
        .accept(
            2,
            &ClipboardOutcome::Received {
                text: "late secret".into()
            }
        )
        .unwrap());
    assert!(session
        .clipboard
        .lock()
        .unwrap()
        .accept(3, &ClipboardOutcome::Disabled)
        .unwrap());
    assert!(manager.clipboard("test", 4, ClipboardAction::Read).is_err());
    assert!(!session
        .clipboard
        .lock()
        .unwrap()
        .accept(
            2,
            &ClipboardOutcome::Received {
                text: "unsolicited".into()
            }
        )
        .unwrap());
}
#[test]
fn clipboard_invalid_reply_and_failed_revocation_are_rejected() {
    use cygnus_rdp_protocol::ClipboardOutcome;
    let (manager, session, _rx) = fixture(3);
    session.clipboard.lock().unwrap().set_available(true);
    manager
        .clipboard("test", 1, ClipboardAction::Enable)
        .unwrap();
    assert!(session
        .clipboard
        .lock()
        .unwrap()
        .accept(
            1,
            &ClipboardOutcome::Received {
                text: "wrong operation".into()
            }
        )
        .is_err());
    for _ in 0..15 {
        session.tx.try_send(Request::Frame).ok().unwrap();
    }
    assert!(manager
        .clipboard("test", 2, ClipboardAction::Disable)
        .is_err());
    assert!(session.cancel.is_cancelled());
    assert!(manager
        .clipboard("test", 3, ClipboardAction::Enable)
        .is_err());
}
