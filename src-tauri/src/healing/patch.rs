//! PATCH_WORKLOAD: validation of the typed change set and generation of the
//! strategic-merge patch. AI only ever supplies typed numbers/quantities/tag;
//! the patch JSON is built here from the CURRENT object, so it can only touch
//! the allow-listed fields of one named container (plus the pod's
//! terminationGracePeriodSeconds).

use super::model::{FieldChange, ProbeChange, ResourceChange, WorkloadPatch};
use serde_json::{json, Map, Value};

const PROBE_HANDLERS: [&str; 4] = ["httpGet", "tcpSocket", "exec", "grpc"];

fn valid_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.as_bytes()[s.len() - 1].is_ascii_alphanumeric()
}

pub fn valid_image_tag(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 128
        && (t.as_bytes()[0].is_ascii_alphanumeric() || t.as_bytes()[0] == b'_')
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

/// CPU quantity in cores ("250m", "2", "1.5").
pub fn parse_cpu(s: &str) -> Option<f64> {
    let (num, mult) = match s.strip_suffix('m') {
        Some(n) => (n, 0.001),
        None => (s, 1.0),
    };
    if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return None;
    }
    num.parse::<f64>()
        .ok()
        .map(|v| v * mult)
        .filter(|v| *v > 0.0)
}

/// Memory quantity in bytes ("512Mi", "1Gi", "500M", "1048576").
pub fn parse_memory(s: &str) -> Option<f64> {
    const UNITS: [(&str, f64); 8] = [
        ("Ki", 1024.0),
        ("Mi", 1048576.0),
        ("Gi", 1073741824.0),
        ("Ti", 1099511627776.0),
        ("k", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
    ];
    let (num, mult) = UNITS
        .iter()
        .find_map(|(u, m)| s.strip_suffix(u).map(|n| (n, *m)))
        .unwrap_or((s, 1.0));
    if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return None;
    }
    num.parse::<f64>()
        .ok()
        .map(|v| v * mult)
        .filter(|v| *v > 0.0)
}

fn check_probe(name: &str, p: &ProbeChange, success_must_be_one: bool) -> Result<(), String> {
    let range = |field: &str, v: Option<u32>, lo: u32, hi: u32| match v {
        Some(x) if x < lo || x > hi => Err(format!("{}.{} must be {}..={}", name, field, lo, hi)),
        _ => Ok(()),
    };
    range("initialDelaySeconds", p.initial_delay_seconds, 0, 600)?;
    range("periodSeconds", p.period_seconds, 1, 300)?;
    range("timeoutSeconds", p.timeout_seconds, 1, 60)?;
    range("failureThreshold", p.failure_threshold, 1, 120)?;
    range("successThreshold", p.success_threshold, 1, 10)?;
    if success_must_be_one && p.success_threshold.map_or(false, |s| s != 1) {
        return Err(format!("{}.successThreshold must be 1", name));
    }
    if *p == ProbeChange::default() {
        return Err(format!("{} change is empty", name));
    }
    Ok(())
}

fn check_resources(r: &ResourceChange) -> Result<(), String> {
    let cpu = |v: &Option<String>, f: &str| -> Result<Option<f64>, String> {
        match v {
            None => Ok(None),
            Some(s) => match parse_cpu(s) {
                Some(c) if c <= 64.0 => Ok(Some(c)),
                Some(_) => Err(format!("{} {} exceeds 64 cores", f, s)),
                None => Err(format!("{} {:?} is not a valid CPU quantity", f, s)),
            },
        }
    };
    let mem = |v: &Option<String>, f: &str| -> Result<Option<f64>, String> {
        match v {
            None => Ok(None),
            Some(s) => match parse_memory(s) {
                Some(m) if m <= 256.0 * 1073741824.0 => Ok(Some(m)),
                Some(_) => Err(format!("{} {} exceeds 256Gi", f, s)),
                None => Err(format!("{} {:?} is not a valid memory quantity", f, s)),
            },
        }
    };
    let (rc, lc) = (
        cpu(&r.requests_cpu, "requests.cpu")?,
        cpu(&r.limits_cpu, "limits.cpu")?,
    );
    let (rm, lm) = (
        mem(&r.requests_memory, "requests.memory")?,
        mem(&r.limits_memory, "limits.memory")?,
    );
    if let (Some(a), Some(b)) = (rc, lc) {
        if a > b {
            return Err("requests.cpu exceeds limits.cpu".into());
        }
    }
    if let (Some(a), Some(b)) = (rm, lm) {
        if a > b {
            return Err("requests.memory exceeds limits.memory".into());
        }
    }
    if *r == ResourceChange::default() {
        return Err("resources change is empty".into());
    }
    Ok(())
}

