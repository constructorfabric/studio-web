//! Model-provider drivers: Anthropic and OpenAI.
//!
//! These connections are what the IDE agents authenticate with — an Anthropic
//! key is what makes `@theia/ai-claude-code` work inside a session, an OpenAI
//! key does the same for `@theia/ai-codex`. Today `studio-session` reads those
//! keys from fixed credstore references seeded by config; a connection is the
//! same secret with provenance, a label and a scope attached, which is the
//! shape a workspace owner can actually manage.
//!
//! Neither provider exposes an account endpoint, so `test()` lists models
//! instead: it proves the key is accepted and says what it can reach, which is
//! the useful half of "whose key is this?".

use super::url_guard::HostRule;
use async_trait::async_trait;
use serde::Deserialize;

use super::driver::{ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity};

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

/// Turn a model listing into an identity line: how many models the key can
/// see, and one concrete name so it is obvious which tier the key is on.
fn identity_from_models(list: ModelList, provider: &str) -> DriverIdentity {
    let n = list.data.len();
    let first = list
        .data
        .into_iter()
        .next()
        .map(|m| m.display_name.unwrap_or(m.id));
    DriverIdentity {
        account: format!("{provider} key accepted"),
        display_name: match first {
            Some(name) => Some(format!("{n} models · e.g. {name}")),
            None => Some(format!("{n} models")),
        },
    }
}

async fn fail(res: reqwest::Response, provider: &str) -> anyhow::Error {
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    anyhow::anyhow!(
        "{provider} {status}: {}",
        body.chars().take(200).collect::<String>()
    )
}

/* ── Anthropic ── */

pub struct AnthropicDriver {
    http: reqwest::Client,
}

impl AnthropicDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }
}

#[async_trait]
impl ConnectorDriver for AnthropicDriver {
    fn provider(&self) -> &'static str {
        "anthropic"
    }

    fn display_name(&self) -> &'static str {
        "Anthropic"
    }

    fn default_base_url(&self) -> &'static str {
        "https://api.anthropic.com"
    }

    /// Anthropic has no self-hosted form, so an address anywhere else is a
    /// typo — or somebody pointing a stored API key at a host of their own.
    fn base_url_rule(&self) -> HostRule {
        HostRule::OneOf(&["anthropic.com"])
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Ai
    }

    fn credential_hint(&self) -> &'static str {
        "sk-ant-…"
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let res = self
            .http
            .get(format!("{}/v1/models", auth.root()))
            // Anthropic authenticates with x-api-key, not a bearer, and
            // requires an explicit API version on every request.
            .header("x-api-key", &auth.token)
            .header("anthropic-version", "2023-06-01")
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(fail(res, "Anthropic").await);
        }
        Ok(identity_from_models(res.json().await?, "Anthropic"))
    }
}

/* ── OpenAI ── */

pub struct OpenAiDriver {
    http: reqwest::Client,
}

impl OpenAiDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }
}

#[async_trait]
impl ConnectorDriver for OpenAiDriver {
    fn provider(&self) -> &'static str {
        "openai"
    }

    fn display_name(&self) -> &'static str {
        "OpenAI"
    }

    fn default_base_url(&self) -> &'static str {
        "https://api.openai.com"
    }

    /// As for Anthropic: one set of endpoints, and a key must not be sent
    /// anywhere else.
    fn base_url_rule(&self) -> HostRule {
        HostRule::OneOf(&["openai.com"])
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Ai
    }

    fn credential_hint(&self) -> &'static str {
        "sk-…"
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        // Any OpenAI-compatible endpoint answers /v1/models, so this driver
        // also validates a key against Groq, Together, a local vLLM, or our
        // own studio-llm-proxy — set the instance URL accordingly.
        let res = self
            .http
            .get(format!("{}/v1/models", auth.root()))
            .header("Authorization", format!("Bearer {}", auth.token))
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(fail(res, "OpenAI").await);
        }
        Ok(identity_from_models(res.json().await?, "OpenAI"))
    }
}
