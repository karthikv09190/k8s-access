//! Cluster access for Self-Healing.
//!
//! `ClusterGateway` has exactly one mutating method, `apply`, and it requires
//! an `ExecutionPermit`. A permit can only be minted inside
//! `service::HealingService::execute_approved` after approval, integrity,
//! cluster-binding, policy and pre-flight checks pass — so no other code path
//! (detector, AI provider, policy, notification, background task) can mutate
//! the cluster through this module.

use super::model::{
    ClusterBinding, HealingAction, HealthObservation, ResourceFingerprint, StateSnapshot,
    VerificationTarget, WorkloadKind,
};
use super::service::ExecutionPermit;
use crate::kubectl::kubectl_path;
use serde_json::Value;
use std::collections::BTreeMap;

pub struct GatewayOutput {
    pub command: Vec<String>,
    pub output: String,
}

#[allow(async_fn_in_trait)]
pub trait ClusterGateway: Send + Sync {
    /// API server URL the kubeconfig context currently points at.
    async fn context_server(&self, context: &str) -> Result<Option<String>, String>;
    /// State that, when changed, makes a proposal stale.
    async fn fingerprint(
        &self,
        binding: &ClusterBinding,
        action: &HealingAction,
    ) -> Result<ResourceFingerprint, String>;
    async fn snapshot(
        &self,
        binding: &ClusterBinding,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<StateSnapshot, String>;
    async fn health(
        &self,
        binding: &ClusterBinding,
        target: &VerificationTarget,
    ) -> Result<HealthObservation, String>;
    async fn gitops_owner(
        &self,
        binding: &ClusterBinding,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<String>, String>;
    /// The ONLY mutating operation.
    async fn apply(&self, permit: &ExecutionPermit) -> Result<GatewayOutput, String>;
    /// Read the full workload object (patch generation).
    async fn workload_object(
        &self,
        binding: &ClusterBinding,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Value, String>;
    /// `kubectl patch --dry-run=server`: validated by the API server, never
    /// persisted. Used only to preview a proposal.
    async fn dry_run_patch(
        &self,
        binding: &ClusterBinding,
        kind: &str,
        namespace: &str,
        name: &str,
        patch: &Value,
    ) -> Result<Value, String>;
}

/// argv (without the kubectl binary) that `apply` runs for an action. Used for
/// the approval preview and the audit trail. Names are policy-validated
/// RFC 1123 strings, passed as separate arguments — never through a shell.
pub fn kubectl_argv(context: &str, action: &HealingAction, patch: Option<&Value>) -> Vec<String> {
    let s = |v: &str| v.to_string();
    match action {
        HealingAction::RestartPod { namespace, pod } => vec![
            s("delete"),
            s("pod"),
            s(pod),
            s("--context"),
            s(context),
            s("-n"),
            s(namespace),
        ],
        HealingAction::RolloutRestart {
            namespace,
            kind,
            name,
        } => vec![
            s("rollout"),
            s("restart"),
            s("--context"),
            s(context),
            s("-n"),
            s(namespace),
            format!("{}/{}", kind.as_str().to_lowercase(), name),
        ],
        HealingAction::RollbackDeployment {
            namespace,
            name,
            to_revision,
        } => vec![
            s("rollout"),
            s("undo"),
            s("--context"),
            s(context),
            s("-n"),
            s(namespace),
            format!("deployment/{}", name),
            format!("--to-revision={}", to_revision),
        ],
        HealingAction::ScaleDeployment {
            namespace,
            name,
            replicas,
        } => vec![
            s("scale"),
            s("--context"),
            s(context),
            s("-n"),
            s(namespace),
            format!("deployment/{}", name),
            format!("--replicas={}", replicas),
        ],
        HealingAction::ScaleStatefulSet {
            namespace,
            name,
            replicas,
        } => vec![
            s("scale"),
            s("--context"),
            s(context),
            s("-n"),
            s(namespace),
            format!("statefulset/{}", name),
            format!("--replicas={}", replicas),
        ],
        HealingAction::PatchWorkload {
            namespace,
            kind,
            name,
            ..
        } => vec![
            s("patch"),
            format!("{}/{}", kind.as_str().to_lowercase(), name),
            s("--context"),
            s(context),
            s("-n"),
            s(namespace),
            s("--type"),
            s("strategic"),
            s("-p"),
            patch.map(|p| p.to_string()).unwrap_or_default(),
        ],
    }
}

/// Server-side dry run of a workload patch: the API server validates and
/// admits it but persists nothing. Always carries `--dry-run=server`.
pub fn dry_run_argv(
    context: &str,
    kind: &str,
    namespace: &str,
    name: &str,
    patch: &Value,
) -> Vec<String> {
    vec![
        "patch".into(),
        format!("{}/{}", kind.to_lowercase(), name),
        "--context".into(),
        context.into(),
        "-n".into(),
        namespace.into(),
        "--type".into(),
        "strategic".into(),
        "-p".into(),
        patch.to_string(),
        "--dry-run=server".into(),
        "-o".into(),
        "json".into(),
    ]
}

async fn run_kubectl(args: &[String]) -> Result<String, String> {
    let out = tokio::process::Command::new(kubectl_path())
        .args(args)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("failed to run kubectl: {}", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// ── JSON helpers (pure, unit-tested) ─────────────────────────────────────────

fn str_at<'a>(v: &'a Value, ptr: &str) -> Option<&'a str> {
    v.pointer(ptr).and_then(Value::as_str)
}

fn i64_at(v: &Value, ptr: &str) -> Option<i64> {
    v.pointer(ptr).and_then(Value::as_i64)
}

pub fn controller_owner(obj: &Value) -> Option<(String, String)> {
    obj.pointer("/metadata/ownerReferences")?
        .as_array()?
        .iter()
        .find(|o| o.get("controller").and_then(Value::as_bool) == Some(true))
        .map(|o| {
            (
                o.get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                o.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            )
        })
}

pub fn images(obj: &Value) -> Vec<String> {
    let ptr = if obj.pointer("/spec/template").is_some() {
        "/spec/template/spec/containers"
    } else {
        "/spec/containers"
    };
    obj.pointer(ptr)
        .and_then(Value::as_array)
        .map(|cs| {
            cs.iter()
                .filter_map(|c| c.get("image").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn revision(obj: &Value) -> Option<u32> {
    str_at(
        obj,
        "/metadata/annotations/deployment.kubernetes.io~1revision",
    )
    .and_then(|s| s.parse().ok())
}

pub fn workload_fingerprint(obj: &Value) -> ResourceFingerprint {
    let mut observed = BTreeMap::new();
    if let Some(r) = i64_at(obj, "/spec/replicas") {
        observed.insert("replicas".into(), r.to_string());
    }
    if let Some(r) = revision(obj) {
        observed.insert("revision".into(), r.to_string());
    }
    observed.insert("images".into(), images(obj).join(","));
    ResourceFingerprint {
        uid: str_at(obj, "/metadata/uid").unwrap_or_default().to_string(),
        generation: i64_at(obj, "/metadata/generation"),
        observed,
    }
}

pub fn pod_fingerprint(pod: &Value, workload: Option<(String, String)>) -> ResourceFingerprint {
    let mut observed = BTreeMap::new();
    if let Some((k, n)) = controller_owner(pod) {
        observed.insert("controllerKind".into(), k);
        observed.insert("controllerName".into(), n);
    }
    if let Some((k, n)) = workload {
        observed.insert("workloadKind".into(), k);
        observed.insert("workloadName".into(), n);
    }
    ResourceFingerprint {
        uid: str_at(pod, "/metadata/uid").unwrap_or_default().to_string(),
        generation: None,
        observed,
    }
}

pub fn snapshot_of(obj: &Value) -> StateSnapshot {
    let replicas = i64_at(obj, "/spec/replicas");
    let ready = match (i64_at(obj, "/status/readyReplicas"), replicas) {
        (r, Some(d)) => Some(format!("{}/{}", r.unwrap_or(0), d)),
        _ => str_at(obj, "/status/phase").map(str::to_string),
    };
    StateSnapshot {
        replicas,
        revision: revision(obj),
        generation: i64_at(obj, "/metadata/generation"),
        images: images(obj),
        ready,
    }
}

pub fn workload_health(
    kind: WorkloadKind,
    obj: &Value,
    expected: Option<u32>,
) -> HealthObservation {
    let generation = i64_at(obj, "/metadata/generation").unwrap_or(0);
    let observed_gen = i64_at(obj, "/status/observedGeneration").unwrap_or(0);
    let n = |p: &str| i64_at(obj, p).unwrap_or(0);
    let (healthy, detail) = match kind {
        WorkloadKind::Deployment => {
            let desired = i64_at(obj, "/spec/replicas").unwrap_or(1);
            let ok = observed_gen >= generation
                && n("/status/updatedReplicas") == desired
                && n("/status/readyReplicas") == desired
                && n("/status/availableReplicas") == desired
                && n("/status/unavailableReplicas") == 0
                && expected.map_or(true, |e| e as i64 == desired);
            (
                ok,
                format!(
                    "desired={} updated={} ready={} available={} gen={}/{}",
                    desired,
                    n("/status/updatedReplicas"),
                    n("/status/readyReplicas"),
                    n("/status/availableReplicas"),
                    observed_gen,
                    generation
                ),
            )
        }
        WorkloadKind::StatefulSet => {
            let desired = i64_at(obj, "/spec/replicas").unwrap_or(1);
            let ok = observed_gen >= generation
                && n("/status/readyReplicas") == desired
                && n("/status/updatedReplicas") == desired
                && str_at(obj, "/status/currentRevision") == str_at(obj, "/status/updateRevision")
                && expected.map_or(true, |e| e as i64 == desired);
            (
                ok,
                format!(
                    "desired={} ready={} updated={} gen={}/{}",
                    desired,
                    n("/status/readyReplicas"),
                    n("/status/updatedReplicas"),
                    observed_gen,
                    generation
                ),
            )
        }
        WorkloadKind::DaemonSet => {
            let desired = n("/status/desiredNumberScheduled");
            let ok = observed_gen >= generation
                && n("/status/numberReady") == desired
                && n("/status/updatedNumberScheduled") == desired
                && n("/status/numberUnavailable") == 0;
            (
                ok,
                format!(
                    "desired={} ready={} updated={} gen={}/{}",
                    desired,
                    n("/status/numberReady"),
                    n("/status/updatedNumberScheduled"),
                    observed_gen,
                    generation
                ),
            )
        }
    };
    HealthObservation { healthy, detail }
}

/// Detects GitOps ownership from well-known labels/annotations.
pub fn gitops_owner_of(obj: &Value) -> Option<String> {
    let label = |k: &str| {
        obj.pointer("/metadata/labels")
            .and_then(|l| l.get(k))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let annotation = |k: &str| {
        obj.pointer("/metadata/annotations")
            .and_then(|l| l.get(k))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    if let Some(id) = annotation("argocd.argoproj.io/tracking-id") {
        let app = id.split(':').next().unwrap_or(&id).to_string();
        return Some(format!("Argo CD (application {})", app));
    }
    if let Some(app) = label("argocd.argoproj.io/instance") {
        return Some(format!("Argo CD (application {})", app));
    }
    if let Some(k) = label("kustomize.toolkit.fluxcd.io/name") {
        return Some(format!("Flux Kustomization {}", k));
    }
    if let Some(h) = label("helm.toolkit.fluxcd.io/name") {
        return Some(format!("Flux HelmRelease {}", h));
    }
    None
}

// ── kubectl-backed implementation ────────────────────────────────────────────

pub struct KubectlGateway;

async fn kubectl_get_json(
    context: &str,
    namespace: &str,
    kind: &str,
    name: &str,
) -> Result<Value, String> {
    let kind_lower = kind.to_lowercase();
    let out = tokio::process::Command::new(kubectl_path())
        .args([
            "get",
            &kind_lower,
            name,
            "-n",
            namespace,
            "--context",
            context,
            "-o",
            "json",
        ])
        .output()
        .await
        .map_err(|e| format!("failed to run kubectl: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

impl ClusterGateway for KubectlGateway {
    async fn context_server(&self, context: &str) -> Result<Option<String>, String> {
        Ok(super::reader::kubeconfig_cluster(context)?.map(|(_, server)| server))
    }

    async fn fingerprint(
        &self,
        binding: &ClusterBinding,
        action: &HealingAction,
    ) -> Result<ResourceFingerprint, String> {
        let ns = action.namespace();
        let (kind, name) = action.target();
        let obj = kubectl_get_json(&binding.context, ns, kind, name).await?;
        if kind != "Pod" {
            return Ok(workload_fingerprint(&obj));
        }
        // Resolve the pod's top-level workload (ReplicaSet → Deployment).
        let workload = match controller_owner(&obj) {
            Some((k, n)) if k == "ReplicaSet" => {
                let rs = kubectl_get_json(&binding.context, ns, "replicaset", &n)
                    .await
                    .ok();
                rs.as_ref().and_then(controller_owner)
            }
            other => other,
        };
        Ok(pod_fingerprint(&obj, workload))
    }

    async fn snapshot(
        &self,
        binding: &ClusterBinding,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<StateSnapshot, String> {
        Ok(snapshot_of(
            &kubectl_get_json(&binding.context, namespace, kind, name).await?,
        ))
    }

    async fn health(
        &self,
        binding: &ClusterBinding,
        target: &VerificationTarget,
    ) -> Result<HealthObservation, String> {
        let obj = kubectl_get_json(
            &binding.context,
            &target.namespace,
            target.kind.as_str(),
            &target.name,
        )
        .await?;
        Ok(workload_health(target.kind, &obj, target.expected_replicas))
    }

    async fn gitops_owner(
        &self,
        binding: &ClusterBinding,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<String>, String> {
        Ok(gitops_owner_of(
            &kubectl_get_json(&binding.context, namespace, kind, name).await?,
        ))
    }

    async fn apply(&self, permit: &ExecutionPermit) -> Result<GatewayOutput, String> {
        use crate::commands::{exec, resources};
        let ctx = permit.binding().context.clone();
        let command = kubectl_argv(&ctx, permit.action(), permit.patch());
        // Reuse the existing resource-action implementations.
        let output = match permit.action().clone() {
            HealingAction::RestartPod { namespace, pod } => {
                resources::delete_resource(ctx, Some(namespace), "pod".into(), pod)
                    .await
                    .map(|_| "pod deleted".to_string())
            }
            HealingAction::RolloutRestart {
                namespace,
                kind,
                name,
            } => exec::restart_resource(ctx, namespace, kind.as_str().into(), name).await,
            HealingAction::RollbackDeployment {
                namespace,
                name,
                to_revision,
            } => {
                exec::rollback_rollout(ctx, namespace, "Deployment".into(), name, to_revision).await
            }
            HealingAction::ScaleDeployment {
                namespace,
                name,
                replicas,
            } => exec::scale_resource(ctx, namespace, "Deployment".into(), name, replicas).await,
            HealingAction::ScaleStatefulSet {
                namespace,
                name,
                replicas,
            } => exec::scale_resource(ctx, namespace, "StatefulSet".into(), name, replicas).await,
            HealingAction::PatchWorkload { .. } => {
                // The exact approved patch (stored in the sealed proposal).
                if permit.patch().is_none() {
                    return Err("approved patch is missing".into());
                }
                run_kubectl(&command).await
            }
        }?;
        Ok(GatewayOutput { command, output })
    }

    async fn workload_object(
        &self,
        binding: &ClusterBinding,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Value, String> {
        kubectl_get_json(&binding.context, namespace, kind, name).await
    }

    async fn dry_run_patch(
        &self,
        binding: &ClusterBinding,
        kind: &str,
        namespace: &str,
        name: &str,
        patch: &Value,
    ) -> Result<Value, String> {
        let out = run_kubectl(&dry_run_argv(
            &binding.context,
            kind,
            namespace,
            name,
            patch,
        ))
        .await?;
        serde_json::from_str(&out).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn patch_argv_and_dry_run_argv() {
        let patch = json!({"spec":{"template":{"spec":{"terminationGracePeriodSeconds":60}}}});
        let a = HealingAction::PatchWorkload {
            namespace: "payments".into(),
            kind: WorkloadKind::Deployment,
            name: "payment-api".into(),
            container: "api".into(),
            changes: Default::default(),
        };
        let apply = kubectl_argv("ctx", &a, Some(&patch));
        assert_eq!(&apply[..2], ["patch", "deployment/payment-api"]);
        assert!(apply.contains(&"strategic".to_string()));
        assert!(!apply.iter().any(|s| s.contains("dry-run")));
        assert_eq!(
            apply.last().unwrap(),
            &patch.to_string(),
            "patch JSON is one argv element"
        );
        let dry = dry_run_argv("ctx", "Deployment", "payments", "payment-api", &patch);
        assert!(dry.contains(&"--dry-run=server".to_string()));
    }

    #[test]
    fn argv_never_uses_shell_and_keeps_names_as_single_args() {
        let a = HealingAction::RolloutRestart {
            namespace: "payments".into(),
            kind: WorkloadKind::Deployment,
            name: "payment-api".into(),
        };
        let argv = kubectl_argv("cluster-eks-apac", &a, None);
        assert_eq!(
            argv,
            [
                "rollout",
                "restart",
                "--context",
                "cluster-eks-apac",
                "-n",
                "payments",
                "deployment/payment-api"
            ]
        );
        assert!(!argv.iter().any(|s| s == "sh" || s == "-c" || s == "bash"));
    }

    #[test]
    fn deployment_health() {
        let healthy = json!({"metadata":{"generation":4},"spec":{"replicas":3},
            "status":{"observedGeneration":4,"updatedReplicas":3,"readyReplicas":3,"availableReplicas":3}});
        assert!(workload_health(WorkloadKind::Deployment, &healthy, None).healthy);
        assert!(!workload_health(WorkloadKind::Deployment, &healthy, Some(5)).healthy);
        let rolling = json!({"metadata":{"generation":5},"spec":{"replicas":3},
            "status":{"observedGeneration":4,"updatedReplicas":3,"readyReplicas":3,"availableReplicas":3}});
        assert!(!workload_health(WorkloadKind::Deployment, &rolling, None).healthy);
        let unavailable = json!({"metadata":{"generation":4},"spec":{"replicas":3},
            "status":{"observedGeneration":4,"updatedReplicas":3,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":2}});
        assert!(!workload_health(WorkloadKind::Deployment, &unavailable, None).healthy);
    }

    #[test]
    fn gitops_detection() {
        let argo = json!({"metadata":{"annotations":{"argocd.argoproj.io/tracking-id":"payments-app:apps/Deployment:payments/payment-api"}}});
        assert_eq!(
            gitops_owner_of(&argo).unwrap(),
            "Argo CD (application payments-app)"
        );
        let flux = json!({"metadata":{"labels":{"kustomize.toolkit.fluxcd.io/name":"apps"}}});
        assert!(gitops_owner_of(&flux).unwrap().contains("Flux"));
        assert!(gitops_owner_of(&json!({"metadata":{}})).is_none());
    }

    #[test]
    fn fingerprint_tracks_spec_not_status() {
        let a = json!({"metadata":{"uid":"u1","generation":3,"annotations":{"deployment.kubernetes.io/revision":"7"}},
            "spec":{"replicas":2,"template":{"spec":{"containers":[{"image":"api:1.2"}]}}},"status":{"readyReplicas":0}});
        let mut b = a.clone();
        b["status"]["readyReplicas"] = json!(2);
        assert!(workload_fingerprint(&a)
            .diff(&workload_fingerprint(&b))
            .is_empty());
        b["spec"]["template"]["spec"]["containers"][0]["image"] = json!("api:1.3");
        assert!(!workload_fingerprint(&a)
            .diff(&workload_fingerprint(&b))
            .is_empty());
        assert_eq!(revision(&a), Some(7));
    }
}
