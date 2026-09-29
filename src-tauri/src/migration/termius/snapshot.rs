//! Read committed LevelDB files without opening the database for writing.
//! Respect MANIFEST membership, sequence numbers and tombstones: forensic
//! readers alone can resurrect deleted hosts from obsolete SSTables.
use leveldb_core::Record;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::SystemTime,
};

const LIMIT: u64 = 64 * 1024 * 1024;
const BAD: &str = "Unsupported or damaged Termius database. Quit Termius and try again.";
type Stamp = BTreeMap<PathBuf, (u64, SystemTime)>;

fn stamp(dir: &Path) -> Result<Stamp, String> {
    let mut result = BTreeMap::new();
    for entry in fs::read_dir(dir).map_err(|_| "Cannot read Termius IndexedDB folder")? {
        let entry = entry.map_err(|_| BAD)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "CURRENT"
            || name.starts_with("MANIFEST-")
            || name.ends_with(".ldb")
            || name.ends_with(".sst")
            || name.ends_with(".log")
        {
            let m = fs::symlink_metadata(entry.path()).map_err(|_| BAD)?;
            if !m.is_file() {
                return Err(BAD.into());
            }
            result.insert(entry.path(), (m.len(), m.modified().map_err(|_| BAD)?));
        }
    }
    if result.len() > 4096 {
        return Err("Termius database has too many files".into());
    }
    Ok(result)
}

fn read(path: &Path, budget: &mut u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|_| BAD)?;
    let mut bytes = vec![];
    file.take(*budget + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| BAD)?;
    if bytes.len() as u64 > *budget {
        return Err("Termius database exceeds the 64 MB import limit".into());
    }
    *budget -= bytes.len() as u64;
    Ok(bytes)
}

struct Cursor<'a>(&'a [u8]);
impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let value = self.0.get(..n).ok_or(BAD)?;
        self.0 = &self.0[n..];
        Ok(value)
    }
    fn varint(&mut self) -> Result<u64, String> {
        let mut value = 0;
        for shift in (0..70).step_by(7) {
            let b = self.take(1)?[0];
            if shift == 63 && b > 1 {
                return Err(BAD.into());
            }
            value |= u64::from(b & 127) << shift;
            if b < 128 {
                return Ok(value);
            }
        }
        Err(BAD.into())
    }
    fn bytes(&mut self) -> Result<&'a [u8], String> {
        let n = usize::try_from(self.varint()?).map_err(|_| BAD)?;
        self.take(n)
    }
}

// Strict physical log reader used for both MANIFEST and WAL. Never silently
// accept a corrupt/truncated batch and fall back to an older host value.
fn log_records(bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let mut records = vec![];
    let mut fragments: Option<Vec<u8>> = None;
    for block in bytes.chunks(32768) {
        let mut pos = 0;
        while pos + 7 <= block.len() {
            let header = &block[pos..pos + 7];
            if header.iter().all(|b| *b == 0) {
                if block[pos..].iter().any(|b| *b != 0) {
                    return Err(BAD.into());
                }
                pos = block.len();
                break;
            }
            let len = u16::from_le_bytes([header[4], header[5]]) as usize;
            let data = block.get(pos + 7..pos + 7 + len).ok_or(BAD)?;
            let crc = crc32c::crc32c_append(crc32c::crc32c(&header[6..7]), data)
                .rotate_left(17)
                .wrapping_add(0xa282_ead8);
            if crc != u32::from_le_bytes(header[..4].try_into().map_err(|_| BAD)?) {
                return Err(BAD.into());
            }
            match header[6] {
                1 if fragments.is_none() => records.push(data.to_vec()),
                2 if fragments.is_none() => fragments = Some(data.to_vec()),
                3 => fragments.as_mut().ok_or(BAD)?.extend_from_slice(data),
                4 => {
                    let mut row = fragments.take().ok_or(BAD)?;
                    row.extend_from_slice(data);
                    records.push(row);
                }
                _ => return Err(BAD.into()),
            }
            pos += 7 + len;
        }
        if block[pos..].iter().any(|b| *b != 0) {
            return Err(BAD.into());
        }
    }
    if fragments.is_some() {
        return Err(BAD.into());
    }
    Ok(records)
}

