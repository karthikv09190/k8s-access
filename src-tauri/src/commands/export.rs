use crate::kubectl::kubectl_path;
use std::process::Command;

#[tauri::command]
pub async fn get_namespace_yaml_bundle(
    context: String,
    namespace: String,
) -> Result<String, String> {
    let output = Command::new(kubectl_path())
        .args([
            "get",
            "all",
            "-n",
            &namespace,
            "--context",
            &context,
            "-o",
            "yaml",
        ])
        .output()
        .map_err(|e| format!("Failed to spawn kubectl: {e}"))?;

    if output.status.success() {
        String::from_utf8(output.stdout)
            .map_err(|e| format!("Invalid UTF-8 in kubectl output: {e}"))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("kubectl error: {stderr}"))
    }
}
