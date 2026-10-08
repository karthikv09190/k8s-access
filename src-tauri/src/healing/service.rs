//! Self-Healing orchestration: proposals, approval, execution, verification,
//! rollback proposals.
//!
//! THE ONLY MUTATION PATH:
//!   approve()            — operator approves a PENDING_APPROVAL proposal hash
//!   execute_approved()   — re-checks approval, hash, cluster, expiry, policy,
//!                          claims APPROVED→EXECUTING atomically, re-reads the
//!                          resource (pre-flight), then mints an
//!                          `ExecutionPermit` and calls `ClusterGateway::apply`.
//!
//! `ExecutionPermit` has private fields and a private constructor; this file
//! is the only place one can be created. Nothing else in the codebase can call
//! `ClusterGateway::apply`.

use super::audit::{log, AuditEvent, AuditLog, AuditRecord};
use super::error::{HealingError, HealingResult};
use super::gateway::ClusterGateway;
use super::model::*;
use super::policy::{is_valid_k8s_name, HealingPolicy};
use super::proposal;
use super::rollback::rollback_action;
use super::state_machine::can_transition;
use super::store::HealingStore;
use super::verifier::{self, VerifyConfig};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock, RwLock};

// ── Clock ─────────────────────────────────────────────────────────────────────

pub trait Clock: Send + Sync {
    fn now(&self) -> Millis;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Millis {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as Millis)
            .unwrap_or(0)
    }
}

// ── Execution permit ──────────────────────────────────────────────────────────

/// Proof that every pre-execution check passed for one exact approved action.
/// Not Clone, not Deserialize, no public constructor.
pub struct ExecutionPermit {
    binding: ClusterBinding,
    action: HealingAction,
}

impl ExecutionPermit {
    fn new(binding: ClusterBinding, action: HealingAction) -> Self {
        Self { binding, action }
    }
    pub fn binding(&self) -> &ClusterBinding {
        &self.binding
    }
    pub fn action(&self) -> &HealingAction {
        &self.action
    }
}

