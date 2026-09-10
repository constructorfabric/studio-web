use serde::Deserialize;

/// Configuration for the studio-llm-proxy gear.
///
/// Provider-agnostic: any OpenAI-compatible chat-completions endpoint works
/// (cloud providers, gateways, self-hosted vLLM/Ollama, ...). There is NO
/// default provider — unconfigured simply means in-IDE AI stays off. Every
/// knob has an env override so switching providers is a restart, not a
/// config edit:
///
///   STUDIO_LLM_BASE_URL  — e.g. https://api.openai.com/v1
///   STUDIO_LLM_MODEL     — e.g. gpt-4o-mini
///   STUDIO_LLM_API_KEY   — the provider key
#[derive(Debug, Clone, Deserialize)]
pub struct LlmProxyConfig {
    /// Upstream OpenAI-compatible base URL, up to and including `/v1`
    /// (no trailing slash). The proxy appends `/chat/completions`, `/models`.
    /// Env `base_url_env` (when set and non-empty) wins over this value.
    /// No default provider on purpose — unconfigured means AI is off.
    #[serde(default)]
    pub base_url: String,
    #[serde(default = "default_base_url_env")]
    pub base_url_env: String,

    /// Literal upstream API key. Wins over `api_key_env` when non-empty.
    /// Prefer the env indirection: keys don't belong in config files.
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_api_key_env")]
    pub api_key_env: String,

    /// Model name requested from the upstream. Advertised to IDE clients via
    /// GET /studio-llm/v1/client-config; env `model_env` wins over this.
    /// No default — must match whatever the configured provider serves.
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_model_env")]
    pub model_env: String,

    /// How OpenAI clients should send system prompts to this provider:
    /// one of `user | system | developer | mergeWithFollowingUserMessage |
    /// skip` (Theia ai-openai `developerMessageSettings`). `system` is the
    /// safe choice for non-OpenAI providers; OpenAI itself accepts any.
    #[serde(default = "default_developer_message_settings")]
    pub developer_message_settings: String,
}

impl Default for LlmProxyConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            base_url_env: default_base_url_env(),
            api_key: String::new(),
            api_key_env: default_api_key_env(),
            model: String::new(),
            model_env: default_model_env(),
            developer_message_settings: default_developer_message_settings(),
        }
    }
}

