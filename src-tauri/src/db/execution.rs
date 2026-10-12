use crate::db::Database;
use crate::execution::history::{HistorySettings, LookupError};
use crate::execution::{ExecutionJob, ExecutionStatus, ExecutionSummary};

// Hide expired rows immediately, even between periodic cleanup passes.
const VISIBLE: &str = "(SELECT enabled FROM execution_history_settings WHERE id=1)=1
    AND (status IN ('connecting','running','cancelling') OR
    julianday(created_at) >= julianday('now') - (SELECT retention_days FROM execution_history_settings WHERE id=1))";

impl Database {
    pub(crate) fn save_execution_job(&self, job: &ExecutionJob) -> Result<bool, String> {
        let record = serde_json::to_string(job).map_err(|e| e.to_string())?;
        let summary = serde_json::to_string(&job.summary).map_err(|e| e.to_string())?;
        let status = serde_json::to_value(job.summary.status).map_err(|e| e.to_string())?;
        let saved = self.conn().execute(
            "INSERT INTO execution_jobs(id,profile_id,created_at,status,record,summary)
             SELECT ?1,?2,?3,?4,?5,?6 WHERE (SELECT enabled FROM execution_history_settings WHERE id=1)=1
             ON CONFLICT(id) DO UPDATE SET status=excluded.status,record=excluded.record,summary=excluded.summary",
            rusqlite::params![job.summary.id, job.summary.profile_id, job.summary.started_at,
                status.as_str(), record, summary],
        ).map_err(|e| format!("Failed to save execution job: {e}"))?;
        Ok(saved > 0)
    }

    pub(crate) fn get_execution_job(&self, id: &str) -> Result<ExecutionJob, LookupError> {
        let record: String = self.conn().query_row(
            &format!("SELECT record FROM execution_jobs WHERE id=?1 AND {VISIBLE}"),
            [id],
            |row| row.get(0),
        )?;
        serde_json::from_str(&record)
            .map_err(|e| LookupError::Storage(format!("Invalid execution job record: {e}")))
    }

    pub(crate) fn get_execution_summary(&self, id: &str) -> Result<ExecutionSummary, LookupError> {
        let summary: String = self.conn().query_row(
            &format!("SELECT summary FROM execution_jobs WHERE id=?1 AND {VISIBLE}"),
            [id],
            |row| row.get(0),
        )?;
        serde_json::from_str(&summary)
            .map_err(|e| LookupError::Storage(format!("Invalid execution summary: {e}")))
    }

