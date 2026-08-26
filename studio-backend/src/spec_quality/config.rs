use serde::Deserialize;

/// Configuration for the studio-spec-quality gear.
///
/// The upstream spec-quality service has its OWN auth (a shared bearer
/// secret). That key lives here, server-side, and is attached to every
/// forwarded request — it never reaches the browser. Every knob has an env
/// override so wiring a deployment is a restart, not a config edit:
///
///   STUDIO_SPEC_QUALITY_BASE_URL  — e.g. https://<host>.constructor.pro
///   STUDIO_SPEC_QUALITY_API_KEY   — the service's shared bearer secret
///
/// Unconfigured is a valid state: the gear loads, logs that the upstream is
/// off, and every call returns a clear 500 telling you what to set — it never
/// fails the backend boot.
#[derive(Debug, Clone, Deserialize)]
pub struct SpecQualityConfig {
    /// Upstream base URL, WITHOUT a trailing slash and WITHOUT the `/v1`
    /// suffix (the wrapper appends `/v1/...` and `/healthz`). Env
    /// `base_url_env` (when set and non-empty) wins over this value.
    #[serde(default)]
    pub base_url: String,
    #[serde(default = "default_base_url_env")]
    pub base_url_env: String,

    /// Literal upstream API key. Wins over `api_key_env` when non-empty.
    /// Prefer the env indirection: secrets don't belong in config files.
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_api_key_env")]
    pub api_key_env: String,
}

impl Default for SpecQualityConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            base_url_env: default_base_url_env(),
            api_key: String::new(),
            api_key_env: default_api_key_env(),
        }
    }
}

fn default_base_url_env() -> String {
    "STUDIO_SPEC_QUALITY_BASE_URL".into()
}
fn default_api_key_env() -> String {
    "STUDIO_SPEC_QUALITY_API_KEY".into()
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl SpecQualityConfig {
    /// Effective base URL: env override beats YAML; trailing slash trimmed.
    pub fn resolve_base_url(&self) -> String {
        env_non_empty(&self.base_url_env)
            .unwrap_or_else(|| self.base_url.clone())
            .trim_end_matches('/')
            .to_string()
    }

    /// Effective key: literal beats env; empty/whitespace counts as absent.
    pub fn resolve_api_key(&self) -> Option<String> {
        let literal = self.api_key.trim();
        if !literal.is_empty() {
            return Some(literal.to_string());
        }
        env_non_empty(&self.api_key_env)
    }
}
