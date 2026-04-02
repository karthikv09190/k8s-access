use crate::kubectl::kubectl_path;
use kube::config::{KubeConfigOptions, Kubeconfig};
use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubectlStatus {
    pub found: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub kubeconfig_found: bool,
    pub context_count: usize,
}

#[tauri::command]
pub async fn check_kubectl() -> KubectlStatus {
    // Check kubectl binary
    // Use `kubectl version --client` — `--short` was removed in v1.28
    let (found, version, path) = match Command::new(kubectl_path())
        .args(["version", "--client"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    {
        Ok(out) => {
            // Process spawned → binary exists regardless of exit code
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            // Extract just the "Client Version: vX.Y.Z" line
            let ver = stdout
                .lines()
                .find(|l| l.starts_with("Client Version:"))
                .map(|l| l.trim().to_string())
                .or_else(|| {
                    // Fallback: first non-empty stdout line
                    stdout.lines().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string())
                })
                .unwrap_or_else(|| "unknown".to_string());
            let path = which_kubectl();
            (true, Some(ver), path)
        }
        Err(_) => (false, None, None),
    };

    // Check kubeconfig
    let (kubeconfig_found, context_count) = match Kubeconfig::read() {
        Ok(kc) => (true, kc.contexts.len()),
        Err(_) => (false, 0),
    };

    KubectlStatus { found, version, path, kubeconfig_found, context_count }
}

fn which_kubectl() -> Option<String> {
    // Return the resolved path directly — no need to shell out
    let p = kubectl_path();
    if p != "kubectl" {
        return Some(p.to_string());
    }
    Command::new("which")
        .arg("kubectl")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KubeContext {
    pub name: String,
    pub cluster: String,
    pub namespace: Option<String>,
    pub current: bool,
}

#[tauri::command]
pub async fn list_contexts() -> Result<Vec<KubeContext>, String> {
    let kubeconfig = Kubeconfig::read().map_err(|e| e.to_string())?;

    let current = kubeconfig
        .current_context
        .clone()
        .unwrap_or_default();

    let contexts = kubeconfig
        .contexts
        .iter()
        .map(|ctx| {
            let cluster = ctx
                .context
                .as_ref()
                .map(|c| c.cluster.clone())
                .unwrap_or_default();
            let namespace = ctx
                .context
                .as_ref()
                .and_then(|c| c.namespace.clone());
            KubeContext {
                name: ctx.name.clone(),
                cluster,
                namespace,
                current: ctx.name == current,
            }
        })
        .collect();

    Ok(contexts)
}

#[tauri::command]
pub async fn list_namespaces(context: String) -> Result<Vec<String>, String> {
    use k8s_openapi::api::core::v1::Namespace;
    use kube::{Api, Client};

    let opts = KubeConfigOptions {
        context: Some(context),
        ..Default::default()
    };
    let config = kube::Config::from_kubeconfig(&opts)
        .await
        .map_err(|e| e.to_string())?;
    let client = Client::try_from(config).map_err(|e| e.to_string())?;

    let ns_api: Api<Namespace> = Api::all(client);
    let ns_list = ns_api
        .list(&Default::default())
        .await
        .map_err(|e| e.to_string())?;

    let namespaces = ns_list
        .items
        .iter()
        .filter_map(|ns| ns.metadata.name.clone())
        .collect();

    Ok(namespaces)
}
