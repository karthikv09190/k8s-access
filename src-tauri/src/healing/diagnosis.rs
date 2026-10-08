//! Structured AI diagnosis: JSON schema handed to the provider and strict
//! validation of what comes back. AI output is untrusted data; the only thing
//! that can become executable is a `HealingAction` that parses into the closed
//! enum, and even that still needs a proposal + administrator approval.

use super::model::{HealingAction, Incident, RiskLevel};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_TEXT: usize = 2_000;
const MAX_ITEMS: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiDiagnosis {
    pub summary: String,
    pub probable_root_cause: String,
    pub confidence: f64,
    pub evidence: Vec<String>,
    pub contributing_factors: Vec<String>,
    pub recommended_action: Option<Value>,
    pub risk_level: RiskLevel,
    pub expected_impact: String,
    pub verification_steps: Vec<String>,
    pub rollback_strategy: String,
    pub limitations: Vec<String>,
    pub uncertainty: String,
    /// For GitOps-managed resources: the change to make in Git (text/diff).
    #[serde(default)]
    pub gitops_suggestion: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Validated {
    Actionable(AiDiagnosis, HealingAction),
    NoAction(AiDiagnosis),
    /// Diagnosis is usable but the proposed action is not executable.
    Unsupported(AiDiagnosis, String),
}

/// JSON schema for a typed action (or null). Shared by diagnosis and chat.
pub fn action_schema() -> Value {
    let int =
        |min: u32, max: u32| json!({"type": ["integer", "null"], "minimum": min, "maximum": max});
    let probe = json!({"anyOf": [{"type": "null"}, {
        "type": "object", "additionalProperties": false,
        "properties": {
            "initial_delay_seconds": int(0, 600), "period_seconds": int(1, 300), "timeout_seconds": int(1, 60),
            "failure_threshold": int(1, 120), "success_threshold": int(1, 10)
        }
    }]});
    let qty = json!({"type": ["string", "null"]});
    json!({"anyOf": [
        {"type": "null"},
        {
            "type": "object",
            "additionalProperties": false,
            "required": ["type", "namespace"],
            "properties": {
                "type": {"enum": ["RESTART_POD", "ROLLOUT_RESTART", "ROLLBACK_DEPLOYMENT", "SCALE_DEPLOYMENT", "SCALE_STATEFULSET", "PATCH_WORKLOAD"]},
                "namespace": {"type": "string"},
                "name": {"type": "string"},
                "pod": {"type": "string"},
                "kind": {"enum": ["Deployment", "StatefulSet", "DaemonSet"]},
                "replicas": {"type": "integer", "minimum": 1},
                "to_revision": {"type": "integer", "minimum": 1},
                "container": {"type": "string"},
                "changes": {
                    "type": "object", "additionalProperties": false,
                    "properties": {
                        "liveness_probe": probe.clone(), "readiness_probe": probe.clone(), "startup_probe": probe,
                        "resources": {"anyOf": [{"type": "null"}, {
                            "type": "object", "additionalProperties": false,
                            "properties": {"requests_cpu": qty.clone(), "requests_memory": qty.clone(),
                                "limits_cpu": qty.clone(), "limits_memory": qty}
                        }]},
                        "termination_grace_period_seconds": int(0, 3600),
                        "pre_stop_sleep_seconds": int(0, 600),
                        "image_tag": {"type": ["string", "null"]}
                    }
                }
            }
        }
    ]})
}

pub fn schema() -> Value {
    let strings = json!({"type": "array", "items": {"type": "string"}});
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary", "probable_root_cause", "confidence", "evidence", "contributing_factors",
            "recommended_action", "risk_level", "expected_impact", "verification_steps",
            "rollback_strategy", "limitations", "uncertainty", "gitops_suggestion"],
        "properties": {
            "summary": {"type": "string"},
            "probable_root_cause": {"type": "string"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "evidence": strings,
            "contributing_factors": strings,
            "recommended_action": action_schema(),
            "risk_level": {"enum": ["LOW", "MEDIUM", "HIGH", "CRITICAL"]},
            "expected_impact": {"type": "string"},
            "verification_steps": strings,
            "rollback_strategy": {"type": "string"},
            "limitations": strings,
            "uncertainty": {"type": "string"},
            "gitops_suggestion": {"type": ["string", "null"]}
        }
    })
}

