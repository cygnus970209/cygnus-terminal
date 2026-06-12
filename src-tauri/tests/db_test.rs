use cygnus_terminal_lib::crypto::CryptoManager;
use cygnus_terminal_lib::db::Database;
use cygnus_terminal_lib::db::profile::CreateProfileRequest;

fn setup() -> (Database, CryptoManager) {
    let db = Database::new_in_memory().unwrap();
    let crypto = CryptoManager::new_random();
    (db, crypto)
}

// ── Migration ──

#[test]
fn migration_creates_tables() {
    let (db, _) = setup();
    let conn = db.conn();

    // 테이블 존재 확인
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();

    assert!(tables.contains(&"profiles".to_string()));
    assert!(tables.contains(&"command_history".to_string()));
    assert!(tables.contains(&"path_bookmarks".to_string()));
    assert!(tables.contains(&"known_hosts".to_string()));
    assert!(tables.contains(&"schema_version".to_string()));
}

#[test]
fn migration_version_recorded() {
    let (db, _) = setup();
    let conn = db.conn();

    let version: u32 = conn
        .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get(0)
        })
        .unwrap();

    assert_eq!(version, cygnus_terminal_lib::db::migration::latest_version());
}

#[test]
fn migration_is_idempotent() {
    let db = Database::new_in_memory().unwrap();
    // 두 번 실행해도 에러 없음
    assert!(db.run_migrations().is_ok());
}

// ── Profile CRUD ──

fn make_password_profile() -> CreateProfileRequest {
    CreateProfileRequest {
        name: "Test Server".to_string(),
        host: "192.168.1.100".to_string(),
        port: 22,
        username: "admin".to_string(),
        auth_type: "password".to_string(),
        password: Some("secret123".to_string()),
        key_path: None,
        group_name: Some("Production".to_string()),
        jump_host: None,
        agent_forward: None,
        environment: None,
    }
}

fn make_key_profile() -> CreateProfileRequest {
    CreateProfileRequest {
        name: "AWS EC2".to_string(),
        host: "ec2.example.com".to_string(),
        port: 2222,
        username: "ubuntu".to_string(),
        auth_type: "key".to_string(),
        password: None,
        key_path: Some("~/.ssh/id_rsa".to_string()),
        group_name: None,
        jump_host: None,
        agent_forward: None,
        environment: None,
    }
}

#[test]
fn create_and_get_profile_with_password() {
    let (db, crypto) = setup();

    let profile = db.create_profile(make_password_profile(), &crypto).unwrap();

    assert_eq!(profile.name, "Test Server");
    assert_eq!(profile.host, "192.168.1.100");
    assert_eq!(profile.port, 22);
    assert_eq!(profile.username, "admin");
    assert_eq!(profile.auth_type, "password");
    assert_eq!(profile.password, Some("secret123".to_string()));
    assert_eq!(profile.group_name, "Production");

    // get으로 다시 조회
    let fetched = db.get_profile(profile.id, &crypto).unwrap();
    assert_eq!(fetched.password, Some("secret123".to_string()));
}

#[test]
fn create_profile_with_key() {
    let (db, crypto) = setup();

    let profile = db.create_profile(make_key_profile(), &crypto).unwrap();

    assert_eq!(profile.auth_type, "key");
    assert_eq!(profile.key_path, Some("~/.ssh/id_rsa".to_string()));
    assert!(profile.password.is_none());
}

#[test]
fn list_profiles_excludes_password() {
    let (db, crypto) = setup();

    db.create_profile(make_password_profile(), &crypto).unwrap();
    db.create_profile(make_key_profile(), &crypto).unwrap();

    let profiles = db.list_profiles(&crypto).unwrap();
    assert_eq!(profiles.len(), 2);

    // 목록에서 비밀번호는 None
    for p in &profiles {
        assert!(p.password.is_none());
    }
}

