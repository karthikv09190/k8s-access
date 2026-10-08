//! Policy layer between approval and execution. Policy can only REFUSE; it
//! never approves and never executes anything.

use super::error::HealingError;
use super::model::{ActionType, HealingAction, HealingProposal, Millis, RiskLevel};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedResource {
    pub namespace: String,
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealingPolicy {
    /// Namespaces the executor will never touch.
    pub protected_namespaces: Vec<String>,
    /// Individual resources the executor will never touch.
    pub protected_resources: Vec<ProtectedResource>,
    /// kubeconfig contexts healing may target. Empty = any context.
    pub allowed_contexts: Vec<String>,
    /// Namespaces healing may target. Empty = any non-protected namespace.
    pub allowed_namespaces: Vec<String>,
    /// Action allow-list. Anything absent is refused.
    pub allowed_actions: Vec<ActionType>,
    /// Highest executable risk. CRITICAL is never executable regardless.
    pub max_risk: RiskLevel,
    pub max_replicas: u32,
    pub proposal_ttl_minutes: u32,
}

impl Default for HealingPolicy {
    fn default() -> Self {
        Self {
            protected_namespaces: vec![
                "kube-system".into(),
                "kube-public".into(),
                "kube-node-lease".into(),
            ],
            protected_resources: vec![],
            allowed_contexts: vec![],
            allowed_namespaces: vec![],
            allowed_actions: vec![
                ActionType::RestartPod,
                ActionType::RolloutRestart,
                ActionType::RollbackDeployment,
                ActionType::ScaleDeployment,
                ActionType::ScaleStatefulset,
            ],
            max_risk: RiskLevel::High,
            max_replicas: 50,
            proposal_ttl_minutes: 30,
        }
    }
}

/// RFC 1123 label/subdomain check. Also guarantees a name can never be
/// interpreted by kubectl as a flag (cannot start with '-').
pub fn is_valid_k8s_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.as_bytes()[s.len() - 1].is_ascii_alphanumeric()
}

impl HealingPolicy {
    pub fn ttl_ms(&self) -> Millis {
        (self.proposal_ttl_minutes.clamp(1, 24 * 60) as Millis) * 60_000
    }

    /// Validate the action itself (no time/state dependent checks).
    pub fn validate_action(
        &self,
        context: &str,
        action: &HealingAction,
        risk: RiskLevel,
    ) -> Result<(), HealingError> {
        let ns = action.namespace();
        let (kind, name) = action.target();

        if !is_valid_k8s_name(ns) || !is_valid_k8s_name(name) {
            return Err(HealingError::PolicyViolation(format!(
                "invalid namespace or resource name ({:?}/{:?})",
                ns, name
            )));
        }
        if !self.allowed_actions.contains(&action.action_type()) {
            return Err(HealingError::PolicyViolation(format!(
                "{:?} is not in the action allow-list",
                action.action_type()
            )));
        }
        if risk == RiskLevel::Critical {
            return Err(HealingError::ManualInterventionRequired(
                "CRITICAL actions are never executed by self-healing".into(),
            ));
        }
        if risk > self.max_risk {
            return Err(HealingError::PolicyViolation(format!(
                "risk {:?} exceeds policy maximum {:?}",
                risk, self.max_risk
            )));
        }
        if !self.allowed_contexts.is_empty() && !self.allowed_contexts.iter().any(|c| c == context)
        {
            return Err(HealingError::PolicyViolation(format!(
                "context {} is not allowed",
                context
            )));
        }
        if self.protected_namespaces.iter().any(|p| p == ns) {
            return Err(HealingError::Protected(format!(
                "namespace {} is protected",
                ns
            )));
        }
        if !self.allowed_namespaces.is_empty() && !self.allowed_namespaces.iter().any(|a| a == ns) {
            return Err(HealingError::PolicyViolation(format!(
                "namespace {} is not allowed",
                ns
            )));
        }
        if self
            .protected_resources
            .iter()
            .any(|p| p.namespace == ns && p.kind.eq_ignore_ascii_case(kind) && p.name == name)
        {
            return Err(HealingError::Protected(format!(
                "{}/{} in {} is protected",
                kind, name, ns
            )));
        }
        match action {
            HealingAction::ScaleDeployment { replicas, .. }
            | HealingAction::ScaleStatefulSet { replicas, .. } => {
                if *replicas == 0 {
                    return Err(HealingError::PolicyViolation(
                        "scaling to 0 replicas is an outage, not a remediation".into(),
                    ));
                }
                if *replicas > self.max_replicas {
                    return Err(HealingError::PolicyViolation(format!(
                        "replicas {} exceeds policy maximum {}",
                        replicas, self.max_replicas
                    )));
                }
            }
            HealingAction::RollbackDeployment { to_revision, .. } => {
                if *to_revision == 0 {
                    return Err(HealingError::PolicyViolation("revision must be ≥ 1".into()));
                }
            }
            HealingAction::RestartPod { .. } | HealingAction::RolloutRestart { .. } => {}
        }
        Ok(())
    }

