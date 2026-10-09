//! Tauri commands for Self-Healing. Thin wrappers: every check lives in
//! `healing::service`, so nothing the frontend sends can skip approval.

use crate::healing::analysis;
use crate::healing::audit::{log, AuditLog, AuditRecord};
use crate::healing::credentials::{KeychainStore, OAuthToken, TokenStore};
use crate::healing::detector;
use crate::healing::gateway::{kubectl_argv, KubectlGateway};
use crate::healing::model::{ExecutionRecord, HealingProposal, Incident, OperatorIdentity};
use crate::healing::policy::HealingPolicy;
use crate::healing::provider::{AiConfig, AuthMode, ClaudeCliProvider};
use crate::healing::reader::{self, KubectlReader};
use crate::healing::service::{
    ApproveRequest, ExecuteRequest, HealingService, HealingStats, RejectRequest, SystemClock,
};
use crate::healing::store::HealingStore;
use crate::healing::verifier::VerifyConfig;
use crate::kubectl::kubectl_path;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::Emitter;

pub type Service = HealingService<KubectlGateway, SystemClock>;

pub struct HealingState {
    pub service: Arc<Service>,
    pub policy_path: Option<PathBuf>,
    pub ai: RwLock<AiConfig>,
    pub ai_path: Option<PathBuf>,
    /// "Analyze all open" batch progress (diagnosis only — never executes).
    pub batch: Arc<std::sync::Mutex<BatchStatus>>,
    pub batch_cancel: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchStatus {
    pub running: bool,
    pub context: Option<String>,
    pub total: usize,
    pub done: usize,
    pub proposals: usize,
    pub manual: usize,
    pub failed: usize,
    pub current: Option<String>,
    pub stopped_reason: Option<String>,
}

impl HealingState {
    /// Persistent state under `<app_data>/healing/`. Falls back to in-memory
    /// (with a logged warning) if the directory cannot be used.
    pub fn open(app_data: Option<PathBuf>) -> Self {
        let dir = app_data.map(|d| d.join("healing"));
        if let Some(d) = &dir {
            if let Err(e) = std::fs::create_dir_all(d) {
                log::info(&format!(
                    "cannot create {}: {} — using in-memory state",
                    d.display(),
                    e
                ));
            }
        }
        let (store, audit, policy, policy_path) = match &dir {
            Some(d) if d.is_dir() => {
                let store = HealingStore::open(d.join("incidents.json")).unwrap_or_else(|e| {
                    log::info(&format!("{} — starting with an empty incident store", e));
                    HealingStore::in_memory()
                });
                let policy_path = d.join("policy.json");
                let policy = load_policy(&policy_path);
                (
                    store,
                    AuditLog::open(d.join("audit.jsonl")),
                    policy,
                    Some(policy_path),
                )
            }
            _ => (
                HealingStore::in_memory(),
                AuditLog::in_memory(),
                HealingPolicy::default(),
                None,
            ),
        };
        let service = HealingService::new(
            KubectlGateway,
            SystemClock,
            store,
            policy,
            audit,
            VerifyConfig::default(),
        );
        service.recover_after_restart();
        let ai_path = dir
            .as_ref()
            .filter(|d| d.is_dir())
            .map(|d| d.join("ai.json"));
        let ai = ai_path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            service: Arc::new(service),
            policy_path,
            ai: RwLock::new(ai),
            ai_path,
            batch: Arc::new(std::sync::Mutex::new(BatchStatus::default())),
            batch_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    fn ai_config(&self) -> AiConfig {
        self.ai.read().unwrap().clone()
    }
}

fn load_policy(path: &PathBuf) -> HealingPolicy {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            // A broken policy file falls back to the (restrictive) defaults.
            log::info(&format!(
                "invalid {}: {} — using default policy",
                path.display(),
                e
            ));
            HealingPolicy::default()
        }),
        Err(_) => {
            let p = HealingPolicy::default();
            let _ = std::fs::write(path, serde_json::to_vec_pretty(&p).unwrap_or_default());
            p
        }
    }
}

