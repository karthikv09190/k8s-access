use crate::kubectl::kubectl_path;
use k8s_openapi::api::core::v1::Pod;
use kube::{api::AttachParams, config::KubeConfigOptions, Api, Client};
use std::process::{Command as StdCommand, Stdio};
use tokio::io::AsyncReadExt;

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

#[tauri::command]
pub async fn exec_pod_command(
    context: String,
    namespace: String,
    pod_name: String,
    container: Option<String>,
    command: Vec<String>,
) -> Result<String, String> {
    let client = make_client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);

    let mut ap = AttachParams::default()
        .stdout(true)
        .stderr(true)
        .stdin(false);

    if let Some(c) = container {
        ap = ap.container(c);
    }

    let mut attached = api
        .exec(&pod_name, &command, &ap)
        .await
        .map_err(|e| e.to_string())?;

    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();

    if let Some(mut out) = attached.stdout() {
        out.read_to_end(&mut stdout_bytes).await.ok();
    }
    if let Some(mut err) = attached.stderr() {
        err.read_to_end(&mut stderr_bytes).await.ok();
    }

    let _ = attached.join().await;

    let stdout = String::from_utf8_lossy(&stdout_bytes);
    let stderr = String::from_utf8_lossy(&stderr_bytes);

    let mut result = stdout.to_string();
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push_str("\n[stderr]\n");
        }
        result.push_str(&stderr);
    }
    Ok(result)
}

#[tauri::command]
pub async fn apply_resource_yaml(context: String, yaml: String) -> Result<String, String> {
    use std::io::Write;

    let mut child = StdCommand::new(kubectl_path())
        .args(["apply", "--context", &context, "-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(yaml.as_bytes()).map_err(|e| e.to_string())?;
    }

    let output = child.wait_with_output().map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub async fn describe_resource(
    context: String,
    namespace: Option<String>,
    kind: String,
    name: String,
) -> Result<String, String> {
    let kind_lower = kind.to_lowercase();
    let mut args: Vec<&str> = vec!["describe", "--context", &context];

    let ns_owned;
    if let Some(ref ns) = namespace {
        ns_owned = ns.clone();
        args.extend(["-n", ns_owned.as_str()]);
    }

    args.push(&kind_lower);
    args.push(&name);

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

#[tauri::command]
pub async fn scale_resource(
    context: String,
    namespace: String,
    kind: String,
    name: String,
    replicas: u32,
) -> Result<String, String> {
    let resource = format!("{}/{}", kind.to_lowercase(), name);
    let replicas_arg = format!("--replicas={}", replicas);

    let output = StdCommand::new(kubectl_path())
        .args([
            "scale",
            "--context",
            &context,
            "-n",
            &namespace,
            &resource,
            &replicas_arg,
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

#[tauri::command]
pub async fn trigger_cronjob(
    context: String,
    namespace: String,
    name: String,
    job_name: Option<String>,
) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let job_name = job_name.unwrap_or_else(|| {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() % 1_000_000)
            .unwrap_or(0);
        let prefix = if name.len() > 50 { &name[..50] } else { &name };
        format!("{}-{}", prefix, ts)
    });

    let from = format!("cronjob/{}", name);

    let output = StdCommand::new(kubectl_path())
        .args([
            "create", "job",
            "--context", &context,
            "-n", &namespace,
            "--from", &from,
            &job_name,
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

#[tauri::command]
pub async fn restart_resource(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<String, String> {
    let resource = format!("{}/{}", kind.to_lowercase(), name);

    let output = StdCommand::new(kubectl_path())
        .args([
            "rollout",
            "restart",
            "--context",
            &context,
            "-n",
            &namespace,
            &resource,
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

#[tauri::command]
pub async fn patch_secret(
    context: String,
    namespace: String,
    name: String,
    data: std::collections::HashMap<String, String>,
) -> Result<String, String> {
    // Use stringData so kubectl handles base64 encoding automatically
    let patch = serde_json::json!({ "stringData": data });
    let patch_str = patch.to_string();

    let output = StdCommand::new(kubectl_path())
        .args([
            "patch", "secret", &name,
            "--context", &context,
            "-n", &namespace,
            "--type", "merge",
            "-p", &patch_str,
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
