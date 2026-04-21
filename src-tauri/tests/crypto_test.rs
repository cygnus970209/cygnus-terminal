use cygnus_terminal_lib::crypto::CryptoManager;

#[test]
fn encrypt_decrypt_roundtrip() {
    let crypto = CryptoManager::new_random();
    let plaintext = "my-secret-password-123!@#";

    let encrypted = crypto.encrypt(plaintext).unwrap();
    assert_ne!(encrypted, plaintext);

    let decrypted = crypto.decrypt(&encrypted).unwrap();
    assert_eq!(decrypted, plaintext);
}

#[test]
fn encrypt_produces_different_ciphertext() {
    let crypto = CryptoManager::new_random();
    let plaintext = "same-input";

    let enc1 = crypto.encrypt(plaintext).unwrap();
    let enc2 = crypto.encrypt(plaintext).unwrap();

    // 랜덤 nonce 덕분에 매번 다른 결과
    assert_ne!(enc1, enc2);

    // 둘 다 복호화하면 같은 평문
    assert_eq!(crypto.decrypt(&enc1).unwrap(), plaintext);
    assert_eq!(crypto.decrypt(&enc2).unwrap(), plaintext);
}

#[test]
fn decrypt_with_wrong_key_fails() {
    let crypto1 = CryptoManager::new_random();
    let crypto2 = CryptoManager::new_random();

    let encrypted = crypto1.encrypt("secret").unwrap();
    let result = crypto2.decrypt(&encrypted);

    assert!(result.is_err());
}

#[test]
fn encrypt_empty_string() {
    let crypto = CryptoManager::new_random();

    let encrypted = crypto.encrypt("").unwrap();
    let decrypted = crypto.decrypt(&encrypted).unwrap();

    assert_eq!(decrypted, "");
}

#[test]
fn decrypt_invalid_base64_fails() {
    let crypto = CryptoManager::new_random();
    let result = crypto.decrypt("not-valid-base64!!!");

    assert!(result.is_err());
}

#[test]
fn decrypt_too_short_fails() {
    let crypto = CryptoManager::new_random();
    // nonce(12바이트)보다 짧은 데이터
    let result = crypto.decrypt("AQID"); // 3 bytes base64

    assert!(result.is_err());
}

#[test]
fn encrypt_unicode() {
    let crypto = CryptoManager::new_random();
    let plaintext = "비밀번호🔑パスワード";

    let encrypted = crypto.encrypt(plaintext).unwrap();
    let decrypted = crypto.decrypt(&encrypted).unwrap();

    assert_eq!(decrypted, plaintext);
}
