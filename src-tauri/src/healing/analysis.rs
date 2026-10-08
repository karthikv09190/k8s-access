//! Orchestrates an operator-requested AI diagnosis:
//!   sanitized context → provider → strict validation → (typed) proposal.
//! Runs only when the administrator clicks Analyze / Re-analyze. The result is
//! at most a PENDING_APPROVAL proposal; nothing here can execute it.

use super::context::{self, ContextMeta, IncidentContext};
use super::diagnosis::{self, Validated};
use super::error::{HealingError, HealingResult};
use super::gateway::ClusterGateway;
use super::model::*;
use super::provider::{user_prompt, AiConfig, DiagnosisProvider, SYSTEM_PROMPT};
use super::reader::ClusterReader;
use super::service::{Clock, HealingService};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Statuses in which a cached diagnosis is still current.
const CACHEABLE: [IncidentStatus; 3] = [
    IncidentStatus::PendingApproval,
    IncidentStatus::ProposalReady,
    IncidentStatus::ManualInterventionRequired,
];

/// Identifies "the same evidence": symptom codes per resource, affected
/// resources and a coarse restart bucket. Log noise does not invalidate it.
pub fn cache_key(inc: &Incident) -> String {
    let mut symptoms: Vec<String> = inc
        .symptoms
        .iter()
        .map(|s| format!("{}@{}/{}", s.code, s.resource.kind, s.resource.name))
        .collect();
    symptoms.sort();
    symptoms.dedup();
    let mut affected: Vec<String> = inc
        .affected
        .iter()
        .map(|a| format!("{}/{}", a.kind, a.name))
        .collect();
    affected.sort();
    let basis = json!({
        "resource": format!("{}/{}", inc.resource.kind, inc.resource.name),
        "symptoms": symptoms,
        "affected": affected,
        "restartBucket": inc.restart_count.map(|r| r / 10),
    });
    Sha256::digest(basis.to_string().as_bytes())
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

pub fn disabled_error() -> HealingError {
    HealingError::AiUnavailable(
        "AI diagnosis is disabled in Self-Healing settings. Inspect events, logs and metrics and use the existing resource actions.".into(),
    )
}

/// Exactly what would be sent to the provider, for the privacy preview.
pub async fn preview<R: ClusterReader>(
    reader: &R,
    inc: &Incident,
    cfg: &AiConfig,
) -> (IncidentContext, ContextMeta) {
    context::build(reader, inc, cfg.max_context_chars).await
}

pub async fn analyze<G, C, R, P>(
    svc: &HealingService<G, C>,
    reader: &R,
    provider: Result<&P, String>,
    cfg: &AiConfig,
    incident_id: &str,
    force: bool,
) -> HealingResult<Incident>
where
    G: ClusterGateway,
    C: Clock,
    R: ClusterReader,
    P: DiagnosisProvider,
{
    let inc = svc.incident(incident_id)?;
    if !cfg.enabled {
        return Err(disabled_error());
    }
    let provider = provider.map_err(HealingError::AiUnavailable)?;

    // Cost control: identical evidence → reuse the existing diagnosis.
    let key = cache_key(&inc);
    let cached = inc
        .diagnosis
        .as_ref()
        .and_then(|d| d.get("cacheKey"))
        .and_then(Value::as_str)
        == Some(key.as_str());
    if !force && cached && CACHEABLE.contains(&inc.status) {
        return Ok(inc);
    }

    svc.begin_analysis(incident_id)?;
    let (ctx, meta) = context::build(reader, &inc, cfg.max_context_chars).await;
    let ctx_json = serde_json::to_string_pretty(&ctx).unwrap_or_default();

    let resp = match provider
        .diagnose(SYSTEM_PROMPT, &user_prompt(&ctx_json), &diagnosis::schema())
        .await
    {
        Ok(r) => r,
        Err(e) => {
            svc.analysis_failed(incident_id, &format!("AI diagnosis unavailable: {}", e))?;
            return Err(HealingError::AiUnavailable(e));
        }
    };
    let validated = match diagnosis::validate(resp.output, &inc) {
        Ok(v) => v,
        Err(e) => {
            svc.analysis_failed(
                incident_id,
                &format!("AI returned an invalid diagnosis: {}", e),
            )?;
            return Err(HealingError::UnsupportedAiAction(format!(
                "invalid diagnosis: {}",
                e
            )));
        }
    };
    let (diag, action, unsupported) = match validated {
        Validated::Actionable(d, a) => (d, Some(a), None),
        Validated::NoAction(d) => (d, None, None),
        Validated::Unsupported(d, why) => (d, None, Some(why)),
    };

    let record = json!({
        "result": diag,
        "provider": provider.name(),
        "model": resp.model,
        "cacheKey": key,
        "at": svc.now(),
        "context": meta,
    });
    let detail = format!(
        "provider={} model={} confidence={:.2} contextChars={} redactions={} sections={} truncated={}",
        provider.name(),
        resp.model.as_deref().unwrap_or("default"),
        diag.confidence,
        meta.chars,
        meta.redactions,
        meta.sections.join(","),
        meta.truncated
    );
    svc.set_diagnosis(incident_id, record, &detail)?;

    match action {
        None => {
            let reason = match unsupported {
                Some(u) => format!("AI proposed an unsupported remediation: {}", u),
                None => "AI did not propose an automated remediation; manual intervention required"
                    .into(),
            };
            svc.require_manual(incident_id, &reason)?;
        }
        Some(action) => {
            let draft = ProposalDraft {
                kind: ProposalKind::Remediation,
                action,
                declared_risk: diag.risk_level,
                rationale: format!(
                    "{}\n\nProbable root cause: {}",
                    diag.summary, diag.probable_root_cause
                ),
                evidence: diag.evidence.clone(),
                expected_impact: diag.expected_impact.clone(),
                verification_steps: diag.verification_steps.clone(),
                rollback_plan: diag.rollback_strategy.clone(),
                confidence: Some(diag.confidence),
                source: ProposalSource::Ai {
                    provider: provider.name(),
                    model: resp.model.clone(),
                },
            };
            if let Err(e) = svc.create_proposal(incident_id, draft).await {
                svc.require_manual(incident_id, &e.to_string())?;
            }
        }
    }
    svc.incident(incident_id)
}

/// Kinds with at least one automated action; others (Node, Job, HelmRelease,
/// ReplicaSet…) can only ever be diagnosed, never healed.
pub const ACTIONABLE_KINDS: [&str; 4] = ["Deployment", "StatefulSet", "DaemonSet", "Pod"];

/// Open incidents in `context` that have not been diagnosed for their current
/// state (DETECTED / EXPIRED / STALE), most severe and most recent first.
pub fn batch_candidates(
    incidents: &[Incident],
    context: &str,
    skip_unactionable: bool,
) -> Vec<String> {
    let mut v: Vec<&Incident> = incidents
        .iter()
        .filter(|i| i.binding.context == context)
        .filter(|i| {
            matches!(
                i.status,
                IncidentStatus::Detected | IncidentStatus::Expired | IncidentStatus::Stale
            )
        })
        .filter(|i| !skip_unactionable || ACTIONABLE_KINDS.contains(&i.resource.kind.as_str()))
        .collect();
    v.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then(b.last_detected.cmp(&a.last_detected))
    });
    v.into_iter().map(|i| i.id.clone()).collect()
}

