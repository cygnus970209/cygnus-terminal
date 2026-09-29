use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::sync::Mutex;
use zeroize::Zeroizing;

const KEYRING_SERVICE: &str = crate::app_identity::APP_ID;
const LEGACY_KEYRING_SERVICE: &str = crate::app_identity::LEGACY_APP_ID;
const KEYRING_USER: &str = "master-key";
const KEY_SIZE: usize = 32;

/// Load the OS key only after explicit UI authorization for a secret operation. Cached key material
/// is zeroized on drop; failed/denied keychain access is not cached and can be retried.
pub struct CryptoManager {
    master_key: Mutex<Option<Zeroizing<[u8; KEY_SIZE]>>>,
    key_loader: Box<dyn Fn() -> Result<[u8; KEY_SIZE], String> + Send + Sync>,
}

impl CryptoManager {
    pub fn new() -> Self {
        Self::with_existing_credentials(false)
    }

    pub fn with_existing_credentials(requires_existing_key: bool) -> Self {
        Self {
            master_key: Mutex::new(None),
            key_loader: Box::new(move || Self::load_or_create_master_key(requires_existing_key)),
        }
    }

    /// Called only after the UI has explained the OS credential-store prompt.
    pub fn authorize_keychain_access(&self) -> Result<(), String> {
        let mut key = self
            .master_key
            .lock()
            .map_err(|_| "Crypto key lock unavailable")?;
        if key.is_none() {
            *key = Some(Zeroizing::new((self.key_loader)()?));
        }
        Ok(())
    }

    fn cipher(&self) -> Result<Aes256Gcm, String> {
        let key = self
            .master_key
            .lock()
            .map_err(|_| "Crypto key lock unavailable")?;
        let key = key.as_ref().ok_or("KEYCHAIN_CONSENT_REQUIRED")?;
        Aes256Gcm::new_from_slice(key.as_ref()).map_err(|e| format!("Failed to create cipher: {e}"))
    }

    /// 평문 → 암호화된 base64 문자열 (nonce + ciphertext)
    pub fn encrypt(&self, plaintext: &str) -> Result<String, String> {
        let cipher = self.cipher()?;

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

        let cipher = self.cipher()?;

        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| "Decryption failed: invalid key or corrupted data".to_string())?;

        String::from_utf8(plaintext).map_err(|e| format!("Decrypted data is not valid UTF-8: {e}"))
    }

    #[doc(hidden)]
    pub fn new_random() -> Self {
        let key: [u8; KEY_SIZE] = rand::random();
        Self {
            master_key: Mutex::new(Some(Zeroizing::new(key))),
            key_loader: Box::new(|| Self::load_or_create_master_key(false)),
        }
    }

    fn load_or_create_master_key(requires_existing_key: bool) -> Result<[u8; KEY_SIZE], String> {
        load_or_migrate_key(
            requires_existing_key,
            |service| {
                let entry = keyring::Entry::new(service, KEYRING_USER)
                    .map_err(|e| format!("Keyring init failed: {e}"))?;
                match entry.get_password() {
                    Ok(value) => Ok(Some(Zeroizing::new(value))),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    Err(e) => Err(format!("Keychain access failed: {e}")),
                }
            },
            |service, value| {
                keyring::Entry::new(service, KEYRING_USER)
                    .map_err(|e| format!("Keyring init failed: {e}"))?
                    .set_password(value)
                    .map_err(|e| format!("Failed to store master key in keychain: {e}"))
            },
        )
    }
}

fn decode_master_key(stored: &str) -> Result<[u8; KEY_SIZE], String> {
    let decoded = Zeroizing::new(
        BASE64
            .decode(stored)
            .map_err(|e| format!("Failed to decode master key: {e}"))?,
    );
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| "Stored master key has invalid length".into())
}

