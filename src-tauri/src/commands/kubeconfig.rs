use crate::kubectl::kubectl_path;
use std::io::Write;
use std::process::{Command as StdCommand, Stdio};

fn run_kubectl(args: &[&str]) -> Result<String, String> {
    let out = StdCommand::new(kubectl_path())
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to spawn kubectl: {e}"))?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn rename_context(old_name: String, new_name: String) -> Result<(), String> {
    run_kubectl(&["config", "rename-context", &old_name, &new_name])?;
    Ok(())
}

#[tauri::command]
pub async fn delete_context(name: String) -> Result<(), String> {
    run_kubectl(&["config", "delete-context", &name])?;
    // Best-effort cleanup — ignore errors
    let _ = run_kubectl(&["config", "delete-cluster", &name]);
    let _ = run_kubectl(&["config", "delete-user", &name]);
    Ok(())
}

#[tauri::command]
pub async fn set_current_context(name: String) -> Result<(), String> {
    run_kubectl(&["config", "use-context", &name])?;
    Ok(())
}

#[tauri::command]
pub async fn test_context_connection(context: String) -> Result<String, String> {
    let out = StdCommand::new(kubectl_path())
        .args(["cluster-info", "--context", &context, "--request-timeout=5s"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to spawn kubectl: {e}"))?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn import_kubeconfig(yaml_content: String) -> Result<Vec<String>, String> {
    // Write to temp file
    let tmp_dir = std::env::temp_dir();
    let tmp_path = tmp_dir.join("k8s_import.yaml");
    let merged_path = "/tmp/k8s_merged.yaml";

    {
        let mut f = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temp file: {e}"))?;
        f.write_all(yaml_content.as_bytes())
            .map_err(|e| format!("Failed to write temp file: {e}"))?;
    }

    // Expand ~ for kubeconfig path
    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
    let kube_config = format!("{home}/.kube/config");

    // Merge: KUBECONFIG=~/.kube/config:<tmpfile> kubectl config view --flatten
    let merge_cmd = format!(
        "KUBECONFIG={kube_config}:{} {kubectl} config view --flatten > {merged_path}",
        tmp_path.to_string_lossy(),
        kubectl = kubectl_path(),
    );

    let merge_out = StdCommand::new("/bin/sh")
        .arg("-c")
        .arg(&merge_cmd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to merge kubeconfigs: {e}"))?;

    if !merge_out.status.success() {
        return Err(String::from_utf8_lossy(&merge_out.stderr).trim().to_string());
    }

    // Copy merged config back
    let cp_out = StdCommand::new("cp")
        .args([merged_path, &kube_config])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to copy merged config: {e}"))?;

    if !cp_out.status.success() {
        return Err(String::from_utf8_lossy(&cp_out.stderr).trim().to_string());
    }

    // Extract context names from the imported YAML
    let names: Vec<String> = yaml_content
        .lines()
        .filter(|l| l.trim_start().starts_with("name: "))
        .map(|l| {
            l.trim_start()
                .trim_start_matches("name: ")
                .trim()
                .trim_matches('"')
                .to_string()
        })
        .filter(|n| !n.is_empty())
        .collect();

    Ok(names)
}