/// Local operator identity: OS account + the Kubernetes user the context
/// authenticates as (best effort). The app has no login system.
async fn operator_for(context: &str) -> OperatorIdentity {
    let os_user = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_else(|_| "unknown".into());
    let whoami = tokio::process::Command::new(kubectl_path())
        .args([
            "auth",
            "whoami",
            "--context",
            context,
            "-o",
            "jsonpath={.status.userInfo.username}",
        ])
        .output();
    let k8s_user = match tokio::time::timeout(Duration::from_secs(8), whoami).await {
        Ok(Ok(out)) if out.status.success() => {
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
        }
        _ => None,
    };
    OperatorIdentity::local(os_user, k8s_user)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealingUpdated {
    incident_id: String,
    status: String,
}

fn emit_updated(app: &tauri::AppHandle, inc: &Incident) {
    let _ = app.emit(
        "healing-updated",
        HealingUpdated {
            incident_id: inc.id.clone(),
            status: inc.status.to_string(),
        },
    );
}

// ── Reads ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_healing_incidents(
    context: Option<String>,
    state: tauri::State<'_, HealingState>,
) -> Result<Vec<Incident>, String> {
    Ok(state
        .service
        .incidents()
        .into_iter()
        .filter(|i| context.as_deref().map_or(true, |c| c == i.binding.context))
        .collect())
}

#[tauri::command]
pub async fn get_healing_incident(
    id: String,
    state: tauri::State<'_, HealingState>,
) -> Result<Incident, String> {
    Ok(state.service.incident(&id)?)
}

#[tauri::command]
pub async fn get_healing_stats(
    context: Option<String>,
    state: tauri::State<'_, HealingState>,
) -> Result<HealingStats, String> {
    Ok(state.service.stats(context.as_deref()))
}

#[tauri::command]
pub async fn get_healing_audit(
    incident_id: Option<String>,
    state: tauri::State<'_, HealingState>,
) -> Result<Vec<AuditRecord>, String> {
    Ok(match incident_id {
        Some(id) => state.service.audit_for(&id),
        None => state.service.recent_audit(500),
    })
}

/// The exact kubectl argv the executor will run for a proposal.
#[tauri::command]
pub async fn get_healing_command_preview(
    incident_id: String,
    proposal_id: String,
    state: tauri::State<'_, HealingState>,
) -> Result<Vec<String>, String> {
    let inc = state.service.incident(&incident_id)?;
    let p: &HealingProposal = inc
        .proposal(&proposal_id)
        .ok_or_else(|| format!("Proposal {} not found for this incident.", proposal_id))?;
    let mut argv = vec!["kubectl".to_string()];
    argv.extend(kubectl_argv(
        &p.binding.context,
        &p.action,
        p.patch.as_ref(),
    ));
    Ok(argv)
}

#[tauri::command]
pub async fn get_healing_policy(
    state: tauri::State<'_, HealingState>,
) -> Result<HealingPolicy, String> {
    Ok(state.service.policy())
}

/// Policy is configuration only; it can restrict healing but never approve or
/// execute anything, and CRITICAL actions stay blocked regardless.
#[tauri::command]
pub async fn set_healing_policy(
    policy: HealingPolicy,
    state: tauri::State<'_, HealingState>,
) -> Result<(), String> {
    if let Some(path) = &state.policy_path {
        let bytes = serde_json::to_vec_pretty(&policy).map_err(|e| e.to_string())?;
        std::fs::write(path, bytes).map_err(|e| e.to_string())?;
    }
    log::info("policy updated");
    state.service.set_policy(policy);
    Ok(())
}

// ── Approval workflow ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn approve_healing(
    request: ApproveRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, HealingState>,
) -> Result<Incident, String> {
    let operator = operator_for(&request.context).await;
    let inc = state.service.approve(&request, &operator)?;
    emit_updated(&app, &inc);
    Ok(inc)
}

#[tauri::command]
pub async fn reject_healing(
    request: RejectRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, HealingState>,
) -> Result<Incident, String> {
    let ctx = state
        .service
        .incident(&request.incident_id)?
        .binding
        .context;
    let operator = operator_for(&ctx).await;
    let inc = state.service.reject(&request, &operator)?;
    emit_updated(&app, &inc);
    Ok(inc)
}

/// Executes a previously approved proposal. All ten pre-execution checks are
/// enforced in `HealingService::execute_approved`; on success a read-only
/// verification task is started.
#[tauri::command]
pub async fn execute_approved_healing(
    request: ExecuteRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, HealingState>,
) -> Result<ExecutionRecord, String> {
    let operator = operator_for(&request.context).await;
    let service = state.service.clone();
    let result = service.execute_approved(&request, &operator).await;
    if let Ok(inc) = service.incident(&request.incident_id) {
        emit_updated(&app, &inc);
    }
    let record = result?;
    if record.success {
        let id = request.incident_id.clone();
        tauri::async_runtime::spawn(async move {
            let _ = service.verify(&id).await;
            if let Ok(inc) = service.incident(&id) {
                emit_updated(&app, &inc);
            }
        });
    }
    Ok(record)
}

