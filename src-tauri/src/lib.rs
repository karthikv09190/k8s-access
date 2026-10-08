mod commands;
mod healing;
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
    crds::{list_crds, list_custom_resources},
    kubeconfig::{
        delete_context, import_kubeconfig, rename_context, set_current_context,
        test_context_connection,
    },
    events::list_events,
    gitops::{list_argo_apps, sync_argo_app},
    helm::{list_helm_releases, uninstall_helm_release},
    exec::{
        apply_resource_yaml, cordon_node, describe_resource, drain_node, exec_pod_command,
        get_rollout_history, get_rollout_status, patch_secret, restart_resource, rollback_rollout,
        scale_resource, trigger_cronjob, uncordon_node,
    },
    logs::{get_pod_containers, get_pod_logs, start_log_stream, stop_log_stream, LogStreamState},
    metrics::{get_cluster_overview, get_node_metrics, get_pod_metrics},
    portforward::{list_port_forwards, start_port_forward, stop_port_forward, PortForwardState},
    resources::{
        delete_resource, get_resource_yaml, list_clusterrolebindings, list_clusterroles,
        list_configmaps, list_cronjobs, list_daemonsets, list_deployments, list_endpoints,
        list_hpas, list_ingresses, list_jobs, list_limitranges,
        list_mutatingwebhookconfigurations, list_networkpolicies, list_nodes, list_pdbs,
        list_pods, list_pvcs, list_pvs, list_replicasets, list_resourcequotas, list_rolebindings,
        list_roles, list_secrets, list_serviceaccounts, list_services, list_statefulsets,
        list_storageclasses, list_validatingwebhookconfigurations,
    },
    terminal::{
        close_terminal, resize_terminal, start_terminal, write_terminal, TerminalState,
    },
    watch::{clear_cluster_alerts, start_cluster_watch, stop_cluster_watch, WatchState},
    kubectl_cmd::run_kubectl_command,
    export::get_namespace_yaml_bundle,
    healing::{
        approve_healing, execute_approved_healing, get_healing_audit, get_healing_command_preview,
        get_healing_incident, get_healing_incidents, get_healing_policy, get_healing_stats,
        propose_healing_rollback, reject_healing, set_healing_policy, HealingState,
        analyze_healing_incident, get_healing_ai_status, preview_healing_ai_context,
        scan_healing_incidents, set_healing_ai_config,
    },
};
use tauri::{Emitter, Manager};

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
        .manage(LogStreamState::default())
        .manage(TerminalState::default())
        .manage(WatchState::default())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().ok();
            let state = HealingState::open(data_dir);
            // Self-Healing events → existing notification center.
            let handle = app.handle().clone();
            state.service.set_notifier(Box::new(move |record| {
                if let Some(n) = healing::notify::notification_for(record) {
                    let _ = handle.emit("cluster-alert", &n);
                }
            }));
            app.manage(state);
            Ok(())
        })
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
            list_storageclasses,
            list_hpas,
            list_pdbs,
            list_networkpolicies,
            list_resourcequotas,
            list_limitranges,
            list_endpoints,
            get_resource_yaml,
            delete_resource,
            // logs
            get_pod_logs,
            get_pod_containers,
            start_log_stream,
            stop_log_stream,
            // terminal
            start_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            // exec / kubectl commands
            exec_pod_command,
            apply_resource_yaml,
            describe_resource,
            scale_resource,
            restart_resource,
            trigger_cronjob,
            patch_secret,
            get_rollout_history,
            rollback_rollout,
            get_rollout_status,
            cordon_node,
            uncordon_node,
            drain_node,
            // port forward
            start_port_forward,
            stop_port_forward,
            list_port_forwards,
            // compare
            compare_clusters,
            // events
            list_events,
            // helm
            list_helm_releases,
            uninstall_helm_release,
            // gitops
            list_argo_apps,
            sync_argo_app,
            // metrics
            get_cluster_overview,
            get_node_metrics,
            get_pod_metrics,
            // crds
            list_crds,
            list_custom_resources,
            // webhooks
            list_mutatingwebhookconfigurations,
            list_validatingwebhookconfigurations,
            // watch / alerts
            start_cluster_watch,
            stop_cluster_watch,
            clear_cluster_alerts,
            // kubectl command palette
            run_kubectl_command,
            // export
            get_namespace_yaml_bundle,
            // kubeconfig management
            rename_context,
            delete_context,
            set_current_context,
            test_context_connection,
            import_kubeconfig,
            // self-healing (every mutation requires approval; see healing::service)
            get_healing_incidents,
            get_healing_incident,
            get_healing_stats,
            get_healing_audit,
            get_healing_command_preview,
            get_healing_policy,
            set_healing_policy,
            approve_healing,
            reject_healing,
            execute_approved_healing,
            propose_healing_rollback,
            scan_healing_incidents,
            analyze_healing_incident,
            preview_healing_ai_context,
            get_healing_ai_status,
            set_healing_ai_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