/// Static validation of the typed change set (no cluster access).
pub fn validate(container: &str, p: &WorkloadPatch) -> Result<(), String> {
    if !valid_label(container) {
        return Err(format!("invalid container name {:?}", container));
    }
    if *p == WorkloadPatch::default() {
        return Err("patch contains no changes".into());
    }
    if let Some(x) = &p.liveness_probe {
        check_probe("livenessProbe", x, true)?;
    }
    if let Some(x) = &p.readiness_probe {
        check_probe("readinessProbe", x, false)?;
    }
    if let Some(x) = &p.startup_probe {
        check_probe("startupProbe", x, true)?;
    }
    if let Some(r) = &p.resources {
        check_resources(r)?;
    }
    if p.termination_grace_period_seconds
        .map_or(false, |g| g > 3600)
    {
        return Err("terminationGracePeriodSeconds must be <= 3600".into());
    }
    if p.pre_stop_sleep_seconds.map_or(false, |s| s > 600) {
        return Err("preStop sleep must be <= 600s".into());
    }
    if let (Some(s), Some(g)) = (p.pre_stop_sleep_seconds, p.termination_grace_period_seconds) {
        if s >= g {
            return Err("preStop sleep must be shorter than terminationGracePeriodSeconds".into());
        }
    }
    if let Some(t) = &p.image_tag {
        if !valid_image_tag(t) {
            return Err(format!("invalid image tag {:?}", t));
        }
    }
    Ok(())
}

pub struct BuiltPatch {
    /// Strategic-merge patch to send to the API server.
    pub patch: Value,
    /// Locally computed result (used when the dry-run result lacks a field).
    pub after: Value,
    /// (JSON pointer into the object, display label) of every touched field.
    pub fields: Vec<(String, String)>,
}

fn apply_probe(mut base: Map<String, Value>, ch: &ProbeChange) -> Map<String, Value> {
    for (k, v) in [
        ("initialDelaySeconds", ch.initial_delay_seconds),
        ("periodSeconds", ch.period_seconds),
        ("timeoutSeconds", ch.timeout_seconds),
        ("failureThreshold", ch.failure_threshold),
        ("successThreshold", ch.success_threshold),
    ] {
        if let Some(v) = v {
            base.insert(k.into(), json!(v));
        }
    }
    base
}

