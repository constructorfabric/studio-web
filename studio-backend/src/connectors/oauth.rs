//! A connection signed in to rather than pasted (ADR-0049 §1): OAuth 2.0
//! authorization code with PKCE, against an OpenID Connect provider.
//!
//! Only what a driver needs to hand the service a credential: the address the
//! person is sent to, the exchange of the code that comes back, and the
//! exchange of a stored refresh token for an access token on every use. The
//! state between the two halves of a sign-in is the service's business
//! (`ConnectorService::oauth_start` / `oauth_complete`), not this module's.
//!
//! The client authenticates with `client_secret_post`. `private_key_jwt`,
//! which ADR-0049 asks for, is a follow-up: the identity provider accepts
//! either for a confidential client.

use anyhow::{Context, anyhow};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// One registered client of one identity provider.
#[derive(Clone)]
pub struct OAuthClient {
    /// `…/connect/authorize`.
    pub authorize_url: String,
    /// `…/connect/token`.
    pub token_url: String,
    pub client_id: String,
    pub client_secret: String,
    /// Space-separated; must include `offline_access`, or no refresh token
    /// comes back and the connection would last one access token.
    pub scope: String,
    /// Where the provider sends the person back: the portal's callback page,
    /// fixed by configuration so a request cannot name another.
    pub redirect_uri: String,
}

impl std::fmt::Debug for OAuthClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OAuthClient")
            .field("token_url", &self.token_url)
            .field("client_id", &self.client_id)
            .finish_non_exhaustive()
    }
}

/// The verifier kept on the server and the challenge sent with the person.
#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    /// A fresh pair. 32 bytes from two v4 UUIDs, which come from the OS's
    /// random source; RFC 7636 asks for 32 octets of entropy, and the version
    /// bits leave 244 of 256 random, far above what an attacker could guess.
    pub fn new() -> Self {
        let mut bytes = [0u8; 32];
        bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        Self::from_verifier(URL_SAFE_NO_PAD.encode(bytes))
    }

    pub fn from_verifier(verifier: String) -> Self {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self {
            verifier,
            challenge,
        }
    }
}

/// What a token endpoint answered.
#[derive(Clone, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    /// Absent when the client was not granted `offline_access`.
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens")
            .field("refresh_token", &self.refresh_token.is_some())
            .field("expires_in", &self.expires_in)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

impl OAuthClient {
    /// Where to send the person: the provider's sign-in page, asking for a
    /// code for this client, bound to `state` and to `pkce`'s challenge.
    pub fn authorize(&self, state: &str, pkce: &Pkce) -> anyhow::Result<String> {
        let url = reqwest::Url::parse_with_params(
            &self.authorize_url,
            &[
                ("response_type", "code"),
                ("client_id", self.client_id.as_str()),
                ("redirect_uri", self.redirect_uri.as_str()),
                ("scope", self.scope.as_str()),
                ("state", state),
                ("code_challenge", pkce.challenge.as_str()),
                ("code_challenge_method", "S256"),
            ],
        )
        .with_context(|| format!("bad authorize address {}", self.authorize_url))?;
        Ok(url.into())
    }

    /// The code the provider sent back, for tokens.
    pub async fn exchange_code(
        &self,
        http: &reqwest::Client,
        code: &str,
        verifier: &str,
    ) -> anyhow::Result<Tokens> {
        self.token(
            http,
            &[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", self.redirect_uri.as_str()),
                ("code_verifier", verifier),
            ],
        )
        .await
    }

    /// A stored refresh token, for a fresh access token. The answer may carry
    /// a new refresh token: a provider that rotates them has made the old one
    /// unusable, and the caller must keep the new one.
    pub async fn refresh(
        &self,
        http: &reqwest::Client,
        refresh_token: &str,
    ) -> anyhow::Result<Tokens> {
        self.token(
            http,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ],
        )
        .await
    }

    async fn token(
        &self,
        http: &reqwest::Client,
        grant: &[(&str, &str)],
    ) -> anyhow::Result<Tokens> {
        let mut form: Vec<(&str, &str)> = grant.to_vec();
        form.push(("client_id", &self.client_id));
        form.push(("client_secret", &self.client_secret));
        let res = http
            .post(&self.token_url)
            .form(&form)
            .send()
            .await
            .map_err(|e| anyhow!("the identity provider did not answer: {e}"))?;
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(match serde_json::from_str::<TokenError>(&body) {
                Ok(e) => anyhow!(
                    "the identity provider refused: {}{}",
                    e.error,
                    e.error_description
                        .map(|d| format!(" ({d})"))
                        .unwrap_or_default()
                ),
                Err(_) => anyhow!("the identity provider answered {status}"),
            });
        }
        serde_json::from_str(&body)
            .context("the identity provider's answer is not a token response")
    }
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;