#[derive(Default)]
struct Manifest {
    tables: BTreeSet<u64>,
    log: Option<u64>,
    previous_log: u64,
}
fn manifest(bytes: &[u8]) -> Result<Manifest, String> {
    let mut state = Manifest::default();
    for edit in log_records(bytes)? {
        let mut cur = Cursor(&edit);
        while !cur.0.is_empty() {
            match cur.varint()? {
                1 => {
                    if cur.bytes()? != b"idb_cmp1" {
                        return Err("Not a Chromium IndexedDB database".into());
                    }
                }
                2 => state.log = Some(cur.varint()?),
                3 | 4 => {
                    cur.varint()?;
                }
                5 => {
                    cur.varint()?;
                    cur.bytes()?;
                }
                6 => {
                    cur.varint()?;
                    state.tables.remove(&cur.varint()?);
                }
                7 => {
                    cur.varint()?;
                    let number = cur.varint()?;
                    cur.varint()?;
                    cur.bytes()?;
                    cur.bytes()?;
                    state.tables.insert(number);
                }
                9 => state.previous_log = cur.varint()?,
                _ => return Err(BAD.into()),
            }
        }
    }
    if state.log.is_none() {
        return Err(BAD.into());
    }
    Ok(state)
}

fn wal(bytes: &[u8], path: &Path) -> Result<Vec<Record>, String> {
    let mut result = vec![];
    for batch in log_records(bytes)? {
        let mut cur = Cursor(&batch);
        let sequence = u64::from_le_bytes(cur.take(8)?.try_into().map_err(|_| BAD)?);
        let count = u32::from_le_bytes(cur.take(4)?.try_into().map_err(|_| BAD)?);
        if count > 100_000 {
            return Err(BAD.into());
        }
        for i in 0..count {
            let kind = cur.take(1)?[0];
            if kind > 1 {
                return Err(BAD.into());
            }
            let key = cur.bytes()?.to_vec();
            let value = if kind == 1 {
                cur.bytes()?.to_vec()
            } else {
                vec![]
            };
            result.push(Record {
                key,
                value,
                seq: sequence.checked_add(u64::from(i)).ok_or(BAD)?,
                deleted: kind == 0,
                origin_file: path.into(),
            });
        }
        if !cur.0.is_empty() {
            return Err(BAD.into());
        }
    }
    Ok(result)
}

fn merge(latest: &mut BTreeMap<Vec<u8>, Record>, records: Vec<Record>) -> Result<(), String> {
    for record in records {
        if record.value.len() > 1024 * 1024 {
            return Err("Termius record exceeds the 1 MB import limit".into());
        }
        match latest.get(&record.key) {
            Some(old) if old.seq > record.seq => continue,
            Some(old)
                if old.seq == record.seq
                    && (old.deleted != record.deleted || old.value != record.value) =>
            {
                return Err(BAD.into())
            }
            _ => {
                latest.insert(record.key.clone(), record);
            }
        }
        if latest.len() > 100_000 {
            return Err("Termius database has too many records".into());
        }
    }
    Ok(())
}

