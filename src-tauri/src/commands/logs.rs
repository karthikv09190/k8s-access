use k8s_openapi::api::core::v1::Pod;
use kube::{api::LogParams, config::KubeConfigOptions, Api, Client};

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
