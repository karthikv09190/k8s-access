use crate::kubectl::kubectl_path;
use std::process::{Command as StdCommand, Stdio};

#[tauri::command]
pub async fn run_kubectl_command(
    context: String,
    namespace: String,
    args: Vec<String>,
) -> Result<String, String> {
    let mut all_args: Vec<String> = vec![
        "--context".into(),
        context,
        "-n".into(),
        namespace,
    ];
    all_args.extend(args);

    let output = StdCommand::new(kubectl_path())
        .args(&all_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run kubectl: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let mut result = stdout;
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push_str("\n[stderr]\n");
        }
        result.push_str(&stderr);
    }

    Ok(result)
}
