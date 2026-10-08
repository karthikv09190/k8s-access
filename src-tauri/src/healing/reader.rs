//! Read-only cluster access for detection and diagnosis context.
//!
//! Every kubectl invocation goes through `run_read`, which refuses anything
//! other than `get`, `logs`, `top` and `rollout history`. Detection and
//! diagnosis therefore cannot mutate the cluster even by mistake.

use super::detector::{ClusterSnapshot, HelmReleaseLite};
use super::model::ClusterBinding;
use crate::kubectl::kubectl_path;
use serde_json::Value;
use std::time::Duration;

#[allow(async_fn_in_trait)]
pub trait ClusterReader: Send + Sync {
    async fn get_json(
        &self,
        context: &str,
        namespace: Option<&str>,
        kind: &str,
        name: &str,
    ) -> Result<Value, String>;
    /// `kinds` may be comma-separated. `namespace: None` lists all namespaces.
    async fn list_json(
        &self,
        context: &str,
        namespace: Option<&str>,
        kinds: &str,
        field_selector: Option<&str>,
    ) -> Result<Vec<Value>, String>;
    async fn logs(
        &self,
        context: &str,
        namespace: &str,
        pod: &str,
        container: &str,
        previous: bool,
        tail: u32,
    ) -> Result<String, String>;
    async fn rollout_history(
        &self,
        context: &str,
        namespace: &str,
        kind: &str,
        name: &str,
    ) -> Result<String, String>;
    async fn top_pods(&self, context: &str, namespace: &str) -> Result<String, String>;
    async fn helm_releases(&self, context: &str) -> Result<Vec<HelmReleaseLite>, String>;
}

/// Allow-list of kubectl verbs the reader may run.
pub fn is_read_only(args: &[String]) -> bool {
    match args.first().map(String::as_str) {
        Some("get") | Some("logs") | Some("top") => true,
        Some("rollout") => args.get(1).map(String::as_str) == Some("history"),
        _ => false,
    }
}

