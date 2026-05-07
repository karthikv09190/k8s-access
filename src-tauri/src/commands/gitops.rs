use crate::kubectl::kubectl_path;
use serde::{Deserialize, Serialize};
use std::process::{Command as StdCommand, Stdio};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArgoApp {
    pub name: String,
    pub namespace: String,
    pub project: String,
    pub repo_url: String,
    pub path: String,
    pub target_revision: String,
    pub dest_namespace: String,
    pub sync_status: String,
    pub health_status: String,
    pub last_synced_at: String,
    pub images: Vec<String>,
    pub message: String,
}

#[tauri::command]
pub async fn list_argo_apps(context: String) -> Result<Vec<ArgoApp>, String> {
    let output = StdCommand::new(kubectl_path())
        .args([
            "get",
            "applications.argoproj.io",
            "-A",
            "-o",
            "json",
            "--context",
            &context,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // ArgoCD not installed or no resources — return empty list
        if stderr.contains("No resources found")
            || stderr.contains("does not exist")
            || stderr.contains("no matches for kind")
            || stderr.contains("couldn't get resource list")
        {
            return Ok(vec![]);
        }
        return Err(stderr.to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return Ok(vec![]);
    }

    let json: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| e.to_string())?;

    let items = match json.get("items").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return Ok(vec![]),
    };

    let mut apps = Vec::new();
    for item in items {
        let name = item["metadata"]["name"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let namespace = item["metadata"]["namespace"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let project = item["spec"]["project"]
            .as_str()
            .unwrap_or("default")
            .to_string();
        let repo_url = item["spec"]["source"]["repoURL"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let path = item["spec"]["source"]["path"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let target_revision = item["spec"]["source"]["targetRevision"]
            .as_str()
            .unwrap_or("HEAD")
            .to_string();
        let dest_namespace = item["spec"]["destination"]["namespace"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let sync_status = item["status"]["sync"]["status"]
            .as_str()
            .unwrap_or("Unknown")
            .to_string();
        let health_status = item["status"]["health"]["status"]
            .as_str()
            .unwrap_or("Unknown")
            .to_string();
        let last_synced_at = item["status"]["reconciledAt"]
            .as_str()
            .unwrap_or("")
            .to_string();

        let images: Vec<String> = item["status"]["summary"]["images"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        // message: prefer conditions[0].message, fall back to sync.message
        let message = item["status"]["conditions"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|c| c["message"].as_str())
            .or_else(|| item["status"]["sync"]["message"].as_str())
            .unwrap_or("")
            .to_string();

        apps.push(ArgoApp {
            name,
            namespace,
            project,
            repo_url,
            path,
            target_revision,
            dest_namespace,
            sync_status,
            health_status,
            last_synced_at,
            images,
            message,
        });
    }

    Ok(apps)
}

#[tauri::command]
pub async fn sync_argo_app(
    context: String,
    namespace: String,
    name: String,
) -> Result<String, String> {
    let output = StdCommand::new(kubectl_path())
        .args([
            "annotate",
            "application",
            &name,
            "-n",
            &namespace,
            "--context",
            &context,
            "argocd.argoproj.io/app-refresh=normal",
            "--overwrite",
        ])
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
