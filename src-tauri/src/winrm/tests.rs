use super::*;
use crate::{
    crypto::CryptoManager,
    db::{winrm::ProfileData, Database},
};

fn config() -> Config {
    Config {
        host: "windows.example.com".into(),
        port: 5986,
        username: "admin".into(),
        domain: "CORP".into(),
        transport: Transport::Https,
        authentication: Authentication::Ntlm,
        certificate_pin: String::new(),
    }
}
fn profile() -> ProfileData {
    ProfileData {
        name: "Windows".into(),
        group_name: "Lab".into(),
        config: config(),
    }
}

#[test]
fn validates_transport_hosts_and_trust_before_using_credentials() {
    assert!(config().validate().is_ok());
    for host in [
        "https://host",
        "user@host",
        "host/path",
        "host:5986",
        "host?query",
        "host\n",
        "",
    ] {
        let mut c = config();
        c.host = host.into();
        assert!(c.validate().is_err(), "{host}");
    }
    for host in ["::1", "[2001:db8::1]", "192.0.2.1"] {
        let mut c = config();
        c.host = host.into();
        assert!(c.validate().is_ok());
    }
    let mut c = config();
    c.transport = Transport::Http;
    c.authentication = Authentication::Basic;
    assert!(c.validate().unwrap_err().contains("HTTPS"));
    c.authentication = Authentication::Ntlm;
    assert!(c.validate().is_ok());
    c.certificate_pin = "aa".repeat(32);
    assert!(c.validate().is_err());
    c.transport = Transport::Https;
    assert!(c.validate().is_ok());
    c.certificate_pin = "invalid".into();
    assert!(c.validate().is_err());
}

#[test]
fn secrets_are_encrypted_preserved_cleared_and_never_returned_in_lists_or_backups() {
    let db = Database::new_in_memory().unwrap();
    let crypto = CryptoManager::new_random();
    let saved = db
        .save_winrm_profile(
            None,
            profile(),
            Some(Zeroizing::new("secret-value".into())),
            &crypto,
        )
        .unwrap();
    assert!(db.has_encrypted_credentials().unwrap());
    let encrypted: String = db
        .conn()
        .query_row("SELECT password FROM winrm_profiles", [], |r| r.get(0))
        .unwrap();
    assert_ne!(encrypted, "secret-value");
    assert!(!serde_json::to_string(&db.list_winrm_profiles().unwrap())
        .unwrap()
        .contains("secret-value"));
    let mut renamed = profile();
    renamed.name = "Renamed".into();
    let saved = db
        .save_winrm_profile(Some(saved.id), renamed.clone(), None, &crypto)
        .unwrap();
    assert!(saved.has_password);
    assert_eq!(
        &**db
            .winrm_credentials(saved.id, &config(), None, &crypto)
            .unwrap()
            .1,
        "secret-value"
    );
    renamed.config.host = "different.example.com".into();
    assert!(
        !db.save_winrm_profile(Some(saved.id), renamed.clone(), None, &crypto)
            .unwrap()
            .has_password
    );
    assert!(db
        .winrm_credentials(saved.id, &renamed.config, None, &crypto)
        .is_err());
    db.save_winrm_profile(
        Some(saved.id),
        renamed.clone(),
        Some(Zeroizing::new("new-secret".into())),
        &crypto,
    )
    .unwrap();
    assert!(
        !db.save_winrm_profile(
            Some(saved.id),
            renamed,
            Some(Zeroizing::new(String::new())),
            &crypto
        )
        .unwrap()
        .has_password
    );
    assert!(!db.has_encrypted_credentials().unwrap());
    db.delete_winrm_profile(saved.id).unwrap();
    assert!(db.list_winrm_profiles().unwrap().is_empty());
}

