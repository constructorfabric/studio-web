//! Constructor Research driver: where a member's products are built and run
//! on the hardware Research allocates (ADR-0049).
//!
//! Studio never reaches into Research itself. The connection's address is
//! Research's integration service, the one door Research opens for Studio,
//! and every call goes there with an access token of the member's own.
//!
//! The credential is not pasted. The member signs in to the shared
//! Constructor identity provider ([`super::oauth`]); the connection stores the
//! refresh token that comes back, and each use trades it for an access token
//! ([`ConnectorDriver::access_token`]). A successful `GET /me` is the proof
//! that the member controls that Research account (ADR-0012).

use anyhow::anyhow;
use async_trait::async_trait;
use serde::Deserialize;

use super::driver::{
    AccessToken, ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity,
};
use super::oauth::{OAuthClient, Pkce, Tokens};

pub const PROVIDER: &str = "research";

pub struct ResearchDriver {
    http: reqwest::Client,
    oauth: OAuthClient,
    /// The integration service's address in this deployment, offered as the
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

/// `GET /me` of the integration service.
#[derive(Debug, Deserialize)]
struct Me {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
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
        let res = self
            .http
            .get(format!("{}/me", auth.root()))
            .bearer_auth(&auth.token)
            .send()
            .await
            .map_err(|e| anyhow!("Constructor Research did not answer: {e}"))?;
        let status = res.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(anyhow!(
                "Constructor Research did not accept the sign-in ({status})"
            ));
        }
        if !status.is_success() {
            return Err(anyhow!("Constructor Research answered {status}"));
        }
        let me: Me = res.json().await.map_err(|e| {
            anyhow!("Constructor Research's answer to /me is not what Studio expects: {e}")
        })?;
        Ok(DriverIdentity {
            account: me.id,
            display_name: me.name.or(me.email),
        })
    }
}
