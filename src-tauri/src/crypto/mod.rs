use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

const KEYRING_SERVICE: &str = "com.intocns.cygnus-terminal";
const KEYRING_USER: &str = "master-key";
const KEY_SIZE: usize = 32;

pub struct CryptoManager {
    master_key: [u8; KEY_SIZE],
}

impl CryptoManager {
    /// OS Keychain에서 마스터 키를 로드하거나, 없으면 새로 생성하여 저장.
    pub fn new() -> Result<Self, String> {
        let master_key = Self::load_or_create_master_key()?;
        Ok(Self { master_key })
    }

    /// 평문 → 암호화된 base64 문자열 (nonce + ciphertext)
    pub fn encrypt(&self, plaintext: &str) -> Result<String, String> {
        let cipher = Aes256Gcm::new_from_slice(&self.master_key)
            .map_err(|e| format!("Failed to create cipher: {e}"))?;

        let nonce_bytes: [u8; 12] = rand::random();
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| format!("Encryption failed: {e}"))?;

        // nonce(12) + ciphertext 를 합쳐서 base64 인코딩
        let mut combined = Vec::with_capacity(12 + ciphertext.len());
        combined.extend_from_slice(&nonce_bytes);
        combined.extend_from_slice(&ciphertext);

        Ok(BASE64.encode(&combined))
    }

    /// 암호화된 base64 문자열 → 복호화된 평문
    pub fn decrypt(&self, encrypted_b64: &str) -> Result<String, String> {
        let combined = BASE64
            .decode(encrypted_b64)
            .map_err(|e| format!("Base64 decode failed: {e}"))?;

        if combined.len() < 12 {
            return Err("Invalid encrypted data: too short".into());
        }

        let (nonce_bytes, ciphertext) = combined.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);

        let cipher = Aes256Gcm::new_from_slice(&self.master_key)
            .map_err(|e| format!("Failed to create cipher: {e}"))?;

        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| "Decryption failed: invalid key or corrupted data".to_string())?;

        String::from_utf8(plaintext).map_err(|e| format!("Decrypted data is not valid UTF-8: {e}"))
    }

    #[doc(hidden)]
    pub fn new_random() -> Self {
        let key: [u8; KEY_SIZE] = rand::random();
        Self { master_key: key }
    }

    fn load_or_create_master_key() -> Result<[u8; KEY_SIZE], String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| format!("Keyring init failed: {e}"))?;

        // 기존 키 로드 시도
        match entry.get_password() {
            Ok(stored) => {
                let key_bytes = BASE64
                    .decode(&stored)
                    .map_err(|e| format!("Failed to decode master key: {e}"))?;
                let key: [u8; KEY_SIZE] = key_bytes
                    .try_into()
                    .map_err(|_| "Stored master key has invalid length".to_string())?;
                Ok(key)
            }
            Err(keyring::Error::NoEntry) => {
                // 새 마스터 키 생성
                let key: [u8; KEY_SIZE] = rand::random();
                let encoded = BASE64.encode(&key);
                entry
                    .set_password(&encoded)
                    .map_err(|e| format!("Failed to store master key in keychain: {e}"))?;
                Ok(key)
            }
            Err(e) => Err(format!("Keychain access failed: {e}")),
        }
    }
}