fn is_num(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// Replace the number in a simple `sleep N` preStop hook, keeping its form.
fn rewrite_pre_stop(pre_stop: &Value, secs: u32) -> Result<Value, String> {
    if pre_stop.pointer("/sleep/seconds").is_some() {
        return Ok(json!({"sleep": {"seconds": secs}}));
    }
    let cmd: Vec<String> = pre_stop
        .pointer("/exec/command")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let shells = ["sh", "/bin/sh", "bash", "/bin/bash"];
    match cmd.len() {
        2 if (cmd[0] == "sleep" || cmd[0] == "/bin/sleep") && is_num(&cmd[1]) => {
            Ok(json!({"exec": {"command": [cmd[0].clone(), secs.to_string()]}}))
        }
        3 if shells.contains(&cmd[0].as_str()) && cmd[1] == "-c" => {
            let parts: Vec<&str> = cmd[2].split_whitespace().collect();
            if parts.len() == 2 && parts[0] == "sleep" && is_num(parts[1]) {
                Ok(json!({"exec": {"command": [cmd[0].clone(), "-c", format!("sleep {}", secs)]}}))
            } else {
                Err("preStop hook is not a simple `sleep N`; change it in the manifest".into())
            }
        }
        _ => Err("container has no simple `sleep N` preStop hook to adjust".into()),
    }
}

/// New image reference: same repository, new tag (digest dropped).
pub fn retag(image: &str, tag: &str) -> String {
    let no_digest = image.split('@').next().unwrap_or(image);
    let slash = no_digest.rfind('/').map_or(0, |i| i + 1);
    let repo = match no_digest[slash..].rfind(':') {
        Some(i) => &no_digest[..slash + i],
        None => no_digest,
    };
    format!("{}:{}", repo, tag)
}

pub fn build(obj: &Value, container: &str, p: &WorkloadPatch) -> Result<BuiltPatch, String> {
    validate(container, p)?;
    let containers = obj
        .pointer("/spec/template/spec/containers")
        .and_then(Value::as_array)
        .ok_or("workload has no pod template containers")?;
    let idx = containers
        .iter()
        .position(|c| c.get("name").and_then(Value::as_str) == Some(container))
        .ok_or_else(|| format!("container {:?} not found in workload", container))?;
    let current = containers[idx].clone();
    let mut cpatch = Map::new();
    cpatch.insert("name".into(), json!(container));
    let mut fields = Vec::new();
    let cptr = format!("/spec/template/spec/containers/{}", idx);
    let mut after = obj.clone();
    let mut set_after = |field: &str, v: Value| {
        after["spec"]["template"]["spec"]["containers"][idx][field] = v;
    };

    for (field, change) in [
        ("livenessProbe", &p.liveness_probe),
        ("readinessProbe", &p.readiness_probe),
        ("startupProbe", &p.startup_probe),
    ] {
        let Some(ch) = change else { continue };
        let base = match current.get(field).and_then(Value::as_object) {
            Some(existing) => existing.clone(),
            None if field == "startupProbe" => {
                // A new startupProbe reuses the liveness handler; AI never
                // supplies a handler (command/URL).
                let live = current
                    .get("livenessProbe")
                    .and_then(Value::as_object)
                    .ok_or(
                    "cannot add a startupProbe: container has no livenessProbe handler to reuse",
                )?;
                let mut m: Map<String, Value> = live
                    .iter()
                    .filter(|(k, _)| PROBE_HANDLERS.contains(&k.as_str()))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                if m.is_empty() {
                    return Err("livenessProbe has no handler to reuse".into());
                }
                m.insert("periodSeconds".into(), json!(10));
                m.insert("failureThreshold".into(), json!(30));
                m
            }
            None => return Err(format!("container has no {} to tune", field)),
        };
        let merged = Value::Object(apply_probe(base, ch));
        cpatch.insert(field.into(), merged.clone());
        set_after(field, merged);
        fields.push((
            format!("{}/{}", cptr, field),
            format!("{}.{}", container, field),
        ));
    }

    if let Some(r) = &p.resources {
        let mut res = current
            .get("resources")
            .cloned()
            .unwrap_or_else(|| json!({}));
        for (section, key, val) in [
            ("requests", "cpu", &r.requests_cpu),
            ("requests", "memory", &r.requests_memory),
            ("limits", "cpu", &r.limits_cpu),
            ("limits", "memory", &r.limits_memory),
        ] {
            if let Some(v) = val {
                if !res.get(section).map_or(false, Value::is_object) {
                    res[section] = json!({});
                }
                res[section][key] = json!(v);
            }
        }
        cpatch.insert("resources".into(), res.clone());
        set_after("resources", res);
        fields.push((
            format!("{}/resources", cptr),
            format!("{}.resources", container),
        ));
    }

    if let Some(secs) = p.pre_stop_sleep_seconds {
        let pre = current
            .pointer("/lifecycle/preStop")
            .ok_or("container has no preStop hook to adjust")?;
        let new_pre = rewrite_pre_stop(pre, secs)?;
        let mut lifecycle = current
            .get("lifecycle")
            .cloned()
            .unwrap_or_else(|| json!({}));
        lifecycle["preStop"] = new_pre.clone();
        cpatch.insert("lifecycle".into(), json!({"preStop": new_pre}));
        set_after("lifecycle", lifecycle);
        fields.push((
            format!("{}/lifecycle/preStop", cptr),
            format!("{}.lifecycle.preStop", container),
        ));
    }

    if let Some(tag) = &p.image_tag {
        let image = current
            .get("image")
            .and_then(Value::as_str)
            .ok_or("container has no image")?;
        let new_image = retag(image, tag);
        cpatch.insert("image".into(), json!(new_image.clone()));
        set_after("image", json!(new_image));
        fields.push((format!("{}/image", cptr), format!("{}.image", container)));
    }

    let mut pod_spec = Map::new();
    if cpatch.len() > 1 {
        pod_spec.insert("containers".into(), json!([Value::Object(cpatch)]));
    }
    if let Some(g) = p.termination_grace_period_seconds {
        pod_spec.insert("terminationGracePeriodSeconds".into(), json!(g));
        after["spec"]["template"]["spec"]["terminationGracePeriodSeconds"] = json!(g);
        fields.push((
            "/spec/template/spec/terminationGracePeriodSeconds".into(),
            "terminationGracePeriodSeconds".into(),
        ));
    }
    Ok(BuiltPatch {
        patch: json!({"spec": {"template": {"spec": Value::Object(pod_spec)}}}),
        after,
        fields,
    })
}

fn compact(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "(unset)".into(),
        Some(v) => serde_json::to_string(v).unwrap_or_default(),
    }
}

