//! What another gear may ask of a model provider: Studio's one way out to
//! them (ADR-0039).
//!
//! `studio-llm-proxy` is the only Studio code that sends a request to a model
//! provider. A gear that needs one — today the connector gear's "test this
//! key", tomorrow anything that wants a completion — takes this client from
//! the ClientHub instead of carrying an HTTP client and a provider's URL
//! conventions of its own. Which providers exist, where they live and how
//! each wants its key are this gear's configuration (`providers`), so they
//! are stated once.
//!
//! Narrow on purpose: one method per thing a caller actually needs. A
//! completion on a member's key is the routes' job (`/studio-llm/v1/providers/…`)
//! until a gear needs one in-process; it is added here, not beside it.

use async_trait::async_trait;

/// One model a key can reach, as the provider names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelInfo {
    pub id: String,
    /// Anthropic's human name (`Claude Sonnet 4`); OpenAI has none.
    pub display_name: Option<String>,
}

#[async_trait]
pub trait ModelProviders: Send + Sync {
    /// The models `key` reaches at `provider` — the proof a key is accepted.
    ///
    /// `provider` is a configured provider's name (`anthropic`, `openai`).
    /// `base_url`, when given, replaces the configured one for this call and
    /// takes the same form: the root the provider's API paths hang off
    /// (`https://api.anthropic.com`, `https://api.openai.com/v1`). The caller
    /// has already decided it may send the key there.
    async fn list_models(
        &self,
        provider: &str,
        base_url: Option<&str>,
        key: &str,
    ) -> anyhow::Result<Vec<ModelInfo>>;
}
