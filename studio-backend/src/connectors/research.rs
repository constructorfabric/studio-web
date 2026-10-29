//! Constructor Research driver: where a member's products are built and run
//! on the hardware Research allocates (ADR-0049).
//!
//! Studio never reaches into Research's cluster. The connection's address is
//! Research's own public API (`https://<stand>/api/platform-account/v1`),
//! and every call goes there with an access token of the member's own.
//!
//! The credential is not pasted. The member signs in to the shared
//! Constructor identity provider ([`super::oauth`]); the connection stores the
//! refresh token that comes back, and each use trades it for an access token
//! ([`ConnectorDriver::access_token`]). A successful `GET /auth/session` is
//! the proof that the member controls that Research account (ADR-0012).

use anyhow::anyhow;
use async_trait::async_trait;

use super::driver::{
    AccessToken, ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity,
};
use super::oauth::{OAuthClient, Pkce, Tokens};

pub const PROVIDER: &str = "research";

pub struct ResearchDriver {
    http: reqwest::Client,
    oauth: OAuthClient,
    /// Research's public API in this deployment, offered as the
    /// connection's default. Leaked once at boot: the contract hands it out as
    /// `&'static str`, and a driver lives as long as the process.
    api_url: &'static str,
}

impl ResearchDriver {
    pub fn new(http: reqwest::Client, oauth: OAuthClient, api_url: String) -> Self {
        Self {
            http,
            oauth,
            api_url: Box::leak(api_url.into_boxed_str()),
        }
    }
}

#[async_trait]
impl ConnectorDriver for ResearchDriver {
    fn provider(&self) -> &'static str {
        PROVIDER
    }

    fn display_name(&self) -> &'static str {
        "Constructor Research"
    }

    fn default_base_url(&self) -> &'static str {
        self.api_url
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Compute
    }

    fn credential_hint(&self) -> &'static str {
        "Sign in with your Constructor account"
    }

    fn signs_in(&self) -> bool {
        true
    }

    fn sign_in_url(&self, state: &str, pkce: &Pkce) -> anyhow::Result<String> {
        self.oauth.authorize(state, pkce)
    }

    async fn exchange_code(&self, code: &str, verifier: &str) -> anyhow::Result<Tokens> {
        self.oauth.exchange_code(&self.http, code, verifier).await
    }

    async fn access_token(&self, stored: &str) -> anyhow::Result<AccessToken> {
        let tokens = self
            .oauth
            .refresh(&self.http, stored)
            .await
            .map_err(|e| anyhow!("{e}; sign in to Constructor Research again"))?;
        Ok(AccessToken {
            rotated: tokens.refresh_token.filter(|t| t != stored),
            token: tokens.access_token,
        })
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let me = super::research_api::ResearchApi::new(
            self.http.clone(),
            auth.root(),
            auth.token.clone(),
        )
        .me()
        .await?;
        Ok(DriverIdentity {
            display_name: me.display_name(),
            account: me.id,
        })
    }
}