/// Drops nulls the model used for unused optional fields (recursively), so
/// the strict `HealingAction` parse sees only what was actually set.
pub fn strip_nulls(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.retain(|_, x| !x.is_null());
            m.values_mut().for_each(strip_nulls);
            // A sub-object left empty (all fields null) means "unchanged".
            m.retain(|_, x| !x.as_object().map_or(false, |o| o.is_empty()));
        }
        Value::Array(a) => a.iter_mut().for_each(strip_nulls),
        _ => {}
    }
}

/// Parses an untrusted action value into the closed enum.
pub fn parse_action(raw: &Value) -> Result<HealingAction, String> {
    let mut a = raw.clone();
    strip_nulls(&mut a);
    serde_json::from_value::<HealingAction>(a).map_err(|e| format!("{} ({})", raw, e))
}

fn clip(s: &mut String) {
    if s.len() > MAX_TEXT {
        let mut cut = MAX_TEXT;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push('…');
    }
}

fn clip_list(v: &mut Vec<String>) {
    v.truncate(MAX_ITEMS);
    v.iter_mut().for_each(clip);
}

/// Strict validation. `Err` means the response is unusable as a diagnosis.
pub fn validate(raw: Value, inc: &Incident) -> Result<Validated, String> {
    let mut d: AiDiagnosis =
        serde_json::from_value(raw).map_err(|e| format!("schema violation: {}", e))?;
    if !d.confidence.is_finite() || !(0.0..=1.0).contains(&d.confidence) {
        return Err(format!("confidence {} outside 0..1", d.confidence));
    }
    if d.summary.trim().is_empty() || d.probable_root_cause.trim().is_empty() {
        return Err("summary and probable_root_cause are required".into());
    }
    if d.evidence.iter().all(|e| e.trim().is_empty()) {
        return Err("no evidence provided".into());
    }
    for s in [
        &mut d.summary,
        &mut d.probable_root_cause,
        &mut d.expected_impact,
        &mut d.rollback_strategy,
        &mut d.uncertainty,
    ] {
        clip(s);
    }
    for l in [
        &mut d.evidence,
        &mut d.contributing_factors,
        &mut d.verification_steps,
        &mut d.limitations,
    ] {
        clip_list(l);
    }

    // Evidence must reference something actually observed for this incident.
    let mut anchors: Vec<String> = vec![inc.resource.name.to_lowercase()];
    anchors.extend(inc.affected.iter().map(|a| a.name.to_lowercase()));
    anchors.extend(inc.symptoms.iter().map(|s| s.code.to_lowercase()));
    anchors.extend(
        inc.symptoms
            .iter()
            .map(|s| s.code.trim_start_matches("WarningEvent:").to_lowercase()),
    );
    let grounded = d.evidence.iter().any(|e| {
        let e = e.to_lowercase();
        anchors
            .iter()
            .any(|a| !a.is_empty() && e.contains(a.as_str()))
    });
    if !grounded {
        return Err("evidence does not reference any observed resource or symptom".into());
    }

    if let Some(g) = d.gitops_suggestion.as_mut() {
        clip(g);
    }
    let Some(action) = d.recommended_action.clone() else {
        return Ok(Validated::NoAction(d));
    };
    // Nulls for unused optional fields are dropped; anything else unexpected
    // still fails the strict parse.
    match parse_action(&action) {
        Ok(a) => Ok(Validated::Actionable(d, a)),
        Err(msg) => Ok(Validated::Unsupported(d, msg)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::healing::model::*;

    fn inc() -> Incident {
        let r = |k: &str, n: &str| ResourceRef {
            kind: k.into(),
            namespace: Some("payments".into()),
            name: n.into(),
            uid: None,
        };
        Incident {
            id: "i".into(),
            key: "k".into(),
            binding: ClusterBinding {
                context: "c".into(),
                cluster_name: "c".into(),
                server: "s".into(),
            },
            severity: Severity::Critical,
            status: IncidentStatus::Analyzing,
            resource: r("Deployment", "payment-api"),
            problem: "CrashLoopBackOff".into(),
            symptoms: vec![Symptom {
                code: "CrashLoopBackOff".into(),
                resource: r("Pod", "payment-api-abc"),
                message: "x".into(),
                first_seen: 0,
                last_seen: 0,
                count: 1,
            }],
            affected: vec![r("Pod", "payment-api-abc")],
            restart_count: None,
            first_detected: 0,
            last_detected: 0,
            gitops_owner: None,
            diagnosis: None,
            diagnosis_error: None,
            proposals: vec![],
            active_proposal_id: None,
            approvals: vec![],
            rejections: vec![],
            executions: vec![],
            verifications: vec![],
            history: vec![],
            last_error: None,
            conversation: vec![],
        }
    }

    fn good(action: Value) -> Value {
        json!({
            "summary": "payment-api crashes on start", "probable_root_cause": "bad config after deploy",
            "confidence": 0.82, "evidence": ["pod payment-api-abc exits with code 1", "CrashLoopBackOff x12"],
            "contributing_factors": [], "recommended_action": action, "risk_level": "MEDIUM",
            "expected_impact": "pods restart", "verification_steps": ["pods ready"],
            "rollback_strategy": "rollout undo", "limitations": [], "uncertainty": "logs truncated"
        })
    }

    #[test]
    fn valid_actionable_diagnosis() {
        let v = validate(good(json!({"type":"ROLLOUT_RESTART","namespace":"payments","kind":"Deployment","name":"payment-api","pod":null,"replicas":null})), &inc()).unwrap();
        match v {
            Validated::Actionable(_, HealingAction::RolloutRestart { name, .. }) => {
                assert_eq!(name, "payment-api")
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn null_action_means_manual() {
        assert!(matches!(
            validate(good(Value::Null), &inc()).unwrap(),
            Validated::NoAction(_)
        ));
    }

    #[test]
    fn unsupported_or_command_actions_are_not_executable() {
        for a in [
            json!({"type":"DELETE_NAMESPACE","namespace":"payments"}),
            json!({"type":"ROLLOUT_RESTART","namespace":"payments","kind":"Deployment","name":"x","command":"kubectl delete ns payments"}),
            json!("kubectl rollout restart deployment/payment-api"),
        ] {
            assert!(
                matches!(
                    validate(good(a.clone()), &inc()).unwrap(),
                    Validated::Unsupported(..)
                ),
                "{a}"
            );
        }
    }

    #[test]
    fn schema_violations_rejected() {
        let mut extra = good(Value::Null);
        extra["shell"] = json!("rm -rf /");
        assert!(validate(extra, &inc()).is_err(), "unknown top-level field");
        let mut conf = good(Value::Null);
        conf["confidence"] = json!(1.7);
        assert!(validate(conf, &inc()).is_err());
        let mut missing = good(Value::Null);
        missing.as_object_mut().unwrap().remove("evidence");
        assert!(validate(missing, &inc()).is_err());
        assert!(validate(json!("just prose"), &inc()).is_err());
    }

    #[test]
    fn ungrounded_evidence_rejected() {
        let mut d = good(Value::Null);
        d["evidence"] = json!(["the database in another cluster is down"]);
        assert!(validate(d, &inc()).unwrap_err().contains("evidence"));
    }

    #[test]
    fn schema_is_object_with_all_fields_required() {
        let s = schema();
        assert_eq!(s["required"].as_array().unwrap().len(), 13);
        assert_eq!(s["additionalProperties"], false);
    }

    #[test]
    fn patch_workload_action_parses_with_null_fields() {
        let a = json!({"type":"PATCH_WORKLOAD","namespace":"payments","kind":"Deployment","name":"payment-api",
            "container":"api","pod":null,"replicas":null,
            "changes":{"startup_probe":{"failure_threshold":18,"period_seconds":5,"timeout_seconds":null},
                "liveness_probe":{"initial_delay_seconds":null},"resources":null,"image_tag":null}});
        let v = validate(good(a), &inc()).unwrap();
        match v {
            Validated::Actionable(_, HealingAction::PatchWorkload { changes, .. }) => {
                assert_eq!(changes.startup_probe.unwrap().failure_threshold, Some(18));
                assert!(
                    changes.liveness_probe.is_none(),
                    "all-null probe means unchanged"
                );
            }
            other => panic!("{other:?}"),
        }
        let smuggled = json!({"type":"PATCH_WORKLOAD","namespace":"payments","kind":"Deployment","name":"payment-api",
            "container":"api","changes":{"env":[{"name":"A","value":"b"}]}});
        assert!(matches!(
            validate(good(smuggled), &inc()).unwrap(),
            Validated::Unsupported(..)
        ));
    }
}
