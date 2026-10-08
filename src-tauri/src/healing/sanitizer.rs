//! Redaction layer for anything that leaves the machine (AI providers) or is
//! written to the audit log. Secret values are never forwarded — even when the
//! UI itself is allowed to display them.

use regex::{Captures, Regex};
use serde_json::Value;
use std::sync::OnceLock;

pub const REDACTED: &str = "[REDACTED]";

const SENSITIVE_KEY: &str = r"(?i)(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth|session|cookie|dsn|connection[_-]?string)";

fn sensitive_key() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(SENSITIVE_KEY).unwrap())
}

pub fn is_sensitive_key(k: &str) -> bool {
    sensitive_key().is_match(k)
}

struct Rule {
    re: Regex,
    replace: fn(&Captures) -> String,
}

fn rules() -> &'static [Rule] {
    static R: OnceLock<Vec<Rule>> = OnceLock::new();
    R.get_or_init(|| {
        vec![
            Rule {
                re: Regex::new(r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----").unwrap(),
                replace: |_| "[REDACTED PRIVATE KEY]".into(),
            },
            Rule {
                re: Regex::new(r"(?s)-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----").unwrap(),
                replace: |_| "[REDACTED CERTIFICATE]".into(),
            },
            // scheme://user:password@host
            Rule {
                re: Regex::new(r"([a-zA-Z][a-zA-Z0-9+.\-]*://[^/\s:@]+):[^@\s/]+@").unwrap(),
                replace: |c| format!("{}:{}@", &c[1], REDACTED),
            },
            Rule {
                re: Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]{8,}").unwrap(),
                replace: |c| format!("{} {}", &c[1], REDACTED),
            },
            Rule {
                re: Regex::new(r"eyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}").unwrap(),
                replace: |_| "[REDACTED JWT]".into(),
            },
            Rule {
                re: Regex::new(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b").unwrap(),
                replace: |_| "[REDACTED AWS KEY]".into(),
            },
            // KEY=value, KEY: value, "key":"value" where the key looks sensitive.
            Rule {
                re: Regex::new(&format!(
                    r#"(?i)([A-Za-z0-9_.\-]*{}[A-Za-z0-9_.\-]*)("?\s*[:=]\s*"?)([^\s",;&'}}]+)"#,
                    SENSITIVE_KEY
                ))
                .unwrap(),
                replace: |c| format!("{}{}{}", &c[1], &c[3], REDACTED),
            },
            // Long opaque tokens. Pure hex (image digests, hashes) is kept.
            Rule {
                re: Regex::new(r"\b[A-Za-z0-9+/_\-]{40,}={0,2}").unwrap(),
                replace: |c| {
                    let s = &c[0];
                    let hex = s.chars().all(|ch| ch.is_ascii_hexdigit());
                    let mixed = s.chars().any(|ch| ch.is_ascii_digit())
                        && s.chars().any(|ch| ch.is_ascii_uppercase())
                        && s.chars().any(|ch| ch.is_ascii_lowercase());
                    if hex || !mixed {
                        s.to_string()
                    } else {
                        REDACTED.to_string()
                    }
                },
            },
        ]
    })
}

/// Redacts secrets in free text (logs, event messages, args). Returns the
/// redacted text and how many replacements were made.
pub fn redact_text(input: &str) -> (String, usize) {
    let mut out = input.to_string();
    let mut count = 0;
    for rule in rules() {
        let replaced = rule.re.replace_all(&out, |c: &Captures| {
            let r = (rule.replace)(c);
            if r != c[0] {
                count += 1;
            }
            r
        });
        out = replaced.into_owned();
    }
    (out, count)
}

/// Sanitizes a Kubernetes object in place before it is sent anywhere.
/// Returns the number of redactions.
pub fn sanitize_object(v: &mut Value) -> usize {
    let mut n = 0;
    let kind = v
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if let Some(meta) = v.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
        if let Some(ann) = meta.get_mut("annotations").and_then(Value::as_object_mut) {
            // Contains the full applied manifest, including any inline secrets.
            if ann.contains_key("kubectl.kubernetes.io/last-applied-configuration") {
                ann.insert(
                    "kubectl.kubernetes.io/last-applied-configuration".into(),
                    Value::String(REDACTED.into()),
                );
                n += 1;
            }
        }
    }
    if kind == "Secret" {
        for field in ["data", "stringData"] {
            if let Some(map) = v.get_mut(field).and_then(Value::as_object_mut) {
                for val in map.values_mut() {
                    *val = Value::String(REDACTED.into());
                    n += 1;
                }
            }
        }
    }
    n + walk(v)
}

