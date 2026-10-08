use serde::{Deserialize, Serialize};
use std::process::{Command as StdCommand, Stdio};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub revision: String,
    pub updated: String,
    pub status: String,
    pub chart: String,
    pub app_version: String,
}

// The JSON output from `helm list -o json` uses these field names
#[derive(Debug, Deserialize)]
struct HelmListEntry {
    name: String,
    namespace: String,
    revision: String,
    updated: String,
    status: String,
    chart: String,
    app_version: String,
}

#[tauri::command]
pub async fn list_helm_releases(context: String) -> Result<Vec<HelmRelease>, String> {
    let output = StdCommand::new("helm")
        .args(["list", "-A", "-o", "json", "--kube-context", &context])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "helm not found on PATH. Install helm: brew install helm".to_string()
            } else {
                e.to_string()
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(stderr);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries: Vec<HelmListEntry> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse helm output: {e}"))?;

    let releases = entries
        .into_iter()
        .map(|e| HelmRelease {
            name: e.name,
            namespace: e.namespace,
            revision: e.revision,
            updated: e.updated,
            status: e.status,
            chart: e.chart,
            app_version: e.app_version,
        })
        .collect();

    Ok(releases)
}

#[tauri::command]
pub async fn uninstall_helm_release(
    context: String,
    namespace: String,
    name: String,
) -> Result<String, String> {
    let output = StdCommand::new("helm")
        .args([
            "uninstall",
            &name,
            "-n",
            &namespace,
            "--kube-context",
            &context,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "helm not found on PATH. Install helm: brew install helm".to_string()
            } else {
                e.to_string()
            }
        })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}
