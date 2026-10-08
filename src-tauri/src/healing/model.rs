//! Core domain types for Self-Healing.
//!
//! Security-relevant decisions are made on these strong types, never on
//! free-form strings. In particular `HealingAction` is a closed enum: anything
//! an AI provider returns that does not deserialize into one of its variants
//! cannot be executed.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// Unix epoch milliseconds.
pub type Millis = i64;

// ── Status / severity / risk ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IncidentStatus {
    Detected,
    Analyzing,
    ProposalReady,
    PendingApproval,
    Approved,
    Executing,
    Verifying,
    Healed,
    Failed,
    Rejected,
    Expired,
    Stale,
    RollbackProposed,
    RolledBack,
    ManualInterventionRequired,
}

impl IncidentStatus {
    pub const ALL: [IncidentStatus; 15] = [
        IncidentStatus::Detected,
        IncidentStatus::Analyzing,
        IncidentStatus::ProposalReady,
        IncidentStatus::PendingApproval,
        IncidentStatus::Approved,
        IncidentStatus::Executing,
        IncidentStatus::Verifying,
        IncidentStatus::Healed,
        IncidentStatus::Failed,
        IncidentStatus::Rejected,
        IncidentStatus::Expired,
        IncidentStatus::Stale,
        IncidentStatus::RollbackProposed,
        IncidentStatus::RolledBack,
        IncidentStatus::ManualInterventionRequired,
    ];

    /// Incident no longer needs attention.
    pub fn is_closed(self) -> bool {
        matches!(
            self,
            IncidentStatus::Healed | IncidentStatus::RolledBack | IncidentStatus::Rejected
        )
    }
}

impl fmt::Display for IncidentStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = serde_json::to_value(self)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        f.write_str(&s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Severity {
    Info,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

// ── Cluster binding ───────────────────────────────────────────────────────────

/// The exact cluster an incident/proposal belongs to. Captured at detection
/// time and never derived from the UI's currently selected context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterBinding {
    /// kubeconfig context name
    pub context: String,
    /// kubeconfig cluster entry name
    pub cluster_name: String,
    /// API server URL — the identity check that survives context renames
    pub server: String,
}

// ── Resources ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRef {
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub uid: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WorkloadKind {
    Deployment,
    StatefulSet,
    DaemonSet,
}

impl WorkloadKind {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkloadKind::Deployment => "Deployment",
            WorkloadKind::StatefulSet => "StatefulSet",
            WorkloadKind::DaemonSet => "DaemonSet",
        }
    }

    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "Deployment" => Some(WorkloadKind::Deployment),
            "StatefulSet" => Some(WorkloadKind::StatefulSet),
            "DaemonSet" => Some(WorkloadKind::DaemonSet),
            _ => None,
        }
    }
}

// ── Healing actions (closed allow-list) ───────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ActionType {
    RestartPod,
    RolloutRestart,
    RollbackDeployment,
    ScaleDeployment,
    ScaleStatefulset,
}

/// Every mutation Self-Healing can perform. Anything not representable here
/// cannot be executed. `deny_unknown_fields` makes extra AI-supplied fields
/// (e.g. a `command` string) a hard parse error rather than silently ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum HealingAction {
    /// Delete a controller-owned pod so its controller recreates it.
    RestartPod { namespace: String, pod: String },
    /// `kubectl rollout restart`
    RolloutRestart {
        namespace: String,
        kind: WorkloadKind,
        name: String,
    },
    /// `kubectl rollout undo --to-revision`
    RollbackDeployment {
        namespace: String,
        name: String,
        to_revision: u32,
    },
    ScaleDeployment {
        namespace: String,
        name: String,
        replicas: u32,
    },
    #[serde(rename = "SCALE_STATEFULSET")]
    ScaleStatefulSet {
        namespace: String,
        name: String,
        replicas: u32,
    },
}

impl HealingAction {
    pub fn action_type(&self) -> ActionType {
        match self {
            HealingAction::RestartPod { .. } => ActionType::RestartPod,
            HealingAction::RolloutRestart { .. } => ActionType::RolloutRestart,
            HealingAction::RollbackDeployment { .. } => ActionType::RollbackDeployment,
            HealingAction::ScaleDeployment { .. } => ActionType::ScaleDeployment,
            HealingAction::ScaleStatefulSet { .. } => ActionType::ScaleStatefulset,
        }
    }

