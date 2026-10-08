use super::model::IncidentStatus;
use thiserror::Error;

/// Every refusal is explicit and actionable. None of these paths mutate the
/// cluster.
#[derive(Debug, Error, PartialEq)]
pub enum HealingError {
    #[error("Incident {0} not found.")]
    IncidentNotFound(String),
    #[error("Proposal {0} not found for this incident.")]
    ProposalNotFound(String),
    #[error("Proposal {0} is no longer the active proposal. Review the current proposal.")]
    ProposalNotActive(String),
    #[error("Invalid state transition {from} → {to}.")]
    InvalidTransition {
        from: IncidentStatus,
        to: IncidentStatus,
    },
    #[error("Incident is {actual}; expected {expected}.")]
    WrongStatus {
        expected: IncidentStatus,
        actual: IncidentStatus,
    },
    #[error("Approval is missing.")]
    ApprovalMissing,
    #[error("Approved proposal hash does not match execution request.")]
    HashMismatch,
    #[error("Proposal integrity check failed: stored proposal was modified after creation.")]
    IntegrityFailure,
    #[error("Proposal has expired. Re-run diagnosis.")]
    Expired,
    #[error("Proposal is stale because {0} changed after diagnosis. Re-run diagnosis and approve again.")]
    Stale(String),
    #[error("Proposal has already been executed.")]
    AlreadyExecuted,
    #[error("Target cluster does not match approved cluster: {0}")]
    ClusterMismatch(String),
    #[error("High-risk action requires explicit confirmation.")]
    HighRiskConfirmationRequired,
    #[error("Resource is protected: {0}")]
    Protected(String),
    #[error("Action is not allowed by self-healing policy: {0}")]
    PolicyViolation(String),
    #[error("Manual intervention required: {0}")]
    ManualInterventionRequired(String),
    #[error("Proposed resource does not exist or cannot be read: {0}")]
    TargetNotFound(String),
    #[error("Proposed action does not target a resource involved in this incident: {0}")]
    UnrelatedTarget(String),
    #[error("Rollback is not available: {0}")]
    RollbackUnavailable(String),
    #[error("AI diagnosis is unavailable: {0}")]
    AiUnavailable(String),
    #[error("AI proposed an unsupported remediation: {0}")]
    UnsupportedAiAction(String),
    #[error("Invalid request: {0}")]
    InvalidInput(String),
    #[error("Kubernetes error: {0}")]
    Cluster(String),
    #[error("Storage error: {0}")]
    Storage(String),
}

impl From<HealingError> for String {
    fn from(e: HealingError) -> Self {
        e.to_string()
    }
}

pub type HealingResult<T> = Result<T, HealingError>;