#[test]
fn update_profile_partial() {
    let (db, crypto) = setup();

    let profile = db.create_profile(make_password_profile(), &crypto).unwrap();

    let updated = db
        .update_profile(
            profile.id,
            cygnus_terminal_lib::db::profile::UpdateProfileRequest {
                name: Some("Renamed Server".to_string()),
                host: None,
                port: Some(2222),
                username: None,
                auth_type: None,
                password: None,
                key_path: None,
                group_name: None,
                jump_host: None,
                agent_forward: None,
                environment: None,
            },
            &crypto,
        )
        .unwrap();

    assert_eq!(updated.name, "Renamed Server");
    assert_eq!(updated.port, 2222);
    // 변경하지 않은 필드는 유지
    assert_eq!(updated.host, "192.168.1.100");
    assert_eq!(updated.username, "admin");
}

#[test]
fn update_profile_password() {
    let (db, crypto) = setup();

    let profile = db.create_profile(make_password_profile(), &crypto).unwrap();
    assert_eq!(profile.password, Some("secret123".to_string()));

    let updated = db
        .update_profile(
            profile.id,
            cygnus_terminal_lib::db::profile::UpdateProfileRequest {
                name: None,
                host: None,
                port: None,
                username: None,
                auth_type: None,
                password: Some("new-password".to_string()),
                key_path: None,
                group_name: None,
                jump_host: None,
                agent_forward: None,
                environment: None,
            },
            &crypto,
        )
        .unwrap();

    assert_eq!(updated.password, Some("new-password".to_string()));
}

#[test]
fn delete_profile() {
    let (db, crypto) = setup();

    let profile = db.create_profile(make_password_profile(), &crypto).unwrap();
    assert!(db.delete_profile(profile.id).is_ok());

    // 삭제 후 조회 실패
    assert!(db.get_profile(profile.id, &crypto).is_err());
}

#[test]
fn delete_nonexistent_profile_fails() {
    let (db, _) = setup();
    assert!(db.delete_profile(9999).is_err());
}

#[test]
fn password_encrypted_in_db() {
    let (db, crypto) = setup();

    db.create_profile(make_password_profile(), &crypto).unwrap();

    // DB에 직접 쿼리해서 암호화된 값 확인
    let conn = db.conn();
    let stored: String = conn
        .query_row("SELECT password FROM profiles WHERE id = 1", [], |row| {
            row.get(0)
        })
        .unwrap();

    // 평문이 아닌 base64 암호화된 값
    assert_ne!(stored, "secret123");
    // 복호화하면 원본
    assert_eq!(crypto.decrypt(&stored).unwrap(), "secret123");
}

// ── Known Hosts ──

#[test]
fn unknown_host_returns_unknown() {
    let (db, _) = setup();

    let status = db
        .check_host_key("new-host.com", 22, "ssh-ed25519", b"key-data")
        .unwrap();

    assert!(matches!(
        status,
        cygnus_terminal_lib::db::known_host::HostKeyStatus::Unknown
    ));
}

#[test]
fn save_and_verify_host_key() {
    let (db, _) = setup();

    db.save_host_key("example.com", 22, "ssh-ed25519", b"key-data-123")
        .unwrap();

    let status = db
        .check_host_key("example.com", 22, "ssh-ed25519", b"key-data-123")
        .unwrap();

    assert!(matches!(
        status,
        cygnus_terminal_lib::db::known_host::HostKeyStatus::Trusted
    ));
}

#[test]
fn changed_host_key_detected() {
    let (db, _) = setup();

    db.save_host_key("example.com", 22, "ssh-ed25519", b"original-key")
        .unwrap();

    let status = db
        .check_host_key("example.com", 22, "ssh-rsa", b"different-key")
        .unwrap();

    assert!(matches!(
        status,
        cygnus_terminal_lib::db::known_host::HostKeyStatus::Changed { .. }
    ));
}

#[test]
fn different_ports_are_separate_hosts() {
    let (db, _) = setup();

    db.save_host_key("example.com", 22, "ssh-ed25519", b"key-22")
        .unwrap();

    // 다른 포트는 Unknown
    let status = db
        .check_host_key("example.com", 2222, "ssh-ed25519", b"key-22")
        .unwrap();

    assert!(matches!(
        status,
        cygnus_terminal_lib::db::known_host::HostKeyStatus::Unknown
    ));
}

#[test]
fn save_host_key_upsert() {
    let (db, _) = setup();

    db.save_host_key("example.com", 22, "ssh-ed25519", b"old-key")
        .unwrap();
    db.save_host_key("example.com", 22, "ssh-rsa", b"new-key")
        .unwrap();

    let status = db
        .check_host_key("example.com", 22, "ssh-rsa", b"new-key")
        .unwrap();

    assert!(matches!(
        status,
        cygnus_terminal_lib::db::known_host::HostKeyStatus::Trusted
    ));
}

