use crate::kubectl::kubectl_path;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tokio::task::JoinHandle;

// ── State ────────────────────────────────────────────────────────────────────

pub struct WatchState {
    pub tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl Default for WatchState {
    fn default() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
        }
    }
}

// ── Alert payload ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClusterAlert {
    pub id: String,
    pub context: String,
    pub severity: String, // "warning" | "critical"
    pub message: String,
    pub timestamp: String,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn rfc3339_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Produce a simple RFC 3339 UTC string without pulling in chrono.
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    // Gregorian calendar approximation (good enough for a log timestamp).
    let year = 1970 + days / 365;
    let day_of_year = days % 365;
    let month = day_of_year / 30 + 1;
    let day = day_of_year % 30 + 1;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, h, m, s
    )
}

fn alert_id(context: &str, kind: &str, name: &str) -> String {
    format!("{}-{}-{}", context, kind, name)
}

// ── JSON scraping ─────────────────────────────────────────────────────────────

fn find_crashloop_pods(context: &str, json: &serde_json::Value) -> Vec<ClusterAlert> {
    let mut alerts = Vec::new();
    let items = match json.get("items").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return alerts,
    };
    for item in items {
        let ns = item
            .pointer("/metadata/namespace")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let name = item
            .pointer("/metadata/name")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        let container_statuses = item
            .pointer("/status/containerStatuses")
            .and_then(|v| v.as_array());

        if let Some(statuses) = container_statuses {
            for cs in statuses {
                let reason = cs
                    .pointer("/state/waiting/reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if reason == "CrashLoopBackOff" {
                    let container_name = cs
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    alerts.push(ClusterAlert {
                        id: alert_id(context, "crashloop", &format!("{}/{}/{}", ns, name, container_name)),
                        context: context.to_string(),
                        severity: "critical".to_string(),
                        message: format!(
                            "Pod {}/{} container '{}' is in CrashLoopBackOff",
                            ns, name, container_name
                        ),
                        timestamp: rfc3339_now(),
                    });
                }
            }
        }
    }
    alerts
}

fn find_warning_events(context: &str, json: &serde_json::Value) -> Vec<ClusterAlert> {
    let mut alerts = Vec::new();
    let items = match json.get("items").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return alerts,
    };
    for item in items {
        let count = item
            .get("count")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if count <= 5 {
            continue;
        }
        let ns = item
            .pointer("/metadata/namespace")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let name = item
            .pointer("/metadata/name")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let reason = item
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");
        let message = item
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let involved = item
            .pointer("/involvedObject/name")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        alerts.push(ClusterAlert {
            id: alert_id(context, "event", &format!("{}/{}", ns, name)),
            context: context.to_string(),
            severity: "warning".to_string(),
            message: format!(
                "Warning event ({} count={}) on {}/{}: {}",
                reason, count, ns, involved, message
            ),
            timestamp: rfc3339_now(),
        });
    }
    alerts
}

// ── Watch loop ────────────────────────────────────────────────────────────────

async fn run_watch_loop(context: String, app: tauri::AppHandle) {
    loop {
        // --- pods ---
        let pods_out = tokio::process::Command::new(kubectl_path())
            .args(["get", "pods", "-A", "-o", "json", "--context", &context])
            .output()
            .await;

        if let Ok(out) = pods_out {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                for alert in find_crashloop_pods(&context, &json) {
                    let _ = app.emit("cluster-alert", &alert);
                }
            }
        }

        // --- warning events ---
        let events_out = tokio::process::Command::new(kubectl_path())
            .args([
                "get",
                "events",
                "-A",
                "-o",
                "json",
                "--context",
                &context,
                "--field-selector",
                "type=Warning",
            ])
            .output()
            .await;

        if let Ok(out) = events_out {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                for alert in find_warning_events(&context, &json) {
                    let _ = app.emit("cluster-alert", &alert);
                }
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_cluster_watch(
    context: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, WatchState>,
) -> Result<(), String> {
    let mut tasks = state.tasks.lock().unwrap();
    // Abort existing task for this context if any.
    if let Some(handle) = tasks.remove(&context) {
        handle.abort();
    }
    let ctx = context.clone();
    let handle = tokio::spawn(run_watch_loop(ctx, app));
    tasks.insert(context, handle);
    Ok(())
}

#[tauri::command]
pub async fn stop_cluster_watch(
    context: String,
    state: tauri::State<'_, WatchState>,
) -> Result<(), String> {
    let mut tasks = state.tasks.lock().unwrap();
    if let Some(handle) = tasks.remove(&context) {
        handle.abort();
    }
    Ok(())
}

/// No-op: alert dismissal is handled entirely on the frontend.
#[tauri::command]
pub async fn clear_cluster_alerts() -> Result<(), String> {
    Ok(())
}