fn default_base_url_env() -> String {
    "STUDIO_LLM_BASE_URL".into()
}
fn default_api_key_env() -> String {
    "STUDIO_LLM_API_KEY".into()
}
fn default_model_env() -> String {
    "STUDIO_LLM_MODEL".into()
}
fn default_developer_message_settings() -> String {
    "system".into()
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl LlmProxyConfig {
    /// Effective base URL: env override beats YAML.
    pub fn resolve_base_url(&self) -> String {
        env_non_empty(&self.base_url_env)
            .unwrap_or_else(|| self.base_url.clone())
            .trim_end_matches('/')
            .to_string()
    }

    /// Effective model: env override beats YAML.
    pub fn resolve_model(&self) -> String {
        env_non_empty(&self.model_env).unwrap_or_else(|| self.model.clone())
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
    //! Same indirection as `studio-spec-quality`, and the same reason: the
    //! provider key stays out of the repository by living in a variable the
    //! config only names. Here it decides which provider the IDE's AI talks to
    //! and on whose account, so precedence resolving the wrong way is a bill
    //! as much as a bug.
    //!
    //! Tests that write to the environment take [`crate::test_env::lock`]:
    //! the process has one environment, so the lock has to be one too. Each
    //! also uses a variable name of its own, so a failure names one test
    //! rather than leaking.

    use super::LlmProxyConfig;
    use crate::test_env::lock;

    fn config(suffix: &str) -> LlmProxyConfig {
        LlmProxyConfig {
            base_url_env: format!("STUDIO_TEST_LLM_BASE_URL_{suffix}"),
            api_key_env: format!("STUDIO_TEST_LLM_API_KEY_{suffix}"),
            model_env: format!("STUDIO_TEST_LLM_MODEL_{suffix}"),
            ..LlmProxyConfig::default()
        }
    }

    /// No default provider, on purpose: unconfigured means the IDE's AI is
    /// off, not that it quietly points somewhere.
    #[test]
    fn an_unconfigured_proxy_resolves_to_nothing() {
        let cfg = config("unset");
        assert_eq!(cfg.resolve_base_url(), "");
        assert_eq!(cfg.resolve_model(), "");
        assert_eq!(cfg.resolve_api_key(), None);
    }

    #[test]
    fn the_yaml_values_are_used_when_the_variables_are_unset() {
        let cfg = LlmProxyConfig {
            base_url: "https://api.example/v1".to_string(),
            model: "some-model".to_string(),
            ..config("yaml")
        };
        assert_eq!(cfg.resolve_base_url(), "https://api.example/v1");
        assert_eq!(cfg.resolve_model(), "some-model");
    }

    #[test]
    fn the_environment_beats_the_yaml_base_url_and_model() {
        let _guard = lock();
        let cfg = LlmProxyConfig {
            base_url: "https://from-yaml.example/v1".to_string(),
            model: "yaml-model".to_string(),
            ..config("precedence")
        };
        unsafe {
            std::env::set_var(&cfg.base_url_env, "https://from-env.example/v1");
            std::env::set_var(&cfg.model_env, "env-model");
        }
        assert_eq!(cfg.resolve_base_url(), "https://from-env.example/v1");
        assert_eq!(cfg.resolve_model(), "env-model");
        unsafe {
            std::env::remove_var(&cfg.base_url_env);
            std::env::remove_var(&cfg.model_env);
        }
    }

    /// The base URL is concatenated with `/chat/completions`, so a trailing
    /// slash from either source would address `…/v1//chat/completions`.
    #[test]
    fn a_trailing_slash_is_trimmed_from_either_source() {
        let cfg = LlmProxyConfig {
            base_url: "https://api.example/v1/".to_string(),
            ..config("trim_yaml")
        };
        assert_eq!(cfg.resolve_base_url(), "https://api.example/v1");

        let _guard = lock();
        let cfg = config("trim_env");
        unsafe { std::env::set_var(&cfg.base_url_env, "https://api.example/v1/") };
        assert_eq!(cfg.resolve_base_url(), "https://api.example/v1");
        unsafe { std::env::remove_var(&cfg.base_url_env) };
    }

    /// A literal key beats the environment — the opposite of the base URL, and
    /// worth pinning for that reason alone.
    #[test]
    fn a_literal_key_beats_the_environment() {
        let _guard = lock();
        let cfg = LlmProxyConfig {
            api_key: "from-yaml".to_string(),
            ..config("key_precedence")
        };
        unsafe { std::env::set_var(&cfg.api_key_env, "from-env") };
        assert_eq!(cfg.resolve_api_key().as_deref(), Some("from-yaml"));
        unsafe { std::env::remove_var(&cfg.api_key_env) };
    }

    /// A deployment script that exports an empty variable must leave the proxy
    /// unconfigured rather than send a `Bearer ` with nothing after it.
    #[test]
    fn a_blank_key_is_absent_from_either_source() {
        let _guard = lock();
        let cfg = LlmProxyConfig {
            api_key: "   ".to_string(),
            ..config("blank_yaml")
        };
        assert_eq!(cfg.resolve_api_key(), None);

        let cfg = config("blank_env");
        unsafe { std::env::set_var(&cfg.api_key_env, "  ") };
        assert_eq!(cfg.resolve_api_key(), None);
        unsafe { std::env::remove_var(&cfg.api_key_env) };
    }

    #[test]
    fn the_defaults_name_the_variables_a_deployment_sets() {
        let cfg = LlmProxyConfig::default();
        assert_eq!(cfg.base_url_env, "STUDIO_LLM_BASE_URL");
        assert_eq!(cfg.api_key_env, "STUDIO_LLM_API_KEY");
        assert!(
            !cfg.developer_message_settings.is_empty(),
            "the IDE needs a system-prompt role to configure itself with"
        );
    }
}
