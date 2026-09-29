//! Termius 10.1.0 local connection metadata. No Termius process, network,
//! password export, private-key export, or writes to the source store.
mod profiles;
mod snapshot;

use super::Candidate;
use base64::{engine::general_purpose::STANDARD, Engine};
use chromium_storage_indexeddb_core::{RecordValue, V8Value};
use crypto_secretbox::{
    aead::{Aead, KeyInit},
    Nonce, XSalsa20Poly1305,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

type Tables = BTreeMap<String, Vec<Value>>;
const TABLES: &[&str] = &[
    "hosts",
    "groups",
    "ssh_configs",
    "ssh_identities",
    "host_chains",
    "ssh_config_identities",
    "ssh_config_identities_shared",
];

pub fn sources(home: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    let paths = [
        home.join("Library/Application Support/Termius"),
        home.join("Library/Containers/com.termius.mac/Data/Library/Application Support/Termius"),
    ];
    #[cfg(not(target_os = "macos"))]
    let paths: [PathBuf; 0] = {
        let _ = home;
        []
    };
    paths.into_iter().filter(|p| locate(p).is_ok()).collect()
}

fn encrypted_fields(table: &str) -> &'static [&'static str] {
    match table {
        "hosts" => &["label", "address"],
        "groups" => &["label"],
        "ssh_identities" => &["username"],
        "ssh_configs" => &["env_variables", "mosh_server_command"],
        _ => &[],
    }
}

fn decrypt(value: &str, cipher: &XSalsa20Poly1305) -> Result<String, String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "Unsupported Termius encryption format")?;
    if bytes.len() < 42 || bytes[..2] != [4, 1] {
        return Err(
            "Unsupported Termius encryption version; expected the 10.1.0 local format".into(),
        );
    }
    let plain = Zeroizing::new(
        cipher
            .decrypt(Nonce::from_slice(&bytes[2..26]), &bytes[26..])
            .map_err(|_| "Cannot decrypt Termius data with this Mac's local key")?,
    );
    String::from_utf8(plain.to_vec())
        .map_err(|_| "Invalid UTF-8 in Termius connection settings".into())
}

#[cfg(target_os = "macos")]
fn local_cipher(tables: &Tables, path: &Path) -> Result<Option<XSalsa20Poly1305>, String> {
    let sample = tables
        .iter()
        .flat_map(|(name, rows)| {
            rows.iter().flat_map(move |row| {
                encrypted_fields(name)
                    .iter()
                    .filter_map(move |field| row[*field].as_str().filter(|s| !s.is_empty()))
            })
        })
        .next();
    let Some(sample) = sample else {
        return Ok(None);
    };
    let mas = path.to_string_lossy().contains("/Containers/");
    let services = if mas {
        ["Termius (MAS)", "Termius"]
    } else {
        ["Termius", "Termius (MAS)"]
    };
    for service in services {
        let entry =
            keyring::Entry::new(service, "localKey").map_err(|_| "Cannot access macOS Keychain")?;
        let password = match entry.get_password() {
            Ok(v) => Zeroizing::new(v),
            Err(keyring::Error::NoEntry) => continue,
            Err(_) => return Err("Termius Keychain access was denied or is unavailable. Allow access to Termius/localKey and preview again.".into()),
        };
        let key = Zeroizing::new(
            STANDARD
                .decode(password.trim())
                .map_err(|_| "Invalid Termius local key")?,
        );
        let cipher = XSalsa20Poly1305::new_from_slice(&key)
            .map_err(|_| "Invalid Termius local key length")?;
        if decrypt(sample, &cipher).is_ok() {
            return Ok(Some(cipher));
        }
    }
    Err("No matching Termius local key found in macOS Keychain. Open Termius once on this Mac, then preview again.".into())
}

pub fn read_profiles(path: &Path) -> Result<Vec<Candidate>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("Direct Termius import currently supports macOS only".into())
    }
    #[cfg(target_os = "macos")]
    {
        let mut tables = read_tables(path)?;
        if tables.get("hosts").is_none_or(Vec::is_empty) {
            return Ok(vec![]);
        }
        let cipher = local_cipher(&tables, path)?;
        for (name, rows) in &mut tables {
            for row in rows {
                for field in encrypted_fields(name) {
                    if let Some(text) = row[*field].as_str() {
                        let text = if text.is_empty() {
                            String::new()
                        } else {
                            decrypt(text, cipher.as_ref().ok_or("Missing Termius local key")?)?
                        };
                        row[*field] = text.into();
                    }
                }
            }
        }
        profiles::convert(&tables)
    }
}

pub fn locate(path: &Path) -> Result<PathBuf, String> {
    [
        path.to_path_buf(),
        path.join("file__0.indexeddb.leveldb"),
        path.join("IndexedDB/file__0.indexeddb.leveldb"),
    ]
    .into_iter()
    .find(|p| p.join("CURRENT").is_file())
    .ok_or_else(|| {
        "Choose the Termius data folder containing IndexedDB/file__0.indexeddb.leveldb".into()
    })
}

fn json(value: V8Value) -> Result<Value, String> {
    Ok(match value {
        V8Value::Null | V8Value::Undefined | V8Value::Hole => Value::Null,
        V8Value::Bool(v) => v.into(),
        V8Value::Int(v) => v.into(),
        V8Value::Double(v) if v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0 => {
            Value::from(v as i64)
        }
        V8Value::Double(v) | V8Value::Date(v) => serde_json::Number::from_f64(v)
            .ok_or("Invalid Termius number")?
            .into(),
        V8Value::String(v) => v.into(),
        V8Value::Array(v) => Value::Array(v.into_iter().map(json).collect::<Result<_, _>>()?),
        V8Value::Object(v) => Value::Object(
            v.into_iter()
                .map(|(k, v)| Ok((k, json(v)?)))
                .collect::<Result<_, String>>()?,
        ),
        _ => return Err("Unsupported Termius data value".into()),
    })
}

