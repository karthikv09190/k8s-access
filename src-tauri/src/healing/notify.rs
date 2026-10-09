//! Maps audit events to notification-center alerts. Notifications are derived
//! only from recorded events, so "Healing succeeded" can appear only after a
//! real execution passed verification.

use super::audit::{AuditEvent, AuditRecord};
use super::model::Millis;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealingNotification {
    pub id: String,
    pub context: String,
    /// "info" | "warning" | "critical" (notification center severities)
    pub severity: String,
    pub message: String,
    pub timestamp: String,
    pub incident_id: String,
}

pub fn rfc3339(ms: Millis) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    // civil from days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        sod / 3600,
        (sod / 60) % 60,
        sod % 60
    )
}

pub fn notification_for(r: &AuditRecord) -> Option<HealingNotification> {
    let res = &r.resource;
    let who = r
        .operator
        .as_ref()
        .map(|o| o.os_user.as_str())
        .unwrap_or("operator");
    let (severity, message) = match r.event {
        AuditEvent::IncidentDetected => (
            "warning",
            format!("New self-healing incident: {} — {}", res, r.detail),
        ),
        AuditEvent::DiagnosisCompleted => ("info", format!("AI diagnosis complete for {}", res)),
        AuditEvent::DiagnosisFailed => (
            "warning",
            format!("AI diagnosis unavailable for {}: {}", res, r.detail),
        ),
        AuditEvent::ProposalCreated => (
            "warning",
            format!(
                "Healing proposal ready — approval required: {} ({})",
                r.detail, res
            ),
        ),
        AuditEvent::ProposalBlocked => (
            "critical",
            format!("Manual intervention required for {}: {}", res, r.detail),
        ),
        AuditEvent::Approved => ("info", format!("Healing approved for {} by {}", res, who)),
        AuditEvent::Rejected => (
            "info",
            format!("Healing proposal rejected for {} by {}", res, who),
        ),
        AuditEvent::ExecutionClaimed => ("info", format!("Healing execution started: {}", res)),
        AuditEvent::Executed => (
            "info",
            format!(
                "Healing action applied to {} — verifying (not yet healed)",
                res
            ),
        ),
        AuditEvent::ExecutionFailed => (
            "critical",
            format!("Healing failed for {}: {}", res, r.detail),
        ),
        AuditEvent::PreflightFailed if r.detail.contains("stale") => (
            "warning",
            format!(
                "Proposal became stale for {} — nothing was changed. Re-analyze.",
                res
            ),
        ),
        AuditEvent::PreflightFailed => (
            "critical",
            format!(
                "Healing aborted before execution for {} — nothing was changed: {}",
                res, r.detail
            ),
        ),
        AuditEvent::VerificationPassed => (
            "info",
            format!("Healing succeeded: {} verified healthy", res),
        ),
        AuditEvent::VerificationFailed => (
            "critical",
            format!("Healing failed verification for {}", res),
        ),
        AuditEvent::Expired => (
            "warning",
            format!("Healing proposal expired for {} — nothing was changed", res),
        ),
        AuditEvent::RollbackProposed => (
            "warning",
            format!("Rollback proposal created for {} — approval required", res),
        ),
        AuditEvent::Interrupted => (
            "critical",
            format!(
                "Healing for {} was interrupted by an app restart; verify manually",
                res
            ),
        ),
        AuditEvent::AnalysisStarted
        | AuditEvent::ApprovalRefused
        | AuditEvent::ExecutionRefused
        | AuditEvent::ChatExchange
        | AuditEvent::IncidentResolved => return None,
    };
    Some(HealingNotification {
        id: format!("healing-{}", r.id),
        context: r.context.clone(),
        severity: severity.into(),
        message,
        timestamp: rfc3339(r.at),
        incident_id: r.incident_id.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(event: AuditEvent, detail: &str) -> AuditRecord {
        AuditRecord {
            id: "a1".into(),
            at: 1_791_417_600_000,
            event,
            incident_id: "i1".into(),
            proposal_id: None,
            proposal_hash: None,
            context: "ctx".into(),
            namespace: Some("payments".into()),
            resource: "Deployment/payment-api".into(),
            resource_uid: None,
            operator: None,
            action: None,
            detail: detail.into(),
        }
    }

    #[test]
    fn timestamps() {
        assert_eq!(rfc3339(1_791_417_600_000), "2026-10-08T00:00:00Z");
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400_000), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn only_verification_claims_success() {
        for ev in [
            AuditEvent::IncidentDetected,
            AuditEvent::DiagnosisCompleted,
            AuditEvent::ProposalCreated,
            AuditEvent::Approved,
            AuditEvent::ExecutionClaimed,
            AuditEvent::Executed,
            AuditEvent::PreflightFailed,
            AuditEvent::Expired,
            AuditEvent::RollbackProposed,
        ] {
            if let Some(n) = notification_for(&rec(ev, "x")) {
                assert!(
                    !n.message.contains("succeeded") && !n.message.contains("healed "),
                    "{ev:?}: {}",
                    n.message
                );
            }
        }
        let ok = notification_for(&rec(AuditEvent::VerificationPassed, "Healthy")).unwrap();
        assert!(ok.message.contains("succeeded"));
        assert_eq!(ok.incident_id, "i1");
    }

    #[test]
    fn stale_and_failure_messages() {
        let stale = notification_for(&rec(
            AuditEvent::PreflightFailed,
            "Proposal is stale because x",
        ))
        .unwrap();
        assert!(stale.message.contains("stale") && stale.message.contains("nothing was changed"));
        assert_eq!(
            notification_for(&rec(AuditEvent::ExecutionFailed, "forbidden"))
                .unwrap()
                .severity,
            "critical"
        );
        assert!(notification_for(&rec(AuditEvent::AnalysisStarted, "")).is_none());
    }
}