fn walk(v: &mut Value) -> usize {
    match v {
        Value::String(s) => {
            let (r, c) = redact_text(s);
            *s = r;
            c
        }
        Value::Array(items) => items.iter_mut().map(walk).sum(),
        Value::Object(map) => {
            let mut n = 0;
            // env-style {"name": "DB_PASSWORD", "value": "..."}
            let named_sensitive = map
                .get("name")
                .and_then(Value::as_str)
                .map_or(false, is_sensitive_key);
            for (k, val) in map.iter_mut() {
                let key_sensitive = is_sensitive_key(k) && val.is_string();
                if (key_sensitive || (named_sensitive && k == "value"))
                    && val.as_str() != Some(REDACTED)
                {
                    *val = Value::String(REDACTED.into());
                    n += 1;
                } else {
                    n += walk(val);
                }
            }
            n
        }
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_env_secrets_but_keeps_useful_env() {
        let mut pod = json!({"kind":"Pod","spec":{"containers":[{"name":"api","image":"api:1.2","env":[
            {"name":"DATABASE_PASSWORD","value":"secret123"},
            {"name":"STRIPE_API_KEY","value":"sk_live_abc"},
            {"name":"LOG_LEVEL","value":"debug"},
            {"name":"DB_URL","value":"postgres://app:hunter2@db:5432/pay"},
            {"name":"FROM_SECRET","valueFrom":{"secretKeyRef":{"name":"db","key":"password"}}}
        ]}]}});
        let n = sanitize_object(&mut pod);
        let s = pod.to_string();
        assert!(n >= 3);
        assert!(!s.contains("secret123"));
        assert!(!s.contains("sk_live_abc"));
        assert!(!s.contains("hunter2"));
        assert!(s.contains("\"debug\""), "non-sensitive env kept");
        assert!(s.contains("secretKeyRef"), "secret references (names) kept");
        assert!(s.contains("postgres://app:[REDACTED]@db:5432/pay"));
    }

    #[test]
    fn secret_objects_are_fully_redacted() {
        let mut sec = json!({"kind":"Secret","metadata":{"name":"db"},"data":{"password":"aHVudGVyMg==","user":"YXBw"}});
        sanitize_object(&mut sec);
        assert_eq!(sec["data"]["password"], REDACTED);
        assert_eq!(sec["data"]["user"], REDACTED);
    }

    #[test]
    fn strips_last_applied_and_managed_fields() {
        let mut d = json!({"kind":"Deployment","metadata":{"managedFields":[{"x":1}],"annotations":{
            "kubectl.kubernetes.io/last-applied-configuration":"{\"stringData\":{\"pw\":\"x\"}}","team":"payments"}}});
        sanitize_object(&mut d);
        assert!(d["metadata"].get("managedFields").is_none());
        assert_eq!(
            d["metadata"]["annotations"]["kubectl.kubernetes.io/last-applied-configuration"],
            REDACTED
        );
        assert_eq!(d["metadata"]["annotations"]["team"], "payments");
    }

    #[test]
    fn redacts_tokens_in_logs() {
        let log = "connecting with password=hunter2\nAuthorization: Bearer abcdefghijklmnop\n\
            token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U\n\
            aws AKIAIOSFODNN7EXAMPLE\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n\
            api_key: \"q8Zr2LmN0pX\"";
        let (out, n) = redact_text(log);
        for leaked in [
            "hunter2",
            "abcdefghijklmnop",
            "eyJhbGci",
            "AKIAIOSFODNN7EXAMPLE",
            "MIIEow",
            "q8Zr2LmN0pX",
        ] {
            assert!(!out.contains(leaked), "leaked {leaked}: {out}");
        }
        assert!(n >= 6);
    }

    #[test]
    fn keeps_diagnostic_text() {
        let text = "Back-off restarting failed container api in pod payment-api-7d9f (exit code 137, OOMKilled) \
            image sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
        let (out, n) = redact_text(text);
        assert_eq!(out, text);
        assert_eq!(n, 0);
    }
}
