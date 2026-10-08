//! Security-boundary and workflow tests for Self-Healing.
//!
//! `FakeGateway` counts calls to `apply` (the only mutating operation). Every
//! refusal test asserts that count stays at zero.
//!
//! This module is a sibling of `service`, so it cannot construct an
//! `ExecutionPermit` (private constructor) — the same restriction every other
//! module in the crate has.

use super::audit::{AuditEvent, AuditLog};
use super::error::HealingError;
use super::gateway::{ClusterGateway, GatewayOutput};
use super::model::*;
use super::policy::HealingPolicy;
use super::service::*;
use super::store::HealingStore;
use super::verifier::VerifyConfig;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ── Fakes ─────────────────────────────────────────────────────────────────────

const SERVER: &str = "https://apac.eks.example";
const CTX: &str = "cluster-eks-apac";

#[derive(Clone)]
struct FakeClock(Arc<AtomicI64>);
impl FakeClock {
    fn advance_min(&self, m: i64) {
        self.0.fetch_add(m * 60_000, Ordering::SeqCst);
    }
}
impl Clock for FakeClock {
    fn now(&self) -> Millis {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Default)]
struct FakeGateway {
    applied: Arc<AtomicUsize>,
    applied_actions: Arc<Mutex<Vec<HealingAction>>>,
    server: Arc<Mutex<Option<String>>>,
    fingerprint: Arc<Mutex<ResourceFingerprint>>,
    healthy: Arc<Mutex<bool>>,
    apply_error: Arc<Mutex<Option<String>>>,
    missing: Arc<Mutex<bool>>,
    gitops: Arc<Mutex<Option<String>>>,
    apply_delay_ms: u64,
}

impl FakeGateway {
    fn new() -> Self {
        let g = FakeGateway::default();
        *g.server.lock().unwrap() = Some(SERVER.into());
        *g.healthy.lock().unwrap() = true;
        let mut observed = BTreeMap::new();
        observed.insert("replicas".into(), "3".into());
        observed.insert("revision".into(), "7".into());
        observed.insert("controllerKind".into(), "ReplicaSet".into());
        observed.insert("workloadKind".into(), "Deployment".into());
        observed.insert("workloadName".into(), "payment-api".into());
        *g.fingerprint.lock().unwrap() = ResourceFingerprint {
            uid: "uid-1".into(),
            generation: Some(4),
            observed,
        };
        g
    }
    fn mutations(&self) -> usize {
        self.applied.load(Ordering::SeqCst)
    }
}

impl ClusterGateway for FakeGateway {
    async fn context_server(&self, _context: &str) -> Result<Option<String>, String> {
        Ok(self.server.lock().unwrap().clone())
    }
    async fn fingerprint(
        &self,
        _b: &ClusterBinding,
        _a: &HealingAction,
    ) -> Result<ResourceFingerprint, String> {
        if *self.missing.lock().unwrap() {
            return Err("NotFound".into());
        }
        Ok(self.fingerprint.lock().unwrap().clone())
    }
    async fn snapshot(
        &self,
        _b: &ClusterBinding,
        _k: &str,
        _n: &str,
        _name: &str,
    ) -> Result<StateSnapshot, String> {
        Ok(StateSnapshot {
            replicas: Some(3),
            revision: Some(7),
            generation: Some(4),
            images: vec!["api:1.2".into()],
            ready: Some("0/3".into()),
        })
    }
    async fn health(
        &self,
        _b: &ClusterBinding,
        _t: &VerificationTarget,
    ) -> Result<HealthObservation, String> {
        let healthy = *self.healthy.lock().unwrap();
        Ok(HealthObservation {
            healthy,
            detail: if healthy {
                "3/3 ready".into()
            } else {
                "0/3 ready".into()
            },
        })
    }
    async fn gitops_owner(
        &self,
        _b: &ClusterBinding,
        _k: &str,
        _n: &str,
        _name: &str,
    ) -> Result<Option<String>, String> {
        Ok(self.gitops.lock().unwrap().clone())
    }
    async fn apply(&self, permit: &ExecutionPermit) -> Result<GatewayOutput, String> {
        if self.apply_delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(self.apply_delay_ms)).await;
        }
        self.applied.fetch_add(1, Ordering::SeqCst);
        self.applied_actions
            .lock()
            .unwrap()
            .push(permit.action().clone());
        if let Some(e) = self.apply_error.lock().unwrap().clone() {
            return Err(e);
        }
        Ok(GatewayOutput {
            command: vec!["fake".into()],
            output: "ok".into(),
        })
    }
}

type Svc = HealingService<FakeGateway, FakeClock>;

fn setup_with(gw: FakeGateway) -> (Arc<Svc>, FakeGateway, FakeClock) {
    let clock = FakeClock(Arc::new(AtomicI64::new(1_791_417_600_000)));
    let cfg = VerifyConfig {
        interval: Duration::from_millis(1),
        timeout: Duration::from_millis(40),
        required_consecutive: 2,
    };
    let svc = HealingService::new(
        gw.clone(),
        clock.clone(),
        HealingStore::in_memory(),
        HealingPolicy::default(),
        AuditLog::in_memory(),
        cfg,
    );
    (Arc::new(svc), gw, clock)
}

fn setup() -> (Arc<Svc>, FakeGateway, FakeClock) {
    setup_with(FakeGateway::new())
}

fn operator() -> OperatorIdentity {
    OperatorIdentity::local(
        "tester",
        Some("arn:aws:iam::000000000000:user/tester".into()),
    )
}

