//! Deterministic problem detection + correlation. No AI involved.
//!
//! Input is a read-only snapshot of the cluster; output is one `Incident` per
//! root resource (e.g. three CrashLoopBackOff pods of one Deployment become a
//! single `Deployment/payment-api` incident with three affected pods).

use super::gateway::{controller_owner, gitops_owner_of};
use super::model::*;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

pub const RESTART_THRESHOLD: i64 = 5;
pub const PENDING_GRACE_MS: Millis = 5 * 60_000;
pub const WARNING_EVENT_MIN_COUNT: i64 = 3;

#[derive(Debug, Clone, Default)]
pub struct HelmReleaseLite {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub revision: String,
    pub chart: String,
}

/// Read-only cluster state for one context.
#[derive(Debug, Clone, Default)]
pub struct ClusterSnapshot {
    /// Pods, Deployments, ReplicaSets, StatefulSets, DaemonSets, Jobs.
    pub workloads: Vec<Value>,
    pub nodes: Vec<Value>,
    /// Warning events.
    pub events: Vec<Value>,
    pub helm: Vec<HelmReleaseLite>,
}

#[derive(Debug, Clone)]
pub struct Finding {
    pub code: String,
    pub severity: Severity,
    pub resource: ResourceRef,
    pub message: String,
    pub count: u32,
    pub restarts: Option<u32>,
    pub seen_at: Millis,
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn s<'a>(v: &'a Value, p: &str) -> &'a str {
    v.pointer(p).and_then(Value::as_str).unwrap_or("")
}

fn i(v: &Value, p: &str) -> i64 {
    v.pointer(p).and_then(Value::as_i64).unwrap_or(0)
}

fn rref(obj: &Value, kind: &str) -> ResourceRef {
    ResourceRef {
        kind: kind.to_string(),
        namespace: obj
            .pointer("/metadata/namespace")
            .and_then(Value::as_str)
            .map(str::to_string),
        name: s(obj, "/metadata/name").to_string(),
        uid: obj
            .pointer("/metadata/uid")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn condition<'a>(obj: &'a Value, ty: &str) -> Option<&'a Value> {
    obj.pointer("/status/conditions")?
        .as_array()?
        .iter()
        .find(|c| c.get("type").and_then(Value::as_str) == Some(ty))
}

/// Minimal RFC 3339 → epoch ms (UTC "Z" or numeric offsets; fractions ignored).
pub fn parse_rfc3339_ms(t: &str) -> Option<Millis> {
    let b = t.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |a: usize, z: usize| t.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let mut secs = days * 86400 + h * 3600 + mi * 60 + se;
    let rest = &t[19..];
    let rest = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    if rest.len() >= 6 && (rest.starts_with('+') || rest.starts_with('-')) {
        let oh: i64 = rest.get(1..3)?.parse().ok()?;
        let om: i64 = rest.get(4..6)?.parse().ok()?;
        let off = (oh * 3600 + om * 60) * if rest.starts_with('+') { 1 } else { -1 };
        secs -= off;
    }
    Some(secs * 1000)
}

// ── detection ─────────────────────────────────────────────────────────────────