pub(super) fn read_current(dir: &Path) -> Result<Vec<Record>, String> {
    let before = stamp(dir)?;
    let mut budget = LIMIT;
    let current = read(&dir.join("CURRENT"), &mut budget)?;
    let name = std::str::from_utf8(&current).map_err(|_| BAD)?.trim();
    if !name
        .strip_prefix("MANIFEST-")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(BAD.into());
    }
    let state = manifest(&read(&dir.join(name), &mut budget)?)?;
    // A missing live WAL can hide newer values or deletion tombstones while
    // the remaining SSTables still look valid. Never import that partial view.
    for number in [state.log.unwrap_or(0), state.previous_log] {
        if number != 0 && !before.contains_key(&dir.join(format!("{number:06}.log"))) {
            return Err(BAD.into());
        }
    }
    let mut latest = BTreeMap::new();
    for number in state.tables {
        let mut path = dir.join(format!("{number:06}.ldb"));
        if !before.contains_key(&path) {
            path = dir.join(format!("{number:06}.sst"));
        }
        if !before.contains_key(&path) {
            return Err(BAD.into());
        }
        let bytes = read(&path, &mut budget)?;
        let records = leveldb_core::parse_table_bytes(&bytes, &path).map_err(|_| BAD)?;
        merge(&mut latest, records)?;
    }
    for path in before
        .keys()
        .filter(|p| p.extension().is_some_and(|e| e == "log"))
    {
        let number = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or(BAD)?;
        if number >= state.log.unwrap_or(u64::MAX) || number == state.previous_log {
            merge(&mut latest, wal(&read(path, &mut budget)?, path)?)?;
        }
    }
    if before != stamp(dir)? {
        return Err("Termius data changed while reading. Quit Termius and preview again.".into());
    }
    Ok(latest.into_values().filter(|r| !r.deleted).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn physical(payload: &[u8], kind: u8) -> Vec<u8> {
        let crc = crc32c::crc32c_append(crc32c::crc32c(&[kind]), payload)
            .rotate_left(17)
            .wrapping_add(0xa282_ead8);
        let mut bytes = crc.to_le_bytes().to_vec();
        bytes.extend((payload.len() as u16).to_le_bytes());
        bytes.push(kind);
        bytes.extend(payload);
        bytes
    }
    #[test]
    fn manifest_and_wal_exclude_obsolete_files_and_deleted_records() {
        let dir =
            std::env::temp_dir().join(format!("cygnus-termius-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("CURRENT"), "MANIFEST-000001\n").unwrap();
        // Comparator, log number 3, add table 2, remove table 2.
        let mut edit = vec![1, 8];
        edit.extend(b"idb_cmp1");
        edit.extend([2, 3, 7, 0, 2, 0, 0, 0, 6, 0, 2]);
        fs::write(dir.join("MANIFEST-000001"), physical(&edit, 1)).unwrap();
        fs::write(dir.join("000002.ldb"), "obsolete and corrupt").unwrap();
        fs::write(dir.join("000001.log"), "obsolete and corrupt").unwrap();
        let mut batch = 1_u64.to_le_bytes().to_vec();
        batch.extend(3_u32.to_le_bytes());
        batch.extend([1, 1, b'a', 1, b'x', 0, 1, b'a', 1, 1, b'b', 1, b'y']);
        fs::write(dir.join("000003.log"), physical(&batch, 1)).unwrap();
        let before = stamp(&dir).unwrap();
        let rows = read_current(&dir).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, b"b");
        assert_eq!(rows[0].value, b"y");
        assert_eq!(before, stamp(&dir).unwrap());
        // Damaged active WAL must fail instead of reviving older values.
        let mut damaged = physical(&batch, 1);
        damaged[0] ^= 1;
        fs::write(dir.join("000003.log"), damaged).unwrap();
        assert!(read_current(&dir).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn fragmented_records_and_truncation() {
        let first = vec![8; 32761];
        let mut bytes = physical(&first, 2);
        bytes.extend(physical(&[9, 10], 4));
        let rows = log_records(&bytes).unwrap();
        assert_eq!(rows[0].len(), 32763);
        bytes.pop();
        assert!(log_records(&bytes).is_err());
    }
    #[test]
    fn deletion_wins_even_if_older_value_is_read_later() {
        let row = |seq, deleted| Record {
            key: vec![1],
            value: vec![],
            seq,
            deleted,
            origin_file: PathBuf::new(),
        };
        let mut latest = BTreeMap::new();
        merge(&mut latest, vec![row(3, true), row(2, false)]).unwrap();
        assert!(latest[&vec![1]].deleted);
    }
    #[test]
    fn damaged_logs_are_rejected() {
        assert!(log_records(&[1, 2, 3]).is_err());
        assert!(log_records(&[1, 0, 0, 0, 1, 0, 1, 42]).is_err());
    }
    #[test]
    fn missing_current_and_previous_wals_are_rejected() {
        let dir =
            std::env::temp_dir().join(format!("cygnus-termius-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("CURRENT"), "MANIFEST-000001\n").unwrap();
        // Current WAL 3 and previous WAL 2 are both live, even when empty.
        fs::write(dir.join("MANIFEST-000001"), physical(&[2, 3, 9, 2], 1)).unwrap();
        fs::write(dir.join("000003.log"), []).unwrap();
        assert!(read_current(&dir).is_err());
        fs::write(dir.join("000002.log"), []).unwrap();
        assert!(read_current(&dir).unwrap().is_empty());
        fs::remove_file(dir.join("000003.log")).unwrap();
        assert!(read_current(&dir).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
