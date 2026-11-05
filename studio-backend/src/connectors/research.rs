//! Constructor Research driver: where a member's products are built and run
//! on the hardware Research allocates (ADR-0049).
//!
//! Studio never reaches into Research's cluster. The connection's address is
//! Research's own public API (`https://<stand>/api/platform-account/v1`),
//! and every call goes there with an access token of the member's own.
//!
//! The credential is not pasted. The member signs in to the shared
//! Constructor identity provider ([`super::oauth`]) once; with the token that
//! comes back Studio makes the member an `rk-` access key that runs out after
//! [`KEY_LIFETIME_DAYS`], and the connection stores the key (ADR-0049 §1).
//! Research limits a key to the routes Studio calls. When it runs out, the
//! member signs in again. A connection made before the keys stored a refresh
//! token, and still trades it for an access token on each use. A successful
//! `GET /auth/session` is the proof that the member controls that Research
//! account (ADR-0012).

use anyhow::anyhow;
use async_trait::async_trait;

use serde::{Deserialize, Serialize};

use super::driver::{
    AccessToken, ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, SignedIn,
};
use super::oauth::{OAuthClient, Pkce, Tokens};
use super::research_api::ResearchApi;

/// How long a key Studio makes lasts.
pub const KEY_LIFETIME_DAYS: i64 = 90;

/// What a connection stores: the member's key, its id (to delete it by) and
/// when it runs out.
#[derive(Serialize, Deserialize)]
struct StoredKey {
    key: String,
    id: String,
    expires_at: String,
}

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

    fn sign_in_url(
        &self,
        state: &str,
        pkce: &Pkce,
        redirect_uri: Option<&str>,
    ) -> anyhow::Result<(String, String)> {
        let redirect_uri = self.oauth.redirect_uri(redirect_uri)?;
        Ok((
            self.oauth.authorize(state, pkce, &redirect_uri)?,
            redirect_uri,
        ))
    }

    async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> anyhow::Result<Tokens> {
        // A sign-in started before the callback was kept has none: it was the
        // default's.
        let redirect_uri = self.oauth.redirect_uri(Some(redirect_uri))?;
        self.oauth
            .exchange_code(&self.http, code, verifier, &redirect_uri)
            .await
    }

    async fn signed_in(&self, base_url: &str, tokens: Tokens) -> anyhow::Result<SignedIn> {
        let expires_at = (chrono::Utc::now() + chrono::Duration::days(KEY_LIFETIME_DAYS))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let made = ResearchApi::new(self.http.clone(), base_url, tokens.access_token)
            .create_access_key("studio", &expires_at)
            .await?;
        let stored = serde_json::to_string(&StoredKey {
            key: made.key.clone(),
            id: made.id,
            expires_at,
        })?;
        Ok(SignedIn {
            stored,
            token: made.key,
        })
    }

    async fn access_token(&self, stored: &str) -> anyhow::Result<AccessToken> {
        if let Ok(k) = serde_json::from_str::<StoredKey>(stored) {
            return Ok(AccessToken {
                token: k.key,
                rotated: None,
            });
        }
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
        let me = ResearchApi::new(self.http.clone(), auth.root(), auth.token.clone())
            .me()
            .await?;
        Ok(DriverIdentity {
            checks: Vec::new(),
            display_name: me.display_name(),
            account: me.id,
        })
    }
}
