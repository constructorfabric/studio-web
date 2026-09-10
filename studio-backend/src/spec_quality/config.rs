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

#[cfg(test)]
mod tests {
    //! Which of the two places a setting comes from.
    //!
    //! The gear reads each value from an environment variable *it names in
    //! config*, falling back to a literal in the same file. That indirection is
    //! how a key stays out of the repository, and getting the precedence
    //! backwards would mean a deployment silently serving whatever the YAML
    //! happened to carry.
    //!
    //! Tests that write to the environment take [`crate::test_env::lock`]:
    //! the process has one environment, so the lock has to be one too. Each
    //! still uses a variable name of its own, so a failure names one test
    //! rather than leaking into the next.

    use super::SpecQualityConfig;
    use crate::test_env::lock;

    fn config(base_url: &str, api_key: &str, suffix: &str) -> SpecQualityConfig {
        SpecQualityConfig {
            base_url: base_url.to_string(),
            base_url_env: format!("STUDIO_TEST_SPEC_QUALITY_BASE_URL_{suffix}"),
            api_key: api_key.to_string(),
            api_key_env: format!("STUDIO_TEST_SPEC_QUALITY_API_KEY_{suffix}"),
        }
    }

    #[test]
    fn the_yaml_value_is_used_when_the_variable_is_unset() {
        let cfg = config("https://spec.example", "", "unset");
        assert_eq!(cfg.resolve_base_url(), "https://spec.example");
        assert_eq!(cfg.resolve_api_key(), None);
    }

    #[test]
    fn a_trailing_slash_is_trimmed_from_either_source() {
        let cfg = config("https://spec.example/", "", "trim_yaml");
        assert_eq!(cfg.resolve_base_url(), "https://spec.example");

        let _guard = lock();
        let cfg = config("https://ignored.example", "", "trim_env");
        unsafe { std::env::set_var(&cfg.base_url_env, "https://from-env.example/") };
        assert_eq!(cfg.resolve_base_url(), "https://from-env.example");
        unsafe { std::env::remove_var(&cfg.base_url_env) };
    }

    /// The deployment sets the variable; the file is the fallback. A base URL
    /// resolving the other way round would send work to the wrong service.
    #[test]
    fn the_environment_beats_the_yaml_base_url() {
        let _guard = lock();
        let cfg = config("https://from-yaml.example", "", "base_precedence");
        unsafe { std::env::set_var(&cfg.base_url_env, "https://from-env.example") };
        assert_eq!(cfg.resolve_base_url(), "https://from-env.example");
        unsafe { std::env::remove_var(&cfg.base_url_env) };
    }

    /// And for the key it is the other way round, which is the surprise worth
    /// pinning: a literal in the file wins, so a key pasted there is used even
    /// where the deployment exports one.
    #[test]
    fn a_literal_key_beats_the_environment() {
        let _guard = lock();
        let cfg = config("", "from-yaml", "key_precedence");
        unsafe { std::env::set_var(&cfg.api_key_env, "from-env") };
        assert_eq!(cfg.resolve_api_key().as_deref(), Some("from-yaml"));
        unsafe { std::env::remove_var(&cfg.api_key_env) };
    }

    /// Unconfigured is a valid state — the gear loads and says so. Whitespace
    /// has to read as absent, or a variable exported empty by a deployment
    /// script would pass for a key and fail at the upstream instead.
    #[test]
    fn a_blank_key_is_absent_from_either_source() {
        let _guard = lock();
        assert_eq!(config("", "   ", "blank_yaml").resolve_api_key(), None);

        let cfg = config("", "", "blank_env");
        unsafe { std::env::set_var(&cfg.api_key_env, "  ") };
        assert_eq!(cfg.resolve_api_key(), None);
        unsafe { std::env::remove_var(&cfg.api_key_env) };
    }

    #[test]
    fn the_defaults_name_the_variables_a_deployment_sets() {
        let cfg = SpecQualityConfig::default();
        assert_eq!(cfg.base_url_env, "STUDIO_SPEC_QUALITY_BASE_URL");
        assert_eq!(cfg.api_key_env, "STUDIO_SPEC_QUALITY_API_KEY");
        assert_eq!(
            cfg.resolve_base_url(),
            "",
            "an unconfigured wrapper must resolve to nothing rather than to a guess"
        );
    }
}
