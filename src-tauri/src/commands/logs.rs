use futures::{io::AsyncBufReadExt, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::{api::LogParams, config::KubeConfigOptions, Api, Client};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Emitter;
use uuid::Uuid;

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
pub async fn get_pod_logs(
    context: String,
    namespace: String,
    pod_name: String,
    container: Option<String>,
    tail_lines: Option<i64>,
) -> Result<String, String> {
    let client = make_client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);

    let params = LogParams {
        container,
        tail_lines,
        ..Default::default()
    };

    api.logs(&pod_name, &params)
        .await
        .map_err(|e| e.to_string())
}

pub struct LogStreamState {
    pub streams: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

impl Default for LogStreamState {
    fn default() -> Self {
        Self {
            streams: Mutex::new(HashMap::new()),
        }
    }
}

#[tauri::command]
pub async fn start_log_stream(
    context: String,
    namespace: String,
    pod_name: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    app: tauri::AppHandle,
    state: tauri::State<'_, LogStreamState>,
) -> Result<String, String> {
    let stream_id = Uuid::new_v4().to_string();

    let client = make_client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);

    let params = LogParams {
        container,
        tail_lines,
        follow: true,
        ..Default::default()
    };

    let log_stream = api
        .log_stream(&pod_name, &params)
        .await
        .map_err(|e| e.to_string())?;

    let sid = stream_id.clone();
    let app2 = app.clone();

    let handle = tokio::spawn(async move {
        let mut lines = log_stream.lines();
        while let Some(result) = lines.next().await {
            match result {
                Ok(line) => {
                    let _ = app2.emit(&format!("log-line-{}", sid), line);
                }
                Err(_) => break,
            }
        }
        let _ = app2.emit(&format!("log-end-{}", sid), ());
    });

    state.streams.lock().unwrap().insert(stream_id.clone(), handle);
    Ok(stream_id)
}

#[tauri::command]
pub async fn stop_log_stream(
    stream_id: String,
    state: tauri::State<'_, LogStreamState>,
) -> Result<(), String> {
    if let Some(handle) = state.streams.lock().unwrap().remove(&stream_id) {
        handle.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn get_pod_containers(
    context: String,
    namespace: String,
    pod_name: String,
) -> Result<Vec<String>, String> {
    let client = make_client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);

    let pod = api.get(&pod_name).await.map_err(|e| e.to_string())?;

    let containers = pod
        .spec
        .map(|s| {
            s.containers
                .into_iter()
                .map(|c| c.name)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(containers)
}