pub fn detect(snap: &ClusterSnapshot, now: Millis) -> Vec<Finding> {
    let mut out = Vec::new();
    for obj in &snap.workloads {
        match s(obj, "/kind") {
            "Pod" => detect_pod(obj, now, &mut out),
            "Deployment" => detect_deployment(obj, now, &mut out),
            "ReplicaSet" => {
                if i(obj, "/spec/replicas") > 0 {
                    if let Some(c) = condition(obj, "ReplicaFailure") {
                        if s(c, "/status") == "True" {
                            out.push(finding(
                                "ReplicaSetFailure",
                                Severity::Warning,
                                rref(obj, "ReplicaSet"),
                                format!("{}: {}", s(c, "/reason"), s(c, "/message")),
                                now,
                            ));
                        }
                    }
                }
            }
            "StatefulSet" => {
                let desired = i(obj, "/spec/replicas");
                let ready = i(obj, "/status/readyReplicas");
                if desired > 0 && ready < desired {
                    let sev = if ready == 0 {
                        Severity::Critical
                    } else {
                        Severity::Warning
                    };
                    out.push(finding(
                        "UnavailableReplicas",
                        sev,
                        rref(obj, "StatefulSet"),
                        format!("{}/{} replicas ready", ready, desired),
                        now,
                    ));
                }
            }
            "DaemonSet" => {
                let unavailable = i(obj, "/status/numberUnavailable");
                if unavailable > 0 {
                    out.push(finding(
                        "UnavailableReplicas",
                        Severity::Warning,
                        rref(obj, "DaemonSet"),
                        format!(
                            "{} of {} scheduled pods unavailable",
                            unavailable,
                            i(obj, "/status/desiredNumberScheduled")
                        ),
                        now,
                    ));
                }
            }
            "Job" => {
                if let Some(c) = condition(obj, "Failed") {
                    if s(c, "/status") == "True" {
                        out.push(finding(
                            "JobFailed",
                            Severity::Warning,
                            rref(obj, "Job"),
                            format!("{}: {}", s(c, "/reason"), s(c, "/message")),
                            now,
                        ));
                    }
                }
            }
            _ => {}
        }
    }
    for node in &snap.nodes {
        let ready = condition(node, "Ready");
        if ready.map(|c| s(c, "/status")) != Some("True") {
            let msg = ready
                .map(|c| format!("{}: {}", s(c, "/reason"), s(c, "/message")))
                .unwrap_or_else(|| "Ready condition missing".into());
            out.push(finding(
                "NodeNotReady",
                Severity::Critical,
                rref(node, "Node"),
                msg,
                now,
            ));
        }
    }
    for ev in &snap.events {
        detect_event(ev, now, &mut out);
    }
    for h in &snap.helm {
        let st = h.status.as_str();
        if st == "failed" || st.starts_with("pending-") {
            out.push(Finding {
                code: "HelmReleaseFailed".into(),
                severity: Severity::Warning,
                resource: ResourceRef {
                    kind: "HelmRelease".into(),
                    namespace: Some(h.namespace.clone()),
                    name: h.name.clone(),
                    uid: None,
                },
                message: format!(
                    "release {} revision {} ({}) is {}",
                    h.name, h.revision, h.chart, st
                ),
                count: 1,
                restarts: None,
                seen_at: now,
            });
        }
    }
    out
}

fn finding(
    code: &str,
    severity: Severity,
    resource: ResourceRef,
    message: String,
    now: Millis,
) -> Finding {
    Finding {
        code: code.into(),
        severity,
        resource,
        message,
        count: 1,
        restarts: None,
        seen_at: now,
    }
}

fn detect_pod(pod: &Value, now: Millis, out: &mut Vec<Finding>) {
    let phase = s(pod, "/status/phase");
    if phase == "Succeeded" {
        return;
    }
    let r = rref(pod, "Pod");
    let mut statuses: Vec<&Value> = Vec::new();
    for p in ["/status/initContainerStatuses", "/status/containerStatuses"] {
        if let Some(a) = pod.pointer(p).and_then(Value::as_array) {
            statuses.extend(a.iter());
        }
    }
    for cs in statuses {
        let cname = s(cs, "/name");
        let restarts = i(cs, "/restartCount");
        let waiting = s(cs, "/state/waiting/reason");
        let mut push = |code: &str, sev: Severity, msg: String| {
            out.push(Finding {
                code: code.into(),
                severity: sev,
                resource: r.clone(),
                message: msg,
                count: 1,
                restarts: Some(restarts as u32),
                seen_at: now,
            });
        };
        let crashloop = waiting == "CrashLoopBackOff";
        match waiting {
            "CrashLoopBackOff" => push(
                "CrashLoopBackOff",
                Severity::Critical,
                format!(
                    "container {} in CrashLoopBackOff ({} restarts): {}",
                    cname,
                    restarts,
                    s(cs, "/state/waiting/message")
                ),
            ),
            "ImagePullBackOff" | "ErrImagePull" | "InvalidImageName" => push(
                waiting,
                Severity::Warning,
                format!(
                    "container {} cannot pull image {}: {}",
                    cname,
                    s(cs, "/image"),
                    s(cs, "/state/waiting/message")
                ),
            ),
            "CreateContainerConfigError" => push(
                waiting,
                Severity::Warning,
                format!("container {}: {}", cname, s(cs, "/state/waiting/message")),
            ),
            _ => {}
        }
        if s(cs, "/lastState/terminated/reason") == "OOMKilled"
            || s(cs, "/state/terminated/reason") == "OOMKilled"
        {
            push(
                "OOMKilled",
                Severity::Critical,
                format!("container {} was OOMKilled (exit 137)", cname),
            );
        }
        if restarts >= RESTART_THRESHOLD && !crashloop {
            push(
                "ExcessiveRestarts",
                Severity::Warning,
                format!(
                    "container {} restarted {} times (last: {})",
                    cname,
                    restarts,
                    s(cs, "/lastState/terminated/reason")
                ),
            );
        }
    }
    if phase == "Pending" {
        let created = parse_rfc3339_ms(s(pod, "/metadata/creationTimestamp")).unwrap_or(now);
        if now - created > PENDING_GRACE_MS {
            let why = condition(pod, "PodScheduled")
                .filter(|c| s(c, "/status") != "True")
                .map(|c| format!("{}: {}", s(c, "/reason"), s(c, "/message")))
                .unwrap_or_else(|| "containers not started".into());
            out.push(finding(
                "PodPending",
                Severity::Warning,
                r.clone(),
                format!("pending for {} min — {}", (now - created) / 60_000, why),
                now,
            ));
        }
    }
    if phase == "Failed" {
        out.push(finding(
            "PodFailed",
            Severity::Warning,
            r,
            format!(
                "{}: {}",
                s(pod, "/status/reason"),
                s(pod, "/status/message")
            ),
            now,
        ));
    }
}

