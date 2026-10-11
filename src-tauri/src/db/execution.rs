use crate::db::Database;
use crate::execution::{ExecutionJob, ExecutionStatus, ExecutionSummary};

impl Database {
    pub(crate) fn save_execution_job(&self, job: &ExecutionJob) -> Result<(), String> {
        let record = serde_json::to_string(job).map_err(|e| e.to_string())?;
        let summary = serde_json::to_string(&job.summary).map_err(|e| e.to_string())?;
        let status = serde_json::to_value(job.summary.status).map_err(|e| e.to_string())?;
        self.conn().execute(
            "INSERT INTO execution_jobs(id,profile_id,created_at,status,record,summary)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(id) DO UPDATE SET status=excluded.status,record=excluded.record,summary=excluded.summary",
            rusqlite::params![job.summary.id, job.summary.profile_id, job.summary.started_at,
                status.as_str(), record, summary],
        ).map_err(|e| format!("Failed to save execution job: {e}"))?;
        Ok(())
    }

    pub(crate) fn get_execution_job(&self, id: &str) -> Result<ExecutionJob, String> {
        let record: String = self
            .conn()
            .query_row(
                "SELECT record FROM execution_jobs WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Execution job not found or unreadable: {e}"))?;
        serde_json::from_str(&record).map_err(|e| format!("Invalid execution job record: {e}"))
    }

    pub(crate) fn list_execution_jobs(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<ExecutionSummary>, String> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT summary FROM execution_jobs ORDER BY created_at DESC,id DESC LIMIT ?1 OFFSET ?2",
        ).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([limit, offset], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
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