/// Provider errors that mean further calls will fail too (stop the batch).
pub fn is_usage_limit(msg: &str) -> bool {
    let m = msg.to_lowercase();
    [
        "session limit",
        "usage limit",
        "rate limit",
        "rate_limit",
        "quota",
        "credit balance",
        "overloaded",
    ]
    .iter()
    .any(|k| m.contains(k))
}

#[cfg(test)]
mod batch_tests {
    use super::*;

    fn inc(
        id: &str,
        ctx: &str,
        kind: &str,
        status: IncidentStatus,
        sev: Severity,
        last: Millis,
    ) -> Incident {
        let r = ResourceRef {
            kind: kind.into(),
            namespace: Some("ns".into()),
            name: id.into(),
            uid: None,
        };
        Incident {
            id: id.into(),
            key: id.into(),
            binding: ClusterBinding {
                context: ctx.into(),
                cluster_name: "c".into(),
                server: "s".into(),
            },
            severity: sev,
            status,
            resource: r,
            problem: "p".into(),
            symptoms: vec![],
            affected: vec![],
            restart_count: None,
            first_detected: 0,
            last_detected: last,
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
            conversation: vec![],
        }
    }

    #[test]
    fn selects_open_undiagnosed_in_context_most_severe_first() {
        use IncidentStatus::*;
        let all = vec![
            inc(
                "warn-dep",
                "dev",
                "Deployment",
                Detected,
                Severity::Warning,
                5,
            ),
            inc(
                "crit-dep",
                "dev",
                "Deployment",
                Detected,
                Severity::Critical,
                1,
            ),
            inc("job", "dev", "Job", Detected, Severity::Warning, 9),
            inc("node", "dev", "Node", Detected, Severity::Critical, 9),
            inc("stale", "dev", "StatefulSet", Stale, Severity::Warning, 2),
            inc(
                "pending",
                "dev",
                "Deployment",
                PendingApproval,
                Severity::Critical,
                9,
            ),
            inc(
                "manual",
                "dev",
                "Deployment",
                ManualInterventionRequired,
                Severity::Critical,
                9,
            ),
            inc("healed", "dev", "Deployment", Healed, Severity::Critical, 9),
            inc(
                "other-ctx",
                "apac",
                "Deployment",
                Detected,
                Severity::Critical,
                9,
            ),
        ];
        assert_eq!(
            batch_candidates(&all, "dev", true),
            vec!["crit-dep", "warn-dep", "stale"]
        );
        let with_all = batch_candidates(&all, "dev", false);
        assert!(with_all.contains(&"job".to_string()) && with_all.contains(&"node".to_string()));
        assert!(!with_all
            .iter()
            .any(|i| ["pending", "manual", "healed", "other-ctx"].contains(&i.as_str())));
    }

    #[test]
    fn usage_limits_stop_the_batch() {
        assert!(is_usage_limit(
            "AI provider error: You've hit your session limit · resets 2pm"
        ));
        assert!(is_usage_limit("429 rate_limit_error"));
        assert!(!is_usage_limit(
            "AI returned an invalid diagnosis: no evidence"
        ));
    }
}
