use k8s_openapi::api::core::v1::Event;
use kube::{api::ListParams, config::KubeConfigOptions, Api, Client};
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct K8sEvent {
    pub namespace: String,
    pub name: String,
    pub event_type: String,
    pub reason: String,
    pub message: String,
    pub object_kind: String,
    pub object_name: String,
    pub count: i32,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    pub source_component: String,
    pub source_host: String,
}

/// List Kubernetes events, optionally filtered by namespace and/or involved object.
#[tauri::command]
pub async fn list_events(
    context: String,
    namespace: Option<String>,
    involved_object_kind: Option<String>,
    involved_object_name: Option<String>,
) -> Result<Vec<K8sEvent>, String> {
    let client = make_client(&context).await?;
    let lp = ListParams::default();

    let event_list = if let Some(ref ns) = namespace {
        let api: Api<Event> = Api::namespaced(client, ns);
        api.list(&lp).await.map_err(|e| e.to_string())?
    } else {
        let api: Api<Event> = Api::all(client);
        api.list(&lp).await.map_err(|e| e.to_string())?
    };

    let mut events: Vec<K8sEvent> = event_list
        .items
        .into_iter()
        .filter(|e| {
            if let (Some(ref kind), Some(ref name)) =
                (&involved_object_kind, &involved_object_name)
            {
                e.involved_object.kind.as_deref() == Some(kind.as_str())
                    && e.involved_object.name.as_deref() == Some(name.as_str())
            } else {
                true
            }
        })
        .map(|e| {
            let source = e.source.as_ref();
            // Prefer last_timestamp, fall back to event_time, then creation_timestamp
            let last_ts = e
                .last_timestamp
                .as_ref()
                .map(|t| t.0.to_rfc3339())
                .or_else(|| {
                    e.event_time
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                })
                .or_else(|| {
                    e.metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                });
            let first_ts = e
                .first_timestamp
                .as_ref()
                .map(|t| t.0.to_rfc3339())
                .or_else(|| last_ts.clone());

            K8sEvent {
                namespace: e.metadata.namespace.unwrap_or_default(),
                name: e.metadata.name.unwrap_or_default(),
                event_type: e.type_.unwrap_or_else(|| "Normal".to_string()),
                reason: e.reason.unwrap_or_default(),
                message: e.message.unwrap_or_default(),
                object_kind: e.involved_object.kind.unwrap_or_default(),
                object_name: e.involved_object.name.unwrap_or_default(),
                count: e.count.unwrap_or(1),
                first_timestamp: first_ts,
                last_timestamp: last_ts,
                source_component: source
                    .and_then(|s| s.component.clone())
                    .unwrap_or_default(),
                source_host: source.and_then(|s| s.host.clone()).unwrap_or_default(),
            }
        })
        .collect();

    // Most recent events first
    events.sort_by(|a, b| b.last_timestamp.cmp(&a.last_timestamp));

    Ok(events)
}