/// Preserve the exact existing key. Never regenerate on denial, malformed values,
/// failed migration writes, or when encrypted credentials exist but keys are missing.
fn load_or_migrate_key(
    requires_existing_key: bool,
    mut read: impl FnMut(&str) -> Result<Option<Zeroizing<String>>, String>,
    mut write: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<[u8; KEY_SIZE], String> {
    if let Some(stored) = read(KEYRING_SERVICE)? {
        return decode_master_key(&stored);
    }
    if let Some(legacy) = read(LEGACY_KEYRING_SERVICE)? {
        let key = Zeroizing::new(decode_master_key(&legacy)?);
        write(KEYRING_SERVICE, &legacy)?;
        // Keep the legacy entry intact for older installed versions and rollback.
        return Ok(*key);
    }
    if requires_existing_key {
        return Err("Encrypted credentials exist, but the original master key was not found. Restore the original keychain item; no replacement key was created.".into());
    }
    let key = Zeroizing::new(rand::random::<[u8; KEY_SIZE]>());
    let encoded = Zeroizing::new(BASE64.encode(key.as_ref()));
    write(KEYRING_SERVICE, &encoded)?;
    Ok(*key)
}

impl Default for CryptoManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn counted_loader(calls: Arc<AtomicUsize>, deny_first: bool) -> CryptoManager {
        CryptoManager {
            master_key: Mutex::new(None),
            key_loader: Box::new(move || {
                let attempt = calls.fetch_add(1, Ordering::SeqCst);
                if deny_first && attempt == 0 {
                    Err("Keychain access denied".into())
                } else {
                    Ok([42; KEY_SIZE])
                }
            }),
        }
    }
    #[test]
    fn keychain_is_lazy_cached_and_retryable_after_denial() {
        let calls = Arc::new(AtomicUsize::new(0));
        let crypto = counted_loader(calls.clone(), true);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            crypto.encrypt("secret").unwrap_err(),
            "KEYCHAIN_CONSENT_REQUIRED"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(crypto.authorize_keychain_access().is_err());
        crypto.authorize_keychain_access().unwrap();
        let encrypted = crypto.encrypt("secret").unwrap();
        assert_eq!(crypto.decrypt(&encrypted).unwrap(), "secret");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn simultaneous_first_use_loads_one_key() {
        let calls = Arc::new(AtomicUsize::new(0));
        let crypto = Arc::new(counted_loader(calls.clone(), false));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let crypto = crypto.clone();
                std::thread::spawn(move || {
                    crypto.authorize_keychain_access().unwrap();
                    let encrypted = crypto.encrypt("secret").unwrap();
                    assert_eq!(crypto.decrypt(&encrypted).unwrap(), "secret");
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn startup_lists_and_backup_do_not_load_key_even_with_stored_secrets() {
        let db = crate::db::Database::new_in_memory().unwrap();
        let seeded = CryptoManager::new_random();
        let profile = db.create_profile(serde_json::from_value(serde_json::json!({
            "name":"server", "host":"example.org", "port":22, "username":"admin",
            "auth_type":"password", "password":"secret", "jump_host":"{\"host\":\"jump.example\",\"password\":\"jump-secret\"}"
        })).unwrap(), &seeded).unwrap();
        db.create_vault_item(serde_json::from_value(serde_json::json!({"label":"secret", "kind":"password", "value":"vault-secret", "source":"cygnus"})).unwrap(), &seeded).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let crypto = counted_loader(calls.clone(), true);
        let list = db.list_profile_summaries().unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].password.is_none());
        assert!(list[0].jump_host.is_none());
        assert_eq!(db.list_vault_items().unwrap().len(), 1);
        let export = db.export_data(&crypto).unwrap();
        db.import_data(export, &crypto).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            db.get_profile(profile.id, &crypto).unwrap_err(),
            "KEYCHAIN_CONSENT_REQUIRED"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};
    #[test]
    fn legacy_key_migrates_exactly_and_old_vault_ciphertext_still_decrypts() {
        let seed = CryptoManager::new_random();
        let encrypted = seed.encrypt("existing-vault-value").unwrap();
        let key = **seed.master_key.lock().unwrap().as_ref().unwrap();
        let store = RefCell::new(HashMap::from([(
            LEGACY_KEYRING_SERVICE.to_string(),
            BASE64.encode(key),
        )]));
        let migrated = load_or_migrate_key(
            true,
            |s| Ok(store.borrow().get(s).cloned().map(Zeroizing::new)),
            |s, v| {
                store.borrow_mut().insert(s.into(), v.into());
                Ok(())
            },
        )
        .unwrap();
        let crypto = CryptoManager {
            master_key: Mutex::new(Some(Zeroizing::new(migrated))),
            key_loader: Box::new(|| panic!("No keychain load expected")),
        };
        assert_eq!(crypto.decrypt(&encrypted).unwrap(), "existing-vault-value");
        assert_eq!(
            store.borrow().get(KEYRING_SERVICE),
            store.borrow().get(LEGACY_KEYRING_SERVICE)
        );
        let loaded = load_or_migrate_key(
            true,
            |s| {
                assert_eq!(s, KEYRING_SERVICE);
                Ok(store.borrow().get(s).cloned().map(Zeroizing::new))
            },
            |_, _| panic!("Existing new key must not be rewritten"),
        )
        .unwrap();
        assert_eq!(loaded, key);
    }
    #[test]
    fn missing_denied_or_corrupt_keys_never_create_replacements_for_existing_data() {
        assert!(
            load_or_migrate_key(true, |_| Ok(None), |_, _| panic!("Must not generate a key"))
                .is_err()
        );
        for denied_service in [KEYRING_SERVICE, LEGACY_KEYRING_SERVICE] {
            assert!(load_or_migrate_key(
                true,
                |service| {
                    if service == denied_service {
                        Err("Access denied".into())
                    } else {
                        Ok(None)
                    }
                },
                |_, _| panic!("Must not write after denial")
            )
            .is_err());
        }
        assert!(load_or_migrate_key(
            true,
            |_| Ok(Some(Zeroizing::new("corrupt".into()))),
            |_, _| panic!("Must not write corrupt key")
        )
        .is_err());
        assert!(load_or_migrate_key(
            true,
            |service| {
                Ok((service == LEGACY_KEYRING_SERVICE)
                    .then(|| Zeroizing::new(BASE64.encode([7; KEY_SIZE]))))
            },
            |_, _| Err("Write denied".into())
        )
        .is_err());
    }
    #[test]
    fn fresh_install_creates_only_the_new_service_after_both_lookups_are_empty() {
        let services = RefCell::new(Vec::new());
        let mut written = None;
        let key = load_or_migrate_key(
            false,
            |s| {
                services.borrow_mut().push(s.to_owned());
                Ok(None)
            },
            |s, value| {
                written = Some((s.to_owned(), value.to_owned()));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            *services.borrow(),
            vec![KEYRING_SERVICE, LEGACY_KEYRING_SERVICE]
        );
        let (service, encoded) = written.unwrap();
        assert_eq!(service, KEYRING_SERVICE);
        assert_eq!(decode_master_key(&encoded).unwrap(), key);
    }
}
