//! AI provider abstraction. Providers only turn a sanitized context into
//! untrusted JSON; they have no access to the cluster, the healing service or
//! any executor.
//!
//! Implemented: `ClaudeCliProvider` — runs the local `claude` CLI headless with
//! ALL tools disabled (`--tools ""`, `--restricted`, no MCP servers), in an
//! empty temporary directory, using the operator's existing Claude Code login.
//! The model can therefore only return text; it cannot run kubectl, a shell,
//! or read files. Other providers (Anthropic API, Bedrock, local LLM) can be
//! added by implementing `DiagnosisProvider`; API keys for those belong in the
//! macOS Keychain, never in config files or logs.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProviderKind {
    ClaudeCli,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiConfig {
    /// Off by default: sending cluster data to an AI service is an explicit
    /// administrator decision.
    pub enabled: bool,
    pub provider: ProviderKind,
    /// e.g. "sonnet", "opus" or a full model id. None = CLI default.
    pub model: Option<String>,
    pub timeout_secs: u64,
    pub max_context_chars: usize,
    /// Hard spend cap per diagnosis passed to the CLI.
    pub max_budget_usd: f64,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: ProviderKind::ClaudeCli,
            model: None,
            timeout_secs: 180,
            max_context_chars: 60_000,
            max_budget_usd: 1.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProviderResponse {
    pub output: Value,
    pub model: Option<String>,
}

#[allow(async_fn_in_trait)]
pub trait DiagnosisProvider: Send + Sync {
    fn name(&self) -> String;
    async fn diagnose(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        schema: &Value,
    ) -> Result<ProviderResponse, String>;
}

pub const SYSTEM_PROMPT: &str = "You are a Kubernetes incident diagnosis assistant inside a desktop \
management tool. You can only read the incident context provided and answer with JSON matching the \
given schema. You cannot execute anything and nothing you return is executed directly: an \
administrator reviews every proposal and a separate deterministic executor performs only the typed \
actions in the schema after explicit approval.\n\
Rules:\n\
- Base every conclusion on the provided context; cite concrete observations (resource names, \
event reasons, log lines, exit codes) in `evidence`.\n\
- `recommended_action` must be null unless one of the schema's typed actions is a safe, appropriate \
remediation for a resource in this incident. Never include shell or kubectl commands anywhere.\n\
- If the fix requires a code, image, configuration, secret, quota or infrastructure change, set \
`recommended_action` to null and explain the manual steps in `summary`/`limitations`.\n\
- Prefer the least disruptive action. A restart does not fix a bad image or bad config.\n\
- If the resource is GitOps-managed, say that direct changes may be reverted and describe the GitOps fix.\n\
- Values shown as [REDACTED] were removed deliberately; do not speculate about them.\n\
- `confidence` is 0..1 and must reflect real uncertainty.";

pub fn user_prompt(context_json: &str) -> String {
    format!(
        "Diagnose this Kubernetes incident. Incident context (JSON):\n{}",
        context_json
    )
}

/// Parses `claude -p --output-format json` output.
pub fn parse_cli_output(stdout: &str) -> Result<ProviderResponse, String> {
    let v: Value =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("unexpected CLI output: {}", e))?;
    if v.get("is_error").and_then(Value::as_bool) == Some(true) {
        let msg = v
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(format!("AI provider error: {}", msg));
    }
    let model = v
        .get("modelUsage")
        .and_then(Value::as_object)
        .and_then(|m| m.keys().next().cloned());
    let output = match v.get("structured_output") {
        Some(o) if !o.is_null() => o.clone(),
        _ => {
            let text = v
                .get("result")
                .and_then(Value::as_str)
                .ok_or("CLI returned no result")?;
            serde_json::from_str(text)
                .map_err(|_| "AI returned prose instead of schema JSON".to_string())?
        }
    };
    Ok(ProviderResponse { output, model })
}

fn valid_model_name(m: &str) -> bool {
    !m.is_empty()
        && m.len() <= 100
        && !m.starts_with('-')
        && m.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-[]".contains(c))
}

pub struct ClaudeCliProvider {
    binary: PathBuf,
    model: Option<String>,
    timeout: Duration,
    max_budget_usd: f64,
}

