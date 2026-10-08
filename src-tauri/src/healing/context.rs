//! Builds the sanitized, incident-scoped context sent to an AI provider.
//! Only resources related to the incident are included, every object and text
//! passes through the sanitizer, and Secret VALUES are never read at all
//! (only names of referenced Secrets are listed).

use super::model::Incident;
use super::reader::ClusterReader;
use super::sanitizer::{redact_text, sanitize_object};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

const MAX_PODS: usize = 5;
const MAX_LOG_PODS: usize = 2;
const LOG_TAIL: u32 = 80;
const MAX_LOG_CHARS: usize = 6_000;
const MAX_EVENTS: usize = 30;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogExcerpt {
    pub pod: String,
    pub container: String,
    pub previous: bool,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentContext {
    pub cluster_context: String,
    pub namespace: Option<String>,
    pub resource_kind: String,
    pub resource_name: String,
    pub problem: String,
    pub severity: String,
    pub symptoms: Vec<Value>,
    pub resource: Option<Value>,
    pub pods: Vec<Value>,
    pub events: Vec<Value>,
    pub logs: Vec<LogExcerpt>,
    pub rollout_history: Option<String>,
    pub nodes: Vec<Value>,
    pub services: Vec<Value>,
    /// ConfigMap/Secret names referenced by the workload (never values).
    pub config_references: Vec<String>,
    pub metrics: Option<String>,
    pub gitops_owner: Option<String>,
    pub collection_notes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMeta {
    pub sections: Vec<String>,
    pub chars: usize,
    pub redactions: usize,
    pub truncated: bool,
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut cut = s.len() - max;
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    format!("…[truncated]…\n{}", &s[cut..])
}

/// Keep only diagnostic parts of an object.
fn trim(obj: &Value) -> Value {
    let m = obj.get("metadata").cloned().unwrap_or(Value::Null);
    json!({
        "kind": obj.get("kind"),
        "metadata": {
            "name": m.get("name"), "namespace": m.get("namespace"), "labels": m.get("labels"),
            "annotations": m.get("annotations"), "generation": m.get("generation"),
            "creationTimestamp": m.get("creationTimestamp"),
            "ownerReferences": m.get("ownerReferences").and_then(Value::as_array).map(|a| a.iter()
                .map(|o| json!({"kind": o.get("kind"), "name": o.get("name")})).collect::<Vec<_>>()),
        },
        "spec": obj.get("spec"),
        "status": obj.get("status"),
    })
}

fn collect_refs(v: &Value, out: &mut BTreeSet<String>) {
    match v {
        Value::Object(map) => {
            for (k, val) in map {
                let name = val.get("name").and_then(Value::as_str);
                match (k.as_str(), name) {
                    ("configMapKeyRef" | "configMapRef" | "configMap", Some(n)) => {
                        out.insert(format!("ConfigMap/{}", n));
                    }
                    ("secretKeyRef" | "secretRef", Some(n)) => {
                        out.insert(format!("Secret/{} (values not sent)", n));
                    }
                    ("secret", _) => {
                        if let Some(n) = val.get("secretName").and_then(Value::as_str) {
                            out.insert(format!("Secret/{} (values not sent)", n));
                        }
                    }
                    _ => {}
                }
                collect_refs(val, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_refs(x, out)),
        _ => {}
    }
}

fn selector_matches(selector: &Value, labels: &Value) -> bool {
    match selector.as_object() {
        Some(sel) if !sel.is_empty() => sel.iter().all(|(k, v)| labels.get(k) == Some(v)),
        _ => false,
    }
}

pub async fn build<R: ClusterReader>(
    reader: &R,
    inc: &Incident,
    max_chars: usize,
) -> (IncidentContext, ContextMeta) {
    let ctx = inc.binding.context.as_str();
    let ns = inc.resource.namespace.clone();
    let mut notes = Vec::new();
    let mut redactions = 0;
    let mut sections = vec!["incident".to_string(), "symptoms".to_string()];

    let symptoms = inc
        .symptoms
        .iter()
        .map(|s| {
            let (msg, n) = redact_text(&s.message);
            redactions += n;
            json!({"code": s.code, "resource": format!("{}/{}", s.resource.kind, s.resource.name), "message": msg, "count": s.count})
        })
        .collect();

    // Root resource (never fetch Secrets).
    let mut resource = None;
    if inc.resource.kind != "HelmRelease" && inc.resource.kind != "Secret" {
        match reader
            .get_json(ctx, ns.as_deref(), &inc.resource.kind, &inc.resource.name)
            .await
        {
            Ok(obj) => {
                let mut t = trim(&obj);
                redactions += sanitize_object(&mut t);
                resource = Some(t);
                sections.push("resource".into());
            }
            Err(e) => notes.push(format!("resource unavailable: {}", redact_text(&e).0)),
        }
    }

    // Affected pods.
    let mut pods = Vec::new();
    let mut raw_pods = Vec::new();
    if let Some(ns) = ns.as_deref() {
        for p in inc
            .affected
            .iter()
            .filter(|a| a.kind == "Pod")
            .take(MAX_PODS)
        {
            match reader.get_json(ctx, Some(ns), "Pod", &p.name).await {
                Ok(obj) => {
                    raw_pods.push(obj.clone());
                    let mut t = trim(&obj);
                    redactions += sanitize_object(&mut t);
                    pods.push(t);
                }
                Err(e) => notes.push(format!("pod {} unavailable: {}", p.name, redact_text(&e).0)),
            }
        }
        if !pods.is_empty() {
            sections.push("pods".into());
        }
    }

    // Logs (current + previous) for the first few pods.
    let mut logs = Vec::new();
    if let Some(ns) = ns.as_deref() {
        for pod in raw_pods.iter().take(MAX_LOG_PODS) {
            let pname = pod
                .pointer("/metadata/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let statuses = pod
                .pointer("/status/containerStatuses")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for cs in statuses {
                let cname = cs.get("name").and_then(Value::as_str).unwrap_or_default();
                let restarted = cs.get("restartCount").and_then(Value::as_i64).unwrap_or(0) > 0;
                for previous in [false, true] {
                    if previous && !restarted {
                        continue;
                    }
                    match reader.logs(ctx, ns, pname, cname, previous, LOG_TAIL).await {
                        Ok(text) if !text.trim().is_empty() => {
                            let (t, n) = redact_text(&text);
                            redactions += n;
                            logs.push(LogExcerpt {
                                pod: pname.into(),
                                container: cname.into(),
                                previous,
                                text: clip(&t, MAX_LOG_CHARS),
                            });
                        }
                        Ok(_) => {}
                        Err(e) => notes.push(format!(
                            "logs {}/{} previous={}: {}",
                            pname,
                            cname,
                            previous,
                            redact_text(&e).0
                        )),
                    }
                }
            }
        }
        if !logs.is_empty() {
            sections.push("logs".into());
        }
    }

    // Events for the incident's objects.
    let mut names: BTreeSet<String> = inc.affected.iter().map(|a| a.name.clone()).collect();
    names.insert(inc.resource.name.clone());
    let mut events = Vec::new();
    match reader.list_json(ctx, ns.as_deref(), "events", None).await {
        Ok(items) => {
            let mut rel: Vec<&Value> = items
                .iter()
                .filter(|e| {
                    let n = e
                        .pointer("/involvedObject/name")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    names.contains(n) || names.iter().any(|x| n.starts_with(&format!("{}-", x)))
                })
                .collect();
            rel.sort_by_key(|e| {
                e.get("lastTimestamp")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            });
            for e in rel.iter().rev().take(MAX_EVENTS) {
                let (msg, n) = redact_text(e.get("message").and_then(Value::as_str).unwrap_or(""));
                redactions += n;
                events.push(json!({
                    "type": e.get("type"), "reason": e.get("reason"), "message": msg, "count": e.get("count"),
                    "object": format!("{}/{}", e.pointer("/involvedObject/kind").and_then(Value::as_str).unwrap_or(""),
                        e.pointer("/involvedObject/name").and_then(Value::as_str).unwrap_or("")),
                    "lastTimestamp": e.get("lastTimestamp"),
                }));
            }
            if !events.is_empty() {
                sections.push("events".into());
            }
        }
        Err(e) => notes.push(format!("events unavailable: {}", redact_text(&e).0)),
    }

    // Rollout history for rollout-capable workloads.
    let mut rollout_history = None;
    if let (Some(ns), "Deployment" | "StatefulSet" | "DaemonSet") =
        (ns.as_deref(), inc.resource.kind.as_str())
    {
        if let Ok(h) = reader
            .rollout_history(ctx, ns, &inc.resource.kind, &inc.resource.name)
            .await
        {
            rollout_history = Some(clip(&redact_text(&h).0, 3_000));
            sections.push("rolloutHistory".into());
        }
    }

    // Nodes the affected pods run on (conditions only).
    let mut nodes = Vec::new();
    let node_names: BTreeSet<String> = raw_pods
        .iter()
        .filter_map(|p| {
            p.pointer("/spec/nodeName")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .chain(std::iter::once(inc.resource.name.clone()).filter(|_| inc.resource.kind == "Node"))
        .collect();
    for n in node_names {
        if let Ok(node) = reader.get_json(ctx, None, "Node", &n).await {
            nodes.push(json!({
                "name": n,
                "conditions": node.pointer("/status/conditions").and_then(Value::as_array).map(|cs| cs.iter()
                    .map(|c| json!({"type": c.get("type"), "status": c.get("status"), "reason": c.get("reason")}))
                    .collect::<Vec<_>>()),
                "allocatable": node.pointer("/status/allocatable"),
            }));
        }
    }
    if !nodes.is_empty() {
        sections.push("nodes".into());
    }

    // Services selecting the pods.
    let mut services = Vec::new();
    if let (Some(ns), Some(pod)) = (ns.as_deref(), raw_pods.first()) {
        let labels = pod
            .pointer("/metadata/labels")
            .cloned()
            .unwrap_or(Value::Null);
        if let Ok(svcs) = reader.list_json(ctx, Some(ns), "services", None).await {
            for s in svcs {
                if selector_matches(s.pointer("/spec/selector").unwrap_or(&Value::Null), &labels) {
                    services.push(json!({"name": s.pointer("/metadata/name"), "type": s.pointer("/spec/type"), "ports": s.pointer("/spec/ports")}));
                }
            }
        }
        if !services.is_empty() {
            sections.push("services".into());
        }
    }

    let mut refs = BTreeSet::new();
    if let Some(r) = &resource {
        collect_refs(r, &mut refs);
    }
    for p in &pods {
        collect_refs(p, &mut refs);
    }

    // Metrics are optional (metrics-server may be absent).
    let metrics = match ns.as_deref() {
        Some(ns) => reader
            .top_pods(ctx, ns)
            .await
            .ok()
            .map(|t| {
                t.lines()
                    .filter(|l| {
                        l.starts_with("NAME") || names.iter().any(|n| l.starts_with(n.as_str()))
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter(|t| t.lines().count() > 1),
        None => None,
    };
    if metrics.is_some() {
        sections.push("metrics".into());
    }

    let mut context = IncidentContext {
        cluster_context: ctx.to_string(),
        namespace: ns,
        resource_kind: inc.resource.kind.clone(),
        resource_name: inc.resource.name.clone(),
        problem: inc.problem.clone(),
        severity: format!("{:?}", inc.severity),
        symptoms,
        resource,
        pods,
        events,
        logs,
        rollout_history,
        nodes,
        services,
        config_references: refs.into_iter().collect(),
        metrics,
        gitops_owner: inc.gitops_owner.clone(),
        collection_notes: notes,
    };

    // Enforce the size budget: drop the bulkiest, least essential parts first.
    let mut truncated = false;
    let size = |c: &IncidentContext| serde_json::to_string(c).map(|s| s.len()).unwrap_or(0);
    while size(&context) > max_chars {
        truncated = true;
        if context.logs.pop().is_some() {
            continue;
        }
        if context.events.len() > 5 {
            context.events.truncate(context.events.len() / 2);
            continue;
        }
        if context.pods.len() > 1 {
            context.pods.pop();
            continue;
        }
        if let Some(r) = context.resource.as_mut() {
            if !r["status"].is_null() {
                r["status"] = Value::Null;
                continue;
            }
        }
        break;
    }
    let meta = ContextMeta {
        chars: size(&context),
        sections,
        redactions,
        truncated,
    };
    (context, meta)
}
