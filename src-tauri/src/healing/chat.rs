//! "Discuss with AI": a per-incident conversation over the same sanitized
//! context used for diagnosis. The AI can suggest a typed action; turning it
//! into a proposal is a separate explicit operator step, and the proposal
//! then needs approval like any other. Chat never changes the cluster.

use super::analysis::disabled_error;
use super::context;
use super::diagnosis::{action_schema, parse_action};
use super::error::{HealingError, HealingResult};
use super::gateway::ClusterGateway;
use super::model::*;
use super::provider::{AiConfig, DiagnosisProvider, CHAT_SYSTEM_PROMPT};
use super::reader::ClusterReader;
use super::sanitizer::redact_text;
use super::service::{Clock, HealingService};
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_OPERATOR_CHARS: usize = 4_000;
const MAX_REPLY_CHARS: usize = 8_000;
const HISTORY_TURNS: usize = 12;

pub fn chat_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["reply", "suggested_action", "risk_level", "confidence", "evidence", "gitops_suggestion"],
        "properties": {
            "reply": {"type": "string"},
            "suggested_action": action_schema(),
            "risk_level": {"enum": ["LOW", "MEDIUM", "HIGH", "CRITICAL", null]},
            "confidence": {"type": ["number", "null"], "minimum": 0, "maximum": 1},
            "evidence": {"type": "array", "items": {"type": "string"}},
            "gitops_suggestion": {"type": ["string", "null"]}
        }
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChatReply {
    reply: String,
    suggested_action: Option<Value>,
    risk_level: Option<RiskLevel>,
    confidence: Option<f64>,
    #[serde(default)]
    evidence: Vec<String>,
    #[serde(default)]
    gitops_suggestion: Option<String>,
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &s[..cut])
}

fn related(inc: &Incident, action: &HealingAction) -> bool {
    let (kind, name) = action.target();
    inc.resource.namespace.as_deref() == Some(action.namespace())
        && std::iter::once(&inc.resource)
            .chain(inc.affected.iter())
            .any(|r| r.kind == kind && r.name == name)
}