async fn run_read(args: Vec<String>) -> Result<String, String> {
    if !is_read_only(&args) {
        return Err(format!(
            "refusing non-read-only kubectl invocation: {:?}",
            args.first()
        ));
    }
    let fut = tokio::process::Command::new(kubectl_path())
        .args(&args)
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(45), fut)
        .await
        .map_err(|_| "kubectl timed out".to_string())?
        .map_err(|e| format!("failed to run kubectl: {}", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn ns_args(namespace: Option<&str>) -> Vec<String> {
    match namespace {
        Some(ns) => vec!["-n".into(), ns.into()],
        None => vec!["-A".into()],
    }
}

pub struct KubectlReader;

impl ClusterReader for KubectlReader {
    async fn get_json(
        &self,
        context: &str,
        namespace: Option<&str>,
        kind: &str,
        name: &str,
    ) -> Result<Value, String> {
        let mut args = vec![
            "get".to_string(),
            kind.to_lowercase(),
            name.to_string(),
            "--context".into(),
            context.into(),
            "-o".into(),
            "json".into(),
        ];
        if let Some(ns) = namespace {
            args.extend(["-n".to_string(), ns.to_string()]);
        }
        serde_json::from_str(&run_read(args).await?).map_err(|e| e.to_string())
    }

    async fn list_json(
        &self,
        context: &str,
        namespace: Option<&str>,
        kinds: &str,
        field_selector: Option<&str>,
    ) -> Result<Vec<Value>, String> {
        let mut args = vec![
            "get".to_string(),
            kinds.to_string(),
            "--context".into(),
            context.into(),
            "-o".into(),
            "json".into(),
        ];
        args.extend(ns_args(namespace));
        if let Some(fs) = field_selector {
            args.extend(["--field-selector".to_string(), fs.to_string()]);
        }
        let v: Value = serde_json::from_str(&run_read(args).await?).map_err(|e| e.to_string())?;
        Ok(v.get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    async fn logs(
        &self,
        context: &str,
        namespace: &str,
        pod: &str,
        container: &str,
        previous: bool,
        tail: u32,
    ) -> Result<String, String> {
        let mut args = vec![
            "logs".to_string(),
            pod.to_string(),
            "-c".into(),
            container.into(),
            "--context".into(),
            context.into(),
            "-n".into(),
            namespace.into(),
            format!("--tail={}", tail),
        ];
        if previous {
            args.push("--previous".into());
        }
        run_read(args).await
    }

    async fn rollout_history(
        &self,
        context: &str,
        namespace: &str,
        kind: &str,
        name: &str,
    ) -> Result<String, String> {
        run_read(vec![
            "rollout".into(),
            "history".into(),
            format!("{}/{}", kind.to_lowercase(), name),
            "--context".into(),
            context.into(),
            "-n".into(),
            namespace.into(),
        ])
        .await
    }

    async fn top_pods(&self, context: &str, namespace: &str) -> Result<String, String> {
        run_read(vec![
            "top".into(),
            "pods".into(),
            "--context".into(),
            context.into(),
            "-n".into(),
            namespace.into(),
        ])
        .await
    }

    async fn helm_releases(&self, context: &str) -> Result<Vec<HelmReleaseLite>, String> {
        // Reuse the existing Helm listing (`helm list -A -o json`, read-only).
        let releases = crate::commands::helm::list_helm_releases(context.to_string()).await?;
        Ok(releases
            .into_iter()
            .map(|r| HelmReleaseLite {
                name: r.name,
                namespace: r.namespace,
                status: r.status,
                revision: r.revision,
                chart: r.chart,
            })
            .collect())
    }
}

/// kubeconfig (cluster entry name, API server) for a context.
pub fn kubeconfig_cluster(context: &str) -> Result<Option<(String, String)>, String> {
    let kc = kube::config::Kubeconfig::read().map_err(|e| e.to_string())?;
    let Some(cluster_name) = kc
        .contexts
        .iter()
        .find(|c| c.name == context)
        .and_then(|c| c.context.as_ref())
        .map(|c| c.cluster.clone())
    else {
        return Ok(None);
    };
    let server = kc
        .clusters
        .iter()
        .find(|c| c.name == cluster_name)
        .and_then(|c| c.cluster.as_ref())
        .and_then(|c| c.server.clone());
    Ok(server.map(|s| (cluster_name, s)))
}

pub fn binding_for(context: &str) -> Result<ClusterBinding, String> {
    let (cluster_name, server) = kubeconfig_cluster(context)?
        .ok_or_else(|| format!("context {} not found in kubeconfig", context))?;
    Ok(ClusterBinding {
        context: context.to_string(),
        cluster_name,
        server,
    })
}

/// One detection pass worth of cluster state.
pub async fn collect_snapshot<R: ClusterReader>(
    reader: &R,
    context: &str,
) -> Result<ClusterSnapshot, String> {
    let workloads = reader
        .list_json(
            context,
            None,
            "pods,deployments,replicasets,statefulsets,daemonsets,jobs",
            None,
        )
        .await?;
    let nodes = reader
        .list_json(context, None, "nodes", None)
        .await
        .unwrap_or_default();
    let events = reader
        .list_json(context, None, "events", Some("type=Warning"))
        .await
        .unwrap_or_default();
    // Helm is optional: missing binary or RBAC must not break detection.
    let helm = reader.helm_releases(context).await.unwrap_or_default();
    Ok(ClusterSnapshot {
        workloads,
        nodes,
        events,
        helm,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_read_verbs_allowed() {
        assert!(is_read_only(&a(&["get", "pods"])));
        assert!(is_read_only(&a(&["logs", "p"])));
        assert!(is_read_only(&a(&["top", "pods"])));
        assert!(is_read_only(&a(&["rollout", "history", "deployment/x"])));
        for bad in [
            &["rollout", "restart"][..],
            &["rollout", "undo"],
            &["delete", "pod"],
            &["scale"],
            &["apply"],
            &["patch"],
            &["exec"],
            &[],
        ] {
            assert!(!is_read_only(&a(bad)), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn run_read_refuses_mutating_verbs_before_spawning() {
        let err = run_read(a(&["delete", "pod", "x"])).await.unwrap_err();
        assert!(err.contains("refusing"));
    }
}
