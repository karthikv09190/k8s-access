//! Derives the action that restores the state captured before an execution.
//! The result is only ever turned into a NEW proposal that needs its own
//! explicit approval — rollback is never executed automatically.

use super::model::{HealingAction, StateSnapshot, WorkloadKind};

pub fn rollback_action(
    executed: &HealingAction,
    pre: &StateSnapshot,
) -> Result<HealingAction, String> {
    match executed {
        HealingAction::ScaleDeployment {
            namespace, name, ..
        } => Ok(HealingAction::ScaleDeployment {
            namespace: namespace.clone(),
            name: name.clone(),
            replicas: prior_replicas(pre)?,
        }),
        HealingAction::ScaleStatefulSet {
            namespace, name, ..
        } => Ok(HealingAction::ScaleStatefulSet {
            namespace: namespace.clone(),
            name: name.clone(),
            replicas: prior_replicas(pre)?,
        }),
        HealingAction::RolloutRestart {
            namespace,
            kind: WorkloadKind::Deployment,
            name,
        }
        | HealingAction::RollbackDeployment {
            namespace, name, ..
        } => {
            let rev = pre.revision.ok_or("pre-change revision was not captured")?;
            Ok(HealingAction::RollbackDeployment {
                namespace: namespace.clone(),
                name: name.clone(),
                to_revision: rev,
            })
        }
        HealingAction::RolloutRestart { kind, .. } => Err(format!(
            "{} rollout restart has no revision-based rollback; inspect manually",
            kind.as_str()
        )),
        HealingAction::RestartPod { .. } => {
            Err("a deleted pod cannot be restored; its controller already replaced it".into())
        }
        // A template patch creates a new Deployment revision; roll back to the
        // revision captured before the patch.
        HealingAction::PatchWorkload {
            namespace,
            kind: WorkloadKind::Deployment,
            name,
            ..
        } => {
            let rev = pre.revision.ok_or("pre-change revision was not captured")?;
            Ok(HealingAction::RollbackDeployment {
                namespace: namespace.clone(),
                name: name.clone(),
                to_revision: rev,
            })
        }
        HealingAction::PatchWorkload { kind, .. } => Err(format!(
            "{} patch has no revision-based rollback; revert the fields manually",
            kind.as_str()
        )),
    }
}

fn prior_replicas(pre: &StateSnapshot) -> Result<u32, String> {
    pre.replicas
        .filter(|r| *r > 0)
        .map(|r| r as u32)
        .ok_or_else(|| "pre-change replica count was not captured".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_rollback_restores_replicas() {
        let a = HealingAction::ScaleDeployment {
            namespace: "p".into(),
            name: "api".into(),
            replicas: 5,
        };
        let pre = StateSnapshot {
            replicas: Some(2),
            ..Default::default()
        };
        assert_eq!(
            rollback_action(&a, &pre).unwrap(),
            HealingAction::ScaleDeployment {
                namespace: "p".into(),
                name: "api".into(),
                replicas: 2
            }
        );
    }

    #[test]
    fn restart_rolls_back_to_captured_revision() {
        let a = HealingAction::RolloutRestart {
            namespace: "p".into(),
            kind: WorkloadKind::Deployment,
            name: "api".into(),
        };
        let pre = StateSnapshot {
            revision: Some(7),
            ..Default::default()
        };
        assert_eq!(
            rollback_action(&a, &pre).unwrap(),
            HealingAction::RollbackDeployment {
                namespace: "p".into(),
                name: "api".into(),
                to_revision: 7
            }
        );
    }

    #[test]
    fn pod_restart_has_no_rollback() {
        let a = HealingAction::RestartPod {
            namespace: "p".into(),
            pod: "api-1".into(),
        };
        assert!(rollback_action(&a, &StateSnapshot::default()).is_err());
    }
}