fn read_tables(path: &Path) -> Result<Tables, String> {
    let raw = snapshot::read_current(&locate(path)?)?;
    let mut tables = Tables::new();
    for record in chromium_storage_indexeddb_core::decode_records(&raw) {
        let Some(name) = record.database.filter(|n| TABLES.contains(&n.as_str())) else {
            continue;
        };
        let RecordValue::V8(value) = record.value else {
            return Err(format!(
                "Cannot decode Termius {name}. This storage format is not supported."
            ));
        };
        let mut value = json(value)?;
        if !value.is_object() {
            return Err("Unsupported Termius record structure".into());
        }
        if matches!(value["status"].as_str(), Some("DELETED" | "DELETE_FAILED")) {
            continue;
        }
        // Keep a presence bit for identity inheritance, never decrypt credentials
        // or the redundant content blob (which can contain passwords).
        let object = value.as_object_mut().ok_or("Invalid Termius row")?;
        let has_password = object.get("password").is_some_and(|p| {
            p.as_str().is_some_and(|s| {
                // Secretbox overhead is 42 bytes; an authenticated empty password
                // has no payload. Only use the length, never decrypt the password.
                !s.is_empty() && STANDARD.decode(s).map_or(true, |b| b.len() > 42)
            })
        });
        object.remove("password");
        object.remove("content");
        object.insert("has_password".into(), has_password.into());
        tables.entry(name).or_default().push(value);
    }
    Ok(tables)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numeric_reference_encodings_are_equivalent() {
        assert_eq!(
            json(V8Value::Double(123.0)).unwrap(),
            json(V8Value::Int(123)).unwrap()
        );
        assert_eq!(json(V8Value::Double(1.5)).unwrap(), serde_json::json!(1.5));
    }
    #[test]
    fn authenticated_fields_support_empty_and_unicode_and_reject_corruption() {
        let cipher = XSalsa20Poly1305::new_from_slice(&[7; 32]).unwrap();
        for text in ["", "운영 서버", "deploy"] {
            let mut envelope = vec![4, 1];
            envelope.extend([3; 24]);
            envelope.extend(
                cipher
                    .encrypt(Nonce::from_slice(&[3; 24]), text.as_bytes())
                    .unwrap(),
            );
            assert_eq!(decrypt(&STANDARD.encode(&envelope), &cipher).unwrap(), text);
            envelope[30] ^= 1;
            assert!(decrypt(&STANDARD.encode(&envelope), &cipher).is_err());
            envelope[0] = 5;
            assert!(decrypt(&STANDARD.encode(&envelope), &cipher).is_err());
        }
        assert!(decrypt("plain host", &cipher).is_err());
    }

    #[test]
    #[ignore = "Reads local Termius and requests Keychain access; never writes connections"]
    fn preview_local_termius() {
        let path = dirs::home_dir()
            .unwrap()
            .join("Library/Application Support/Termius");
        let rows = read_profiles(&path).unwrap();
        assert!(!rows.is_empty());
        assert!(rows.iter().any(|c| !c.blocked));
        println!(
            "Termius preview: {} connections, {} available, {} with username",
            rows.len(),
            rows.iter().filter(|c| !c.blocked).count(),
            rows.iter()
                .filter(|c| !c.profile.username.is_empty())
                .count()
        );
        let warnings: std::collections::BTreeSet<_> =
            rows.iter().flat_map(|c| c.warnings.iter()).collect();
        println!("Warning categories: {warnings:?}");
        assert!(rows.iter().all(|c| c.blocked || !c.profile.host.is_empty()));
    }
    #[test]
    #[ignore = "Reads local Termius structure only; run explicitly on a test machine"]
    fn inspect_local_termius_schema() {
        let path = dirs::home_dir()
            .unwrap()
            .join("Library/Application Support/Termius");
        let tables = read_tables(&path).unwrap();
        let rows = profiles::convert(&tables).unwrap();
        println!("Connection reference resolution: {} rows, {} available (encrypted fields not displayed)", rows.len(), rows.iter().filter(|c| !c.blocked).count());
        assert!(rows.iter().any(|c| !c.blocked));
        for (name, rows) in tables {
            let fields: std::collections::BTreeSet<_> = rows
                .iter()
                .flat_map(|r| r.as_object().unwrap().keys())
                .collect();
            println!("{name}: {} records; field names: {fields:?}", rows.len());
            let mut shapes = BTreeMap::<String, std::collections::BTreeSet<String>>::new();
            for row in &rows {
                for (k, v) in row.as_object().unwrap() {
                    let shape = match v {
                        Value::Object(o) => {
                            format!("object keys: {:?}", o.keys().collect::<Vec<_>>())
                        }
                        Value::Array(_) => "array".into(),
                        Value::String(s) => if s.starts_with("BAE") {
                            "encrypted string"
                        } else {
                            "string"
                        }
                        .into(),
                        Value::Null => "null".into(),
                        Value::Number(_) => "number".into(),
                        Value::Bool(_) => "bool".into(),
                    };
                    shapes.entry(k.clone()).or_default().insert(shape);
                }
            }
            println!("shapes: {shapes:?}");
        }
    }
}
