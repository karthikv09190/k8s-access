use k8s_openapi::api::{
    apps::v1::{DaemonSet, Deployment, StatefulSet},
    core::v1::{ConfigMap, Secret, Service},
    networking::v1::Ingress,
};
use kube::{api::ListParams, config::KubeConfigOptions, Api, Client};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDiff {
    pub name: String,
    pub kind: String,
    pub namespace: String,
    pub status: DiffStatus,
    pub left: Option<ResourceSnapshot>,
    pub right: Option<ResourceSnapshot>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DiffStatus {
    Identical,
    Different,
    LeftOnly,
    RightOnly,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub replicas: Option<i32>,
    pub ready_replicas: Option<i32>,
    pub image: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub secret_keys: Option<Vec<String>>,   // keys only, never values
    pub configmap_keys: Option<Vec<String>>,
    pub service_type: Option<String>,
    pub service_port: Option<i32>,
    pub raw_json: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub left_context: String,
    pub right_context: String,
    pub namespace: String,
    pub diffs: Vec<ResourceDiff>,
    pub summary: CompareSummary,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareSummary {
    pub total: usize,
    pub identical: usize,
    pub different: usize,
    pub left_only: usize,
    pub right_only: usize,
}

// ── Deployments ─────────────────────────────────────────────────────────────

async fn snapshot_deployments(
    client: &Client,
    namespace: &str,
) -> Result<HashMap<String, ResourceSnapshot>, String> {
    let api: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| e.to_string())?;

    let mut map = HashMap::new();
    for d in list.items {
        let name = d.metadata.name.clone().unwrap_or_default();
        let spec = d.spec.as_ref();
        let status = d.status.as_ref();
        let replicas = spec.and_then(|s| s.replicas);
        let ready_replicas = status.and_then(|s| s.ready_replicas);
        let image = spec
            .and_then(|s| s.template.spec.as_ref())
            .and_then(|ps| ps.containers.first())
            .map(|c| c.image.clone().unwrap_or_default());
        let labels = d.metadata.labels.clone().unwrap_or_default();
        let annotations = d.metadata.annotations.clone().unwrap_or_default();
        let raw_json = serde_json::to_string(&d).unwrap_or_default();

        map.insert(
            name.clone(),
            ResourceSnapshot {
                replicas,
                ready_replicas,
                image,
                labels,
                annotations,
                secret_keys: None,
                configmap_keys: None,
                service_type: None,
                service_port: None,
                raw_json,
            },
        );
    }
    Ok(map)
}

// ── Secrets (keys only, never values) ───────────────────────────────────────

async fn snapshot_secrets(
    client: &Client,
    namespace: &str,
) -> Result<HashMap<String, ResourceSnapshot>, String> {
    let api: Api<Secret> = Api::namespaced(client.clone(), namespace);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| e.to_string())?;

    let mut map = HashMap::new();
    for s in list.items {
        let name = s.metadata.name.clone().unwrap_or_default();
        let mut keys: Vec<String> = s
            .data
            .as_ref()
            .map(|d| d.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();

        // Redact raw_json data values for security
        let mut safe = serde_json::to_value(&s).unwrap_or_default();
        if let Some(obj) = safe.as_object_mut() {
            obj.insert("data".to_string(), serde_json::json!("<redacted>"));
        }

        map.insert(
            name.clone(),
            ResourceSnapshot {
                replicas: None,
                ready_replicas: None,
                image: None,
                labels: s.metadata.labels.clone().unwrap_or_default(),
                annotations: s.metadata.annotations.clone().unwrap_or_default(),
                secret_keys: Some(keys),
                configmap_keys: None,
                service_type: None,
                service_port: None,
                raw_json: safe.to_string(),
            },
        );
    }
    Ok(map)
}

// ── ConfigMaps ───────────────────────────────────────────────────────────────

async fn snapshot_configmaps(
    client: &Client,
    namespace: &str,
) -> Result<HashMap<String, ResourceSnapshot>, String> {
    let api: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| e.to_string())?;

    let mut map = HashMap::new();
    for cm in list.items {
        let name = cm.metadata.name.clone().unwrap_or_default();
        let mut keys: Vec<String> = cm
            .data
            .as_ref()
            .map(|d| d.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        let raw_json = serde_json::to_string(&cm).unwrap_or_default();

        map.insert(
            name.clone(),
            ResourceSnapshot {
                replicas: None,
                ready_replicas: None,
                image: None,
                labels: cm.metadata.labels.clone().unwrap_or_default(),
                annotations: cm.metadata.annotations.clone().unwrap_or_default(),
                secret_keys: None,
                configmap_keys: Some(keys),
                service_type: None,
                service_port: None,
                raw_json,
            },
        );
    }
    Ok(map)
}

// ── Services ─────────────────────────────────────────────────────────────────

async fn snapshot_services(
    client: &Client,
    namespace: &str,
) -> Result<HashMap<String, ResourceSnapshot>, String> {
    let api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| e.to_string())?;

    let mut map = HashMap::new();
    for svc in list.items {
        let name = svc.metadata.name.clone().unwrap_or_default();
        let spec = svc.spec.as_ref();
        let service_type = spec.and_then(|s| s.type_.clone());
        let service_port = spec
            .and_then(|s| s.ports.as_ref())
            .and_then(|ps| ps.first())
            .map(|p| p.port);
        let raw_json = serde_json::to_string(&svc).unwrap_or_default();

        map.insert(
            name.clone(),
            ResourceSnapshot {
                replicas: None,
                ready_replicas: None,
                image: None,
                labels: svc.metadata.labels.clone().unwrap_or_default(),
                annotations: svc.metadata.annotations.clone().unwrap_or_default(),
                secret_keys: None,
                configmap_keys: None,
                service_type,
                service_port,
                raw_json,
            },
        );
    }
    Ok(map)
}

