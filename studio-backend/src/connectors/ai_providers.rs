//! Model-provider drivers: Anthropic and OpenAI.
//!
//! These connections are what the IDE agents authenticate with — an Anthropic
//! key is what makes `@theia/ai-claude-code` work inside a session, an OpenAI
//! key does the same for `@theia/ai-codex`. A connection is where such a key
//! is stored (in credstore, under the connection's reference) with
//! provenance, a label and a scope attached, which is the shape a workspace
//! owner can actually manage.
//!
//! These drivers do not call the provider themselves. `studio-llm-proxy` is
//! Studio's one way out to a model provider (ADR-0037); a driver asks it,
//! through its port, with the key being tested. What stays here is what a
//! connection knows: the provider's name, the hosts a key may be sent to, and
//! how its stored address maps onto the proxy's.
//!
//! Neither provider exposes an account endpoint, so `test()` lists models
//! instead: it proves the key is accepted and says what it can reach, which is
//! the useful half of "whose key is this?".

use std::sync::Arc;

use async_trait::async_trait;

use super::driver::{ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity};
use super::url_guard::HostRule;
use crate::llm_proxy::port::{ModelInfo, ModelProviders};

/// How a driver reaches the provider layer: resolved on use, so a plugin does
/// not depend on the order gears start in, and a deployment without the proxy
/// says so when a key is tested rather than failing its boot.
pub type ProviderLink = Arc<dyn Fn() -> anyhow::Result<Arc<dyn ModelProviders>> + Send + Sync>;

/// The link through a gear's ClientHub.
pub fn hub_link(hub: Arc<toolkit::client_hub::ClientHub>) -> ProviderLink {
    Arc::new(move || {
        hub.get::<dyn ModelProviders>().map_err(|_| {
            anyhow::anyhow!("studio-llm-proxy is not running: model provider keys cannot be tested")
        })
    })
}

/// Turn a model listing into an identity line: how many models the key can
/// see, and one concrete name so it is obvious which tier the key is on.
fn identity_from_models(list: Vec<ModelInfo>, provider: &str) -> DriverIdentity {
    let n = list.len();
    let first = list
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

/// A connection's address as the proxy's provider table writes it.
///
/// A connection stores the installation root (`https://api.openai.com`), and
/// some were saved with the API version on (`https://api.anthropic.com/v1`).
/// The proxy's Anthropic base has no `/v1` (its paths carry it), its OpenAI
/// base does (Codex appends `/responses` to it).
fn proxy_base(root: &str, with_v1: bool) -> String {
    let bare = root.trim_end_matches('/').trim_end_matches("/v1");
    if with_v1 {
        format!("{bare}/v1")
    } else {
        bare.to_owned()
    }
}

async fn test_key(
    link: &ProviderLink,
    provider: &str,
    display: &str,
    base_url: String,
    key: &str,
) -> anyhow::Result<DriverIdentity> {
    // The provider layer's error already names the provider and its status.
    let models = link()?.list_models(provider, Some(&base_url), key).await?;
    Ok(identity_from_models(models, display))
}

/* ── Anthropic ── */

pub struct AnthropicDriver {
    providers: ProviderLink,
}

impl AnthropicDriver {
    pub fn new(providers: ProviderLink) -> Self {
        Self { providers }
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
        test_key(
            &self.providers,
            self.provider(),
            self.display_name(),
            proxy_base(auth.root(), false),
            &auth.token,
        )
        .await
    }
}

/* ── OpenAI ── */

pub struct OpenAiDriver {
    providers: ProviderLink,
}

impl OpenAiDriver {
    pub fn new(providers: ProviderLink) -> Self {
        Self { providers }
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
        test_key(
            &self.providers,
            self.provider(),
            self.display_name(),
            proxy_base(auth.root(), true),
            &auth.token,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// The provider layer as a driver sees it: records what it was asked.
    #[derive(Default)]
    struct Recorded(Mutex<Vec<(String, Option<String>, String)>>);

    #[async_trait]
    impl ModelProviders for Recorded {
        async fn list_models(
            &self,
            provider: &str,
            base_url: Option<&str>,
            key: &str,
        ) -> anyhow::Result<Vec<ModelInfo>> {
            self.0.lock().unwrap().push((
                provider.to_owned(),
                base_url.map(str::to_owned),
                key.to_owned(),
            ));
            if key == "sk-bad" {
                anyhow::bail!("{provider} 401 Unauthorized: invalid key");
            }
            Ok(vec![ModelInfo {
                id: "m-1".into(),
                display_name: Some("Model One".into()),
            }])
        }
    }

    fn link(to: Arc<Recorded>) -> ProviderLink {
        Arc::new(move || Ok(to.clone() as Arc<dyn ModelProviders>))
    }

    fn auth(base_url: &str, token: &str) -> ConnectionAuth {
        ConnectionAuth {
            base_url: base_url.into(),
            token: token.into(),
        }
    }

    /// A key test goes out through the proxy's provider layer, with the
    /// connection's own key, at the connection's address in the proxy's form.
    #[tokio::test]
    async fn a_key_is_tested_through_the_one_way_out() {
        let seen = Arc::new(Recorded::default());
        let anthropic = AnthropicDriver::new(link(seen.clone()));
        let openai = OpenAiDriver::new(link(seen.clone()));

        let who = anthropic
            .test(&auth("https://api.anthropic.com/v1/", "sk-ant"))
            .await
            .unwrap();
        assert_eq!(who.account, "Anthropic key accepted");
        assert_eq!(
            who.display_name.as_deref(),
            Some("1 models · e.g. Model One")
        );
        openai
            .test(&auth("https://api.openai.com", "sk-oai"))
            .await
            .unwrap();

        let error = openai
            .test(&auth("https://api.openai.com/v1", "sk-bad"))
            .await
            .expect_err("a refused key fails the test");
        assert!(error.to_string().starts_with("openai 401"), "{error}");

        assert_eq!(
            seen.0.lock().unwrap().as_slice(),
            [
                (
                    "anthropic".to_owned(),
                    Some("https://api.anthropic.com".to_owned()),
                    "sk-ant".to_owned()
                ),
                (
                    "openai".to_owned(),
                    Some("https://api.openai.com/v1".to_owned()),
                    "sk-oai".to_owned()
                ),
                (
                    "openai".to_owned(),
                    Some("https://api.openai.com/v1".to_owned()),
                    "sk-bad".to_owned()
                ),
            ]
        );
    }

    #[tokio::test]
    async fn without_the_proxy_a_test_says_so() {
        let missing: ProviderLink =
            Arc::new(|| Err(anyhow::anyhow!("studio-llm-proxy is not running")));
        let error = AnthropicDriver::new(missing)
            .test(&auth("https://api.anthropic.com", "sk"))
            .await
            .expect_err("no provider layer, no test");
        assert!(error.to_string().contains("studio-llm-proxy"), "{error}");
    }
}
