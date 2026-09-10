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

#[cfg(test)]
mod tests {
    //! Which of the two places a setting comes from, and what shape the API
    //! path is normalised to.
    //!
    //! Same literal-or-env convention as `studio-spec-quality`, with one extra
    //! knob: Insight serves its REST API under a prefix, and the client
    //! concatenates `{base_url}{api_path}/{resource}`. Both halves of that join
    //! have to be normalised or the seam addresses `…//api/v1//reports`.
    //!
    //! Tests that write to the environment take [`crate::test_env::lock`]: the
    //! process has one environment, so the lock has to be one too.

    use super::InsightConfig;
    use crate::test_env::with_var;

    fn config(suffix: &str) -> InsightConfig {
        InsightConfig {
            base_url_env: format!("STUDIO_TEST_INSIGHT_BASE_URL_{suffix}"),
            api_key_env: format!("STUDIO_TEST_INSIGHT_API_KEY_{suffix}"),
            ..InsightConfig::default()
        }
    }

    #[test]
    fn an_unconfigured_seam_resolves_to_nothing() {
        let cfg = config("unset");
        assert_eq!(cfg.resolve_base_url(), "");
        assert_eq!(cfg.resolve_api_key(), None);
    }

    #[test]
    fn the_environment_beats_the_yaml_base_url() {
        let cfg = InsightConfig {
            base_url: "https://from-yaml.example".to_string(),
            ..config("base_precedence")
        };
        let resolved = with_var(&cfg.base_url_env, "https://from-env.example", || {
            cfg.resolve_base_url()
        });
        assert_eq!(resolved, "https://from-env.example");
    }

    /// The other way round for the key, as in the other two gears.
    #[test]
    fn a_literal_key_beats_the_environment() {
        let cfg = InsightConfig {
            api_key: "from-yaml".to_string(),
            ..config("key_precedence")
        };
        let resolved = with_var(&cfg.api_key_env, "from-env", || cfg.resolve_api_key());
        assert_eq!(resolved.as_deref(), Some("from-yaml"));
    }

    #[test]
    fn a_blank_key_is_absent_from_either_source() {
        let cfg = InsightConfig {
            api_key: "  ".to_string(),
            ..config("blank_yaml")
        };
        assert_eq!(cfg.resolve_api_key(), None);

        let cfg = config("blank_env");
        assert_eq!(
            with_var(&cfg.api_key_env, " ", || cfg.resolve_api_key()),
            None
        );
    }

    #[test]
    fn a_trailing_slash_is_trimmed_from_the_base_url() {
        let cfg = InsightConfig {
            base_url: "https://insight.example/".to_string(),
            ..config("trim")
        };
        assert_eq!(cfg.resolve_base_url(), "https://insight.example");
    }

    /// The path is normalised to exactly one leading slash and no trailing one,
    /// whatever it was written as — this is the half of the join the deployment
    /// gets to type, so every plausible spelling has to land in one place.
    #[test]
    fn the_api_path_normalises_to_one_leading_slash_and_no_trailing_one() {
        for written in ["/api/v1", "api/v1", "/api/v1/", "api/v1/", "  /api/v1/  "] {
            let cfg = InsightConfig {
                api_path: written.to_string(),
                ..config("path")
            };
            assert_eq!(
                cfg.resolve_api_path(),
                "/api/v1",
                "`{written}` must normalise to /api/v1"
            );
        }
    }

    /// A path left blank falls back rather than resolving to `/`, which would
    /// send every call to the host root.
    #[test]
    fn a_blank_api_path_falls_back_to_the_default() {
        for written in ["", "   "] {
            let cfg = InsightConfig {
                api_path: written.to_string(),
                ..config("blank_path")
            };
            assert_eq!(cfg.resolve_api_path(), "/api/v1");
        }
    }

    #[test]
    fn the_defaults_name_the_variables_a_deployment_sets() {
        let cfg = InsightConfig::default();
        assert_eq!(cfg.base_url_env, "STUDIO_INSIGHT_BASE_URL");
        assert_eq!(cfg.api_key_env, "STUDIO_INSIGHT_API_KEY");
        assert_eq!(cfg.resolve_api_path(), "/api/v1");
    }
}