/// Builds a rollback PROPOSAL after failed healing. It must be approved like
/// any other proposal before anything runs.
#[tauri::command]
pub async fn propose_healing_rollback(
    incident_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, HealingState>,
) -> Result<HealingProposal, String> {
    let result = state.service.propose_rollback(&incident_id).await;
    if let Ok(inc) = state.service.incident(&incident_id) {
        emit_updated(&app, &inc);
    }
    Ok(result?)
}

// ── Detection (read-only) ─────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub new_incidents: Vec<Incident>,
    pub open_incidents: usize,
    pub findings: usize,
    pub scanned_at: i64,
    /// Incidents marked RESOLVED because they are no longer detected.
    pub resolved: usize,
    /// False when nodes/events/Helm could not be read (no auto-resolve).
    pub complete: bool,
}

/// Runs the deterministic detectors against `context` and records incidents.
/// Read-only against the cluster; creates no proposals and calls no AI.
#[tauri::command]
pub async fn scan_healing_incidents(
    context: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, HealingState>,
) -> Result<ScanResult, String> {
    let binding = reader::binding_for(&context)?;
    let snapshot = reader::collect_snapshot(&KubectlReader, &context).await?;
    let now = state.service.now();
    let findings = detector::detect(&snapshot, now);
    let finding_count = findings.len();
    let mut new_incidents = Vec::new();
    let mut present = std::collections::HashSet::new();
    for inc in detector::correlate(&binding, &snapshot, findings) {
        present.insert(inc.key.clone());
        let (stored, is_new) = state.service.upsert_detected(inc);
        if is_new {
            let _ = app.emit("healing-incident", &stored);
            new_incidents.push(stored);
        }
    }
    // Only a complete scan may conclude that something is gone.
    let resolved = if snapshot.complete {
        state.service.resolve_absent(&context, &present)
    } else {
        0
    };
    let open_incidents = state
        .service
        .incidents()
        .iter()
        .filter(|i| i.binding.context == context && !i.status.is_closed())
        .count();
    Ok(ScanResult {
        new_incidents,
        open_incidents,
        findings: finding_count,
        scanned_at: now,
        resolved,
        complete: snapshot.complete,
    })
}

// ── AI diagnosis (operator-initiated) ─────────────────────────────────────────

/// Analyze (or re-analyze with `force`) an incident. Produces at most a
/// PENDING_APPROVAL proposal — never executes anything.
#[tauri::command]
pub async fn analyze_healing_incident(
    incident_id: String,
    force: Option<bool>,
    app: tauri::AppHandle,
    state: tauri::State<'_, HealingState>,
) -> Result<Incident, String> {
    let cfg = state.ai_config();
    let provider = stored_token(&cfg).and_then(|t| ClaudeCliProvider::from_config(&cfg, t));
    let result = analysis::analyze(
        &state.service,
        &KubectlReader,
        provider.as_ref().map_err(Clone::clone),
        &cfg,
        &incident_id,
        force.unwrap_or(false),
    )
    .await;
    if let Ok(inc) = state.service.incident(&incident_id) {
        emit_updated(&app, &inc);
    }
    Ok(result?)
}