impl ClaudeCliProvider {
    /// macOS .app bundles do not inherit the shell PATH, so probe common
    /// install locations first.
    pub fn locate() -> Option<PathBuf> {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut candidates = vec![
            PathBuf::from(&home).join(".local/bin/claude"),
            PathBuf::from(&home).join(".claude/local/claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
        ];
        if let Ok(path) = std::env::var("PATH") {
            candidates.extend(
                path.split(':')
                    .filter(|p| !p.is_empty())
                    .map(|p| PathBuf::from(p).join("claude")),
            );
        }
        candidates.into_iter().find(|p| p.is_file())
    }

    pub fn from_config(cfg: &AiConfig) -> Result<Self, String> {
        let binary =
            Self::locate().ok_or("claude CLI not found (install Claude Code and log in)")?;
        if let Some(m) = &cfg.model {
            if !valid_model_name(m) {
                return Err(format!("invalid model name {:?}", m));
            }
        }
        Ok(Self {
            binary,
            model: cfg.model.clone(),
            timeout: Duration::from_secs(cfg.timeout_secs.clamp(10, 900)),
            max_budget_usd: cfg.max_budget_usd.clamp(0.05, 20.0),
        })
    }

    pub fn args(&self, system_prompt: &str, schema: &Value) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(),
            "json".into(),
            "--json-schema".into(),
            schema.to_string(),
            // No tools at all: the model can only produce text.
            "--tools".into(),
            "".into(),
            "--restricted".into(),
            "--strict-mcp-config".into(),
            "--no-session-persistence".into(),
            "--system-prompt".into(),
            system_prompt.into(),
            "--max-budget-usd".into(),
            format!("{:.2}", self.max_budget_usd),
        ];
        if let Some(m) = &self.model {
            args.extend(["--model".to_string(), m.clone()]);
        }
        args
    }
}

impl DiagnosisProvider for ClaudeCliProvider {
    fn name(&self) -> String {
        "claude-cli".into()
    }

    async fn diagnose(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        schema: &Value,
    ) -> Result<ProviderResponse, String> {
        // Empty scratch directory: no project files, CLAUDE.md or settings.
        let dir = std::env::temp_dir().join(format!("k8s-manager-ai-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let result = async {
            let mut child = tokio::process::Command::new(&self.binary)
                .args(self.args(system_prompt, schema))
                .current_dir(&dir)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| format!("cannot start claude CLI: {}", e))?;
            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(user_prompt.as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
            }
            let out = tokio::time::timeout(self.timeout, child.wait_with_output())
                .await
                .map_err(|_| format!("AI diagnosis timed out after {}s", self.timeout.as_secs()))?
                .map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&out.stdout);
            if !out.status.success() && stdout.trim().is_empty() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                return Err(format!(
                    "claude CLI failed: {}",
                    stderr.lines().last().unwrap_or("").trim()
                ));
            }
            parse_cli_output(&stdout)
        }
        .await;
        let _ = std::fs::remove_dir_all(&dir);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_structured_output() {
        let out = r#"{"type":"result","is_error":false,"result":"{\"a\":1}","structured_output":{"a":1},
            "modelUsage":{"claude-opus-5-5":{"inputTokens":2}}}"#;
        let r = parse_cli_output(out).unwrap();
        assert_eq!(r.output, json!({"a":1}));
        assert_eq!(r.model.as_deref(), Some("claude-opus-5-5"));
    }

    #[test]
    fn falls_back_to_result_json_and_rejects_prose() {
        assert_eq!(
            parse_cli_output(r#"{"result":"{\"a\":2}"}"#)
                .unwrap()
                .output,
            json!({"a":2})
        );
        assert!(parse_cli_output(r#"{"result":"I think you should run kubectl delete"}"#).is_err());
        assert!(
            parse_cli_output(r#"{"is_error":true,"result":"Not logged in"}"#)
                .unwrap_err()
                .contains("Not logged in")
        );
        assert!(parse_cli_output("garbage").is_err());
    }

    #[test]
    fn cli_runs_without_tools_or_settings() {
        let p = ClaudeCliProvider {
            binary: "claude".into(),
            model: Some("sonnet".into()),
            timeout: Duration::from_secs(5),
            max_budget_usd: 1.0,
        };
        let args = p.args("sys", &json!({}));
        let pos = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[pos + 1], "", "all tools disabled");
        for flag in [
            "--restricted",
            "--strict-mcp-config",
            "--no-session-persistence",
            "-p",
        ] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        assert!(!args
            .iter()
            .any(|a| a.contains("dangerously") || a == "--allowedTools"));
    }

    #[test]
    fn model_names_validated() {
        assert!(valid_model_name("sonnet"));
        assert!(valid_model_name("claude-opus-5-5"));
        assert!(!valid_model_name("--dangerously-skip-permissions"));
        assert!(!valid_model_name("x; rm -rf /"));
        let cfg = AiConfig {
            model: Some("--tools=Bash".into()),
            ..Default::default()
        };
        if ClaudeCliProvider::locate().is_some() {
            assert!(ClaudeCliProvider::from_config(&cfg).is_err());
        }
    }

    #[test]
    fn ai_disabled_by_default() {
        assert!(!AiConfig::default().enabled);
    }
}