// ── Jump host 암호화 ──

const JUMP_HOST_JSON: &str =
    r#"{"host":"bastion.example.com","port":22,"username":"jump","auth_type":"password","password":"jump-secret"}"#;

fn make_jump_host_profile() -> CreateProfileRequest {
    CreateProfileRequest {
        name: "Behind Bastion".to_string(),
        host: "10.0.0.5".to_string(),
        port: 22,
        username: "admin".to_string(),
        auth_type: "password".to_string(),
        password: Some("secret123".to_string()),
        key_path: None,
        group_name: None,
        jump_host: Some(JUMP_HOST_JSON.to_string()),
        agent_forward: None,
        environment: None,
    }
}

#[test]
fn jump_host_stored_encrypted_in_db() {
    let (db, crypto) = setup();
    let profile = db.create_profile(make_jump_host_profile(), &crypto).unwrap();

    let raw: String = db
        .conn()
        .query_row(
            "SELECT jump_host FROM profiles WHERE id = ?1",
            [profile.id],
            |row| row.get(0),
        )
        .unwrap();

    // DB 에는 평문 JSON 이 아닌 암호문(base64)이 저장되어야 한다.
    assert!(!raw.starts_with('{'));
    assert!(!raw.contains("jump-secret"));
}

#[test]
fn get_profile_decrypts_jump_host() {
    let (db, crypto) = setup();
    let profile = db.create_profile(make_jump_host_profile(), &crypto).unwrap();

    let fetched = db.get_profile(profile.id, &crypto).unwrap();
    assert_eq!(fetched.jump_host.as_deref(), Some(JUMP_HOST_JSON));
}

#[test]
fn list_profiles_strips_jump_host_password() {
    let (db, crypto) = setup();
    db.create_profile(make_jump_host_profile(), &crypto).unwrap();

    let profiles = db.list_profiles(&crypto).unwrap();
    let jh = profiles[0].jump_host.as_deref().unwrap();

    // 목록에서는 호스트 정보는 유지하되 비밀번호는 제거된다.
    assert!(jh.contains("bastion.example.com"));
    assert!(!jh.contains("jump-secret"));
}

#[test]
fn update_with_empty_jump_host_clears_it() {
    let (db, crypto) = setup();
    let profile = db.create_profile(make_jump_host_profile(), &crypto).unwrap();

    let updated = db
        .update_profile(
            profile.id,
            cygnus_terminal_lib::db::profile::UpdateProfileRequest {
                name: None,
                host: None,
                port: None,
                username: None,
                auth_type: None,
                password: None,
                key_path: None,
                group_name: None,
                jump_host: Some(String::new()),
                agent_forward: None,
                environment: None,
            },
            &crypto,
        )
        .unwrap();

    assert!(updated.jump_host.is_none());
}

#[test]
fn migrate_plaintext_jump_hosts_encrypts_legacy_rows() {
    let (db, crypto) = setup();
    let profile = db.create_profile(make_jump_host_profile(), &crypto).unwrap();

    // 레거시 상태 재현: 평문 JSON 을 직접 저장
    db.conn()
        .execute(
            "UPDATE profiles SET jump_host = ?1 WHERE id = ?2",
            rusqlite::params![JUMP_HOST_JSON, profile.id],
        )
        .unwrap();

    let migrated = db.migrate_plaintext_jump_hosts(&crypto).unwrap();
    assert_eq!(migrated, 1);

    // 마이그레이션 후 DB 값은 암호문, get 은 평문 복원
    let raw: String = db
        .conn()
        .query_row(
            "SELECT jump_host FROM profiles WHERE id = ?1",
            [profile.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!raw.starts_with('{'));
    assert_eq!(
        db.get_profile(profile.id, &crypto).unwrap().jump_host.as_deref(),
        Some(JUMP_HOST_JSON)
    );

    // 멱등성: 두 번째 실행은 아무것도 바꾸지 않는다
    assert_eq!(db.migrate_plaintext_jump_hosts(&crypto).unwrap(), 0);
}
