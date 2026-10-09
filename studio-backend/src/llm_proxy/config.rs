use serde::Deserialize;

/// Configuration for the studio-llm-proxy gear.
///
/// Only the providers: which ones exist, where they live, where a member's
/// profile key for each is kept, and which model the IDE's chat uses on each.
/// There is no Studio-held key and no server upstream — every call goes out on
/// the caller's own key or an AI connection they reach ([`super::keys`]).
#[derive(Debug, Clone, Deserialize)]
pub struct LlmProxyConfig {
    /// The agents' own APIs (Anthropic for Claude Code, OpenAI for Codex) and
    /// the chat models the IDE may use on them, in the order the chat tries
    /// them — see [`super::providers`].
    #[serde(default = "super::providers::default_providers")]
    pub providers: Vec<super::providers::ProviderConfig>,
}

impl Default for LlmProxyConfig {
    fn default() -> Self {
        Self {
            providers: super::providers::default_providers(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LlmProxyConfig;

    /// The defaults give the chat a model on both providers, Anthropic first.
    #[test]
    fn the_default_providers_carry_chat_models() {
        let cfg = LlmProxyConfig::default();
        let chat: Vec<(&str, Option<&str>)> = cfg
            .providers
            .iter()
            .map(|p| (p.name.as_str(), p.chat_model.as_deref()))
            .collect();
        assert_eq!(
            chat,
            [
                ("anthropic", Some("claude-sonnet-5-5")),
                ("openai", Some("gpt-4.1-mini"))
            ]
        );
    }

    /// A deployment overrides a chat model in YAML; what it leaves out keeps
    /// its default. Fields the proxy no longer reads (the old server upstream)
    /// do not break loading.
    #[test]
    fn a_chat_model_is_overridable_in_yaml() {
        let cfg: LlmProxyConfig = serde_json::from_value(serde_json::json!({
            "base_url": "https://api.groq.com/openai/v1",
            "providers": [{
                "name": "openai",
                "base_url": "https://api.openai.com/v1",
                "secret_ref": "openai-key",
                "key_header": "bearer",
                "chat_model": "gpt-5-mini"
            }]
        }))
        .expect("config loads");
        let openai = &cfg.providers[0];
        assert_eq!(openai.chat_model.as_deref(), Some("gpt-5-mini"));
        assert_eq!(openai.chat_path, "chat/completions");
        assert_eq!(openai.developer_message_settings, "system");
    }
}
