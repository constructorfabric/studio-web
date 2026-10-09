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
//! streamed completion on a member's key is the routes' job
//! (`/studio-llm/v1/providers/…`); a gear that needs one answer in-process —
//! the catalogue's registry suggesting a component's description (ADR-0041
//! P4) — asks [`ModelProviders::complete`], on the caller's key, chosen
//! exactly as the IDE's chat chooses it.

use async_trait::async_trait;
use toolkit_security::SecurityContext;

/// One question to a model, answered whole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompletionRequest {
    /// The system prompt.
    pub system: String,
    /// The user's message.
    pub prompt: String,
    pub max_tokens: u32,
}

/// A model's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    /// The provider that answered (`anthropic`, `openai`).
    pub provider: String,
    pub model: String,
    pub text: String,
}

/// Why there is no answer.
#[derive(Debug)]
pub enum CompletionError {
    /// The caller has no key for any provider with a chat model: the words
    /// to show them.
    NoKey(String),
    /// The provider was asked and failed, or answered nothing readable.
    Failed(anyhow::Error),
}

impl std::fmt::Display for CompletionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoKey(message) => f.write_str(message),
            Self::Failed(e) => write!(f, "{e:#}"),
        }
    }
}

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

    /// One completion on `ctx`'s key: the first configured provider with a
    /// chat model the caller has a key for, at its OpenAI-compatible chat
    /// endpoint, not streamed. Never on a key Studio holds.
    async fn complete(
        &self,
        ctx: &SecurityContext,
        request: &CompletionRequest,
    ) -> Result<Completion, CompletionError> {
        let _ = (ctx, request);
        Err(CompletionError::Failed(anyhow::anyhow!(
            "this model client answers no completions"
        )))
    }
}
