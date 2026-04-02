use crate::kubectl::kubectl_path;
use kube::{api::ListParams, config::KubeConfigOptions, Api, Client};
use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};

async fn make_client(context: &str) -> Result<Client, String> {
    let opts = KubeConfigOptions {
        context: Some(context.to_string()),
        ..Default::default()
    };
    let config = kube::Config::from_kubeconfig(&opts)
        .await
        .map_err(|e| e.to_string())?;
    Client::try_from(config).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMetrics {
    pub name: String,
    pub cpu_cores: String,
    pub cpu_percent: String,
    pub memory_bytes: String,
    pub memory_percent: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMetrics {
    pub name: String,
    pub namespace: String,
    pub cpu_cores: String,
    pub memory_bytes: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterOverview {
    pub total_nodes: usize,
    pub ready_nodes: usize,
    pub total_pods: usize,
    pub running_pods: usize,
    pub pending_pods: usize,
    pub failed_pods: usize,
    pub total_deployments: usize,
    pub total_services: usize,
    pub total_namespaces: usize,
}

#[tauri::command]
pub async fn get_cluster_overview(context: String) -> Result<ClusterOverview, String> {
    use k8s_openapi::api::{
        apps::v1::Deployment,
        core::v1::{Namespace, Node, Pod, Service},
    };

    let client = make_client(&context).await?;
    let lp = ListParams::default();

    let (nodes, pods, deployments, services, namespaces) = tokio::try_join!(
        async {
            let api: Api<Node> = Api::all(client.clone());
            api.list(&lp).await.map_err(|e| e.to_string())
        },
        async {
            let api: Api<Pod> = Api::all(client.clone());
            api.list(&lp).await.map_err(|e| e.to_string())
        },
        async {
            let api: Api<Deployment> = Api::all(client.clone());
            api.list(&lp).await.map_err(|e| e.to_string())
        },
        async {
            let api: Api<Service> = Api::all(client.clone());
            api.list(&lp).await.map_err(|e| e.to_string())
        },
        async {
            let api: Api<Namespace> = Api::all(client.clone());
            api.list(&lp).await.map_err(|e| e.to_string())
        },
    )?;

    let ready_nodes = nodes
        .items
        .iter()
        .filter(|n| {
            n.status
                .as_ref()
                .and_then(|s| s.conditions.as_ref())
                .map(|cs| {
                    cs.iter().any(|c| c.type_ == "Ready" && c.status == "True")
                })
                .unwrap_or(false)
        })
        .count();

    let running_pods = pods
        .items
        .iter()
        .filter(|p| {
            p.status
                .as_ref()
                .and_then(|s| s.phase.as_deref())
                .map(|ph| ph == "Running")
                .unwrap_or(false)
        })
        .count();

    let pending_pods = pods
        .items
        .iter()
        .filter(|p| {
            p.status
                .as_ref()
                .and_then(|s| s.phase.as_deref())
                .map(|ph| ph == "Pending")
                .unwrap_or(false)
        })
        .count();

    let failed_pods = pods
        .items
        .iter()
        .filter(|p| {
            p.status
                .as_ref()
                .and_then(|s| s.phase.as_deref())
                .map(|ph| ph == "Failed")
                .unwrap_or(false)
        })
        .count();

    Ok(ClusterOverview {
        total_nodes: nodes.items.len(),
        ready_nodes,
        total_pods: pods.items.len(),
        running_pods,
        pending_pods,
        failed_pods,
        total_deployments: deployments.items.len(),
        total_services: services.items.len(),
        total_namespaces: namespaces.items.len(),
    })
}

#[tauri::command]
pub async fn get_node_metrics(context: String) -> Result<Vec<NodeMetrics>, String> {
    let output = Command::new(kubectl_path())
        .args(["top", "nodes", "--context", &context, "--no-headers"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut metrics = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 5 {
            metrics.push(NodeMetrics {
                name: parts[0].to_string(),
                cpu_cores: parts[1].to_string(),
                cpu_percent: parts[2].to_string(),
                memory_bytes: parts[3].to_string(),
                memory_percent: parts[4].to_string(),
            });
        }
    }

    Ok(metrics)
}

#[tauri::command]
pub async fn get_pod_metrics(
    context: String,
    namespace: Option<String>,
) -> Result<Vec<PodMetrics>, String> {
    let mut args = vec!["top", "pods", "--context", &context, "--no-headers"];
    let ns_owned;
    if let Some(ref ns) = namespace {
        ns_owned = ns.clone();
        args.push("-n");
        args.push(&ns_owned);
    } else {
        args.push("-A");
    }

    let output = Command::new(kubectl_path())
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut metrics = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        // With -A: NAMESPACE NAME CPU MEMORY (4 cols)
        // With -n: NAME CPU MEMORY (3 cols)
        if namespace.is_none() && parts.len() >= 4 {
            metrics.push(PodMetrics {
                namespace: parts[0].to_string(),
                name: parts[1].to_string(),
                cpu_cores: parts[2].to_string(),
                memory_bytes: parts[3].to_string(),
            });
        } else if namespace.is_some() && parts.len() >= 3 {
            metrics.push(PodMetrics {
                namespace: namespace.as_deref().unwrap_or("").to_string(),
                name: parts[0].to_string(),
                cpu_cores: parts[1].to_string(),
                memory_bytes: parts[2].to_string(),
            });
        }
    }

    Ok(metrics)
}