fn history(inc: &Incident) -> String {
    let start = inc.conversation.len().saturating_sub(HISTORY_TURNS);
    inc.conversation[start..]
        .iter()
        .map(|m| match m.role {
            ChatRole::Operator => format!("OPERATOR: {}", m.text),
            ChatRole::Assistant => match &m.suggested_action {
                Some(a) => format!(
                    "ASSISTANT: {}\n(suggested action: {})",
                    m.text,
                    a.describe()
                ),
                None => format!("ASSISTANT: {}", m.text),
            },
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub async fn send<G, C, R, P>(
    svc: &HealingService<G, C>,
    reader: &R,
    provider: Result<&P, String>,
    cfg: &AiConfig,
    incident_id: &str,
    text: &str,
) -> HealingResult<Incident>
where
    G: ClusterGateway,
    C: Clock,
    R: ClusterReader,
    P: DiagnosisProvider,
{
    let inc = svc.incident(incident_id)?;
    if !cfg.enabled {
        return Err(disabled_error());
    }
    let provider = provider.map_err(HealingError::AiUnavailable)?;
    let text = text.trim();
    if text.is_empty() {
        return Err(HealingError::InvalidInput("message is empty".into()));
    }
    // Operators can paste anything; secrets are redacted before storing/sending.
    let (operator_text, user_redactions) = redact_text(&clip(text, MAX_OPERATOR_CHARS));

    let (ctx, meta) = context::build(reader, &inc, cfg.max_context_chars).await;
    let prompt = format!(
        "Incident context (JSON):\n{}\n\nConversation so far:\n{}\n\nOPERATOR: {}\n\nRespond to the operator's latest message.",
        serde_json::to_string_pretty(&ctx).unwrap_or_default(),
        history(&inc),
        operator_text
    );
    let resp = provider
        .diagnose(CHAT_SYSTEM_PROMPT, &prompt, &chat_schema())
        .await
        .map_err(HealingError::AiUnavailable)?;
    let reply: ChatReply = serde_json::from_value(resp.output)
        .map_err(|e| HealingError::UnsupportedAiAction(format!("invalid chat reply: {}", e)))?;

    let (suggested_action, suggestion_error) = match &reply.suggested_action {
        None => (None, None),
        Some(raw) => match parse_action(raw) {
            Ok(a) if related(&inc, &a) => (Some(a), None),
            Ok(a) => (
                None,
                Some(format!(
                    "{} does not belong to this incident",
                    a.target_display()
                )),
            ),
            Err(e) => (None, Some(format!("unsupported action: {}", e))),
        },
    };
    let now = svc.now();
    let operator = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        role: ChatRole::Operator,
        text: operator_text,
        at: now,
        suggested_action: None,
        suggestion_error: None,
        gitops_suggestion: None,
        risk_level: None,
        confidence: None,
        evidence: vec![],
        model: None,
        proposal_id: None,
    };
    let assistant = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        role: ChatRole::Assistant,
        text: clip(&reply.reply, MAX_REPLY_CHARS),
        at: now,
        suggested_action: suggested_action.clone(),
        suggestion_error,
        gitops_suggestion: reply.gitops_suggestion.map(|g| clip(&g, MAX_REPLY_CHARS)),
        risk_level: reply.risk_level,
        confidence: reply
            .confidence
            .filter(|c| c.is_finite() && (0.0..=1.0).contains(c)),
        evidence: reply
            .evidence
            .iter()
            .take(20)
            .map(|e| clip(e, 2_000))
            .collect(),
        model: resp.model.clone(),
        proposal_id: None,
    };
    let detail =
        format!(
        "provider={} model={} contextChars={} redactions={} operatorRedactions={} suggestion={}",
        provider.name(),
        resp.model.as_deref().unwrap_or("default"),
        meta.chars,
        meta.redactions,
        user_redactions,
        suggested_action.map(|a| a.describe()).unwrap_or_else(|| "none".into())
    );
    svc.append_chat(incident_id, vec![operator, assistant], &detail)
}

/// Explicit operator step: turn a chat suggestion into a PENDING_APPROVAL
/// proposal (validated, dry-run, sealed). Nothing is executed.
pub async fn propose_from_chat<G: ClusterGateway, C: Clock>(
    svc: &HealingService<G, C>,
    incident_id: &str,
    message_id: &str,
) -> HealingResult<Incident> {
    let inc = svc.incident(incident_id)?;
    let msg = inc
        .conversation
        .iter()
        .find(|m| m.id == message_id && m.role == ChatRole::Assistant)
        .cloned()
        .ok_or_else(|| HealingError::InvalidInput("chat message not found".into()))?;
    let action = msg
        .suggested_action
        .clone()
        .ok_or_else(|| HealingError::InvalidInput("this message has no suggested action".into()))?;
    if msg.proposal_id.is_some() {
        return Err(HealingError::InvalidInput(
            "this suggestion was already turned into a proposal".into(),
        ));
    }
    svc.begin_analysis(incident_id)?;
    let draft = ProposalDraft {
        kind: ProposalKind::Remediation,
        declared_risk: msg.risk_level.unwrap_or(RiskLevel::Medium),
        rationale: format!("Agreed in discussion with AI:\n{}", clip(&msg.text, 2_000)),
        evidence: msg.evidence.clone(),
        expected_impact: "Workload is rolled out with the change; pods are replaced.".into(),
        verification_steps: vec![
            "Workload reaches desired/ready/available replicas and stays healthy".into(),
        ],
        rollback_plan: "Propose a rollback to the pre-change revision (requires approval).".into(),
        confidence: msg.confidence,
        source: ProposalSource::Ai {
            provider: "claude-cli (chat)".into(),
            model: msg.model.clone(),
        },
        action,
    };
    match svc.create_proposal(incident_id, draft).await {
        Ok(p) => {
            svc.link_chat_proposal(incident_id, message_id, &p.id)?;
            svc.incident(incident_id)
        }
        Err(e) => {
            let _ = svc.require_manual(incident_id, &e.to_string());
            Err(e)
        }
    }
}