#[test]
fn edited_profiles_cannot_reconnect_from_a_tab_showing_an_old_destination() {
    let db = Database::new_in_memory().unwrap();
    let crypto = CryptoManager::new_random();
    let saved = db
        .save_winrm_profile(
            None,
            profile(),
            Some(Zeroizing::new("old-secret".into())),
            &crypto,
        )
        .unwrap();
    let displayed = saved.data.config.clone();
    let mut changed = profile();
    changed.config.host = "new.example.com".into();
    db.save_winrm_profile(
        Some(saved.id),
        changed.clone(),
        Some(Zeroizing::new("new-secret".into())),
        &crypto,
    )
    .unwrap();
    // The mismatch is rejected before keychain access, including one-time passwords.
    for password in [None, Some(Zeroizing::new("one-time-secret".into()))] {
        let error = db
            .winrm_credentials(saved.id, &displayed, password, &CryptoManager::new())
            .unwrap_err();
        assert!(error.contains("Close this tab"), "{error}");
    }
    let (actual, secret) = db
        .winrm_credentials(saved.id, &changed.config, None, &crypto)
        .unwrap();
    assert_eq!(actual, changed.config);
    assert_eq!(&**secret, "new-secret");
}

#[test]
fn winrm_only_credentials_require_the_existing_key_and_backup_drops_password_and_trust() {
    let db = Database::new_in_memory().unwrap();
    let crypto = CryptoManager::new_random();
    let mut p = profile();
    p.config.certificate_pin = "ab".repeat(32);
    db.save_winrm_profile(
        None,
        p,
        Some(Zeroizing::new("secret-value".into())),
        &crypto,
    )
    .unwrap();
    assert!(db.has_encrypted_credentials().unwrap());
    let backup = db.export_data(&crypto).unwrap();
    assert!(backup.winrm_profiles[0].config.certificate_pin.is_empty());
    assert!(!serde_json::to_string(&backup)
        .unwrap()
        .contains("secret-value"));
    let other = Database::new_in_memory().unwrap();
    assert_eq!(other.import_data(backup, &crypto).unwrap(), 1);
    let list = other.list_winrm_profiles().unwrap();
    assert_eq!(list[0].data.config, config());
    assert!(!list[0].has_password);
    assert_eq!(
        other
            .import_data(db.export_data(&crypto).unwrap(), &crypto)
            .unwrap(),
        0
    );
    // A malformed entry must not partly import other records.
    let mut backup = db.export_data(&crypto).unwrap();
    backup.winrm_profiles[0].config.port = 0;
    assert!(other.import_data(backup, &crypto).is_err());
    assert_eq!(other.list_winrm_profiles().unwrap().len(), 1);
}

#[test]
fn listing_without_keychain_and_failed_unlock_do_not_mutate_profiles() {
    let db = Database::new_in_memory().unwrap();
    let locked = CryptoManager::new();
    let saved = db
        .save_winrm_profile(None, profile(), None, &locked)
        .unwrap();
    assert_eq!(db.list_winrm_profiles().unwrap().len(), 1);
    let error = db
        .save_winrm_profile(
            Some(saved.id),
            profile(),
            Some(Zeroizing::new("secret".into())),
            &locked,
        )
        .err()
        .unwrap();
    assert_eq!(error, "KEYCHAIN_CONSENT_REQUIRED");
    assert!(!db.list_winrm_profiles().unwrap()[0].has_password);
}

#[tokio::test]
async fn closed_sessions_and_invalid_scripts_fail_without_network() {
    let manager = WinrmManager::default();
    assert!(manager.run("missing", "Get-Process").await.is_err());
    assert!(manager.run("missing", " ").await.is_err());
    assert!(manager
        .run("missing", &"a".repeat(16 * 1024 + 1))
        .await
        .is_err());
    manager.close("missing").await;
    manager.cancel("missing").await;
    let mut bad = config();
    bad.transport = Transport::Http;
    bad.authentication = Authentication::Basic;
    assert!(manager
        .connect(
            uuid::Uuid::new_v4().to_string(),
            bad,
            Zeroizing::new("secret".into())
        )
        .await
        .is_err());
    assert!(manager.sessions.lock().await.is_empty());
}

mod wire;
