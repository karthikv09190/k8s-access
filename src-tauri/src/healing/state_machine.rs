//! Explicit incident state machine.
//!
//! `Executing` is reachable ONLY from `Approved`, and `Approved` is reachable
//! ONLY from `PendingApproval` — so every execution is preceded by an approval
//! of a pending proposal. There is no edge from detection, analysis, policy or
//! a ready-but-unreviewed proposal into execution.

use super::model::IncidentStatus::{self, *};

pub fn allowed_next(from: IncidentStatus) -> &'static [IncidentStatus] {
    match from {
        Detected => &[Analyzing, ManualInterventionRequired],
        // AI failure returns to Detected (manual remediation still possible).
        Analyzing => &[ProposalReady, Detected, ManualInterventionRequired],
        ProposalReady => &[PendingApproval, Analyzing, ManualInterventionRequired],
        PendingApproval => &[Approved, Rejected, Expired, Stale, Analyzing],
        Approved => &[Executing, Expired, Stale, ManualInterventionRequired],
        // Pre-flight runs after the Approved→Executing claim, so it can still
        // abort as Stale/Failed without touching the cluster.
        Executing => &[Verifying, Failed, Stale],
        Verifying => &[Healed, Failed, RolledBack],
        Failed => &[RollbackProposed, Analyzing, ManualInterventionRequired],
        RollbackProposed => &[PendingApproval, ManualInterventionRequired],
        Rejected => &[Analyzing],
        Expired => &[Analyzing],
        Stale => &[Analyzing],
        ManualInterventionRequired => &[Analyzing],
        Healed => &[],
        RolledBack => &[],
    }
}

pub fn can_transition(from: IncidentStatus, to: IncidentStatus) -> bool {
    allowed_next(from).contains(&to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executing_only_reachable_from_approved() {
        for from in IncidentStatus::ALL {
            let ok = can_transition(from, Executing);
            assert_eq!(
                ok,
                from == Approved,
                "{from} → EXECUTING must be {}",
                from == Approved
            );
        }
    }

    #[test]
    fn approved_only_reachable_from_pending_approval() {
        for from in IncidentStatus::ALL {
            assert_eq!(
                can_transition(from, Approved),
                from == PendingApproval,
                "{from} → APPROVED"
            );
        }
    }

    #[test]
    fn forbidden_shortcuts_do_not_exist() {
        assert!(!can_transition(Detected, Executing));
        assert!(!can_transition(Analyzing, Executing));
        assert!(!can_transition(ProposalReady, Executing));
        assert!(!can_transition(ProposalReady, Approved));
        assert!(!can_transition(Detected, Approved));
        assert!(!can_transition(Failed, Executing));
        assert!(!can_transition(RollbackProposed, Executing));
        assert!(!can_transition(RollbackProposed, Approved));
    }

    #[test]
    fn rollback_requires_new_approval_cycle() {
        assert!(can_transition(Failed, RollbackProposed));
        assert_eq!(
            allowed_next(RollbackProposed),
            &[PendingApproval, ManualInterventionRequired]
        );
    }

    #[test]
    fn terminal_states() {
        assert!(allowed_next(Healed).is_empty());
        assert!(allowed_next(RolledBack).is_empty());
    }
}
