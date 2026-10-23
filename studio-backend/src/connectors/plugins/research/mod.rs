use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use toolkit::Gear;
use toolkit::context::GearCtx;
use tracing::info;

use super::super::driver::ConnectorDriver;
use super::super::gts::RESEARCH_INSTANCE_ID;
use super::super::oauth::OAuthClient;
use super::super::research::ResearchDriver;
use super::{http_client, register_driver};

/// This driver's section. Beside the vendor and priority every driver has, the
/// client Studio is registered as with the Constructor identity provider and
/// where Research's integration service is (ADR-0049 §1, §6).
///
/// A deployment that has no client yet leaves `client_id` empty, and the
/// driver is not registered: Constructor Research is then not offered, rather
/// than offered and failing at the sign-in.
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default = "default_vendor")]
    pub vendor: String,
    #[serde(default = "default_priority")]
    pub priority: i16,
    /// The identity provider's root, `https://<host>/idp`; its OpenID Connect
    /// endpoints are `connect/authorize` and `connect/token` under it.
    #[serde(default)]
    pub issuer: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    /// What the client asks for. `offline_access` is what makes the sign-in
    /// last past one access token.
    #[serde(default = "default_scope")]
    pub scope: String,
    /// The portal's callback page. The identity provider sends the person
    /// here, and only here, with the code.
    #[serde(default)]
    pub redirect_uri: String,
    /// Research's integration service, the default address of a connection.
    #[serde(default)]
    pub api_url: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            vendor: default_vendor(),
            priority: default_priority(),
            issuer: String::new(),
            client_id: String::new(),
            client_secret: String::new(),
            scope: default_scope(),
            redirect_uri: String::new(),
            api_url: String::new(),
        }
    }
}

fn default_vendor() -> String {
    "constructorfabric".into()
}
fn default_priority() -> i16 {
    100
}
fn default_scope() -> String {
    "openid profile offline_access research-integration".into()
}

impl Config {
    /// The client, or what is missing for one.
    fn client(&self) -> Result<OAuthClient, &'static str> {
        let issuer = self.issuer.trim().trim_end_matches('/');
        for (value, name) in [
            (issuer, "issuer"),
            (self.client_id.trim(), "client_id"),
            (self.client_secret.trim(), "client_secret"),
            (self.redirect_uri.trim(), "redirect_uri"),
            (self.api_url.trim(), "api_url"),
        ] {
            if value.is_empty() {
                return Err(name);
            }
        }
        Ok(OAuthClient {
            authorize_url: format!("{issuer}/connect/authorize"),
            token_url: format!("{issuer}/connect/token"),
            client_id: self.client_id.trim().to_owned(),
            client_secret: self.client_secret.trim().to_owned(),
            scope: self.scope.trim().to_owned(),
            redirect_uri: self.redirect_uri.trim().to_owned(),
        })
    }
}

#[toolkit::gear(name = "research-connector-plugin", deps = [types_registry])]
#[derive(Default)]
pub struct ResearchConnectorPlugin {}

#[async_trait]
impl Gear for ResearchConnectorPlugin {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: Config = ctx.config_or_default()?;
        let oauth = match cfg.client() {
            Ok(client) => client,
            Err(missing) => {
                info!(
                    "research-connector-plugin: `{missing}` is not configured, so \
                     Constructor Research is not offered"
                );
                return Ok(());
            }
        };
        let driver: Arc<dyn ConnectorDriver> = Arc::new(ResearchDriver::new(
            http_client()?,
            oauth,
            cfg.api_url.trim().trim_end_matches('/').to_owned(),
        ));
        register_driver(ctx, RESEARCH_INSTANCE_ID, &cfg.vendor, cfg.priority, driver).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured() -> Config {
        Config {
            issuer: "https://idp.example.com/idp/".into(),
            client_id: "constructor-studio".into(),
            client_secret: "s".into(),
            redirect_uri: "https://studio.example.com/connections/oauth/callback".into(),
            api_url: "https://research.example.com/integration".into(),
            ..Config::default()
        }
    }

    #[test]
    fn the_endpoints_are_the_identity_providers_connect_routes() {
        let c = configured().client().unwrap();
        assert_eq!(
            c.authorize_url,
            "https://idp.example.com/idp/connect/authorize"
        );
        assert_eq!(c.token_url, "https://idp.example.com/idp/connect/token");
        assert!(c.scope.split(' ').any(|s| s == "offline_access"));
    }

    #[test]
    fn an_unconfigured_client_names_what_is_missing() {
        assert_eq!(Config::default().client().unwrap_err(), "issuer");
        let mut c = configured();
        c.client_secret = "  ".into();
        assert_eq!(c.client().unwrap_err(), "client_secret");
    }
}