/// Before/after for each touched field. `result` (server dry-run) wins over
/// the local computation when it contains the field.
pub fn field_changes(
    before: &Value,
    result: Option<&Value>,
    local: &Value,
    fields: &[(String, String)],
) -> Vec<FieldChange> {
    fields
        .iter()
        .map(|(ptr, label)| FieldChange {
            path: label.clone(),
            before: compact(before.pointer(ptr)),
            after: compact(
                result
                    .and_then(|r| r.pointer(ptr))
                    .or_else(|| local.pointer(ptr)),
            ),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deployment() -> Value {
        json!({"kind":"Deployment","metadata":{"name":"ats-account-api"},"spec":{"template":{"spec":{
            "terminationGracePeriodSeconds":30,
            "containers":[{"name":"api","image":"123.dkr.ecr/ats-account-api:1.4.2@sha256:abc",
                "livenessProbe":{"httpGet":{"path":"/api/health","port":8080},"initialDelaySeconds":10,"periodSeconds":10,"timeoutSeconds":1,"failureThreshold":3},
                "readinessProbe":{"httpGet":{"path":"/api/health","port":8080},"periodSeconds":5},
                "resources":{"requests":{"cpu":"100m","memory":"256Mi"},"limits":{"memory":"512Mi"}},
                "lifecycle":{"preStop":{"exec":{"command":["sh","-c","sleep 30"]}}}}]}}}})
    }

    #[test]
    fn startup_probe_reuses_liveness_handler() {
        let p = WorkloadPatch {
            startup_probe: Some(ProbeChange {
                failure_threshold: Some(18),
                period_seconds: Some(5),
                ..Default::default()
            }),
            liveness_probe: Some(ProbeChange {
                timeout_seconds: Some(3),
                ..Default::default()
            }),
            ..Default::default()
        };
        let b = build(&deployment(), "api", &p).unwrap();
        let c = &b.patch["spec"]["template"]["spec"]["containers"][0];
        assert_eq!(c["name"], "api");
        assert_eq!(c["startupProbe"]["httpGet"]["path"], "/api/health");
        assert_eq!(c["startupProbe"]["failureThreshold"], 18);
        assert_eq!(c["startupProbe"]["periodSeconds"], 5);
        assert_eq!(c["livenessProbe"]["timeoutSeconds"], 3);
        assert_eq!(
            c["livenessProbe"]["initialDelaySeconds"], 10,
            "untouched fields kept"
        );
        assert!(
            c.get("image").is_none() && c.get("resources").is_none(),
            "only requested fields patched"
        );
        let changes = field_changes(&deployment(), None, &b.after, &b.fields);
        assert_eq!(changes.len(), 2);
        assert!(changes
            .iter()
            .any(|f| f.path == "api.startupProbe" && f.before == "(unset)"));
    }

    #[test]
    fn resources_grace_prestop_and_image() {
        let p = WorkloadPatch {
            resources: Some(ResourceChange {
                limits_memory: Some("1Gi".into()),
                requests_memory: Some("512Mi".into()),
                ..Default::default()
            }),
            termination_grace_period_seconds: Some(45),
            pre_stop_sleep_seconds: Some(10),
            image_tag: Some("1.4.3".into()),
            ..Default::default()
        };
        let b = build(&deployment(), "api", &p).unwrap();
        let spec = &b.patch["spec"]["template"]["spec"];
        assert_eq!(spec["terminationGracePeriodSeconds"], 45);
        let c = &spec["containers"][0];
        assert_eq!(c["resources"]["limits"]["memory"], "1Gi");
        assert_eq!(
            c["resources"]["requests"]["cpu"], "100m",
            "existing request kept"
        );
        assert_eq!(
            c["lifecycle"]["preStop"]["exec"]["command"],
            json!(["sh", "-c", "sleep 10"])
        );
        assert_eq!(c["image"], "123.dkr.ecr/ats-account-api:1.4.3");
    }

    #[test]
    fn retag_keeps_repository() {
        assert_eq!(retag("nginx", "1.27"), "nginx:1.27");
        assert_eq!(
            retag("registry:5000/team/app:1.0", "2.0"),
            "registry:5000/team/app:2.0"
        );
        assert_eq!(retag("ghcr.io/x/app@sha256:aa", "v3"), "ghcr.io/x/app:v3");
    }

    #[test]
    fn rejects_bad_input() {
        let ok_probe = Some(ProbeChange {
            timeout_seconds: Some(3),
            ..Default::default()
        });
        let mk = |p: WorkloadPatch| validate("api", &p);
        assert!(mk(WorkloadPatch::default()).is_err(), "empty");
        assert!(validate(
            "API; rm",
            &WorkloadPatch {
                liveness_probe: ok_probe.clone(),
                ..Default::default()
            }
        )
        .is_err());
        assert!(mk(WorkloadPatch {
            liveness_probe: Some(ProbeChange {
                timeout_seconds: Some(0),
                ..Default::default()
            }),
            ..Default::default()
        })
        .is_err());
        assert!(mk(WorkloadPatch {
            liveness_probe: Some(ProbeChange {
                success_threshold: Some(2),
                ..Default::default()
            }),
            ..Default::default()
        })
        .is_err());
        assert!(mk(WorkloadPatch {
            resources: Some(ResourceChange {
                limits_memory: Some("lots".into()),
                ..Default::default()
            }),
            ..Default::default()
        })
        .is_err());
        assert!(mk(WorkloadPatch {
            resources: Some(ResourceChange {
                requests_cpu: Some("2".into()),
                limits_cpu: Some("500m".into()),
                ..Default::default()
            }),
            ..Default::default()
        })
        .is_err());
        assert!(mk(WorkloadPatch {
            resources: Some(ResourceChange {
                limits_memory: Some("1024Gi".into()),
                ..Default::default()
            }),
            ..Default::default()
        })
        .is_err());
        assert!(mk(WorkloadPatch {
            image_tag: Some("../evil".into()),
            ..Default::default()
        })
        .is_err());
        assert!(mk(WorkloadPatch {
            image_tag: Some("x:y".into()),
            ..Default::default()
        })
        .is_err());
        assert!(mk(WorkloadPatch {
            image_tag: Some("1.0;rm -rf /".into()),
            ..Default::default()
        })
        .is_err());
        assert!(mk(WorkloadPatch {
            pre_stop_sleep_seconds: Some(40),
            termination_grace_period_seconds: Some(30),
            ..Default::default()
        })
        .is_err());
        assert!(
            build(
                &deployment(),
                "sidecar",
                &WorkloadPatch {
                    liveness_probe: ok_probe,
                    ..Default::default()
                }
            )
            .is_err(),
            "unknown container"
        );
    }

    #[test]
    fn prestop_must_be_simple_sleep() {
        let mut d = deployment();
        d["spec"]["template"]["spec"]["containers"][0]["lifecycle"]["preStop"] =
            json!({"exec":{"command":["sh","-c","curl -X POST localhost/drain && sleep 30"]}});
        let p = WorkloadPatch {
            pre_stop_sleep_seconds: Some(5),
            ..Default::default()
        };
        assert!(build(&d, "api", &p).is_err());
    }

    #[test]
    fn quantities() {
        assert_eq!(parse_cpu("250m"), Some(0.25));
        assert_eq!(parse_cpu("2"), Some(2.0));
        assert_eq!(parse_memory("512Mi"), Some(536870912.0));
        assert!(
            parse_cpu("-1").is_none() && parse_memory("1Xi").is_none() && parse_cpu("").is_none()
        );
    }

    #[test]
    fn ai_cannot_smuggle_extra_patch_fields() {
        let bad = [
            r#"{"liveness_probe":{"timeout_seconds":3,"exec":{"command":["rm","-rf","/"]}}}"#,
            r#"{"env":[{"name":"X","value":"y"}]}"#,
            r#"{"security_context":{"privileged":true}}"#,
            r#"{"command":["sh","-c","evil"]}"#,
        ];
        for b in bad {
            assert!(serde_json::from_str::<WorkloadPatch>(b).is_err(), "{b}");
        }
    }
}
