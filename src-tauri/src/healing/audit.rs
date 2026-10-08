//! Append-only audit trail (`audit.jsonl`). Records contain identifiers,
//! actions and structural state only — never secret values or credentials.

use super::model::{HealingAction, Millis, OperatorIdentity};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuditEvent {
    IncidentDetected,
    AnalysisStarted,
    DiagnosisCompleted,
    DiagnosisFailed,
    ProposalCreated,
    ProposalBlocked,
    Approved,
    Rejected,
    ApprovalRefused,
    Expired,
    ExecutionRefused,
    ExecutionClaimed,
    PreflightFailed,
    Executed,
    ExecutionFailed,
    VerificationPassed,
    VerificationFailed,
    RollbackProposed,
    Interrupted,
    ChatExchange,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRecord {
    pub id: String,
    pub at: Millis,
    pub event: AuditEvent,
    pub incident_id: String,
    pub proposal_id: Option<String>,
    pub proposal_hash: Option<String>,
    pub context: String,
    pub namespace: Option<String>,
    pub resource: String,
    pub resource_uid: Option<String>,
    pub operator: Option<OperatorIdentity>,
    pub action: Option<HealingAction>,
    pub detail: String,
}

pub struct AuditLog {
    path: Option<PathBuf>,
    records: Mutex<Vec<AuditRecord>>,
}

impl AuditLog {
    pub fn in_memory() -> Self {
        Self {
            path: None,
            records: Mutex::new(Vec::new()),
        }
    }

    pub fn open(path: PathBuf) -> Self {
        let records = std::fs::read_to_string(&path)
            .map(|s| {
                s.lines()
                    .filter_map(|l| serde_json::from_str::<AuditRecord>(l).ok())
                    .collect()
            })
            .unwrap_or_default();
        Self {
            path: Some(path),
            records: Mutex::new(records),
        }
    }

    pub fn append(&self, record: AuditRecord) {
        log::info(&format!(
            "audit event={:?} incident={} proposal={:?} resource={} detail={}",
            record.event, record.incident_id, record.proposal_id, record.resource, record.detail
        ));
        if let Some(path) = &self.path {
            let line = serde_json::to_string(&record).unwrap_or_default();
            let res = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .and_then(|mut f| writeln!(f, "{}", line));
            if let Err(e) = res {
                log::info(&format!("audit write failed: {}", e));
            }
        }
        self.records.lock().unwrap().push(record);
    }

    pub fn for_incident(&self, incident_id: &str) -> Vec<AuditRecord> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.incident_id == incident_id)
            .cloned()
            .collect()
    }

    pub fn recent(&self, limit: usize) -> Vec<AuditRecord> {
        let recs = self.records.lock().unwrap();
        recs.iter().rev().take(limit).cloned().collect()
    }
}

/// Minimal structured logging to stderr (the app has no logging crate).
pub mod log {
    pub fn info(msg: &str) {
        eprintln!("[self-healing] {}", msg);
    }
}
