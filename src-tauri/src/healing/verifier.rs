//! Post-execution verification. Read-only: polls workload health until it is
//! healthy for `required_consecutive` polls in a row, or the timeout elapses.

use super::gateway::ClusterGateway;
use super::model::{ClusterBinding, VerificationOutcome, VerificationTarget};
use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub struct VerifyConfig {
    pub interval: Duration,
    pub timeout: Duration,
    /// Healthy polls in a row needed, so a pod that becomes Ready and then
    /// crashes again is not reported as healed.
    pub required_consecutive: u32,
}

impl Default for VerifyConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(5),
            timeout: Duration::from_secs(180),
            required_consecutive: 4,
        }
    }
}

pub async fn verify<G: ClusterGateway>(
    gateway: &G,
    binding: &ClusterBinding,
    target: &VerificationTarget,
    cfg: VerifyConfig,
) -> (VerificationOutcome, Vec<String>) {
    let start = tokio::time::Instant::now();
    let mut checks = Vec::new();
    let mut streak = 0;
    let mut errors = 0;
    loop {
        match gateway.health(binding, target).await {
            Ok(obs) => {
                errors = 0;
                streak = if obs.healthy { streak + 1 } else { 0 };
                checks.push(format!(
                    "t+{}s {} — {}",
                    start.elapsed().as_secs(),
                    if obs.healthy { "healthy" } else { "not ready" },
                    obs.detail
                ));
                if streak >= cfg.required_consecutive {
                    return (VerificationOutcome::Healthy, checks);
                }
            }
            Err(e) => {
                streak = 0;
                errors += 1;
                checks.push(format!("t+{}s error — {}", start.elapsed().as_secs(), e));
                if errors >= 5 {
                    return (VerificationOutcome::Error, checks);
                }
            }
        }
        if start.elapsed() + cfg.interval > cfg.timeout {
            let outcome = if checks.iter().any(|c| c.contains("not ready")) {
                VerificationOutcome::Unhealthy
            } else {
                VerificationOutcome::TimedOut
            };
            return (outcome, checks);
        }
        tokio::time::sleep(cfg.interval).await;
    }
}
