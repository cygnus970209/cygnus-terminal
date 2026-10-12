use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::ExecutionJob;

pub const MEMORY_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_MEMORY_JOBS: usize = 32;
const MAX_MEMORY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistorySettings {
    pub enabled: bool,
    pub retention_days: u32,
}

impl HistorySettings {
    pub fn validate(self) -> Result<(), String> {
        if !(1..=365).contains(&self.retention_days) {
            return Err("History retention must be between 1 and 365 days".into());
        }
        Ok(())
    }
}

/// Distinguish expired/deleted results from corrupt records and database errors.
#[derive(Debug)]
pub enum LookupError {
    NotFound,
    Storage(String),
}

impl std::fmt::Display for LookupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "Execution result is unavailable (expired, deleted, or unknown); do not automatically repeat the command"),
            Self::Storage(message) => f.write_str(message),
        }
    }
}

impl From<LookupError> for String {
    fn from(error: LookupError) -> Self {
        error.to_string()
    }
}

impl From<rusqlite::Error> for LookupError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::QueryReturnedNoRows => Self::NotFound,
            other => Self::Storage(format!("Cannot read execution history: {other}")),
        }
    }
}

pub(super) struct CachedJob {
    pub job: ExecutionJob,
    completed: Instant,
    bytes: usize,
}

#[derive(Default)]
pub(super) struct ResultCache {
    pub jobs: HashMap<String, CachedJob>,
}

impl ResultCache {
    pub fn insert(&mut self, job: ExecutionJob) {
        let bytes = job.stdout.len()
            + job.stderr.len()
            + serde_json::to_vec(&job.summary).map_or(0, |value| value.len());
        self.jobs.insert(
            job.summary.id.clone(),
            CachedJob {
                job,
                completed: Instant::now(),
                bytes,
            },
        );
        self.prune();
    }

    pub fn prune(&mut self) {
        self.jobs
            .retain(|_, entry| entry.completed.elapsed() < MEMORY_TTL);
        let mut bytes: usize = self.jobs.values().map(|entry| entry.bytes).sum();
        while self.jobs.len() > MAX_MEMORY_JOBS || bytes > MAX_MEMORY_BYTES {
            let Some(id) = self
                .jobs
                .iter()
                .min_by_key(|(_, entry)| entry.completed)
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            bytes -= self.jobs.remove(&id).expect("cached entry").bytes;
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub fn expire(cache: &mut ResultCache, id: &str) {
        cache.jobs.get_mut(id).unwrap().completed = Instant::now() - MEMORY_TTL;
    }
}