    pub(crate) fn list_execution_jobs(
        &self,
        limit: u32,
        offset: u32,
        excluded_ids: &[String],
    ) -> Result<Vec<ExecutionSummary>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT summary FROM execution_jobs WHERE {VISIBLE}
            AND id NOT IN (SELECT value FROM json_each(?3))
            ORDER BY created_at DESC,id DESC LIMIT ?1 OFFSET ?2"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                rusqlite::params![
                    limit,
                    offset,
                    serde_json::to_string(excluded_ids).map_err(|e| e.to_string())?
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }

    pub fn execution_history_settings(&self) -> Result<HistorySettings, String> {
        self.conn()
            .query_row(
                "SELECT enabled,retention_days FROM execution_history_settings WHERE id=1",
                [],
                |row| {
                    Ok(HistorySettings {
                        enabled: row.get(0)?,
                        retention_days: row.get(1)?,
                    })
                },
            )
            .map_err(|e| format!("Cannot read history settings: {e}"))
    }

    pub(crate) fn set_execution_history_settings(
        &self,
        settings: HistorySettings,
    ) -> Result<(), String> {
        settings.validate()?;
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE execution_history_settings SET enabled=?1,retention_days=?2 WHERE id=1",
            rusqlite::params![settings.enabled, settings.retention_days],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            &format!("DELETE FROM execution_jobs WHERE NOT ({VISIBLE})"),
            [],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        checkpoint_history(&conn)
    }

    pub(crate) fn clear_execution_history(&self) -> Result<(), String> {
        let conn = self.conn();
        conn.execute("DELETE FROM execution_jobs", [])
            .map_err(|e| e.to_string())?;
        checkpoint_history(&conn)
    }

    pub(crate) fn prune_execution_history(&self) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            &format!("DELETE FROM execution_jobs WHERE NOT ({VISIBLE})"),
            [],
        )
        .map_err(|e| e.to_string())?;
        // Also retry a checkpoint that an external reader blocked on an earlier pass.
        checkpoint_history(&conn)
    }

    pub(crate) fn recover_execution_jobs(&self) -> Result<(), String> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let records: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT record FROM execution_jobs WHERE status IN ('connecting','running','cancelling')",
            ).map_err(|e| e.to_string())?;
            let records = stmt
                .query_map([], |row| row.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            records
        };
        for record in records {
            let mut job: ExecutionJob = serde_json::from_str(&record).map_err(|e| e.to_string())?;
            job.summary.status = ExecutionStatus::Interrupted;
            job.summary.finished_at = Some(chrono::Utc::now().to_rfc3339());
            job.summary.error = Some(
                "Application stopped before the job finished; command was not replayed".into(),
            );
            tx.execute(
                "UPDATE execution_jobs SET status='interrupted',record=?1,summary=?2 WHERE id=?3",
                rusqlite::params![
                    serde_json::to_string(&job).map_err(|e| e.to_string())?,
                    serde_json::to_string(&job.summary).map_err(|e| e.to_string())?,
                    job.summary.id
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
}

fn checkpoint_history(conn: &rusqlite::Connection) -> Result<(), String> {
    let busy: i32 = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .map_err(|e| format!("History updated, but database journal cleanup failed: {e}"))?;
    if busy != 0 {
        return Err("History updated, but database journal cleanup is blocked by another reader; cleanup will retry within a minute".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleting_history_clears_live_database_pages_and_wal() {
        let directory =
            std::env::temp_dir().join(format!("cygnus-history-{}", uuid::Uuid::new_v4()));
        let db = Database::new(directory.clone()).unwrap();
        let marker = "synthetic-history-secret-7c41c9";
        db.conn()
            .execute(
                "INSERT INTO execution_jobs VALUES('test',1,datetime('now'),'succeeded',?1,?1)",
                [marker.repeat(1000)],
            )
            .unwrap();
        db.conn()
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        let path = directory.join("cygnus.db");
        assert!(std::fs::read(&path)
            .unwrap()
            .windows(marker.len())
            .any(|bytes| bytes == marker.as_bytes()));
        db.clear_execution_history().unwrap();
        assert!(!std::fs::read(&path)
            .unwrap()
            .windows(marker.len())
            .any(|bytes| bytes == marker.as_bytes()));
        assert_eq!(
            std::fs::metadata(directory.join("cygnus.db-wal"))
                .unwrap()
                .len(),
            0
        );
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn blocked_wal_cleanup_is_reported_and_retried() {
        let directory =
            std::env::temp_dir().join(format!("cygnus-history-busy-{}", uuid::Uuid::new_v4()));
        let db = Database::new(directory.clone()).unwrap();
        db.conn().busy_timeout(std::time::Duration::ZERO).unwrap();
        db.conn().execute("INSERT INTO execution_jobs VALUES('test',1,datetime('now'),'succeeded','record','summary')", []).unwrap();
        let reader = rusqlite::Connection::open(directory.join("cygnus.db")).unwrap();
        reader
            .execute_batch("BEGIN; SELECT * FROM execution_jobs;")
            .unwrap();
        assert!(db
            .clear_execution_history()
            .unwrap_err()
            .contains("blocked by another reader"));
        assert_eq!(
            db.conn()
                .query_row("SELECT count(*) FROM execution_jobs", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            0
        );
        reader.execute_batch("ROLLBACK").unwrap();
        db.prune_execution_history().unwrap();
        assert_eq!(
            std::fs::metadata(directory.join("cygnus.db-wal"))
                .unwrap()
                .len(),
            0
        );
        drop(reader);
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
