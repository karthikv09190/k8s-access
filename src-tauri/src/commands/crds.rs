use crate::kubectl::kubectl_path;
use serde::{Deserialize, Serialize};
use std::process::{Command as StdCommand, Stdio};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CrdInfo {
    pub name: String,
    pub group: String,
    pub kind: String,
    pub plural: String,
    pub scope: String,
    pub versions: Vec<String>,
    pub established: bool,
}

#[tauri::command]
pub async fn list_crds(context: String) -> Result<Vec<CrdInfo>, String> {
    let output = StdCommand::new(kubectl_path())
        .args(["get", "crds", "-o", "json", "--context", &context])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    let items = json["items"].as_array().cloned().unwrap_or_default();
    let mut crds = Vec::with_capacity(items.len());

    for item in items {
        let name = item["metadata"]["name"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let group = item["spec"]["group"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let kind = item["spec"]["names"]["kind"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let plural = item["spec"]["names"]["plural"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let scope = item["spec"]["scope"]
            .as_str()
            .unwrap_or("")
            .to_string();

        let versions: Vec<String> = item["spec"]["versions"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v["name"].as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let established = item["status"]["conditions"]
            .as_array()
            .map(|conds| {
                conds.iter().any(|c| {
                    c["type"].as_str() == Some("Established")
                        && c["status"].as_str() == Some("True")
                })
            })
            .unwrap_or(false);

        crds.push(CrdInfo {
            name,
            group,
            kind,
            plural,
            scope,
            versions,
            established,
        });
    }

    Ok(crds)
}

#[tauri::command]
pub async fn list_custom_resources(
    context: String,
    crd_name: String,
    namespace: Option<String>,
) -> Result<String, String> {
    let mut args = vec![
        "get".to_string(),
        crd_name.clone(),
        "-o".to_string(),
        "json".to_string(),
        "--context".to_string(),
        context.clone(),
    ];

    match namespace {
        Some(ns) => {
            args.push("-n".to_string());
            args.push(ns);
        }
        None => {
            args.push("-A".to_string());
        }
    }

    let output = StdCommand::new(kubectl_path())
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
