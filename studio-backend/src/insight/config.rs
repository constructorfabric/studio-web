//! Configuration for the Constructor Insight integration.
//!
//! Insight is an external service (its REST API lives under `/api/v1`); this
//! gear is the seam. The base URL and API key follow the same literal-or-env
//! convention `studio-spec-quality` uses, so a deployment can inject the secret
//! through a Secret-backed env var without putting it in YAML.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct InsightConfig {
    /// Insight base URL, e.g. `https://insight.cfabric.org`. `base_url_env`
    /// (when set and non-empty) wins over this value.
    #[serde(default)]
    pub base_url: String,
    #[serde(default = "default_base_url_env")]
    pub base_url_env: String,

    /// Literal upstream API key. Wins over `api_key_env` when non-empty.
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_api_key_env")]
    pub api_key_env: String,

    /// Path prefix on the Insight host (Insight serves its REST API here).
    #[serde(default = "default_api_path")]
    pub api_path: String,
}

impl Default for InsightConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            base_url_env: default_base_url_env(),
            api_key: String::new(),
            api_key_env: default_api_key_env(),
            api_path: default_api_path(),
        }
    }
}

fn default_base_url_env() -> String {
    "STUDIO_INSIGHT_BASE_URL".into()
}
fn default_api_key_env() -> String {
    "STUDIO_INSIGHT_API_KEY".into()
}
fn default_api_path() -> String {
    "/api/v1".into()
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl InsightConfig {
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

    /// The API path with exactly one leading slash and no trailing slash.
    pub fn resolve_api_path(&self) -> String {
        let p = self.api_path.trim();
        let p = if p.is_empty() { "/api/v1" } else { p };
        format!("/{}", p.trim_matches('/'))
    }
}