fn detect_deployment(d: &Value, now: Millis, out: &mut Vec<Finding>) {
    let r = rref(d, "Deployment");
    if let Some(c) = condition(d, "Progressing") {
        if s(c, "/status") == "False" && s(c, "/reason") == "ProgressDeadlineExceeded" {
            out.push(finding(
                "RolloutStuck",
                Severity::Critical,
                r.clone(),
                format!("rollout stuck: {}", s(c, "/message")),
                now,
            ));
        }
    }
    let desired = i(d, "/spec/replicas");
    let unavailable = i(d, "/status/unavailableReplicas");
    if desired > 0 && unavailable > 0 {
        let available = i(d, "/status/availableReplicas");
        let sev = if available == 0 {
            Severity::Critical
        } else {
            Severity::Warning
        };
        out.push(finding(
            "UnavailableReplicas",
            sev,
            r,
            format!(
                "{}/{} replicas available, {} unavailable",
                available, desired, unavailable
            ),
            now,
        ));
    }
}

fn detect_event(ev: &Value, now: Millis, out: &mut Vec<Finding>) {
    let reason = s(ev, "/reason");
    let msg = s(ev, "/message");
    let count = i(ev, "/count").max(i(ev, "/series/count")).max(1);
    let obj = ev.get("involvedObject").or_else(|| ev.get("regarding"));
    let Some(obj) = obj else { return };
    let resource = ResourceRef {
        kind: s(obj, "/kind").to_string(),
        namespace: obj
            .get("namespace")
            .and_then(Value::as_str)
            .map(str::to_string),
        name: s(obj, "/name").to_string(),
        uid: obj.get("uid").and_then(Value::as_str).map(str::to_string),
    };
    if resource.name.is_empty() {
        return;
    }
    let seen = [
        s(ev, "/lastTimestamp"),
        s(ev, "/eventTime"),
        s(ev, "/metadata/creationTimestamp"),
    ]
    .iter()
    .find_map(|t| parse_rfc3339_ms(t))
    .unwrap_or(now);
    let (code, severity) = if reason == "Unhealthy" && msg.starts_with("Readiness probe failed") {
        ("ReadinessProbeFailed".to_string(), Severity::Warning)
    } else if reason == "Unhealthy" && msg.starts_with("Liveness probe failed") {
        ("LivenessProbeFailed".to_string(), Severity::Warning)
    } else if count >= WARNING_EVENT_MIN_COUNT {
        (format!("WarningEvent:{}", reason), Severity::Info)
    } else {
        return;
    };
    out.push(Finding {
        code,
        severity,
        resource,
        message: format!("{} (x{}): {}", reason, count, msg),
        count: count as u32,
        restarts: None,
        seen_at: seen,
    });
}

