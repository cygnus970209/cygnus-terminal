use super::*;
use crate::crypto::CryptoManager;
fn data() -> ProfileData {
    ProfileData {
        name: "IIS 데스크톱".into(),
        config: ConnectConfig {
            host: "SERVER.test".into(),
            port: 3389,
            username: "user".into(),
            domain: "COMPANY".into(),
            width: 1280,
            height: 720,
        },
    }
}
fn pin(value: &str) -> String {
    [value; 32].join(":")
}
#[test]
fn saves_updates_and_deletes_only_rdp_metadata() {
    let db = Database::new_in_memory().unwrap();
    let saved = db.save_rdp_profile(None, data()).unwrap();
    let mut updated = data();
    updated.name = "renamed".into();
    updated.config.port = 3390;
    let updated = db.save_rdp_profile(Some(saved.id), updated).unwrap();
    assert_eq!(updated.id, saved.id);
    let all = db.list_rdp_profiles().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].config.port, 3390);
    let json = serde_json::to_string(&all).unwrap();
    assert!(!json.contains("password"));
    assert!(!json.contains("fingerprint"));
    assert!(db.list_profile_summaries().unwrap().is_empty());
    db.delete_rdp_profile(saved.id).unwrap();
    assert!(db.list_rdp_profiles().unwrap().is_empty());
    assert!(db.save_rdp_profile(Some(saved.id), data()).is_err());
}
#[test]
fn profile_schema_rejects_credentials_and_invalid_data() {
    let mut json = serde_json::to_value(data()).unwrap();
    json["config"]["password"] = "private-secret".into();
    assert!(serde_json::from_value::<ProfileData>(json).is_err());
    let db = Database::new_in_memory().unwrap();
    let mut bad = data();
    bad.config.width = 65535;
    assert!(db.save_rdp_profile(None, bad).is_err());
    let mut bad = data();
    bad.name = "\n".into();
    assert!(db.save_rdp_profile(None, bad).is_err());
    assert!(db.list_rdp_profiles().unwrap().is_empty());
}
#[test]
fn trust_is_opt_in_endpoint_scoped_and_changed_pin_requires_approval() {
    let db = Database::new_in_memory().unwrap();
    let endpoint = Endpoint::new(&data().config).unwrap();
    let a = pin("AB");
    let b = pin("CD");
    db.approve_rdp_certificate(&endpoint, &a, None, false, false)
        .unwrap();
    assert!(db.rdp_certificate(&endpoint).unwrap().is_none());
    db.approve_rdp_certificate(&endpoint, &a, None, true, false)
        .unwrap();
    let mut lower = data().config;
    lower.host = "server.test".into();
    assert_eq!(
        db.rdp_certificate(&Endpoint::new(&lower).unwrap()).unwrap(),
        Some(a.clone())
    );
    lower.port = 3390;
    assert!(db
        .rdp_certificate(&Endpoint::new(&lower).unwrap())
        .unwrap()
        .is_none());
    assert!(db
        .approve_rdp_certificate(&endpoint, &b, Some(&a), true, false)
        .is_err());
    // Trust-once permits the verified change but does not replace the saved pin.
    db.approve_rdp_certificate(&endpoint, &b, Some(&a), false, true)
        .unwrap();
    assert_eq!(db.rdp_certificate(&endpoint).unwrap(), Some(a.clone()));
    db.approve_rdp_certificate(&endpoint, &b, Some(&a), true, true)
        .unwrap();
    assert_eq!(db.rdp_certificate(&endpoint).unwrap(), Some(b.clone()));
    assert!(db
        .approve_rdp_certificate(&endpoint, &a, Some(&a), false, true)
        .is_err());
    assert!(db.forget_rdp_certificate(&endpoint, &a).is_err());
    db.forget_rdp_certificate(&endpoint, &b).unwrap();
    assert!(db.rdp_certificate(&endpoint).unwrap().is_none());
}
#[test]
fn simultaneous_first_use_cannot_overwrite_the_other_sessions_approval() {
    let db = Database::new_in_memory().unwrap();
    let endpoint = Endpoint::new(&data().config).unwrap();
    db.approve_rdp_certificate(&endpoint, &pin("AB"), None, true, false)
        .unwrap();
    assert!(db
        .approve_rdp_certificate(&endpoint, &pin("CD"), None, true, true)
        .is_err());
    assert!(db
        .approve_rdp_certificate(&endpoint, "bad", Some(&pin("AB")), true, true)
        .is_err());
    assert_eq!(db.rdp_certificate(&endpoint).unwrap(), Some(pin("AB")));
}
#[test]
fn backup_roundtrip_never_imports_trust_and_bad_rdp_data_aborts_everything() {
    let db = Database::new_in_memory().unwrap();
    let crypto = CryptoManager::new_random();
    db.save_rdp_profile(None, data()).unwrap();
    let endpoint = Endpoint::new(&data().config).unwrap();
    db.approve_rdp_certificate(&endpoint, &pin("AB"), None, true, false)
        .unwrap();
    let backup = db.export_data(&crypto).unwrap();
    assert_eq!(backup.version, 4);
    let json = serde_json::to_value(&backup).unwrap();
    assert!(!json.to_string().contains("fingerprint"));
    assert!(!json.to_string().contains("password"));
    let target = Database::new_in_memory().unwrap();
    assert_eq!(
        target
            .import_data(serde_json::from_value(json.clone()).unwrap(), &crypto)
            .unwrap(),
        1
    );
    assert_eq!(
        target
            .import_data(serde_json::from_value(json.clone()).unwrap(), &crypto)
            .unwrap(),
        0
    );
    assert!(target.rdp_certificate(&endpoint).unwrap().is_none());
    assert_eq!(
        target.list_rdp_profiles().unwrap()[0].config.domain,
        "COMPANY"
    );
    let mut invalid = json;
    invalid["rdp_profiles"][0]["config"]["port"] = 0.into();
    invalid["profiles"] = serde_json::json!([{"name":"ssh","host":"host.test","port":22,"username":"u","auth_type":"password","group_name":""}]);
    let empty = Database::new_in_memory().unwrap();
    assert!(empty
        .import_data(serde_json::from_value(invalid).unwrap(), &crypto)
        .is_err());
    assert!(empty.list_profile_summaries().unwrap().is_empty());
}
#[test]
fn file_database_reopens_profiles_and_pins() {
    let dir = std::env::temp_dir().join(format!("cygnus-rdp-test-{}", uuid::Uuid::new_v4()));
    let endpoint = Endpoint::new(&data().config).unwrap();
    {
        let db = Database::new(dir.clone()).unwrap();
        db.save_rdp_profile(None, data()).unwrap();
        db.approve_rdp_certificate(&endpoint, &pin("AB"), None, true, false)
            .unwrap();
    }
    let db = Database::new(dir.clone()).unwrap();
    assert_eq!(db.list_rdp_profiles().unwrap().len(), 1);
    assert_eq!(db.rdp_certificate(&endpoint).unwrap(), Some(pin("AB")));
    drop(db);
    std::fs::remove_dir_all(dir).unwrap();
}
