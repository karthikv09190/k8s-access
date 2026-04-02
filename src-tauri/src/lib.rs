mod commands;
pub mod kubectl;

/// Prepend common binary directories to PATH so macOS .app bundles can find
/// kubectl, aws, gke-gcloud-auth-plugin, kubelogin, helm, etc.
fn fix_path_for_app_bundle() {
    let extra = [
        "/opt/homebrew/bin",           // Apple Silicon Homebrew
        "/opt/homebrew/sbin",
        "/usr/local/bin",              // Intel Mac Homebrew / manual installs
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];

    let current = std::env::var("PATH").unwrap_or_default();
    // Build new PATH: extra paths first, then whatever was already set
    let mut parts: Vec<&str> = extra.iter().copied().collect();
    for p in current.split(':') {
        if !p.is_empty() && !parts.contains(&p) {
            parts.push(p);
        }
    }
    let new_path = parts.join(":");
    std::env::set_var("PATH", &new_path);
}

use commands::{
    clusters::{check_kubectl, list_contexts, list_namespaces},
    compare::compare_clusters,
    exec::{
        apply_resource_yaml, describe_resource, exec_pod_command, patch_secret, restart_resource,
        scale_resource, trigger_cronjob,
    },
    logs::{get_pod_containers, get_pod_logs},
    metrics::{get_cluster_overview, get_node_metrics, get_pod_metrics},
    portforward::{list_port_forwards, start_port_forward, stop_port_forward, PortForwardState},
    resources::{
        delete_resource, get_resource_yaml, list_clusterrolebindings, list_clusterroles,
        list_configmaps, list_cronjobs, list_daemonsets, list_deployments, list_ingresses,
        list_jobs, list_nodes, list_pods, list_pvcs, list_pvs, list_replicasets,
        list_rolebindings, list_roles, list_secrets, list_serviceaccounts, list_services,
        list_statefulsets,
    },
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ── Extend PATH for macOS .app bundles ────────────────────────────────────
    // .app bundles launch with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
    // Shell profiles (~/.zshrc etc.) are never loaded, so tools installed via
    // Homebrew (/opt/homebrew/bin), manual installs (/usr/local/bin), or
    // pkg managers are invisible — this breaks kubectl, aws, gke-gcloud-auth-plugin,
    // kubelogin, and any exec-based kubeconfig auth provider.
    fix_path_for_app_bundle();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PortForwardState::default())
        .invoke_handler(tauri::generate_handler![
            // clusters
            check_kubectl,
            list_contexts,
            list_namespaces,
            // resources
            list_pods,
            list_deployments,
            list_statefulsets,
            list_daemonsets,
            list_replicasets,
            list_jobs,
            list_cronjobs,
            list_services,
            list_ingresses,
            list_configmaps,
            list_secrets,
            list_pvcs,
            list_pvs,
            list_nodes,
            list_serviceaccounts,
            list_roles,
            list_rolebindings,
            list_clusterroles,
            list_clusterrolebindings,
            get_resource_yaml,
            delete_resource,
            // logs
            get_pod_logs,
            get_pod_containers,
            // exec / kubectl commands
            exec_pod_command,
            apply_resource_yaml,
            describe_resource,
            scale_resource,
            restart_resource,
            trigger_cronjob,
            patch_secret,
            // port forward
            start_port_forward,
            stop_port_forward,
            list_port_forwards,
            // compare
            compare_clusters,
            // metrics
            get_cluster_overview,
            get_node_metrics,
            get_pod_metrics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