    /// Minimum risk for the action. A proposal can never be rated lower.
    pub fn base_risk(&self) -> RiskLevel {
        match self {
            HealingAction::RestartPod { .. } => RiskLevel::Low,
            HealingAction::RolloutRestart { .. } => RiskLevel::Medium,
            HealingAction::RollbackDeployment { .. }
            | HealingAction::ScaleDeployment { .. }
            | HealingAction::ScaleStatefulSet { .. } => RiskLevel::High,
        }
    }

    pub fn namespace(&self) -> &str {
        match self {
            HealingAction::RestartPod { namespace, .. }
            | HealingAction::RolloutRestart { namespace, .. }
            | HealingAction::RollbackDeployment { namespace, .. }
            | HealingAction::ScaleDeployment { namespace, .. }
            | HealingAction::ScaleStatefulSet { namespace, .. } => namespace,
        }
    }

    /// (kind, name) of the object the action mutates.
    pub fn target(&self) -> (&'static str, &str) {
        match self {
            HealingAction::RestartPod { pod, .. } => ("Pod", pod),
            HealingAction::RolloutRestart { kind, name, .. } => (kind.as_str(), name),
            HealingAction::RollbackDeployment { name, .. }
            | HealingAction::ScaleDeployment { name, .. } => ("Deployment", name),
            HealingAction::ScaleStatefulSet { name, .. } => ("StatefulSet", name),
        }
    }

    pub fn target_display(&self) -> String {
        let (kind, name) = self.target();
        format!("{}/{}", kind, name)
    }

    /// Human readable description shown in the approval UI and audit log.
    pub fn describe(&self) -> String {
        match self {
            HealingAction::RestartPod { namespace, pod } => {
                format!(
                    "Delete pod {}/{} so its controller recreates it",
                    namespace, pod
                )
            }
            HealingAction::RolloutRestart {
                namespace,
                kind,
                name,
            } => {
                format!(
                    "Rollout restart {}/{} in {}",
                    kind.as_str(),
                    name,
                    namespace
                )
            }
            HealingAction::RollbackDeployment {
                namespace,
                name,
                to_revision,
            } => format!(
                "Roll back Deployment/{} in {} to revision {}",
                name, namespace, to_revision
            ),
            HealingAction::ScaleDeployment {
                namespace,
                name,
                replicas,
            } => {
                format!(
                    "Scale Deployment/{} in {} to {} replicas",
                    name, namespace, replicas
                )
            }
            HealingAction::ScaleStatefulSet {
                namespace,
                name,
                replicas,
            } => {
                format!(
                    "Scale StatefulSet/{} in {} to {} replicas",
                    name, namespace, replicas
                )
            }
        }
    }
}

// ── Observed state ────────────────────────────────────────────────────────────

/// The parts of a resource that, if changed, invalidate a proposal.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceFingerprint {
    pub uid: String,
    pub generation: Option<i64>,
    /// Extra comparable fields (replicas, revision, controller owner, ...).
    pub observed: BTreeMap<String, String>,
}

impl ResourceFingerprint {
    /// Human readable list of differences, empty when identical.
    pub fn diff(&self, other: &ResourceFingerprint) -> Vec<String> {
        let mut out = Vec::new();
        if self.uid != other.uid {
            out.push("resource was recreated (uid changed)".to_string());
        }
        if self.generation != other.generation {
            out.push(format!(
                "generation changed {:?} → {:?}",
                self.generation, other.generation
            ));
        }
        let keys: std::collections::BTreeSet<&String> =
            self.observed.keys().chain(other.observed.keys()).collect();
        for k in keys {
            let a = self.observed.get(k);
            let b = other.observed.get(k);
            if a != b {
                out.push(format!("{} changed {:?} → {:?}", k, a, b));
            }
        }
        out
    }
}

/// Pre/post change snapshot. Only non-secret, structural fields.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub replicas: Option<i64>,
    pub revision: Option<u32>,
    pub generation: Option<i64>,
    pub images: Vec<String>,
    pub ready: Option<String>,
}

/// What the verifier watches after execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationTarget {
    pub kind: WorkloadKind,
    pub namespace: String,
    pub name: String,
    /// Expected replica count after the action, when the action sets one.
    pub expected_replicas: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthObservation {
    pub healthy: bool,
    pub detail: String,
}

// ── Operator identity ─────────────────────────────────────────────────────────

/// Who acted. The desktop app has no authentication system; identity is the
/// local OS account plus, when available, the Kubernetes user the context
/// authenticates as. This is recorded honestly as an unauthenticated operator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorIdentity {
    pub kind: String,
    pub os_user: String,
    pub kubernetes_user: Option<String>,
}

