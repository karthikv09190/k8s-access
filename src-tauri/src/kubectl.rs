/// Resolves the path to the `kubectl` binary.
///
/// macOS `.app` bundles do NOT inherit the user's shell PATH (no ~/.zshrc,
/// no ~/.bash_profile), so `Command::new("kubectl")` silently fails even when
/// kubectl is installed via Homebrew.  This function probes all common
/// installation locations before falling back to a bare "kubectl" lookup.
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

static KUBECTL_PATH: OnceLock<String> = OnceLock::new();

pub fn kubectl_path() -> &'static str {
    KUBECTL_PATH.get_or_init(resolve_kubectl)
}

fn resolve_kubectl() -> String {
    // ── 1. Common hard-coded locations (fastest, most reliable) ────────────
    let candidates = [
        "/opt/homebrew/bin/kubectl",        // Apple Silicon Homebrew (arm64 Mac)
        "/usr/local/bin/kubectl",           // Intel Mac Homebrew / manual install
        "/usr/bin/kubectl",                 // Linux apt/yum system install
        "/home/linuxbrew/.linuxbrew/bin/kubectl", // Linux Homebrew
        "/snap/bin/kubectl",                // Ubuntu snap
    ];

    for &p in &candidates {
        if Path::new(p).exists() {
            return p.to_string();
        }
    }

    // ── 2. Ask the shell (works in dev / terminal launch) ──────────────────
    if let Ok(out) = Command::new("/bin/sh")
        .args(["-c", "command -v kubectl"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                return p;
            }
        }
    }

    // ── 3. Last resort — bare name, relies on whatever PATH the process has ─
    "kubectl".to_string()
}