// ── StatefulSets ─────────────────────────────────────────────────────────────

async fn snapshot_statefulsets(
    client: &Client,
    namespace: &str,
) -> Result<HashMap<String, ResourceSnapshot>, String> {
    let api: Api<StatefulSet> = Api::namespaced(client.clone(), namespace);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| e.to_string())?;

    let mut map = HashMap::new();
    for ss in list.items {
        let name = ss.metadata.name.clone().unwrap_or_default();
        let spec = ss.spec.as_ref();
        let replicas = spec.and_then(|s| s.replicas);
        let ready_replicas = ss.status.as_ref().and_then(|s| s.ready_replicas);
        let image = spec
            .map(|s| &s.template)
            .and_then(|t| t.spec.as_ref())
            .and_then(|ps| ps.containers.first())
            .map(|c| c.image.clone().unwrap_or_default());
        let raw_json = serde_json::to_string(&ss).unwrap_or_default();

        map.insert(
            name.clone(),
            ResourceSnapshot {
                replicas,
                ready_replicas,
                image,
                labels: ss.metadata.labels.clone().unwrap_or_default(),
                annotations: ss.metadata.annotations.clone().unwrap_or_default(),
                secret_keys: None,
                configmap_keys: None,
                service_type: None,
                service_port: None,
                raw_json,
            },
        );
    }
    Ok(map)
}

// ── Diff helper ──────────────────────────────────────────────────────────────

fn diff_snapshots(
    kind: &str,
    namespace: &str,
    left_map: HashMap<String, ResourceSnapshot>,
    right_map: HashMap<String, ResourceSnapshot>,
) -> Vec<ResourceDiff> {
    let mut diffs = Vec::new();
    let mut all_names: Vec<String> = left_map
        .keys()
        .chain(right_map.keys())
        .cloned()
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    all_names.sort();

    for name in all_names {
        let left = left_map.get(&name).cloned();
        let right = right_map.get(&name).cloned();

        let status = match (&left, &right) {
            (Some(l), Some(r)) => {
                let replica_same = l.replicas == r.replicas;
                let keys_same = l.secret_keys == r.secret_keys
                    && l.configmap_keys == r.configmap_keys;
                let svc_same =
                    l.service_type == r.service_type && l.service_port == r.service_port;
                if replica_same && keys_same && svc_same {
                    DiffStatus::Identical
                } else {
                    DiffStatus::Different
                }
            }
            (Some(_), None) => DiffStatus::LeftOnly,
            (None, Some(_)) => DiffStatus::RightOnly,
            (None, None) => unreachable!(),
        };

        diffs.push(ResourceDiff {
            name,
            kind: kind.to_string(),
            namespace: namespace.to_string(),
            status,
            left,
            right,
        });
    }

    diffs
}

// ── Main compare command ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn compare_clusters(
    left_context: String,
    right_context: String,
    namespace: String,
    resource_kinds: Vec<String>,
) -> Result<CompareResult, String> {
    let left_client = make_client(&left_context).await?;
    let right_client = make_client(&right_context).await?;

    let mut all_diffs: Vec<ResourceDiff> = Vec::new();

    for kind in &resource_kinds {
        let diffs = match kind.as_str() {
            "Deployment" => {
                let (l, r) = tokio::try_join!(
                    snapshot_deployments(&left_client, &namespace),
                    snapshot_deployments(&right_client, &namespace)
                )?;
                diff_snapshots("Deployment", &namespace, l, r)
            }
            "Secret" => {
                let (l, r) = tokio::try_join!(
                    snapshot_secrets(&left_client, &namespace),
                    snapshot_secrets(&right_client, &namespace)
                )?;
                diff_snapshots("Secret", &namespace, l, r)
            }
            "ConfigMap" => {
                let (l, r) = tokio::try_join!(
                    snapshot_configmaps(&left_client, &namespace),
                    snapshot_configmaps(&right_client, &namespace)
                )?;
                diff_snapshots("ConfigMap", &namespace, l, r)
            }
            "Service" => {
                let (l, r) = tokio::try_join!(
                    snapshot_services(&left_client, &namespace),
                    snapshot_services(&right_client, &namespace)
                )?;
                diff_snapshots("Service", &namespace, l, r)
            }
            "StatefulSet" => {
                let (l, r) = tokio::try_join!(
                    snapshot_statefulsets(&left_client, &namespace),
                    snapshot_statefulsets(&right_client, &namespace)
                )?;
                diff_snapshots("StatefulSet", &namespace, l, r)
            }
            _ => vec![],
        };
        all_diffs.extend(diffs);
    }

    let summary = CompareSummary {
        total: all_diffs.len(),
        identical: all_diffs
            .iter()
            .filter(|d| d.status == DiffStatus::Identical)
            .count(),
        different: all_diffs
            .iter()
            .filter(|d| d.status == DiffStatus::Different)
            .count(),
        left_only: all_diffs
            .iter()
            .filter(|d| d.status == DiffStatus::LeftOnly)
            .count(),
        right_only: all_diffs
            .iter()
            .filter(|d| d.status == DiffStatus::RightOnly)
            .count(),
    };

    Ok(CompareResult {
        left_context,
        right_context,
        namespace,
        diffs: all_diffs,
        summary,
    })
}