/// The exact sanitized context an analysis would send to the AI provider.
#[tauri::command]
pub async fn preview_healing_ai_context(
    incident_id: String,
    state: tauri::State<'_, HealingState>,
) -> Result<serde_json::Value, String> {
    let inc = state.service.incident(&incident_id)?;
    let cfg = state.ai_config();
    let (context, meta) = analysis::preview(&KubectlReader, &inc, &cfg).await;
    Ok(
        serde_json::json!({ "context": context, "meta": meta, "provider": "claude-cli", "enabled": cfg.enabled }),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub config: AiConfig,
    pub cli_path: Option<String>,
    pub available: bool,
    pub message: String,
    /// Keychain token present (value never returned; only a masked hint).
    pub token_stored: bool,
    pub token_hint: Option<String>,
    pub keychain_error: Option<String>,
    /// `claude auth status` for the machine's own CLI login.
    pub cli_login: Option<CliLogin>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliLogin {
    pub logged_in: bool,
    pub auth_method: Option<String>,
    pub org_name: Option<String>,
}

/// Keychain token, read only when the active mode needs it.
fn stored_token(cfg: &AiConfig) -> Result<Option<OAuthToken>, String> {
    match cfg.auth_mode {
        AuthMode::KeychainToken => KeychainStore.load(),
        AuthMode::CliLogin => Ok(None),
    }
}

async fn cli_login_status(cli: &std::path::Path) -> Option<CliLogin> {
    let out = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(cli)
            .args(["auth", "status", "--json"])
            // Report the machine login, not a token from this process env.
            .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Some(CliLogin {
        logged_in: v.get("loggedIn").and_then(|x| x.as_bool()).unwrap_or(false),
        auth_method: s("authMethod"),
        org_name: s("orgName"),
    })
}

#[tauri::command]
pub async fn get_healing_ai_status(
    state: tauri::State<'_, HealingState>,
) -> Result<AiStatus, String> {
    let config = state.ai_config();
    let cli = ClaudeCliProvider::locate();
    let (token, keychain_error) = match KeychainStore.load() {
        Ok(t) => (t, None),
        Err(e) => (None, Some(e)),
    };
    let cli_login = match &cli {
        Some(p) => cli_login_status(p).await,
        None => None,
    };
    let (available, message) = match (&cli, config.enabled, config.auth_mode) {
        (_, false, _) => (false, "AI diagnosis is disabled.".to_string()),
        (None, true, _) => (
            false,
            "claude CLI not found. Install Claude Code to use AI diagnosis.".to_string(),
        ),
        (Some(_), true, AuthMode::KeychainToken) if token.is_none() => (
            false,
            "No Claude Code token stored. Run `claude setup-token` and save the token in Self-Healing settings."
                .to_string(),
        ),
        (Some(_), true, AuthMode::KeychainToken) => (
            true,
            "AI diagnosis enabled via claude CLI using the Keychain token (tools disabled).".to_string(),
        ),
        (Some(_), true, AuthMode::CliLogin) if !cli_login.as_ref().map_or(false, |l| l.logged_in) => (
            false,
            "claude CLI is not logged in. Run `claude auth login`, or store a long-lived token.".to_string(),
        ),
        (Some(_), true, AuthMode::CliLogin) => (
            true,
            "AI diagnosis enabled via the local claude CLI login (tools disabled).".to_string(),
        ),
    };
    Ok(AiStatus {
        config,
        cli_path: cli.map(|p| p.display().to_string()),
        available,
        message,
        token_stored: token.is_some(),
        token_hint: token.map(|t| t.hint()),
        keychain_error,
        cli_login,
    })
}

/// Stores a `claude setup-token` token in the macOS Keychain. The value is
/// validated, never logged, and never returned to the frontend.
#[tauri::command]
pub async fn save_claude_token(token: String) -> Result<String, String> {
    let t = OAuthToken::parse(&token)?;
    KeychainStore.save(&t)?;
    log::info("Claude Code token saved to Keychain");
    Ok(t.hint())
}

#[tauri::command]
pub async fn delete_claude_token() -> Result<(), String> {
    KeychainStore.delete()?;
    log::info("Claude Code token removed from Keychain");
    Ok(())
}

/// Makes one minimal Claude call (haiku, $0.05 cap) with the configured
/// authentication to prove it works. Sends no cluster data.
#[tauri::command]
pub async fn test_claude_auth(state: tauri::State<'_, HealingState>) -> Result<String, String> {
    let cfg = state.ai_config();
    let provider = ClaudeCliProvider::from_config(&cfg, stored_token(&cfg)?)?;
    let model = provider.test_auth().await?;
    Ok(format!(
        "Authenticated ({}) — test call answered by {}",
        match cfg.auth_mode {
            AuthMode::KeychainToken => "Keychain token",
            AuthMode::CliLogin => "claude CLI login",
        },
        model.unwrap_or_else(|| "Claude".into())
    ))
}

#[tauri::command]
pub async fn set_healing_ai_config(
    config: AiConfig,
    state: tauri::State<'_, HealingState>,
) -> Result<(), String> {
    if let Some(path) = &state.ai_path {
        let bytes = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
        std::fs::write(path, bytes).map_err(|e| e.to_string())?;
    }
    log::info(&format!(
        "AI config updated: enabled={} model={:?}",
        config.enabled, config.model
    ));
    *state.ai.write().unwrap() = config;
    Ok(())
}

// ── Discuss with AI ──────────────────────────────────────────────────────────

/// One chat turn about an incident. Never changes the cluster or the
/// incident status; a suggested fix becomes a proposal only via
/// `propose_healing_from_chat`, and then still needs approval.
#[tauri::command]
pub async fn send_healing_chat(
    incident_id: String,
    message: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, HealingState>,
) -> Result<Incident, String> {
    let cfg = state.ai_config();
    let provider = stored_token(&cfg).and_then(|t| ClaudeCliProvider::from_config(&cfg, t));
    let inc = crate::healing::chat::send(
        &state.service,
        &KubectlReader,
        provider.as_ref().map_err(Clone::clone),
        &cfg,
        &incident_id,
        &message,
    )
    .await?;
    emit_updated(&app, &inc);
    Ok(inc)
}

/// Turns a chat suggestion into a PENDING_APPROVAL proposal (validated,
/// server dry-run for patches, sealed). Executes nothing.
#[tauri::command]
pub async fn propose_healing_from_chat(
    incident_id: String,
    message_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, HealingState>,
) -> Result<Incident, String> {
    let result =
        crate::healing::chat::propose_from_chat(&state.service, &incident_id, &message_id).await;
    if let Ok(inc) = state.service.incident(&incident_id) {
        emit_updated(&app, &inc);
    }
    Ok(result?)
}

// ── Analyze all open (batch diagnosis; never executes) ───────────────────────

/// Starts a background, one-at-a-time AI diagnosis of every open incident in
/// `context` that has not been analyzed yet. Produces at most
/// PENDING_APPROVAL proposals; nothing is executed. Stops on cancel or when
/// the AI provider reports a usage/rate limit.
#[tauri::command]
pub async fn analyze_all_healing_incidents(
    context: String,
    skip_unactionable: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, HealingState>,
) -> Result<BatchStatus, String> {
    use std::sync::atomic::Ordering;
    let cfg = state.ai_config();
    if !cfg.enabled {
        return Err(analysis::disabled_error().to_string());
    }
    let provider = stored_token(&cfg).and_then(|t| ClaudeCliProvider::from_config(&cfg, t))?;
    let ids = analysis::batch_candidates(&state.service.incidents(), &context, skip_unactionable);
    {
        let mut b = state.batch.lock().unwrap();
        if b.running {
            return Err("a batch analysis is already running".into());
        }
        *b = BatchStatus {
            running: true,
            context: Some(context.clone()),
            total: ids.len(),
            ..Default::default()
        };
    }
    state.batch_cancel.store(false, Ordering::SeqCst);
    let (service, batch, cancel) = (
        state.service.clone(),
        state.batch.clone(),
        state.batch_cancel.clone(),
    );
    let snapshot = batch.lock().unwrap().clone();
    let _ = app.emit("healing-batch-progress", &snapshot);

    tauri::async_runtime::spawn(async move {
        for id in ids {
            if cancel.load(Ordering::SeqCst) {
                batch.lock().unwrap().stopped_reason = Some("cancelled".into());
                break;
            }
            let label = service
                .incident(&id)
                .map(|i| format!("{}/{}", i.resource.kind, i.resource.name))
                .unwrap_or_default();
            batch.lock().unwrap().current = Some(label);
            let _ = app.emit("healing-batch-progress", &batch.lock().unwrap().clone());
            let result =
                analysis::analyze(&service, &KubectlReader, Ok(&provider), &cfg, &id, false).await;
            let stop = {
                let mut b = batch.lock().unwrap();
                b.done += 1;
                match (&result, service.incident(&id).map(|i| i.status)) {
                    (Ok(_), Ok(crate::healing::model::IncidentStatus::PendingApproval)) => {
                        b.proposals += 1
                    }
                    (Ok(_), _) => b.manual += 1,
                    (Err(e), _) => {
                        b.failed += 1;
                        let msg = e.to_string();
                        if analysis::is_usage_limit(&msg) {
                            b.stopped_reason = Some(format!("stopped: {}", msg));
                        }
                    }
                }
                b.stopped_reason.is_some()
            };
            if let Ok(inc) = service.incident(&id) {
                emit_updated(&app, &inc);
            }
            let _ = app.emit("healing-batch-progress", &batch.lock().unwrap().clone());
            if stop {
                break;
            }
        }
        let mut b = batch.lock().unwrap();
        b.running = false;
        b.current = None;
        let _ = app.emit("healing-batch-progress", &b.clone());
        log::info(&format!(
            "batch analysis finished: {}/{} done, {} proposals, {} manual, {} failed{}",
            b.done,
            b.total,
            b.proposals,
            b.manual,
            b.failed,
            b.stopped_reason
                .as_deref()
                .map(|r| format!(" ({})", r))
                .unwrap_or_default()
        ));
    });
    Ok(snapshot)
}

#[tauri::command]
pub async fn get_healing_batch_status(
    state: tauri::State<'_, HealingState>,
) -> Result<BatchStatus, String> {
    Ok(state.batch.lock().unwrap().clone())
}

#[tauri::command]
pub async fn cancel_healing_batch(state: tauri::State<'_, HealingState>) -> Result<(), String> {
    state
        .batch_cancel
        .store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}