// ── Requests ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveRequest {
    pub incident_id: String,
    pub proposal_id: String,
    pub proposal_hash: String,
    /// Context the operator saw on the approval screen.
    pub context: String,
    pub high_risk_confirmed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectRequest {
    pub incident_id: String,
    pub proposal_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRequest {
    pub incident_id: String,
    pub proposal_id: String,
    pub proposal_hash: String,
    pub context: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealingStats {
    pub active: usize,
    pub pending_approval: usize,
    pub in_progress: usize,
    pub healed_today: usize,
    pub failed: usize,
    pub needs_attention: usize,
}

// ── Service ───────────────────────────────────────────────────────────────────

pub struct HealingService<G: ClusterGateway, C: Clock> {
    gateway: G,
    clock: C,
    store: Mutex<HealingStore>,
    policy: RwLock<HealingPolicy>,
    audit: AuditLog,
    verify_cfg: VerifyConfig,
    notifier: OnceLock<Box<dyn Fn(&AuditRecord) + Send + Sync>>,
}

fn transition(
    inc: &mut Incident,
    to: IncidentStatus,
    at: Millis,
    reason: &str,
) -> HealingResult<()> {
    let from = inc.status;
    if !can_transition(from, to) {
        return Err(HealingError::InvalidTransition { from, to });
    }
    inc.status = to;
    inc.history.push(StatusChange {
        from: Some(from),
        to,
        at,
        reason: reason.to_string(),
    });
    log::info(&format!(
        "incident={} {} → {} ({})",
        inc.id, from, to, reason
    ));
    Ok(())
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl<G: ClusterGateway, C: Clock> HealingService<G, C> {
    pub fn new(
        gateway: G,
        clock: C,
        store: HealingStore,
        policy: HealingPolicy,
        audit: AuditLog,
        verify_cfg: VerifyConfig,
    ) -> Self {
        Self {
            gateway,
            clock,
            store: Mutex::new(store),
            policy: RwLock::new(policy),
            audit,
            verify_cfg,
            notifier: OnceLock::new(),
        }
    }

    pub fn now(&self) -> Millis {
        self.clock.now()
    }

    pub fn policy(&self) -> HealingPolicy {
        self.policy.read().unwrap().clone()
    }

    pub fn set_policy(&self, policy: HealingPolicy) {
        *self.policy.write().unwrap() = policy;
    }

    fn record(
        &self,
        inc: &Incident,
        event: AuditEvent,
        proposal: Option<&HealingProposal>,
        operator: Option<&OperatorIdentity>,
        detail: impl Into<String>,
    ) {
        let record = AuditRecord {
            id: new_id(),
            at: self.clock.now(),
            event,
            incident_id: inc.id.clone(),
            proposal_id: proposal.map(|p| p.id.clone()),
            proposal_hash: proposal.map(|p| p.hash.clone()),
            context: inc.binding.context.clone(),
            namespace: inc.resource.namespace.clone(),
            resource: proposal
                .map(|p| p.action.target_display())
                .unwrap_or_else(|| format!("{}/{}", inc.resource.kind, inc.resource.name)),
            resource_uid: proposal
                .map(|p| p.baseline.uid.clone())
                .or_else(|| inc.resource.uid.clone()),
            operator: operator.cloned(),
            action: proposal.map(|p| p.action.clone()),
            detail: detail.into(),
        };
        // Notifications are derived from audit events, so they can only
        // describe things that actually happened.
        if let Some(notify) = self.notifier.get() {
            notify(&record);
        }
        self.audit.append(record);
    }

    /// Receives every audit record (used for the notification center).
    /// Observers cannot act on the cluster: they only get a copy of the record.
    pub fn set_notifier(&self, f: Box<dyn Fn(&AuditRecord) + Send + Sync>) {
        let _ = self.notifier.set(f);
    }

    /// Lock, mutate one incident, persist. Persist failures are reported.
    fn with_incident<T>(
        &self,
        id: &str,
        f: impl FnOnce(&mut Incident, Millis) -> HealingResult<T>,
    ) -> HealingResult<T> {
        let mut store = self.store.lock().unwrap();
        let now = self.clock.now();
        let inc = store
            .incidents
            .get_mut(id)
            .ok_or_else(|| HealingError::IncidentNotFound(id.to_string()))?;
        let result = f(inc, now);
        store.save()?;
        result
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    /// Marks proposals past their TTL as EXPIRED. Read path housekeeping; never
    /// touches the cluster.
    pub fn expire_due(&self) {
        let mut store = self.store.lock().unwrap();
        let now = self.clock.now();
        let mut changed = Vec::new();
        for inc in store.incidents.values_mut() {
            if !matches!(
                inc.status,
                IncidentStatus::PendingApproval | IncidentStatus::Approved
            ) {
                continue;
            }
            if inc.active_proposal().map_or(false, |p| now > p.expires_at)
                && transition(inc, IncidentStatus::Expired, now, "proposal TTL elapsed").is_ok()
            {
                changed.push(inc.clone());
            }
        }
        if !changed.is_empty() {
            let _ = store.save();
        }
        drop(store);
        for inc in changed {
            self.record(
                &inc,
                AuditEvent::Expired,
                inc.active_proposal(),
                None,
                "proposal expired",
            );
        }
    }

    pub fn incidents(&self) -> Vec<Incident> {
        self.expire_due();
        let store = self.store.lock().unwrap();
        let mut v: Vec<Incident> = store.incidents.values().cloned().collect();
        v.sort_by(|a, b| b.last_detected.cmp(&a.last_detected));
        v
    }

    pub fn incident(&self, id: &str) -> HealingResult<Incident> {
        self.expire_due();
        let store = self.store.lock().unwrap();
        store
            .incidents
            .get(id)
            .cloned()
            .ok_or_else(|| HealingError::IncidentNotFound(id.to_string()))
    }

    pub fn audit_for(&self, incident_id: &str) -> Vec<AuditRecord> {
        self.audit.for_incident(incident_id)
    }

    pub fn recent_audit(&self, limit: usize) -> Vec<AuditRecord> {
        self.audit.recent(limit)
    }

    pub fn stats(&self, context: Option<&str>) -> HealingStats {
        use IncidentStatus::*;
        let now = self.clock.now();
        let day_ms = 24 * 3600 * 1000;
        let mut s = HealingStats::default();
        for inc in self.incidents() {
            if context.map_or(false, |c| c != inc.binding.context) {
                continue;
            }
            if !inc.status.is_closed() {
                s.active += 1;
            }
            match inc.status {
                PendingApproval => s.pending_approval += 1,
                Approved | Executing | Verifying => s.in_progress += 1,
                Healed if inc.history.last().map_or(false, |h| now - h.at < day_ms) => {
                    s.healed_today += 1
                }
                Failed => s.failed += 1,
                _ => {}
            }
            if matches!(
                inc.status,
                Failed | Stale | Expired | ManualInterventionRequired | RollbackProposed
            ) {
                s.needs_attention += 1;
            }
        }
        s
    }

    // ── Incident lifecycle (no cluster mutation) ─────────────────────────────

    /// Insert or merge a detected incident (merging keeps workflow state).
    pub fn upsert_detected(&self, detected: Incident) -> (Incident, bool) {
        let mut store = self.store.lock().unwrap();
        let existing_id = store
            .incidents
            .values()
            .find(|i| i.key == detected.key && !i.status.is_closed())
            .map(|i| i.id.clone());
        let (inc, is_new) = match existing_id {
            Some(id) => {
                let inc = store.incidents.get_mut(&id).expect("exists");
                inc.last_detected = detected.last_detected;
                inc.symptoms = detected.symptoms;
                inc.affected = detected.affected;
                inc.restart_count = detected.restart_count;
                inc.severity = inc.severity.max(detected.severity);
                inc.problem = detected.problem;
                (inc.clone(), false)
            }
            None => {
                store
                    .incidents
                    .insert(detected.id.clone(), detected.clone());
                (detected, true)
            }
        };
        let _ = store.save();
        drop(store);
        if is_new {
            self.record(
                &inc,
                AuditEvent::IncidentDetected,
                None,
                None,
                inc.problem.clone(),
            );
        }
        (inc, is_new)
    }

    pub fn begin_analysis(&self, incident_id: &str) -> HealingResult<Incident> {
        let inc = self.with_incident(incident_id, |inc, now| {
            transition(inc, IncidentStatus::Analyzing, now, "analysis requested")?;
            inc.diagnosis_error = None;
            Ok(inc.clone())
        })?;
        self.record(&inc, AuditEvent::AnalysisStarted, None, None, "");
        Ok(inc)
    }

    /// AI unavailable / failed: back to DETECTED for manual remediation.
    pub fn analysis_failed(&self, incident_id: &str, error: &str) -> HealingResult<Incident> {
        let inc = self.with_incident(incident_id, |inc, now| {
            inc.diagnosis_error = Some(error.to_string());
            transition(inc, IncidentStatus::Detected, now, "diagnosis failed")?;
            Ok(inc.clone())
        })?;
        self.record(&inc, AuditEvent::DiagnosisFailed, None, None, error);
        Ok(inc)
    }

    pub fn set_diagnosis(
        &self,
        incident_id: &str,
        diagnosis: serde_json::Value,
        audit_detail: &str,
    ) -> HealingResult<()> {
        let inc = self.with_incident(incident_id, |inc, _| {
            if inc.status != IncidentStatus::Analyzing {
                return Err(HealingError::WrongStatus {
                    expected: IncidentStatus::Analyzing,
                    actual: inc.status,
                });
            }
            inc.diagnosis = Some(diagnosis);
            inc.diagnosis_error = None;
            Ok(inc.clone())
        })?;
        self.record(
            &inc,
            AuditEvent::DiagnosisCompleted,
            None,
            None,
            audit_detail,
        );
        Ok(())
    }

    /// Diagnosis produced no executable action.
    pub fn require_manual(&self, incident_id: &str, reason: &str) -> HealingResult<Incident> {
        let inc = self.with_incident(incident_id, |inc, now| {
            inc.last_error = Some(reason.to_string());
            transition(inc, IncidentStatus::ManualInterventionRequired, now, reason)?;
            Ok(inc.clone())
        })?;
        self.record(&inc, AuditEvent::ProposalBlocked, None, None, reason);
        Ok(inc)
    }

    // ── Proposal creation (untrusted input → sealed proposal) ────────────────

    pub async fn create_proposal(
        &self,
        incident_id: &str,
        draft: ProposalDraft,
    ) -> HealingResult<HealingProposal> {
        let inc = self.incident(incident_id)?;
        let expected = match draft.kind {
            ProposalKind::Remediation => IncidentStatus::Analyzing,
            ProposalKind::Rollback => IncidentStatus::RollbackProposed,
        };
        if inc.status != expected {
            return Err(HealingError::WrongStatus {
                expected,
                actual: inc.status,
            });
        }

        let action = &draft.action;
        let (kind, name) = action.target();
        if !is_valid_k8s_name(action.namespace()) || !is_valid_k8s_name(name) {
            return Err(HealingError::UnsupportedAiAction(format!(
                "invalid resource name {:?}/{:?}",
                action.namespace(),
                name
            )));
        }
        // The action must target something this incident is actually about.
        if draft.kind == ProposalKind::Remediation {
            let ns_ok = inc.resource.namespace.as_deref() == Some(action.namespace());
            let related = std::iter::once(&inc.resource)
                .chain(inc.affected.iter())
                .any(|r| r.kind == kind && r.name == name);
            if !ns_ok || !related {
                return Err(HealingError::UnrelatedTarget(action.target_display()));
            }
        }

        let binding = inc.binding.clone();
        // Proves the resource exists; becomes the pre-flight baseline.
        let baseline = self
            .gateway
            .fingerprint(&binding, action)
            .await
            .map_err(|e| {
                HealingError::TargetNotFound(format!("{}: {}", action.target_display(), e))
            })?;

        let verification_target = match action {
            HealingAction::RestartPod { namespace, .. } => {
                let wk = baseline
                    .observed
                    .get("workloadKind")
                    .and_then(|k| WorkloadKind::parse(k));
                let wn = baseline.observed.get("workloadName").cloned();
                match (wk, wn) {
                    (Some(kind), Some(name)) => VerificationTarget {
                        kind,
                        namespace: namespace.clone(),
                        name,
                        expected_replicas: None,
                    },
                    _ => {
                        return Err(HealingError::ManualInterventionRequired(
                            "pod is not owned by a Deployment/StatefulSet/DaemonSet".into(),
                        ))
                    }
                }
            }
            HealingAction::RolloutRestart {
                namespace,
                kind,
                name,
            } => VerificationTarget {
                kind: *kind,
                namespace: namespace.clone(),
                name: name.clone(),
                expected_replicas: None,
            },
            HealingAction::RollbackDeployment {
                namespace, name, ..
            } => VerificationTarget {
                kind: WorkloadKind::Deployment,
                namespace: namespace.clone(),
                name: name.clone(),
                expected_replicas: None,
            },
            HealingAction::ScaleDeployment {
                namespace,
                name,
                replicas,
            } => VerificationTarget {
                kind: WorkloadKind::Deployment,
                namespace: namespace.clone(),
                name: name.clone(),
                expected_replicas: Some(*replicas),
            },
            HealingAction::ScaleStatefulSet {
                namespace,
                name,
                replicas,
            } => VerificationTarget {
                kind: WorkloadKind::StatefulSet,
                namespace: namespace.clone(),
                name: name.clone(),
                expected_replicas: Some(*replicas),
            },
        };

        let vt = &verification_target;
        let current_state = self
            .gateway
            .snapshot(&binding, vt.kind.as_str(), &vt.namespace, &vt.name)
            .await
            .unwrap_or_default();
        let mut proposed_state = current_state.clone();
        match action {
            HealingAction::ScaleDeployment { replicas, .. }
            | HealingAction::ScaleStatefulSet { replicas, .. } => {
                proposed_state.replicas = Some(*replicas as i64)
            }
            HealingAction::RollbackDeployment { to_revision, .. } => {
                proposed_state.revision = Some(*to_revision)
            }
            HealingAction::RolloutRestart { .. } | HealingAction::RestartPod { .. } => {
                proposed_state.ready = Some("all replicas ready after restart".into())
            }
        }
        let gitops_owner = self
            .gateway
            .gitops_owner(&binding, vt.kind.as_str(), &vt.namespace, &vt.name)
            .await
            .ok()
            .flatten();

        let risk = draft.declared_risk.max(action.base_risk());
        let policy = self.policy();
        let blocked_reason = policy
            .validate_action(&binding.context, action, risk)
            .err()
            .map(|e| e.to_string());
        let now = self.clock.now();
        let p = proposal::seal(HealingProposal {
            id: new_id(),
            incident_id: inc.id.clone(),
            kind: draft.kind,
            binding,
            action: draft.action,
            risk,
            rationale: draft.rationale,
            evidence: draft.evidence,
            expected_impact: draft.expected_impact,
            verification_steps: draft.verification_steps,
            rollback_plan: draft.rollback_plan,
            confidence: draft.confidence.map(|c| c.clamp(0.0, 1.0)),
            source: draft.source,
            baseline,
            current_state,
            proposed_state,
            verification_target,
            gitops_owner,
            blocked_reason: blocked_reason.clone(),
            created_at: now,
            expires_at: now + policy.ttl_ms(),
            hash: String::new(),
        });

        let stored = p.clone();
        let inc = self.with_incident(incident_id, move |inc, now| {
            if inc.status != expected {
                return Err(HealingError::WrongStatus {
                    expected,
                    actual: inc.status,
                });
            }
            if expected == IncidentStatus::Analyzing {
                transition(
                    inc,
                    IncidentStatus::ProposalReady,
                    now,
                    "proposal generated",
                )?;
            }
            match &stored.blocked_reason {
                Some(reason) => {
                    transition(inc, IncidentStatus::ManualInterventionRequired, now, reason)?
                }
                None => transition(
                    inc,
                    IncidentStatus::PendingApproval,
                    now,
                    "awaiting administrator approval",
                )?,
            }
            inc.proposals.push(stored.clone());
            inc.active_proposal_id = Some(stored.id.clone());
            Ok(inc.clone())
        })?;
        match blocked_reason {
            Some(r) => self.record(&inc, AuditEvent::ProposalBlocked, Some(&p), None, r),
            None => self.record(
                &inc,
                AuditEvent::ProposalCreated,
                Some(&p),
                None,
                p.action.describe(),
            ),
        }
        Ok(p)
    }

    // ── Approval ─────────────────────────────────────────────────────────────

    pub fn approve(
        &self,
        req: &ApproveRequest,
        operator: &OperatorIdentity,
    ) -> HealingResult<Incident> {
        let policy = self.policy();
        let mut refused: Option<(Incident, String)> = None;
        let result = self.with_incident(&req.incident_id, |inc, now| {
            let check = (|| {
                if inc.status != IncidentStatus::PendingApproval {
                    return Err(HealingError::WrongStatus {
                        expected: IncidentStatus::PendingApproval,
                        actual: inc.status,
                    });
                }
                if inc.active_proposal_id.as_deref() != Some(req.proposal_id.as_str()) {
                    return Err(HealingError::ProposalNotActive(req.proposal_id.clone()));
                }
                let p = inc
                    .proposal(&req.proposal_id)
                    .ok_or_else(|| HealingError::ProposalNotFound(req.proposal_id.clone()))?;
                if !proposal::is_intact(p) {
                    return Err(HealingError::IntegrityFailure);
                }
                if p.hash != req.proposal_hash {
                    return Err(HealingError::HashMismatch);
                }
                if p.binding.context != req.context {
                    return Err(HealingError::ClusterMismatch(format!(
                        "proposal is bound to {}, approval came from {}",
                        p.binding.context, req.context
                    )));
                }
                policy.validate_proposal(p, now)?;
                if p.risk >= RiskLevel::High && !req.high_risk_confirmed {
                    return Err(HealingError::HighRiskConfirmationRequired);
                }
                Ok(p.hash.clone())
            })();
            match check {
                Ok(hash) => {
                    inc.approvals.push(Approval {
                        proposal_id: req.proposal_id.clone(),
                        proposal_hash: hash,
                        operator: operator.clone(),
                        approved_at: now,
                        high_risk_confirmed: req.high_risk_confirmed,
                    });
                    transition(
                        inc,
                        IncidentStatus::Approved,
                        now,
                        &format!("approved by {}", operator.os_user),
                    )?;
                    Ok(inc.clone())
                }
                Err(e) => {
                    if e == HealingError::Expired {
                        let _ =
                            transition(inc, IncidentStatus::Expired, now, "proposal TTL elapsed");
                    }
                    refused = Some((inc.clone(), e.to_string()));
                    Err(e)
                }
            }
        });
        match &result {
            Ok(inc) => self.record(
                inc,
                AuditEvent::Approved,
                inc.active_proposal(),
                Some(operator),
                "explicit approval",
            ),
            Err(_) => {
                if let Some((inc, msg)) = refused {
                    self.record(
                        &inc,
                        AuditEvent::ApprovalRefused,
                        inc.active_proposal(),
                        Some(operator),
                        msg,
                    );
                }
            }
        }
        result
    }

    pub fn reject(
        &self,
        req: &RejectRequest,
        operator: &OperatorIdentity,
    ) -> HealingResult<Incident> {
        let inc = self.with_incident(&req.incident_id, |inc, now| {
            if inc.status != IncidentStatus::PendingApproval {
                return Err(HealingError::WrongStatus {
                    expected: IncidentStatus::PendingApproval,
                    actual: inc.status,
                });
            }
            if inc.active_proposal_id.as_deref() != Some(req.proposal_id.as_str()) {
                return Err(HealingError::ProposalNotActive(req.proposal_id.clone()));
            }
            inc.rejections.push(Rejection {
                proposal_id: req.proposal_id.clone(),
                operator: operator.clone(),
                rejected_at: now,
                reason: req.reason.clone(),
            });
            transition(
                inc,
                IncidentStatus::Rejected,
                now,
                &format!("rejected by {}", operator.os_user),
            )?;
            Ok(inc.clone())
        })?;
        self.record(
            &inc,
            AuditEvent::Rejected,
            inc.active_proposal(),
            Some(operator),
            req.reason.clone().unwrap_or_default(),
        );
        Ok(inc)
    }

    // ── Execution ────────────────────────────────────────────────────────────

    pub async fn execute_approved(
        &self,
        req: &ExecuteRequest,
        operator: &OperatorIdentity,
    ) -> HealingResult<ExecutionRecord> {
        let policy = self.policy();

        // Phase 1 — under the lock: verify everything and atomically claim
        // APPROVED → EXECUTING so a second caller cannot also execute.
        let mut refused: Option<(Incident, String)> = None;
        let claimed = self.with_incident(&req.incident_id, |inc, now| {
            let check = (|| {
                if inc
                    .executions
                    .iter()
                    .any(|e| e.proposal_id == req.proposal_id)
                {
                    return Err(HealingError::AlreadyExecuted);
                }
                if inc.status == IncidentStatus::PendingApproval {
                    return Err(HealingError::ApprovalMissing);
                }
                if inc.status != IncidentStatus::Approved {
                    return Err(HealingError::WrongStatus {
                        expected: IncidentStatus::Approved,
                        actual: inc.status,
                    });
                }
                if inc.active_proposal_id.as_deref() != Some(req.proposal_id.as_str()) {
                    return Err(HealingError::ProposalNotActive(req.proposal_id.clone()));
                }
                let p = inc
                    .proposal(&req.proposal_id)
                    .ok_or_else(|| HealingError::ProposalNotFound(req.proposal_id.clone()))?;
                if !proposal::is_intact(p) {
                    return Err(HealingError::IntegrityFailure);
                }
                if p.hash != req.proposal_hash {
                    return Err(HealingError::HashMismatch);
                }
                let approval = inc
                    .approvals
                    .iter()
                    .rev()
                    .find(|a| a.proposal_id == req.proposal_id)
                    .ok_or(HealingError::ApprovalMissing)?;
                if approval.proposal_hash != p.hash {
                    return Err(HealingError::HashMismatch);
                }
                if p.binding.context != req.context {
                    return Err(HealingError::ClusterMismatch(format!(
                        "proposal is bound to {}, execution requested for {}",
                        p.binding.context, req.context
                    )));
                }
                policy.validate_proposal(p, now)?;
                Ok(p.clone())
            })();
            match check {
                Ok(p) => {
                    transition(inc, IncidentStatus::Executing, now, "pre-flight started")?;
                    Ok((p, inc.clone()))
                }
                Err(e) => {
                    let to = match &e {
                        HealingError::Expired => Some(IncidentStatus::Expired),
                        HealingError::Protected(_)
                        | HealingError::PolicyViolation(_)
                        | HealingError::ManualInterventionRequired(_)
                        | HealingError::IntegrityFailure => {
                            Some(IncidentStatus::ManualInterventionRequired)
                        }
                        _ => None,
                    };
                    if let Some(to) = to {
                        let _ = transition(inc, to, now, &e.to_string());
                        inc.last_error = Some(e.to_string());
                    }
                    refused = Some((inc.clone(), e.to_string()));
                    Err(e)
                }
            }
        });
        let (p, inc) = match claimed {
            Ok(v) => v,
            Err(e) => {
                if let Some((inc, msg)) = refused {
                    self.record(
                        &inc,
                        AuditEvent::ExecutionRefused,
                        inc.active_proposal(),
                        Some(operator),
                        msg,
                    );
                }
                return Err(e);
            }
        };
        self.record(
            &inc,
            AuditEvent::ExecutionClaimed,
            Some(&p),
            Some(operator),
            "",
        );

        // Phase 2 — pre-flight against the bound cluster (read-only).
        match self.gateway.context_server(&p.binding.context).await {
            Ok(Some(server)) if server == p.binding.server => {}
            Ok(Some(server)) => {
                let e = HealingError::ClusterMismatch(format!(
                    "context {} now points at {}, approved for {}",
                    p.binding.context, server, p.binding.server
                ));
                return Err(self.abort(&req.incident_id, &p, operator, IncidentStatus::Failed, e));
            }
            Ok(None) | Err(_) => {
                let e = HealingError::ClusterMismatch(format!(
                    "context {} is unavailable",
                    p.binding.context
                ));
                return Err(self.abort(&req.incident_id, &p, operator, IncidentStatus::Failed, e));
            }
        }
        let current = match self.gateway.fingerprint(&p.binding, &p.action).await {
            Ok(f) => f,
            Err(err) => {
                let e =
                    HealingError::TargetNotFound(format!("{}: {}", p.action.target_display(), err));
                return Err(self.abort(&req.incident_id, &p, operator, IncidentStatus::Failed, e));
            }
        };
        let changes = p.baseline.diff(&current);
        if !changes.is_empty() {
            let e = HealingError::Stale(format!(
                "{} ({})",
                p.action.target_display(),
                changes.join("; ")
            ));
            return Err(self.abort(&req.incident_id, &p, operator, IncidentStatus::Stale, e));
        }

        // Phase 3 — execute the exact approved action.
        let vt = &p.verification_target;
        let pre_state = self
            .gateway
            .snapshot(&p.binding, vt.kind.as_str(), &vt.namespace, &vt.name)
            .await
            .ok();
        let permit = ExecutionPermit::new(p.binding.clone(), p.action.clone());
        let started_at = self.clock.now();
        let result = self.gateway.apply(&permit).await;
        let post_state = self
            .gateway
            .snapshot(&p.binding, vt.kind.as_str(), &vt.namespace, &vt.name)
            .await
            .ok();
        let finished_at = self.clock.now();
        let (success, command, output, error) = match result {
            Ok(o) => (true, o.command, o.output, None),
            Err(e) => (
                false,
                super::gateway::kubectl_argv(&p.binding.context, &p.action),
                String::new(),
                Some(e),
            ),
        };
        let record = ExecutionRecord {
            id: new_id(),
            proposal_id: p.id.clone(),
            proposal_hash: p.hash.clone(),
            operator: operator.clone(),
            action: p.action.clone(),
            command,
            started_at,
            finished_at: Some(finished_at),
            success,
            output,
            error: error.clone(),
            pre_state,
            post_state,
        };
        let rec = record.clone();
        let inc = self.with_incident(&req.incident_id, move |inc, now| {
            inc.executions.push(rec);
            match &error {
                None => transition(
                    inc,
                    IncidentStatus::Verifying,
                    now,
                    "action applied; verifying",
                )?,
                Some(e) => {
                    inc.last_error = Some(e.clone());
                    transition(inc, IncidentStatus::Failed, now, "execution failed")?
                }
            }
            Ok(inc.clone())
        })?;
        if success {
            self.record(
                &inc,
                AuditEvent::Executed,
                Some(&p),
                Some(operator),
                record.command.join(" "),
            );
        } else {
            self.record(
                &inc,
                AuditEvent::ExecutionFailed,
                Some(&p),
                Some(operator),
                record.error.clone().unwrap_or_default(),
            );
        }
        Ok(record)
    }

    fn abort(
        &self,
        incident_id: &str,
        p: &HealingProposal,
        operator: &OperatorIdentity,
        to: IncidentStatus,
        e: HealingError,
    ) -> HealingError {
        let msg = e.to_string();
        if let Ok(inc) = self.with_incident(incident_id, |inc, now| {
            inc.last_error = Some(msg.clone());
            transition(inc, to, now, &msg)?;
            Ok(inc.clone())
        }) {
            self.record(
                &inc,
                AuditEvent::PreflightFailed,
                Some(p),
                Some(operator),
                msg,
            );
        }
        e
    }

    // ── Verification (read-only) ─────────────────────────────────────────────

    pub async fn verify(&self, incident_id: &str) -> HealingResult<VerificationRecord> {
        let inc = self.incident(incident_id)?;
        if inc.status != IncidentStatus::Verifying {
            return Err(HealingError::WrongStatus {
                expected: IncidentStatus::Verifying,
                actual: inc.status,
            });
        }
        let p = inc
            .active_proposal()
            .cloned()
            .ok_or(HealingError::ProposalNotFound("active".into()))?;
        let exec_id = inc
            .executions
            .last()
            .map(|e| e.id.clone())
            .unwrap_or_default();
        let started_at = self.clock.now();
        let (outcome, checks) = verifier::verify(
            &self.gateway,
            &p.binding,
            &p.verification_target,
            self.verify_cfg,
        )
        .await;
        let rec = VerificationRecord {
            execution_id: exec_id,
            started_at,
            finished_at: self.clock.now(),
            outcome,
            checks,
        };
        let stored = rec.clone();
        let inc = self.with_incident(incident_id, move |inc, now| {
            inc.verifications.push(stored);
            let to = match (outcome, p.kind) {
                (VerificationOutcome::Healthy, ProposalKind::Remediation) => IncidentStatus::Healed,
                (VerificationOutcome::Healthy, ProposalKind::Rollback) => {
                    IncidentStatus::RolledBack
                }
                _ => IncidentStatus::Failed,
            };
            if to == IncidentStatus::Failed {
                inc.last_error = Some(format!("verification {:?}", outcome));
            }
            transition(inc, to, now, &format!("verification {:?}", outcome))?;
            Ok(inc.clone())
        })?;
        let ev = if outcome == VerificationOutcome::Healthy {
            AuditEvent::VerificationPassed
        } else {
            AuditEvent::VerificationFailed
        };
        self.record(
            &inc,
            ev,
            inc.active_proposal(),
            None,
            format!("{:?}", outcome),
        );
        Ok(rec)
    }

    // ── Rollback (proposal only — needs its own approval) ────────────────────

    pub async fn propose_rollback(&self, incident_id: &str) -> HealingResult<HealingProposal> {
        let inc = self.incident(incident_id)?;
        if inc.status != IncidentStatus::Failed {
            return Err(HealingError::WrongStatus {
                expected: IncidentStatus::Failed,
                actual: inc.status,
            });
        }
        let exec = inc
            .executions
            .iter()
            .rev()
            .find(|e| Some(&e.proposal_id) == inc.active_proposal_id.as_ref())
            .cloned()
            .ok_or_else(|| HealingError::RollbackUnavailable("no execution to roll back".into()))?;
        let pre = exec.pre_state.clone().ok_or_else(|| {
            HealingError::RollbackUnavailable("pre-change state was not captured".into())
        })?;
        let action =
            rollback_action(&exec.action, &pre).map_err(HealingError::RollbackUnavailable)?;

        let inc = self.with_incident(incident_id, |inc, now| {
            transition(
                inc,
                IncidentStatus::RollbackProposed,
                now,
                "operator requested rollback proposal",
            )?;
            Ok(inc.clone())
        })?;
        self.record(
            &inc,
            AuditEvent::RollbackProposed,
            inc.active_proposal(),
            None,
            action.describe(),
        );

        let draft = ProposalDraft {
            kind: ProposalKind::Rollback,
            declared_risk: RiskLevel::High,
            rationale: format!(
                "Healing execution {} failed verification. Restore the state captured before it ran.",
                exec.id
            ),
            evidence: inc
                .verifications
                .last()
                .map(|v| v.checks.clone())
                .unwrap_or_default(),
            expected_impact: "Workload returns to its pre-healing configuration; pods are replaced.".into(),
            verification_steps: vec!["Workload reaches desired/ready/available replicas".into()],
            rollback_plan: "Re-run diagnosis if the rolled-back state is also unhealthy.".into(),
            confidence: None,
            source: ProposalSource::RollbackOfExecution { execution_id: exec.id.clone() },
            action,
        };
        match self.create_proposal(incident_id, draft).await {
            Ok(p) => Ok(p),
            Err(e) => {
                let _ = self.with_incident(incident_id, |inc, now| {
                    inc.last_error = Some(e.to_string());
                    transition(
                        inc,
                        IncidentStatus::ManualInterventionRequired,
                        now,
                        &e.to_string(),
                    )
                });
                Err(e)
            }
        }
    }

    /// After an app restart, executions that were in flight are unknown.
    pub fn recover_after_restart(&self) {
        let ids: Vec<String> = {
            let store = self.store.lock().unwrap();
            store
                .incidents
                .values()
                .filter(|i| {
                    matches!(
                        i.status,
                        IncidentStatus::Executing | IncidentStatus::Verifying
                    )
                })
                .map(|i| i.id.clone())
                .collect()
        };
        for id in ids {
            if let Ok(inc) = self.with_incident(&id, |inc, now| {
                let msg = "interrupted by application restart; verify the workload manually";
                inc.last_error = Some(msg.into());
                transition(inc, IncidentStatus::Failed, now, msg)?;
                Ok(inc.clone())
            }) {
                self.record(
                    &inc,
                    AuditEvent::Interrupted,
                    inc.active_proposal(),
                    None,
                    "app restart",
                );
            }
        }
    }
}
