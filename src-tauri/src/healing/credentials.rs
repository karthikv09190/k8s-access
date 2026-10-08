//! Claude Code long-lived OAuth token (from `claude setup-token`), stored in
//! the macOS Keychain. The token is never written to config files, the audit
//! log, stderr logs, or returned to the frontend; it is only passed to the
//! `claude` CLI process as `CLAUDE_CODE_OAUTH_TOKEN`.

use std::fmt;

const SERVICE: &str = "k8s-manager.self-healing";
const ACCOUNT: &str = "claude-code-oauth-token";

/// Secret wrapper whose Debug/Display never reveal the value.
#[derive(Clone, PartialEq, Eq)]
pub struct OAuthToken(String);

impl OAuthToken {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let t = raw.trim();
        if t.is_empty() {
            return Err("token is empty".into());
        }
        if t.len() > 4096 || t.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("token contains invalid characters; paste only the token printed by `claude setup-token`".into());
        }
        if !t.starts_with("sk-ant-") {
            return Err(
                "this does not look like a Claude Code token (expected it to start with sk-ant-)"
                    .into(),
            );
        }
        Ok(Self(t.to_string()))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Safe hint for the UI, e.g. "sk-ant-oat01-…a1b2".
    pub fn hint(&self) -> String {
        let prefix: String = self.0.chars().take(13).collect();
        let suffix: String = self
            .0
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{}…{}", prefix, suffix)
    }
}

impl fmt::Debug for OAuthToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OAuthToken([REDACTED])")
    }
}

/// Storage abstraction so tests never touch the real Keychain.
pub trait TokenStore: Send + Sync {
    fn load(&self) -> Result<Option<OAuthToken>, String>;
    fn save(&self, token: &OAuthToken) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

pub struct KeychainStore;

impl KeychainStore {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keychain unavailable: {}", e))
    }
}

impl TokenStore for KeychainStore {
    fn load(&self) -> Result<Option<OAuthToken>, String> {
        match Self::entry()?.get_password() {
            Ok(s) => OAuthToken::parse(&s).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keychain read failed: {}", e)),
        }
    }

    fn save(&self, token: &OAuthToken) -> Result<(), String> {
        Self::entry()?
            .set_password(token.expose())
            .map_err(|e| format!("keychain write failed: {}", e))
    }

    fn delete(&self) -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keychain delete failed: {}", e)),
        }
    }
}

#[cfg(test)]
pub mod memory {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MemoryStore(pub Mutex<Option<OAuthToken>>);

    impl TokenStore for MemoryStore {
        fn load(&self) -> Result<Option<OAuthToken>, String> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, token: &OAuthToken) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(token.clone());
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::memory::MemoryStore;
    use super::*;

    const TOKEN: &str = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-wxyz";

    #[test]
    fn parse_validates() {
        assert!(OAuthToken::parse(TOKEN).is_ok());
        assert!(
            OAuthToken::parse(&format!("  {}\n", TOKEN)).is_ok(),
            "surrounding whitespace trimmed"
        );
        assert!(OAuthToken::parse("").is_err());
        assert!(OAuthToken::parse("sk-ant-oat01 two parts").is_err());
        assert!(OAuthToken::parse("hunter2").is_err());
    }

    #[test]
    fn never_printed() {
        let t = OAuthToken::parse(TOKEN).unwrap();
        let dbg = format!("{:?}", t);
        assert!(!dbg.contains("AbCdEf"), "{dbg}");
        let hint = t.hint();
        assert!(hint.starts_with("sk-ant-oat01-") && hint.ends_with("wxyz"));
        assert!(!hint.contains("AbCdEfGhIj"));
    }

    #[test]
    fn store_roundtrip() {
        let s = MemoryStore::default();
        assert!(s.load().unwrap().is_none());
        s.save(&OAuthToken::parse(TOKEN).unwrap()).unwrap();
        assert_eq!(s.load().unwrap().unwrap().expose(), TOKEN);
        s.delete().unwrap();
        assert!(s.load().unwrap().is_none());
    }
}
