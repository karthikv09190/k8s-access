use crate::kubectl::kubectl_path;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInfo {
    pub id: String,
    pub context: String,
    pub namespace: String,
    pub resource_type: String, // "pod" or "svc"
    pub resource_name: String,
    pub local_port: u16,
    pub remote_port: u16,
}

pub struct PortForwardState {
    pub forwards: Mutex<HashMap<String, (PortForwardInfo, Child)>>,
}

impl Default for PortForwardState {
    fn default() -> Self {
        Self {
            forwards: Mutex::new(HashMap::new()),
        }
    }
}

#[tauri::command]
pub async fn start_port_forward(
    state: tauri::State<'_, PortForwardState>,
    context: String,
    namespace: String,
    resource_type: String,
    resource_name: String,
    local_port: u16,
    remote_port: u16,
) -> Result<String, String> {
    let id = format!("{}-{}-{}-{}", resource_type, resource_name, local_port, remote_port);
    let target = format!("{}/{}", resource_type, resource_name);

    let child = Command::new(kubectl_path())
        .args([
            "port-forward",
            "--context",
            &context,
            "-n",
            &namespace,
            &target,
            &format!("{}:{}", local_port, remote_port),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    let info = PortForwardInfo {
        id: id.clone(),
        context,
        namespace,
        resource_type,
        resource_name,
        local_port,
        remote_port,
    };

    state
        .forwards
        .lock()
        .unwrap()
        .insert(id.clone(), (info, child));

    Ok(id)
}

#[tauri::command]
pub async fn stop_port_forward(
    state: tauri::State<'_, PortForwardState>,
    id: String,
) -> Result<(), String> {
    let mut forwards = state.forwards.lock().unwrap();
    if let Some((_, mut child)) = forwards.remove(&id) {
        child.kill().ok();
    }
    Ok(())
}

#[tauri::command]
pub async fn list_port_forwards(
    state: tauri::State<'_, PortForwardState>,
) -> Result<Vec<PortForwardInfo>, String> {
    let forwards = state.forwards.lock().unwrap();
    Ok(forwards.values().map(|(info, _)| info.clone()).collect())
}