fn binding() -> ClusterBinding {
    ClusterBinding {
        context: CTX.into(),
        cluster_name: "apac".into(),
        server: SERVER.into(),
    }
}

fn incident(ns: &str) -> Incident {
    let res = |kind: &str, name: &str| ResourceRef {
        kind: kind.into(),
        namespace: Some(ns.into()),
        name: name.into(),
        uid: None,
    };
    Incident {
        id: uuid::Uuid::new_v4().to_string(),
        key: format!("{}/{}/Deployment/payment-api/CrashLoopBackOff", CTX, ns),
        binding: binding(),
        severity: Severity::Critical,
        status: IncidentStatus::Detected,
        resource: res("Deployment", "payment-api"),
        problem: "CrashLoopBackOff".into(),
        symptoms: vec![],
        affected: vec![res("Pod", "payment-api-abc"), res("Pod", "payment-api-def")],
        restart_count: Some(12),
        first_detected: 0,
        last_detected: 0,
        gitops_owner: None,
        diagnosis: None,
        diagnosis_error: None,
        proposals: vec![],
        active_proposal_id: None,
        approvals: vec![],
        rejections: vec![],
        executions: vec![],
        verifications: vec![],
        history: vec![],
        last_error: None,
    }
}

fn restart_draft(ns: &str) -> ProposalDraft {
    ProposalDraft {
        kind: ProposalKind::Remediation,
        action: HealingAction::RolloutRestart {
            namespace: ns.into(),
            kind: WorkloadKind::Deployment,
            name: "payment-api".into(),
        },
        declared_risk: RiskLevel::Low, // below base risk → raised to MEDIUM
        rationale: "stuck pods".into(),
        evidence: vec!["BackOff x12".into()],
        expected_impact: "pods replaced".into(),
        verification_steps: vec!["ready".into()],
        rollback_plan: "rollout undo".into(),
        confidence: Some(0.99),
        source: ProposalSource::Ai {
            provider: "fake".into(),
            model: None,
        },
    }
}

/// Detected → Analyzing → PendingApproval with a restart proposal.
async fn pending(svc: &Svc, ns: &str) -> (Incident, HealingProposal) {
    let (inc, _) = svc.upsert_detected(incident(ns));
    svc.begin_analysis(&inc.id).unwrap();
    let p = svc
        .create_proposal(&inc.id, restart_draft(ns))
        .await
        .unwrap();
    (svc.incident(&inc.id).unwrap(), p)
}

fn approve_req(inc: &Incident, p: &HealingProposal) -> ApproveRequest {
    ApproveRequest {
        incident_id: inc.id.clone(),
        proposal_id: p.id.clone(),
        proposal_hash: p.hash.clone(),
        context: CTX.into(),
        high_risk_confirmed: false,
    }
}

fn exec_req(inc: &Incident, p: &HealingProposal) -> ExecuteRequest {
    ExecuteRequest {
        incident_id: inc.id.clone(),
        proposal_id: p.id.clone(),
        proposal_hash: p.hash.clone(),
        context: CTX.into(),
    }
}

// ── Happy path ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn crashloop_diagnosis_proposal_approval_execution_verification() {
    let (svc, gw, _) = setup();
    let (inc, p) = pending(&svc, "payments").await;
    assert_eq!(inc.status, IncidentStatus::PendingApproval);
    assert_eq!(
        p.risk,
        RiskLevel::Medium,
        "declared LOW must be raised to the action's base risk"
    );
    assert_eq!(gw.mutations(), 0, "proposal creation must not mutate");

    svc.approve(&approve_req(&inc, &p), &operator()).unwrap();
    assert_eq!(gw.mutations(), 0, "approval alone must not mutate");

    let rec = svc
        .execute_approved(&exec_req(&inc, &p), &operator())
        .await
        .unwrap();
    assert!(rec.success);
    assert_eq!(gw.mutations(), 1);
    assert_eq!(
        gw.applied_actions.lock().unwrap()[0],
        p.action,
        "executes exactly the approved action"
    );
    assert_eq!(
        svc.incident(&inc.id).unwrap().status,
        IncidentStatus::Verifying
    );

    let v = svc.verify(&inc.id).await.unwrap();
    assert_eq!(v.outcome, VerificationOutcome::Healthy);
    let done = svc.incident(&inc.id).unwrap();
    assert_eq!(done.status, IncidentStatus::Healed);

    let events: Vec<AuditEvent> = svc.audit_for(&inc.id).iter().map(|r| r.event).collect();
    for e in [
        AuditEvent::IncidentDetected,
        AuditEvent::ProposalCreated,
        AuditEvent::Approved,
        AuditEvent::Executed,
        AuditEvent::VerificationPassed,
    ] {
        assert!(events.contains(&e), "audit missing {:?}: {:?}", e, events);
    }
    let approved = svc
        .audit_for(&inc.id)
        .into_iter()
        .find(|r| r.event == AuditEvent::Approved)
        .unwrap();
    assert_eq!(approved.proposal_hash.as_deref(), Some(p.hash.as_str()));
    assert_eq!(approved.operator.unwrap().os_user, "tester");
}

// ── Security: no mutation without approval ────────────────────────────────────

