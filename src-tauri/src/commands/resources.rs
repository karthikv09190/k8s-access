use crate::kubectl::kubectl_path;
use k8s_openapi::api::{
    admissionregistration::v1::{MutatingWebhookConfiguration, ValidatingWebhookConfiguration},
    apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet},
    autoscaling::v2::HorizontalPodAutoscaler,
    batch::v1::{CronJob, Job},
    core::v1::{
        ConfigMap, Endpoints, LimitRange, Node, PersistentVolume, PersistentVolumeClaim,
        Pod, ResourceQuota, Secret, Service, ServiceAccount,
    },
    networking::v1::{Ingress, NetworkPolicy},
    policy::v1::PodDisruptionBudget,
    rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding},
    storage::v1::StorageClass,
};
use kube::{
    api::{ListParams, ObjectList},
    config::KubeConfigOptions,
    Api, Client, Resource,
};
use serde_json::Value;

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

// Macro for namespace-scoped resources
macro_rules! list_namespaced {
    ($fn_name:ident, $resource:ty) => {
        #[tauri::command]
        pub async fn $fn_name(
            context: String,
            namespace: Option<String>,
        ) -> Result<Vec<Value>, String> {
            let client = make_client(&context).await?;
            let lp = ListParams::default();
            let ns = namespace.as_deref().unwrap_or("default");
            let api: Api<$resource> = Api::namespaced(client, ns);
            let items: Vec<Value> = api
                .list(&lp)
                .await
                .map_err(|e| e.to_string())?
                .items
                .into_iter()
                .filter_map(|r| serde_json::to_value(r).ok())
                .collect();
            Ok(items)
        }
    };
}

// Macro for cluster-scoped resources
macro_rules! list_cluster {
    ($fn_name:ident, $resource:ty) => {
        #[tauri::command]
        pub async fn $fn_name(
            context: String,
            namespace: Option<String>,
        ) -> Result<Vec<Value>, String> {
            let _ = namespace; // ignored for cluster-scoped
            let client = make_client(&context).await?;
            let lp = ListParams::default();
            let api: Api<$resource> = Api::all(client);
            let items: Vec<Value> = api
                .list(&lp)
                .await
                .map_err(|e| e.to_string())?
                .items
                .into_iter()
                .filter_map(|r| serde_json::to_value(r).ok())
                .collect();
            Ok(items)
        }
    };
}

// Namespaced resources
list_namespaced!(list_pods, Pod);
list_namespaced!(list_deployments, Deployment);
list_namespaced!(list_statefulsets, StatefulSet);
list_namespaced!(list_daemonsets, DaemonSet);
list_namespaced!(list_replicasets, ReplicaSet);
list_namespaced!(list_jobs, Job);
list_namespaced!(list_cronjobs, CronJob);
list_namespaced!(list_services, Service);
list_namespaced!(list_ingresses, Ingress);
list_namespaced!(list_configmaps, ConfigMap);
list_namespaced!(list_secrets, Secret);
list_namespaced!(list_pvcs, PersistentVolumeClaim);
list_namespaced!(list_serviceaccounts, ServiceAccount);
list_namespaced!(list_roles, Role);
list_namespaced!(list_rolebindings, RoleBinding);

// Cluster-scoped resources
list_cluster!(list_pvs, PersistentVolume);
list_cluster!(list_nodes, Node);
list_cluster!(list_clusterroles, ClusterRole);
list_cluster!(list_clusterrolebindings, ClusterRoleBinding);
list_cluster!(list_storageclasses, StorageClass);
list_cluster!(list_mutatingwebhookconfigurations, MutatingWebhookConfiguration);
list_cluster!(list_validatingwebhookconfigurations, ValidatingWebhookConfiguration);

// P0 new namespaced resources
list_namespaced!(list_hpas, HorizontalPodAutoscaler);
list_namespaced!(list_pdbs, PodDisruptionBudget);
list_namespaced!(list_networkpolicies, NetworkPolicy);
list_namespaced!(list_resourcequotas, ResourceQuota);
list_namespaced!(list_limitranges, LimitRange);
list_namespaced!(list_endpoints, Endpoints);

#[tauri::command]
pub async fn get_resource_yaml(
    context: String,
    namespace: Option<String>,
    kind: String,
    name: String,
) -> Result<String, String> {
    use std::process::Stdio;

    let kind_lower = kind.to_lowercase();
    let mut args: Vec<&str> = vec!["get", &kind_lower, &name, "-o", "yaml", "--context", &context];

    let ns_owned;
    if let Some(ref ns) = namespace {
        ns_owned = ns.clone();
        args.extend(["-n", ns_owned.as_str()]);
    }

    let output = std::process::Command::new(kubectl_path())
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub async fn delete_resource(
    context: String,
    namespace: Option<String>,
    kind: String,
    name: String,
) -> Result<(), String> {
    use std::process::Stdio;

    let kind_lower = kind.to_lowercase();
    let mut args = vec![
        "delete",
        kind_lower.as_str(),
        name.as_str(),
        "--context",
        context.as_str(),
    ];

    let ns_owned;
    if let Some(ref ns) = namespace {
        ns_owned = ns.clone();
        args.extend(["-n", ns_owned.as_str()]);
    }

    let output = std::process::Command::new(kubectl_path())
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}