// ── correlation ───────────────────────────────────────────────────────────────

struct OwnerIndex {
    /// (ns, kind, name) → controller (kind, name)
    owners: HashMap<(String, String, String), (String, String)>,
    objects: HashMap<(String, String, String), Value>,
}

impl OwnerIndex {
    fn build(snap: &ClusterSnapshot) -> Self {
        let mut owners = HashMap::new();
        let mut objects = HashMap::new();
        for o in &snap.workloads {
            let key = (
                s(o, "/metadata/namespace").to_string(),
                s(o, "/kind").to_string(),
                s(o, "/metadata/name").to_string(),
            );
            if let Some(owner) = controller_owner(o) {
                owners.insert(key.clone(), owner);
            }
            objects.insert(key, o.clone());
        }
        Self { owners, objects }
    }

    /// Walks controller ownerReferences up to the top-level workload.
    fn root(&self, r: &ResourceRef) -> ResourceRef {
        let ns = r.namespace.clone().unwrap_or_default();
        let mut kind = r.kind.clone();
        let mut name = r.name.clone();
        for _ in 0..4 {
            match self.owners.get(&(ns.clone(), kind.clone(), name.clone())) {
                // CronJobs are not collected; the Job is the actionable root.
                Some((k, _)) if k == "CronJob" => break,
                Some((k, n)) => {
                    kind = k.clone();
                    name = n.clone();
                }
                None => break,
            }
        }
        // A ReplicaSet with no Deployment in the snapshot stays the root.
        let uid = self
            .objects
            .get(&(ns.clone(), kind.clone(), name.clone()))
            .and_then(|o| {
                o.pointer("/metadata/uid")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| {
                if kind == r.kind && name == r.name {
                    r.uid.clone()
                } else {
                    None
                }
            });
        ResourceRef {
            kind,
            namespace: r.namespace.clone(),
            name,
            uid,
        }
    }

    fn object(&self, r: &ResourceRef) -> Option<&Value> {
        self.objects.get(&(
            r.namespace.clone().unwrap_or_default(),
            r.kind.clone(),
            r.name.clone(),
        ))
    }
}

const CODE_PRIORITY: [&str; 12] = [
    "CrashLoopBackOff",
    "OOMKilled",
    "ImagePullBackOff",
    "ErrImagePull",
    "RolloutStuck",
    "NodeNotReady",
    "JobFailed",
    "HelmReleaseFailed",
    "PodPending",
    "PodFailed",
    "UnavailableReplicas",
    "ExcessiveRestarts",
];

fn priority(code: &str) -> usize {
    CODE_PRIORITY
        .iter()
        .position(|c| *c == code)
        .unwrap_or(CODE_PRIORITY.len())
}

pub fn incident_key(binding: &ClusterBinding, r: &ResourceRef) -> String {
    format!(
        "{}/{}/{}/{}",
        binding.context,
        r.namespace.as_deref().unwrap_or("_cluster"),
        r.kind,
        r.name
    )
}

/// Groups findings by their root resource. Groups made only of informational
/// findings (e.g. generic warning events) do not become incidents.
pub fn correlate(
    binding: &ClusterBinding,
    snap: &ClusterSnapshot,
    findings: Vec<Finding>,
) -> Vec<Incident> {
    let index = OwnerIndex::build(snap);
    let mut groups: BTreeMap<String, (ResourceRef, Vec<Finding>)> = BTreeMap::new();
    for f in findings {
        let root = index.root(&f.resource);
        let key = incident_key(binding, &root);
        groups
            .entry(key)
            .or_insert_with(|| (root, Vec::new()))
            .1
            .push(f);
    }
    let mut out = Vec::new();
    for (key, (root, fs)) in groups {
        let severity = fs
            .iter()
            .map(|f| f.severity)
            .max()
            .unwrap_or(Severity::Info);
        if severity == Severity::Info {
            continue;
        }
        let mut codes: Vec<&str> = fs.iter().map(|f| f.code.as_str()).collect();
        codes.sort_by_key(|c| (priority(c), *c));
        codes.dedup();
        let mut affected: Vec<ResourceRef> = Vec::new();
        for f in &fs {
            if f.resource != root
                && !affected
                    .iter()
                    .any(|a| a.kind == f.resource.kind && a.name == f.resource.name)
            {
                affected.push(f.resource.clone());
            }
        }
        let first = fs.iter().map(|f| f.seen_at).min().unwrap_or(0);
        let last = fs.iter().map(|f| f.seen_at).max().unwrap_or(0);
        let symptoms = fs
            .iter()
            .map(|f| Symptom {
                code: f.code.clone(),
                resource: f.resource.clone(),
                message: f.message.clone(),
                first_seen: f.seen_at,
                last_seen: f.seen_at,
                count: f.count,
            })
            .collect();
        let pods = affected.iter().filter(|a| a.kind == "Pod").count();
        let problem = if pods > 1 {
            format!("{} ({} pods affected)", codes.join(", "), pods)
        } else {
            codes.join(", ")
        };
        out.push(Incident {
            id: uuid::Uuid::new_v4().to_string(),
            key,
            binding: binding.clone(),
            severity,
            status: IncidentStatus::Detected,
            gitops_owner: index.object(&root).and_then(gitops_owner_of),
            resource: root,
            problem,
            symptoms,
            affected,
            restart_count: fs.iter().filter_map(|f| f.restarts).max(),
            first_detected: first,
            last_detected: last,
            diagnosis: None,
            diagnosis_error: None,
            proposals: vec![],
            active_proposal_id: None,
            approvals: vec![],
            rejections: vec![],
            executions: vec![],
            verifications: vec![],
            history: vec![StatusChange {
                from: None,
                to: IncidentStatus::Detected,
                at: last,
                reason: "detected".into(),
            }],
            last_error: None,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: Millis = 1_791_417_600_000; // 2026-10-08T00:00:00Z

    fn binding() -> ClusterBinding {
        ClusterBinding {
            context: "ctx".into(),
            cluster_name: "c".into(),
            server: "https://s".into(),
        }
    }

    fn crash_pod(name: &str, rs: &str) -> Value {
        json!({"kind":"Pod","metadata":{"name":name,"namespace":"payments","uid":format!("uid-{name}"),
            "creationTimestamp":"2026-10-07T23:00:00Z",
            "ownerReferences":[{"kind":"ReplicaSet","name":rs,"controller":true}]},
            "status":{"phase":"Running","containerStatuses":[{"name":"api","restartCount":12,
                "state":{"waiting":{"reason":"CrashLoopBackOff","message":"back-off 5m0s"}},
                "lastState":{"terminated":{"reason":"Error","exitCode":1}}}]}})
    }

    fn deployment_chain() -> Vec<Value> {
        vec![
            json!({"kind":"Deployment","metadata":{"name":"payment-api","namespace":"payments","uid":"dep-uid",
                "labels":{"argocd.argoproj.io/instance":"payments"}},
                "spec":{"replicas":3},"status":{"availableReplicas":0,"unavailableReplicas":3}}),
            json!({"kind":"ReplicaSet","metadata":{"name":"payment-api-7d9f","namespace":"payments",
                "ownerReferences":[{"kind":"Deployment","name":"payment-api","controller":true}]},"spec":{"replicas":3}}),
        ]
    }

    #[test]
    fn rfc3339() {
        assert_eq!(parse_rfc3339_ms("2026-10-08T00:00:00Z"), Some(NOW));
        assert_eq!(parse_rfc3339_ms("2026-10-08T09:00:00.123+09:00"), Some(NOW));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("garbage"), None);
    }

    #[test]
    fn three_crashlooping_pods_become_one_deployment_incident() {
        let mut w = deployment_chain();
        for n in [
            "payment-api-7d9f-a",
            "payment-api-7d9f-b",
            "payment-api-7d9f-c",
        ] {
            w.push(crash_pod(n, "payment-api-7d9f"));
        }
        let snap = ClusterSnapshot {
            workloads: w,
            ..Default::default()
        };
        let incs = correlate(&binding(), &snap, detect(&snap, NOW));
        assert_eq!(
            incs.len(),
            1,
            "{:#?}",
            incs.iter().map(|i| &i.key).collect::<Vec<_>>()
        );
        let inc = &incs[0];
        assert_eq!(inc.resource.kind, "Deployment");
        assert_eq!(inc.resource.name, "payment-api");
        assert_eq!(inc.resource.uid.as_deref(), Some("dep-uid"));
        assert_eq!(inc.affected.iter().filter(|a| a.kind == "Pod").count(), 3);
        assert_eq!(inc.severity, Severity::Critical);
        assert!(
            inc.problem.starts_with("CrashLoopBackOff"),
            "{}",
            inc.problem
        );
        assert_eq!(inc.restart_count, Some(12));
        assert_eq!(
            inc.gitops_owner.as_deref(),
            Some("Argo CD (application payments)")
        );
        assert_eq!(inc.key, "ctx/payments/Deployment/payment-api");
    }

    #[test]
    fn pod_level_detectors() {
        let oom = json!({"kind":"Pod","metadata":{"name":"oom","namespace":"a"},"status":{"phase":"Running",
            "containerStatuses":[{"name":"c","restartCount":2,"state":{"running":{}},"lastState":{"terminated":{"reason":"OOMKilled"}}}]}});
        let pull = json!({"kind":"Pod","metadata":{"name":"pull","namespace":"a"},"status":{"phase":"Pending",
            "containerStatuses":[{"name":"c","image":"x:bad","restartCount":0,"state":{"waiting":{"reason":"ImagePullBackOff"}}}]}});
        let errpull = json!({"kind":"Pod","metadata":{"name":"errpull","namespace":"a"},"status":{"phase":"Pending",
            "containerStatuses":[{"name":"c","restartCount":0,"state":{"waiting":{"reason":"ErrImagePull"}}}]}});
        let restarts = json!({"kind":"Pod","metadata":{"name":"flappy","namespace":"a"},"status":{"phase":"Running",
            "containerStatuses":[{"name":"c","restartCount":9,"state":{"running":{}}}]}});
        let pending_old = json!({"kind":"Pod","metadata":{"name":"stuck","namespace":"a","creationTimestamp":"2026-10-07T23:00:00Z"},
            "status":{"phase":"Pending","conditions":[{"type":"PodScheduled","status":"False","reason":"Unschedulable","message":"0/3 nodes available"}]}});
        let pending_new = json!({"kind":"Pod","metadata":{"name":"fresh","namespace":"a","creationTimestamp":"2026-10-07T23:59:00Z"},
            "status":{"phase":"Pending"}});
        let failed = json!({"kind":"Pod","metadata":{"name":"evicted","namespace":"a"},"status":{"phase":"Failed","reason":"Evicted","message":"low memory"}});
        let done = json!({"kind":"Pod","metadata":{"name":"done","namespace":"a"},"status":{"phase":"Succeeded",
            "containerStatuses":[{"name":"c","restartCount":9}]}});
        let snap = ClusterSnapshot {
            workloads: vec![
                oom,
                pull,
                errpull,
                restarts,
                pending_old,
                pending_new,
                failed,
                done,
            ],
            ..Default::default()
        };
        let codes: Vec<(String, String)> = detect(&snap, NOW)
            .into_iter()
            .map(|f| (f.resource.name, f.code))
            .collect();
        let has = |n: &str, c: &str| codes.contains(&(n.to_string(), c.to_string()));
        assert!(has("oom", "OOMKilled"));
        assert!(has("pull", "ImagePullBackOff"));
        assert!(has("errpull", "ErrImagePull"));
        assert!(has("flappy", "ExcessiveRestarts"));
        assert!(has("stuck", "PodPending"));
        assert!(
            !codes.iter().any(|(n, _)| n == "fresh"),
            "pending within grace period ignored"
        );
        assert!(has("evicted", "PodFailed"));
        assert!(
            !codes.iter().any(|(n, _)| n == "done"),
            "succeeded pods ignored"
        );
    }

    #[test]
    fn workload_node_job_helm_detectors() {
        let stuck = json!({"kind":"Deployment","metadata":{"name":"web","namespace":"a"},"spec":{"replicas":2},
            "status":{"availableReplicas":2,"conditions":[{"type":"Progressing","status":"False","reason":"ProgressDeadlineExceeded","message":"timed out"}]}});
        let rs = json!({"kind":"ReplicaSet","metadata":{"name":"quota-rs","namespace":"a"},"spec":{"replicas":1},
            "status":{"conditions":[{"type":"ReplicaFailure","status":"True","reason":"FailedCreate","message":"exceeded quota"}]}});
        let job = json!({"kind":"Job","metadata":{"name":"migrate","namespace":"a"},
            "status":{"conditions":[{"type":"Failed","status":"True","reason":"BackoffLimitExceeded","message":"Job has reached the specified backoff limit"}]}});
        let node_bad = json!({"kind":"Node","metadata":{"name":"ip-10-0-1-1"},"status":{"conditions":[{"type":"Ready","status":"Unknown","reason":"NodeStatusUnknown"}]}});
        let node_ok = json!({"kind":"Node","metadata":{"name":"ip-10-0-1-2"},"status":{"conditions":[{"type":"Ready","status":"True"}]}});
        let snap = ClusterSnapshot {
            workloads: vec![stuck, rs, job],
            nodes: vec![node_bad, node_ok],
            helm: vec![
                HelmReleaseLite {
                    name: "pay".into(),
                    namespace: "a".into(),
                    status: "failed".into(),
                    revision: "4".into(),
                    chart: "pay-1.0".into(),
                },
                HelmReleaseLite {
                    name: "ok".into(),
                    namespace: "a".into(),
                    status: "deployed".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let incs = correlate(&binding(), &snap, detect(&snap, NOW));
        let keys: Vec<&str> = incs.iter().map(|i| i.key.as_str()).collect();
        assert!(keys.contains(&"ctx/a/Deployment/web"));
        assert!(keys.contains(&"ctx/a/ReplicaSet/quota-rs"));
        assert!(keys.contains(&"ctx/a/Job/migrate"));
        assert!(keys.contains(&"ctx/_cluster/Node/ip-10-0-1-1"));
        assert!(keys.contains(&"ctx/a/HelmRelease/pay"));
        assert_eq!(incs.len(), 5, "{keys:?}");
    }

    #[test]
    fn probe_events_attach_to_owning_workload_and_info_events_alone_are_ignored() {
        let mut w = deployment_chain();
        w[0]["status"] = json!({"availableReplicas":3});
        w.push(json!({"kind":"Pod","metadata":{"name":"payment-api-7d9f-a","namespace":"payments",
            "ownerReferences":[{"kind":"ReplicaSet","name":"payment-api-7d9f","controller":true}]},"status":{"phase":"Running"}}));
        let ev = |reason: &str, msg: &str, name: &str, count: i64| {
            json!({"reason":reason,"message":msg,"count":count,
            "involvedObject":{"kind":"Pod","name":name,"namespace":"payments"},"lastTimestamp":"2026-10-07T23:58:00Z"})
        };
        let snap = ClusterSnapshot {
            workloads: w,
            events: vec![
                ev(
                    "Unhealthy",
                    "Readiness probe failed: HTTP probe failed with statuscode: 503",
                    "payment-api-7d9f-a",
                    40,
                ),
                ev(
                    "Unhealthy",
                    "Liveness probe failed: connection refused",
                    "payment-api-7d9f-a",
                    3,
                ),
                ev("FailedMount", "MountVolume.SetUp failed", "lonely-pod", 9),
                ev("BackOff", "x", "rare-pod", 1),
            ],
            ..Default::default()
        };
        let incs = correlate(&binding(), &snap, detect(&snap, NOW));
        assert_eq!(
            incs.len(),
            1,
            "{:?}",
            incs.iter().map(|i| &i.key).collect::<Vec<_>>()
        );
        let codes: Vec<&str> = incs[0].symptoms.iter().map(|s| s.code.as_str()).collect();
        assert!(codes.contains(&"ReadinessProbeFailed") && codes.contains(&"LivenessProbeFailed"));
        assert_eq!(incs[0].resource.name, "payment-api");
    }

    #[test]
    fn healthy_cluster_has_no_incidents() {
        let snap = ClusterSnapshot {
            workloads: vec![
                json!({"kind":"Deployment","metadata":{"name":"ok","namespace":"a"},"spec":{"replicas":2},
                "status":{"availableReplicas":2,"conditions":[{"type":"Progressing","status":"True"}]}}),
            ],
            nodes: vec![
                json!({"kind":"Node","metadata":{"name":"n"},"status":{"conditions":[{"type":"Ready","status":"True"}]}}),
            ],
            ..Default::default()
        };
        assert!(correlate(&binding(), &snap, detect(&snap, NOW)).is_empty());
    }
}