#[tokio::test]
async fn cannot_execute_without_approval() {
    let (svc, gw, _) = setup();
    let (inc, p) = pending(&svc, "payments").await;
    let err = svc
        .execute_approved(&exec_req(&inc, &p), &operator())
        .await
        .unwrap_err();
    assert_eq!(err, HealingError::ApprovalMissing);
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn cannot_execute_from_detected_or_analyzing() {
    let (svc, gw, _) = setup();
    let (inc, _) = svc.upsert_detected(incident("payments"));
    let fake = ExecuteRequest {
        incident_id: inc.id.clone(),
        proposal_id: "x".into(),
        proposal_hash: "y".into(),
        context: CTX.into(),
    };
    assert!(svc.execute_approved(&fake, &operator()).await.is_err());
    svc.begin_analysis(&inc.id).unwrap();
    assert!(svc.execute_approved(&fake, &operator()).await.is_err());
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn cannot_execute_rejected_proposal() {
    let (svc, gw, _) = setup();
    let (inc, p) = pending(&svc, "payments").await;
    svc.reject(
        &RejectRequest {
            incident_id: inc.id.clone(),
            proposal_id: p.id.clone(),
            reason: Some("no".into()),
        },
        &operator(),
    )
    .unwrap();
    assert!(
        svc.approve(&approve_req(&inc, &p), &operator()).is_err(),
        "rejected proposal cannot be approved"
    );
    assert!(svc
        .execute_approved(&exec_req(&inc, &p), &operator())
        .await
        .is_err());
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn cannot_approve_or_execute_expired_proposal() {
    let (svc, gw, clock) = setup();
    let (inc, p) = pending(&svc, "payments").await;
    clock.advance_min(31);
    assert_eq!(
        svc.approve(&approve_req(&inc, &p), &operator())
            .unwrap_err(),
        HealingError::Expired
    );
    assert_eq!(
        svc.incident(&inc.id).unwrap().status,
        IncidentStatus::Expired
    );

    // Approved, then expires before execution.
    let (inc2, p2) = pending(&svc, "web").await;
    svc.approve(&approve_req(&inc2, &p2), &operator()).unwrap();
    clock.advance_min(31);
    assert!(svc
        .execute_approved(&exec_req(&inc2, &p2), &operator())
        .await
        .is_err());
    assert_eq!(
        svc.incident(&inc2.id).unwrap().status,
        IncidentStatus::Expired
    );
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn stale_proposal_is_not_executed() {
    let (svc, gw, _) = setup();
    let (inc, p) = pending(&svc, "payments").await;
    svc.approve(&approve_req(&inc, &p), &operator()).unwrap();
    // Someone edits the Deployment after diagnosis.
    gw.fingerprint.lock().unwrap().generation = Some(5);
    let err = svc
        .execute_approved(&exec_req(&inc, &p), &operator())
        .await
        .unwrap_err();
    assert!(matches!(err, HealingError::Stale(_)), "{err}");
    assert!(err.to_string().contains("Deployment/payment-api"));
    assert_eq!(svc.incident(&inc.id).unwrap().status, IncidentStatus::Stale);
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn modified_proposal_is_not_executed() {
    let (svc, gw, _) = setup();
    let (inc, p) = pending(&svc, "payments").await;
    svc.approve(&approve_req(&inc, &p), &operator()).unwrap();

    // Execution request carrying a different hash.
    let mut req = exec_req(&inc, &p);
    req.proposal_hash = "0".repeat(64);
    assert_eq!(
        svc.execute_approved(&req, &operator()).await.unwrap_err(),
        HealingError::HashMismatch
    );
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn tampered_stored_proposal_is_not_executed() {
    // Simulates the backend (or a tampered state file) changing the approved
    // proposal: persist to disk, edit the action, reload.
    let dir = std::env::temp_dir().join(format!("healing-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("incidents.json");
    let gw = FakeGateway::new();
    let clock = FakeClock(Arc::new(AtomicI64::new(1_791_417_600_000)));
    let svc = HealingService::new(
        gw.clone(),
        clock.clone(),
        HealingStore::open(path.clone()).unwrap(),
        HealingPolicy::default(),
        AuditLog::in_memory(),
        VerifyConfig::default(),
    );
    let (inc, p) = pending(&svc, "payments").await;
    svc.approve(&approve_req(&inc, &p), &operator()).unwrap();
    drop(svc);

    let text = std::fs::read_to_string(&path).unwrap();
    let tampered = text.replace(
        "\"rationale\": \"stuck pods\"",
        "\"rationale\": \"edited after approval\"",
    );
    assert_ne!(text, tampered);
    std::fs::write(&path, tampered).unwrap();

    let svc = HealingService::new(
        gw.clone(),
        clock,
        HealingStore::open(path).unwrap(),
        HealingPolicy::default(),
        AuditLog::in_memory(),
        VerifyConfig::default(),
    );
    let err = svc
        .execute_approved(&exec_req(&inc, &p), &operator())
        .await
        .unwrap_err();
    assert_eq!(err, HealingError::IntegrityFailure);
    assert_eq!(gw.mutations(), 0);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn cannot_execute_against_another_cluster() {
    let (svc, gw, _) = setup();
    let (inc, p) = pending(&svc, "payments").await;

    // UI switched to another context before approving.
    let mut a = approve_req(&inc, &p);
    a.context = "cluster-b".into();
    assert!(matches!(
        svc.approve(&a, &operator()),
        Err(HealingError::ClusterMismatch(_))
    ));

    svc.approve(&approve_req(&inc, &p), &operator()).unwrap();
    // UI switched before executing.
    let mut e = exec_req(&inc, &p);
    e.context = "cluster-b".into();
    assert!(matches!(
        svc.execute_approved(&e, &operator()).await,
        Err(HealingError::ClusterMismatch(_))
    ));
    assert_eq!(gw.mutations(), 0);

    // Same context name, but kubeconfig now points it at a different API server.
    *gw.server.lock().unwrap() = Some("https://other-cluster.example".into());
    assert!(matches!(
        svc.execute_approved(&exec_req(&inc, &p), &operator()).await,
        Err(HealingError::ClusterMismatch(_))
    ));
    assert_eq!(
        svc.incident(&inc.id).unwrap().status,
        IncidentStatus::Failed
    );
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn unavailable_context_fails_safely() {
    let (svc, gw, _) = setup();
    let (inc, p) = pending(&svc, "payments").await;
    svc.approve(&approve_req(&inc, &p), &operator()).unwrap();
    *gw.server.lock().unwrap() = None;
    assert!(svc
        .execute_approved(&exec_req(&inc, &p), &operator())
        .await
        .is_err());
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn protected_namespace_proposal_cannot_be_approved_or_executed() {
    let (svc, gw, _) = setup();
    let mut i = incident("kube-system");
    i.key.push_str("-ks");
    let (inc, _) = svc.upsert_detected(i);
    svc.begin_analysis(&inc.id).unwrap();
    let p = svc
        .create_proposal(&inc.id, restart_draft("kube-system"))
        .await
        .unwrap();
    assert!(p.blocked_reason.is_some());
    let inc = svc.incident(&inc.id).unwrap();
    assert_eq!(inc.status, IncidentStatus::ManualInterventionRequired);
    assert!(svc.approve(&approve_req(&inc, &p), &operator()).is_err());
    assert!(svc
        .execute_approved(&exec_req(&inc, &p), &operator())
        .await
        .is_err());
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn policy_change_after_approval_blocks_execution() {
    let (svc, gw, _) = setup();
    let (inc, p) = pending(&svc, "payments").await;
    svc.approve(&approve_req(&inc, &p), &operator()).unwrap();
    let mut pol = svc.policy();
    pol.protected_namespaces.push("payments".into());
    svc.set_policy(pol);
    assert!(matches!(
        svc.execute_approved(&exec_req(&inc, &p), &operator()).await,
        Err(HealingError::Protected(_))
    ));
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn duplicate_execution_only_runs_once() {
    let mut gw = FakeGateway::new();
    gw.apply_delay_ms = 20;
    let (svc, gw, _) = setup_with(gw);
    let (inc, p) = pending(&svc, "payments").await;
    svc.approve(&approve_req(&inc, &p), &operator()).unwrap();

    let (req, op) = (exec_req(&inc, &p), operator());
    let (a, b) = tokio::join!(
        svc.execute_approved(&req, &op),
        svc.execute_approved(&req, &op)
    );
    assert!(
        a.is_ok() ^ b.is_ok(),
        "exactly one execution must be accepted"
    );
    assert_eq!(gw.mutations(), 1);

    // And again after it finished.
    let again = svc
        .execute_approved(&exec_req(&inc, &p), &operator())
        .await
        .unwrap_err();
    assert_eq!(again, HealingError::AlreadyExecuted);
    assert_eq!(gw.mutations(), 1);
}

#[tokio::test]
async fn high_risk_requires_explicit_confirmation() {
    let (svc, gw, _) = setup();
    let (inc, _) = svc.upsert_detected(incident("payments"));
    svc.begin_analysis(&inc.id).unwrap();
    let mut d = restart_draft("payments");
    d.action = HealingAction::ScaleDeployment {
        namespace: "payments".into(),
        name: "payment-api".into(),
        replicas: 5,
    };
    let p = svc.create_proposal(&inc.id, d).await.unwrap();
    assert_eq!(p.risk, RiskLevel::High);
    let inc = svc.incident(&inc.id).unwrap();
    assert_eq!(
        svc.approve(&approve_req(&inc, &p), &operator())
            .unwrap_err(),
        HealingError::HighRiskConfirmationRequired
    );
    let mut req = approve_req(&inc, &p);
    req.high_risk_confirmed = true;
    svc.approve(&req, &operator()).unwrap();
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn high_confidence_does_not_bypass_approval() {
    let (svc, gw, _) = setup();
    let (inc, _) = svc.upsert_detected(incident("payments"));
    svc.begin_analysis(&inc.id).unwrap();
    let mut d = restart_draft("payments");
    d.confidence = Some(1.0);
    svc.create_proposal(&inc.id, d).await.unwrap();
    assert_eq!(
        svc.incident(&inc.id).unwrap().status,
        IncidentStatus::PendingApproval
    );
    assert_eq!(gw.mutations(), 0);
}

// ── Untrusted AI output ───────────────────────────────────────────────────────

#[test]
fn ai_arbitrary_commands_do_not_parse_as_actions() {
    let bad = [
        r#"{"type":"SHELL","command":"kubectl delete ns payments"}"#,
        r#"{"type":"DELETE_NAMESPACE","namespace":"payments"}"#,
        r#"{"type":"ROLLOUT_RESTART","namespace":"payments","kind":"Deployment","name":"api","command":"rm -rf /"}"#,
        r#"{"type":"ROLLOUT_RESTART","namespace":"payments","kind":"Namespace","name":"payments"}"#,
        r#"{"type":"SCALE_DEPLOYMENT","namespace":"payments","name":"api","replicas":-1}"#,
        r#""kubectl delete deployment foo""#,
    ];
    for b in bad {
        assert!(
            serde_json::from_str::<HealingAction>(b).is_err(),
            "must reject: {b}"
        );
    }
    let ok = r#"{"type":"ROLLOUT_RESTART","namespace":"payments","kind":"Deployment","name":"payment-api"}"#;
    assert!(serde_json::from_str::<HealingAction>(ok).is_ok());
}

#[tokio::test]
async fn malformed_names_in_ai_action_rejected() {
    let (svc, gw, _) = setup();
    let (inc, _) = svc.upsert_detected(incident("payments"));
    svc.begin_analysis(&inc.id).unwrap();
    let mut d = restart_draft("payments");
    d.action = HealingAction::RolloutRestart {
        namespace: "payments".into(),
        kind: WorkloadKind::Deployment,
        name: "--all".into(),
    };
    assert!(matches!(
        svc.create_proposal(&inc.id, d).await,
        Err(HealingError::UnsupportedAiAction(_))
    ));
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn ai_cannot_target_unrelated_or_missing_resources() {
    let (svc, gw, _) = setup();
    let (inc, _) = svc.upsert_detected(incident("payments"));
    svc.begin_analysis(&inc.id).unwrap();
    let mut d = restart_draft("payments");
    d.action = HealingAction::RolloutRestart {
        namespace: "payments".into(),
        kind: WorkloadKind::Deployment,
        name: "ledger".into(),
    };
    assert!(matches!(
        svc.create_proposal(&inc.id, d).await,
        Err(HealingError::UnrelatedTarget(_))
    ));
    let mut d = restart_draft("payments");
    d.action = HealingAction::RolloutRestart {
        namespace: "other-ns".into(),
        kind: WorkloadKind::Deployment,
        name: "payment-api".into(),
    };
    assert!(matches!(
        svc.create_proposal(&inc.id, d).await,
        Err(HealingError::UnrelatedTarget(_))
    ));
    *gw.missing.lock().unwrap() = true;
    assert!(matches!(
        svc.create_proposal(&inc.id, restart_draft("payments"))
            .await,
        Err(HealingError::TargetNotFound(_))
    ));
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn restart_of_uncontrolled_pod_is_blocked() {
    let (svc, gw, _) = setup();
    gw.fingerprint.lock().unwrap().observed.clear();
    let (inc, _) = svc.upsert_detected(incident("payments"));
    svc.begin_analysis(&inc.id).unwrap();
    let mut d = restart_draft("payments");
    d.action = HealingAction::RestartPod {
        namespace: "payments".into(),
        pod: "payment-api-abc".into(),
    };
    assert!(matches!(
        svc.create_proposal(&inc.id, d).await,
        Err(HealingError::ManualInterventionRequired(_))
    ));
    assert_eq!(gw.mutations(), 0);
}

#[tokio::test]
async fn ai_unavailable_returns_to_detected_for_manual_work() {
    let (svc, gw, _) = setup();
    let (inc, _) = svc.upsert_detected(incident("payments"));
    svc.begin_analysis(&inc.id).unwrap();
    let inc = svc
        .analysis_failed(&inc.id, "AI diagnosis unavailable")
        .unwrap();
    assert_eq!(inc.status, IncidentStatus::Detected);
    assert_eq!(
        inc.diagnosis_error.as_deref(),
        Some("AI diagnosis unavailable")
    );
    assert_eq!(gw.mutations(), 0);
}

// ── Failure, rollback ─────────────────────────────────────────────────────────

#[tokio::test]
async fn failed_verification_requires_new_approval_for_rollback() {
    let (svc, gw, _) = setup();
    let (inc, p) = pending(&svc, "payments").await;
    svc.approve(&approve_req(&inc, &p), &operator()).unwrap();
    *gw.healthy.lock().unwrap() = false;
    svc.execute_approved(&exec_req(&inc, &p), &operator())
        .await
        .unwrap();
    let v = svc.verify(&inc.id).await.unwrap();
    assert_ne!(v.outcome, VerificationOutcome::Healthy);
    assert_eq!(
        svc.incident(&inc.id).unwrap().status,
        IncidentStatus::Failed
    );
    assert_eq!(gw.mutations(), 1, "no automatic rollback");

    let rb = svc.propose_rollback(&inc.id).await.unwrap();
    assert_eq!(rb.kind, ProposalKind::Rollback);
    assert_eq!(
        rb.action,
        HealingAction::RollbackDeployment {
            namespace: "payments".into(),
            name: "payment-api".into(),
            to_revision: 7
        }
    );
    let inc = svc.incident(&inc.id).unwrap();
    assert_eq!(inc.status, IncidentStatus::PendingApproval);
    assert_eq!(gw.mutations(), 1, "proposing rollback must not mutate");

    // The old approval does not carry over.
    assert_eq!(
        svc.execute_approved(&exec_req(&inc, &rb), &operator())
            .await
            .unwrap_err(),
        HealingError::ApprovalMissing
    );
    assert_eq!(gw.mutations(), 1);

    let mut req = approve_req(&inc, &rb);
    req.high_risk_confirmed = true;
    svc.approve(&req, &operator()).unwrap();
    *gw.healthy.lock().unwrap() = true;
    svc.execute_approved(&exec_req(&inc, &rb), &operator())
        .await
        .unwrap();
    assert_eq!(gw.mutations(), 2);
    svc.verify(&inc.id).await.unwrap();
    assert_eq!(
        svc.incident(&inc.id).unwrap().status,
        IncidentStatus::RolledBack
    );
}

#[tokio::test]
async fn failed_kubectl_marks_failed() {
    let (svc, gw, _) = setup();
    let (inc, p) = pending(&svc, "payments").await;
    svc.approve(&approve_req(&inc, &p), &operator()).unwrap();
    *gw.apply_error.lock().unwrap() = Some("forbidden".into());
    let rec = svc
        .execute_approved(&exec_req(&inc, &p), &operator())
        .await
        .unwrap();
    assert!(!rec.success);
    assert_eq!(
        svc.incident(&inc.id).unwrap().status,
        IncidentStatus::Failed
    );
}

// ── Persistence, correlation, GitOps ──────────────────────────────────────────

#[tokio::test]
async fn approval_survives_restart_and_in_flight_work_is_marked_interrupted() {
    let dir = std::env::temp_dir().join(format!("healing-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("incidents.json");
    let gw = FakeGateway::new();
    let clock = FakeClock(Arc::new(AtomicI64::new(1_791_417_600_000)));
    let mk = |p: &std::path::Path| {
        HealingService::new(
            gw.clone(),
            clock.clone(),
            HealingStore::open(p.to_path_buf()).unwrap(),
            HealingPolicy::default(),
            AuditLog::in_memory(),
            VerifyConfig::default(),
        )
    };

    let svc = mk(&path);
    let (inc, p) = pending(&svc, "payments").await;
    svc.approve(&approve_req(&inc, &p), &operator()).unwrap();
    drop(svc);

    let svc = mk(&path);
    let reloaded = svc.incident(&inc.id).unwrap();
    assert_eq!(reloaded.status, IncidentStatus::Approved);
    assert_eq!(reloaded.approvals.len(), 1);
    svc.execute_approved(&exec_req(&inc, &p), &operator())
        .await
        .unwrap();
    drop(svc);

    let svc = mk(&path);
    svc.recover_after_restart();
    assert_eq!(
        svc.incident(&inc.id).unwrap().status,
        IncidentStatus::Failed
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn repeated_detection_correlates_into_one_incident() {
    let (svc, _, _) = setup();
    let (a, new_a) = svc.upsert_detected(incident("payments"));
    let mut again = incident("payments");
    again.restart_count = Some(20);
    let (b, new_b) = svc.upsert_detected(again);
    assert!(new_a && !new_b);
    assert_eq!(a.id, b.id);
    assert_eq!(svc.incidents().len(), 1);
    assert_eq!(svc.incident(&a.id).unwrap().restart_count, Some(20));
}

#[tokio::test]
async fn gitops_owner_is_surfaced_on_proposal() {
    let (svc, gw, _) = setup();
    *gw.gitops.lock().unwrap() = Some("Argo CD (application payments)".into());
    let (_, p) = pending(&svc, "payments").await;
    assert_eq!(
        p.gitops_owner.as_deref(),
        Some("Argo CD (application payments)")
    );
}

// ── AI diagnosis (fake reader + fake provider) ────────────────────────────────

mod ai {
    use super::*;
    use crate::healing::analysis;
    use crate::healing::detector::HelmReleaseLite;
    use crate::healing::provider::{AiConfig, DiagnosisProvider, ProviderResponse};
    use crate::healing::reader::ClusterReader;
    use serde_json::{json, Value};

    struct FakeReader;

    impl ClusterReader for FakeReader {
        async fn get_json(
            &self,
            _c: &str,
            _ns: Option<&str>,
            kind: &str,
            name: &str,
        ) -> Result<Value, String> {
            Ok(match kind {
                "Pod" => {
                    json!({"kind":"Pod","metadata":{"name":name,"namespace":"payments","labels":{"app":"payment-api"},
                    "managedFields":[{"manager":"kubectl"}]},
                    "spec":{"nodeName":"ip-10-0-1-1","containers":[{"name":"api","image":"api:1.2","env":[
                        {"name":"DB_PASSWORD","value":"supersecret-value-123"},
                        {"name":"LOG_LEVEL","value":"info"}]}]},
                    "status":{"phase":"Running","containerStatuses":[{"name":"api","restartCount":12,
                        "state":{"waiting":{"reason":"CrashLoopBackOff"}}}]}})
                }
                "Node" => {
                    json!({"kind":"Node","metadata":{"name":name},"status":{"conditions":[{"type":"Ready","status":"True"}]}})
                }
                _ => {
                    json!({"kind":kind,"metadata":{"name":name,"namespace":"payments","generation":4,
                    "annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\"token\":\"tok-abc\"}"}},
                    "spec":{"replicas":3,"template":{"spec":{"containers":[{"name":"api","image":"api:1.2",
                        "envFrom":[{"secretRef":{"name":"payment-db"}}]}]}}}})
                }
            })
        }
        async fn list_json(
            &self,
            _c: &str,
            _ns: Option<&str>,
            kinds: &str,
            _fs: Option<&str>,
        ) -> Result<Vec<Value>, String> {
            Ok(match kinds {
                "events" => vec![
                    json!({"type":"Warning","reason":"BackOff","message":"Back-off restarting failed container",
                    "count":12,"involvedObject":{"kind":"Pod","name":"payment-api-abc"},"lastTimestamp":"2026-10-07T23:58:00Z"}),
                ],
                "services" => vec![
                    json!({"metadata":{"name":"payment-api"},"spec":{"selector":{"app":"payment-api"},"type":"ClusterIP"}}),
                ],
                _ => vec![],
            })
        }
        async fn logs(
            &self,
            _c: &str,
            _ns: &str,
            _p: &str,
            _ct: &str,
            previous: bool,
            _t: u32,
        ) -> Result<String, String> {
            Ok(if previous {
                "panic: cannot connect to postgres://app:hunter2@db:5432/pay password=hunter2"
                    .into()
            } else {
                "starting payment-api v1.2".into()
            })
        }
        async fn rollout_history(
            &self,
            _c: &str,
            _ns: &str,
            _k: &str,
            _n: &str,
        ) -> Result<String, String> {
            Ok("REVISION  CHANGE-CAUSE\n6         <none>\n7         <none>".into())
        }
        async fn top_pods(&self, _c: &str, _ns: &str) -> Result<String, String> {
            Err("metrics-server not installed".into())
        }
        async fn helm_releases(&self, _c: &str) -> Result<Vec<HelmReleaseLite>, String> {
            Ok(vec![])
        }
    }

    struct FakeProvider {
        calls: AtomicUsize,
        prompt: Mutex<String>,
        response: Mutex<Result<Value, String>>,
    }

    impl FakeProvider {
        fn returning(v: Result<Value, String>) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                prompt: Mutex::new(String::new()),
                response: Mutex::new(v),
            }
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl DiagnosisProvider for FakeProvider {
        fn name(&self) -> String {
            "fake".into()
        }
        async fn diagnose(
            &self,
            _s: &str,
            user: &str,
            _schema: &Value,
        ) -> Result<ProviderResponse, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.prompt.lock().unwrap() = user.to_string();
            self.response
                .lock()
                .unwrap()
                .clone()
                .map(|output| ProviderResponse {
                    output,
                    model: Some("fake-model".into()),
                })
        }
    }

    fn diagnosis(action: Value) -> Value {
        json!({
            "summary": "payment-api cannot reach its database", "probable_root_cause": "DB connection refused at start",
            "confidence": 0.97, "evidence": ["payment-api-abc previous logs: cannot connect to postgres", "CrashLoopBackOff x12"],
            "contributing_factors": [], "recommended_action": action, "risk_level": "LOW",
            "expected_impact": "pods restart", "verification_steps": ["3/3 ready"],
            "rollback_strategy": "rollout undo to revision 7", "limitations": [], "uncertainty": "db side not visible"
        })
    }

    fn restart_action() -> Value {
        json!({"type":"ROLLOUT_RESTART","namespace":"payments","kind":"Deployment","name":"payment-api"})
    }

    fn enabled() -> AiConfig {
        AiConfig {
            enabled: true,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn disabled_ai_changes_nothing() {
        let (svc, gw, _) = setup();
        let (inc, _) = svc.upsert_detected(incident("payments"));
        let p = FakeProvider::returning(Ok(diagnosis(restart_action())));
        let err = analysis::analyze(
            &svc,
            &FakeReader,
            Ok(&p),
            &AiConfig::default(),
            &inc.id,
            false,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, HealingError::AiUnavailable(_)));
        assert_eq!(p.calls(), 0);
        assert_eq!(
            svc.incident(&inc.id).unwrap().status,
            IncidentStatus::Detected
        );
        assert_eq!(gw.mutations(), 0);
    }

    #[tokio::test]
    async fn provider_failure_falls_back_to_manual_detection() {
        let (svc, gw, _) = setup();
        let (inc, _) = svc.upsert_detected(incident("payments"));
        let p = FakeProvider::returning(Err("Not logged in".into()));
        assert!(matches!(
            analysis::analyze(&svc, &FakeReader, Ok(&p), &enabled(), &inc.id, false).await,
            Err(HealingError::AiUnavailable(_))
        ));
        let inc = svc.incident(&inc.id).unwrap();
        assert_eq!(inc.status, IncidentStatus::Detected);
        assert!(inc
            .diagnosis_error
            .unwrap()
            .contains("AI diagnosis unavailable"));
        // Missing CLI behaves the same way.
        let none: Result<&FakeProvider, String> = Err("claude CLI not found".into());
        assert!(
            analysis::analyze(&svc, &FakeReader, none, &enabled(), &inc.id, false)
                .await
                .is_err()
        );
        assert_eq!(gw.mutations(), 0);
    }

    #[tokio::test]
    async fn valid_diagnosis_creates_pending_proposal_without_executing_and_never_leaks_secrets() {
        let (svc, gw, _) = setup();
        let (inc, _) = svc.upsert_detected(incident("payments"));
        let p = FakeProvider::returning(Ok(diagnosis(restart_action())));
        let inc = analysis::analyze(&svc, &FakeReader, Ok(&p), &enabled(), &inc.id, false)
            .await
            .unwrap();
        assert_eq!(
            inc.status,
            IncidentStatus::PendingApproval,
            "99% confidence still needs approval"
        );
        let prop = inc.active_proposal().unwrap();
        assert_eq!(
            prop.risk,
            RiskLevel::Medium,
            "AI-declared LOW raised to base risk"
        );
        assert!(matches!(prop.source, ProposalSource::Ai { .. }));
        assert_eq!(gw.mutations(), 0);

        let prompt = p.prompt.lock().unwrap().clone();
        for secret in ["supersecret-value-123", "hunter2", "tok-abc"] {
            assert!(
                !prompt.contains(secret),
                "secret {secret} leaked into AI prompt"
            );
        }
        assert!(prompt.contains("[REDACTED]"));
        assert!(prompt.contains("payment-api") && prompt.contains("CrashLoopBackOff"));
        assert!(prompt.contains("Secret/payment-db (values not sent)"));
        assert!(!prompt.contains("managedFields"));

        let diag = inc.diagnosis.unwrap();
        assert_eq!(diag["model"], "fake-model");
        assert!(diag["context"]["redactions"].as_u64().unwrap() >= 3);
        assert!(svc
            .audit_for(&inc.id)
            .iter()
            .any(|r| r.event == AuditEvent::DiagnosisCompleted));
    }

    #[tokio::test]
    async fn diagnosis_is_cached_until_reanalyze() {
        let (svc, _, _) = setup();
        let (inc, _) = svc.upsert_detected(incident("payments"));
        let p = FakeProvider::returning(Ok(diagnosis(restart_action())));
        analysis::analyze(&svc, &FakeReader, Ok(&p), &enabled(), &inc.id, false)
            .await
            .unwrap();
        analysis::analyze(&svc, &FakeReader, Ok(&p), &enabled(), &inc.id, false)
            .await
            .unwrap();
        assert_eq!(p.calls(), 1, "same evidence → no second AI call");
        let again = analysis::analyze(&svc, &FakeReader, Ok(&p), &enabled(), &inc.id, true)
            .await
            .unwrap();
        assert_eq!(p.calls(), 2, "explicit re-analyze calls the provider");
        assert_eq!(again.status, IncidentStatus::PendingApproval);
        assert_eq!(
            again.proposals.len(),
            2,
            "re-analysis creates a new proposal; old approval would not apply"
        );
    }

    #[tokio::test]
    async fn unsupported_or_unrelated_ai_actions_require_manual_intervention() {
        for action in [
            json!({"type":"DELETE_NAMESPACE","namespace":"payments"}),
            json!({"type":"ROLLOUT_RESTART","namespace":"payments","kind":"Deployment","name":"ledger"}),
            json!({"type":"ROLLOUT_RESTART","namespace":"payments","kind":"Deployment","name":"payment-api","command":"kubectl delete ns payments"}),
            Value::Null,
        ] {
            let (svc, gw, _) = setup();
            let (inc, _) = svc.upsert_detected(incident("payments"));
            let p = FakeProvider::returning(Ok(diagnosis(action.clone())));
            let inc = analysis::analyze(&svc, &FakeReader, Ok(&p), &enabled(), &inc.id, false)
                .await
                .unwrap();
            assert_eq!(
                inc.status,
                IncidentStatus::ManualInterventionRequired,
                "{action}"
            );
            assert!(inc.proposals.is_empty(), "{action}");
            assert!(inc.diagnosis.is_some(), "diagnosis kept for the operator");
            assert_eq!(gw.mutations(), 0);
        }
    }

    /// Opt-in: `cargo test --lib live_claude_cli -- --ignored`. Uses the real
    /// local claude CLI with a synthetic incident and fake cluster reader.
    #[tokio::test]
    #[ignore]
    async fn live_claude_cli_diagnosis() {
        let (svc, gw, _) = setup();
        let (inc, _) = svc.upsert_detected(incident("payments"));
        let cfg = AiConfig {
            enabled: true,
            model: Some("sonnet".into()),
            max_budget_usd: 0.5,
            ..Default::default()
        };
        let provider = crate::healing::provider::ClaudeCliProvider::from_config(&cfg, None)
            .expect("claude CLI installed");
        let result =
            analysis::analyze(&svc, &FakeReader, Ok(&provider), &cfg, &inc.id, false).await;
        let inc = svc.incident(&inc.id).unwrap();
        eprintln!(
            "result ok={} status={} error={:?}",
            result.is_ok(),
            inc.status,
            inc.diagnosis_error
        );
        eprintln!(
            "diagnosis={}",
            serde_json::to_string_pretty(&inc.diagnosis).unwrap()
        );
        assert!(matches!(
            inc.status,
            IncidentStatus::PendingApproval | IncidentStatus::ManualInterventionRequired
        ));
        assert_eq!(gw.mutations(), 0);
    }

    #[tokio::test]
    async fn prose_or_invalid_ai_output_is_rejected() {
        let (svc, gw, _) = setup();
        let (inc, _) = svc.upsert_detected(incident("payments"));
        let p = FakeProvider::returning(Ok(json!(
            "Just run kubectl rollout restart deployment/payment-api"
        )));
        assert!(
            analysis::analyze(&svc, &FakeReader, Ok(&p), &enabled(), &inc.id, false)
                .await
                .is_err()
        );
        let inc = svc.incident(&inc.id).unwrap();
        assert_eq!(inc.status, IncidentStatus::Detected);
        assert!(inc.diagnosis_error.unwrap().contains("invalid diagnosis"));
        assert_eq!(gw.mutations(), 0);
    }
}

// ── Structural proof: a single mutation entry point ───────────────────────────

fn rust_sources(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().map_or(false, |e| e == "rs") {
            let rel = path
                .strip_prefix(env!("CARGO_MANIFEST_DIR"))
                .unwrap()
                .display()
                .to_string();
            out.push((rel, std::fs::read_to_string(&path).unwrap()));
        }
    }
}

/// `ExecutionPermit::new` (and therefore `ClusterGateway::apply`) is reachable
/// only from `service.rs`; there is no autonomous/auto-approve switch anywhere.
#[test]
fn only_the_approved_executor_can_mint_permits_or_apply() {
    let mut files = Vec::new();
    rust_sources(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    assert!(files.len() > 20);
    let this_file = "src/healing/tests.rs";
    for (path, src) in &files {
        if path == this_file {
            continue;
        }
        if src.contains("ExecutionPermit::new(") {
            assert_eq!(
                path, "src/healing/service.rs",
                "permit minted outside the executor in {path}"
            );
        }
        if src.contains(".apply(&permit") || src.contains(".apply(permit") {
            assert_eq!(
                path, "src/healing/service.rs",
                "gateway apply called outside the executor in {path}"
            );
        }
        let lower = src.to_lowercase();
        for banned in [
            "auto_approve",
            "autoapprove",
            "autonomous_healing",
            "enable_autonomous",
            "auto_execute",
        ] {
            assert!(!lower.contains(banned), "{banned} found in {path}");
        }
    }
    let service = &files
        .iter()
        .find(|(p, _)| p == "src/healing/service.rs")
        .unwrap()
        .1;
    assert_eq!(
        service.matches("ExecutionPermit::new(").count(),
        1,
        "exactly one permit mint site"
    );
}