    /// Full validation of a stored proposal at approval/execution time.
    pub fn validate_proposal(&self, p: &HealingProposal, now: Millis) -> Result<(), HealingError> {
        if let Some(reason) = &p.blocked_reason {
            return Err(HealingError::ManualInterventionRequired(reason.clone()));
        }
        if now > p.expires_at {
            return Err(HealingError::Expired);
        }
        if p.risk < p.action.base_risk() {
            return Err(HealingError::PolicyViolation(
                "proposal risk is below the action's base risk".into(),
            ));
        }
        // A pod restart is only a remediation when a controller recreates it.
        if let HealingAction::RestartPod { .. } = &p.action {
            let owned = p
                .baseline
                .observed
                .get("controllerKind")
                .map(String::as_str);
            if !matches!(
                owned,
                Some("ReplicaSet") | Some("StatefulSet") | Some("DaemonSet")
            ) {
                return Err(HealingError::PolicyViolation(
                    "pod has no ReplicaSet/StatefulSet/DaemonSet controller to recreate it".into(),
                ));
            }
        }
        self.validate_action(&p.binding.context, &p.action, p.risk)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::healing::model::WorkloadKind;

    fn restart(ns: &str, name: &str) -> HealingAction {
        HealingAction::RolloutRestart {
            namespace: ns.into(),
            kind: WorkloadKind::Deployment,
            name: name.into(),
        }
    }

    #[test]
    fn rejects_flag_like_and_shell_names() {
        assert!(!is_valid_k8s_name("--all"));
        assert!(!is_valid_k8s_name("-n"));
        assert!(!is_valid_k8s_name("foo;rm -rf /"));
        assert!(!is_valid_k8s_name("foo bar"));
        assert!(!is_valid_k8s_name("Foo"));
        assert!(!is_valid_k8s_name(""));
        assert!(is_valid_k8s_name("payment-api"));
        assert!(is_valid_k8s_name("payment-api-7d9f8b-x2k4p"));
    }

    #[test]
    fn protected_namespace_blocked() {
        let p = HealingPolicy::default();
        let err = p
            .validate_action("ctx", &restart("kube-system", "coredns"), RiskLevel::Medium)
            .unwrap_err();
        assert!(matches!(err, HealingError::Protected(_)));
    }

    #[test]
    fn protected_resource_blocked() {
        let mut p = HealingPolicy::default();
        p.protected_resources.push(ProtectedResource {
            namespace: "payments".into(),
            kind: "Deployment".into(),
            name: "ledger".into(),
        });
        assert!(matches!(
            p.validate_action("ctx", &restart("payments", "ledger"), RiskLevel::Medium),
            Err(HealingError::Protected(_))
        ));
        assert!(p
            .validate_action(
                "ctx",
                &restart("payments", "payment-api"),
                RiskLevel::Medium
            )
            .is_ok());
    }

    #[test]
    fn critical_never_allowed_even_if_max_risk_raised() {
        let mut p = HealingPolicy::default();
        p.max_risk = RiskLevel::Critical;
        assert!(matches!(
            p.validate_action("ctx", &restart("payments", "api"), RiskLevel::Critical),
            Err(HealingError::ManualInterventionRequired(_))
        ));
    }

    #[test]
    fn action_allow_list_enforced() {
        let mut p = HealingPolicy::default();
        p.allowed_actions = vec![ActionType::RestartPod];
        assert!(matches!(
            p.validate_action("ctx", &restart("payments", "api"), RiskLevel::Medium),
            Err(HealingError::PolicyViolation(_))
        ));
    }

    #[test]
    fn context_and_namespace_allow_lists() {
        let mut p = HealingPolicy::default();
        p.allowed_contexts = vec!["cluster-eks-apac".into()];
        assert!(p
            .validate_action("other", &restart("payments", "api"), RiskLevel::Medium)
            .is_err());
        assert!(p
            .validate_action(
                "cluster-eks-apac",
                &restart("payments", "api"),
                RiskLevel::Medium
            )
            .is_ok());
        p.allowed_namespaces = vec!["web".into()];
        assert!(p
            .validate_action(
                "cluster-eks-apac",
                &restart("payments", "api"),
                RiskLevel::Medium
            )
            .is_err());
    }

    #[test]
    fn scale_bounds() {
        let p = HealingPolicy::default();
        let scale = |r| HealingAction::ScaleDeployment {
            namespace: "payments".into(),
            name: "api".into(),
            replicas: r,
        };
        assert!(p.validate_action("c", &scale(0), RiskLevel::High).is_err());
        assert!(p.validate_action("c", &scale(51), RiskLevel::High).is_err());
        assert!(p.validate_action("c", &scale(3), RiskLevel::High).is_ok());
    }

    #[test]
    fn risk_above_max_refused() {
        let mut p = HealingPolicy::default();
        p.max_risk = RiskLevel::Medium;
        let rb = HealingAction::RollbackDeployment {
            namespace: "payments".into(),
            name: "api".into(),
            to_revision: 3,
        };
        assert!(matches!(
            p.validate_action("c", &rb, RiskLevel::High),
            Err(HealingError::PolicyViolation(_))
        ));
    }
}