impl OperatorIdentity {
    pub fn local(os_user: impl Into<String>, kubernetes_user: Option<String>) -> Self {
        Self {
            kind: "local-operator".to_string(),
            os_user: os_user.into(),
            kubernetes_user,
        }
    }
}

// ── Diagnosis / proposals ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProposalKind {
    Remediation,
    Rollback,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProposalSource {
    Ai {
        provider: String,
        model: Option<String>,
    },
    RollbackOfExecution {
        execution_id: String,
    },
}

/// Input for creating a proposal. Untrusted until validated by the service.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDraft {
    pub kind: ProposalKind,
    pub action: HealingAction,
    pub declared_risk: RiskLevel,
    pub rationale: String,
    pub evidence: Vec<String>,
    pub expected_impact: String,
    pub verification_steps: Vec<String>,
    pub rollback_plan: String,
    pub confidence: Option<f64>,
    pub source: ProposalSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealingProposal {
    pub id: String,
    pub incident_id: String,
    pub kind: ProposalKind,
    pub binding: ClusterBinding,
    pub action: HealingAction,
    pub risk: RiskLevel,
    pub rationale: String,
    pub evidence: Vec<String>,
    pub expected_impact: String,
    pub verification_steps: Vec<String>,
    pub rollback_plan: String,
    pub confidence: Option<f64>,
    pub source: ProposalSource,
    /// Resource state when the proposal was created (pre-flight compares it).
    pub baseline: ResourceFingerprint,
    pub current_state: StateSnapshot,
    pub proposed_state: StateSnapshot,
    pub verification_target: VerificationTarget,
    /// Set when the target appears to be owned by a GitOps controller.
    pub gitops_owner: Option<String>,
    /// Policy verdict at creation time; `Some` means it cannot be approved.
    pub blocked_reason: Option<String>,
    pub created_at: Millis,
    pub expires_at: Millis,
    /// SHA-256 over every other field. Approval binds to this value.
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub proposal_id: String,
    pub proposal_hash: String,
    pub operator: OperatorIdentity,
    pub approved_at: Millis,
    pub high_risk_confirmed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejection {
    pub proposal_id: String,
    pub operator: OperatorIdentity,
    pub rejected_at: Millis,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionRecord {
    pub id: String,
    pub proposal_id: String,
    pub proposal_hash: String,
    pub operator: OperatorIdentity,
    pub action: HealingAction,
    /// The argv run, for the audit trail (never contains secret values).
    pub command: Vec<String>,
    pub started_at: Millis,
    pub finished_at: Option<Millis>,
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
    pub pre_state: Option<StateSnapshot>,
    pub post_state: Option<StateSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VerificationOutcome {
    Healthy,
    Unhealthy,
    TimedOut,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRecord {
    pub execution_id: String,
    pub started_at: Millis,
    pub finished_at: Millis,
    pub outcome: VerificationOutcome,
    pub checks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusChange {
    pub from: Option<IncidentStatus>,
    pub to: IncidentStatus,
    pub at: Millis,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Symptom {
    pub code: String,
    pub resource: ResourceRef,
    pub message: String,
    pub first_seen: Millis,
    pub last_seen: Millis,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Incident {
    pub id: String,
    /// Correlation key — same underlying problem ⇒ same key.
    pub key: String,
    pub binding: ClusterBinding,
    pub severity: Severity,
    pub status: IncidentStatus,
    pub resource: ResourceRef,
    pub problem: String,
    pub symptoms: Vec<Symptom>,
    pub affected: Vec<ResourceRef>,
    pub restart_count: Option<u32>,
    pub first_detected: Millis,
    pub last_detected: Millis,
    pub gitops_owner: Option<String>,
    /// Structured AI diagnosis, kept as validated JSON.
    pub diagnosis: Option<serde_json::Value>,
    pub diagnosis_error: Option<String>,
    pub proposals: Vec<HealingProposal>,
    pub active_proposal_id: Option<String>,
    pub approvals: Vec<Approval>,
    pub rejections: Vec<Rejection>,
    pub executions: Vec<ExecutionRecord>,
    pub verifications: Vec<VerificationRecord>,
    pub history: Vec<StatusChange>,
    pub last_error: Option<String>,
}

impl Incident {
    pub fn active_proposal(&self) -> Option<&HealingProposal> {
        let id = self.active_proposal_id.as_ref()?;
        self.proposals.iter().find(|p| &p.id == id)
    }

    pub fn proposal(&self, id: &str) -> Option<&HealingProposal> {
        self.proposals.iter().find(|p| p.id == id)
    }
}
