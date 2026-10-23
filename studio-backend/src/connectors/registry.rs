//! Registry driver: an OCI registry an organization's products are pushed to
//! and its clusters pull from (ADR-0048 §1).
//!
//! A connection of this kind holds the registry's address (`https://ghcr.io`,
//! a Harbor, a GitLab registry) and, as its credential, `username:token`. A
//! registry wants both for a login, and keeping them in one credstore value
//! keeps the pair together: the username of a robot account is half its
//! secret. A bare token logs in as `studio`, which a registry that only reads
//! the token (ghcr.io with a PAT) accepts.
//!
//! The credential is used by the server only: a deploy writes it into the
//! project's namespace as the pull secret, and pulls the chart with it. A
//! member's machine never holds it (ADR-0027).

use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;
use base64::Engine;
use reqwest::StatusCode;

use super::driver::{ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity};
use super::url_guard::{HostRule, check_url};

/// The username a bare token logs in as.
const DEFAULT_USERNAME: &str = "studio";

pub struct RegistryDriver {
    http: reqwest::Client,
}

impl RegistryDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }
}

#[async_trait]
impl ConnectorDriver for RegistryDriver {
    fn provider(&self) -> &'static str {
        "registry"
    }

    fn display_name(&self) -> &'static str {
        "Container registry"
    }

    fn default_base_url(&self) -> &'static str {
        "https://ghcr.io"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Registry
    }

    fn credential_label(&self) -> &'static str {
        "username:token"
    }

    fn credential_hint(&self) -> &'static str {
        "robot$acme+deployer:… or a token alone"
    }

    /// Log in the way a container runtime does: `/v2/` with the credential,
    /// and when the registry answers with a token challenge, ask its token
    /// service. A refused login is a refused credential.
    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let access = RegistryAccess::parse(&auth.base_url, &auth.token)?;
        let base = check_url(&auth.base_url, "the registry address", HostRule::AnyPublic)?;
        let v2 = base.join("/v2/")?;
        let res = self
            .http
            .get(v2.clone())
            .basic_auth(&access.username, Some(&access.password))
            .send()
            .await
            .map_err(|e| anyhow!("the registry did not answer: {e}"))?;
        match res.status() {
            s if s.is_success() => {}
            StatusCode::UNAUTHORIZED => {
                let challenge = res
                    .headers()
                    .get(reqwest::header::WWW_AUTHENTICATE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                let Some(realm) = bearer_challenge(&challenge) else {
                    bail!("the registry refused the credential (401 at {v2})");
                };
                // The realm is the registry's own answer, still a URL the
                // server is about to send a credential to: the same guard.
                let mut url = check_url(
                    &realm.realm,
                    "the registry's token service",
                    HostRule::AnyPublic,
                )?;
                if let Some(service) = &realm.service {
                    url.query_pairs_mut().append_pair("service", service);
                }
                let res = self
                    .http
                    .get(url)
                    .basic_auth(&access.username, Some(&access.password))
                    .send()
                    .await
                    .map_err(|e| anyhow!("the registry's token service did not answer: {e}"))?;
                if !res.status().is_success() {
                    bail!(
                        "the registry refused the credential ({} from its token service)",
                        res.status()
                    );
                }
            }
            s => bail!("the registry answered {s} at {v2}"),
        }
        Ok(DriverIdentity {
            account: access.username.clone(),
            display_name: Some(access.host.clone()),
        })
    }
}

/// A `Bearer` challenge's `realm` and `service`.
#[derive(Debug, PartialEq, Eq)]
struct Challenge {
    realm: String,
    service: Option<String>,
}

/// `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="…"`.
fn bearer_challenge(header: &str) -> Option<Challenge> {
    let rest = header
        .trim()
        .strip_prefix("Bearer ")
        .or_else(|| header.trim().strip_prefix("bearer "))?;
    let mut realm = None;
    let mut service = None;
    for part in rest.split(',') {
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        let v = v.trim().trim_matches('"').to_owned();
        match k.trim() {
            "realm" => realm = Some(v),
            "service" => service = Some(v),
            _ => {}
        }
    }
    Some(Challenge {
        realm: realm?,
        service,
    })
}

/// How the server logs in to one registry.
#[derive(Clone)]
pub struct RegistryAccess {
    /// `ghcr.io`, `harbor.acme.example:8443`: what image references start with.
    pub host: String,
    username: String,
    password: String,
}

impl std::fmt::Debug for RegistryAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegistryAccess")
            .field("host", &self.host)
            .field("username", &self.username)
            .finish_non_exhaustive()
    }
}

impl RegistryAccess {
    /// The access a connection's address and credential give.
    pub fn parse(base_url: &str, credential: &str) -> anyhow::Result<Self> {
        let url = check_url(base_url, "the registry address", HostRule::AnyPublic)?;
        let host = match url.port() {
            Some(p) => format!("{}:{p}", url.host_str().unwrap_or_default()),
            None => url.host_str().unwrap_or_default().to_owned(),
        };
        let credential = credential.trim();
        if credential.is_empty() {
            bail!("a registry connection needs a credential: username:token, or a token");
        }
        let (username, password) = match credential.split_once(':') {
            Some((u, p)) if !u.trim().is_empty() && !p.trim().is_empty() => {
                (u.trim().to_owned(), p.trim().to_owned())
            }
            Some(_) => bail!("write the credential as username:token"),
            None => (DEFAULT_USERNAME.to_owned(), credential.to_owned()),
        };
        Ok(Self {
            host,
            username,
            password,
        })
    }

    /// Whether `prefix` (`ghcr.io/acme`, no scheme) is on this registry.
    pub fn holds(&self, prefix: &str) -> bool {
        prefix
            .strip_prefix(&self.host)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    }

    /// A Docker config holding exactly this login: the body of a
    /// `kubernetes.io/dockerconfigjson` secret, and a registry config helm
    /// reads. Secret: written only where the server alone reads it.
    pub fn docker_config_json(&self) -> String {
        let auth = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", self.username, self.password));
        serde_json::json!({
            "auths": {
                &self.host: {
                    "username": self.username,
                    "password": self.password,
                    "auth": auth,
                }
            }
        })
        .to_string()
    }
}

impl RegistryAccess {
    /// A token from the registry's token service that may pull and push
    /// `paths` (`acme/gbx-api`) and nothing else, and how long it lasts. A
    /// registry with no token service cannot scope one, so it is refused:
    /// handing out its login would hand out everything it reaches.
    pub async fn push_token(
        &self,
        http: &reqwest::Client,
        paths: &[String],
    ) -> anyhow::Result<(String, Option<u64>)> {
        let base = check_url(
            &format!("https://{}", self.host),
            "the registry address",
            HostRule::AnyPublic,
        )?;
        let res = http
            .get(base.join("/v2/")?)
            .send()
            .await
            .map_err(|e| anyhow!("the registry did not answer: {e}"))?;
        let challenge = res
            .headers()
            .get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .and_then(bearer_challenge)
            .ok_or_else(|| {
                anyhow!(
                    "{} has no token service, so Studio cannot give out a push-only token: \
                     push with your own login",
                    self.host
                )
            })?;
        let mut url = check_url(
            &challenge.realm,
            "the registry's token service",
            HostRule::AnyPublic,
        )?;
        {
            let mut q = url.query_pairs_mut();
            if let Some(service) = &challenge.service {
                q.append_pair("service", service);
            }
            for p in paths {
                q.append_pair("scope", &format!("repository:{p}:pull,push"));
            }
        }
        let res = http
            .get(url)
            .basic_auth(&self.username, Some(&self.password))
            .send()
            .await
            .map_err(|e| anyhow!("the registry's token service did not answer: {e}"))?;
        if !res.status().is_success() {
            bail!("the registry refused a push token ({})", res.status());
        }
        let body: serde_json::Value = res.json().await?;
        let token = body
            .get("token")
            .or_else(|| body.get("access_token"))
            .and_then(|t| t.as_str())
            .filter(|t| !t.is_empty())
            .ok_or_else(|| anyhow!("the registry's token service answered without a token"))?;
        Ok((
            token.to_owned(),
            body.get("expires_in").and_then(|v| v.as_u64()),
        ))
    }
}

/// The access an image reference's host needs, checked to be `access`'s.
pub fn same_registry(access: &RegistryAccess, reference: &str) -> anyhow::Result<()> {
    let bare = reference.strip_prefix("oci://").unwrap_or(reference);
    if access.holds(bare) {
        Ok(())
    } else {
        Err(anyhow!(
            "'{reference}' is not on the registry {}",
            access.host
        ))
        .context("a chart is pulled only from the environment's registry")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_credential_is_a_username_and_a_token_or_a_token_alone() {
        let a = RegistryAccess::parse("https://ghcr.io", "acme-bot:ghp_x").unwrap();
        assert_eq!(
            (a.host.as_str(), a.username.as_str()),
            ("ghcr.io", "acme-bot")
        );
        let b = RegistryAccess::parse("https://harbor.acme.example:8443/", " tok ").unwrap();
        assert_eq!(b.host, "harbor.acme.example:8443");
        assert_eq!(b.username, DEFAULT_USERNAME);
        assert!(RegistryAccess::parse("https://ghcr.io", ":tok").is_err());
        assert!(RegistryAccess::parse("https://ghcr.io", "").is_err());
        assert!(RegistryAccess::parse("http://ghcr.io", "tok").is_err());
        assert!(
            format!("{a:?}").find("ghp_x").is_none(),
            "Debug must not print the token"
        );
    }

    #[test]
    fn the_docker_config_logs_in_to_the_registry_only() {
        let a = RegistryAccess::parse("https://ghcr.io", "u:p").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a.docker_config_json()).unwrap();
        assert_eq!(v["auths"]["ghcr.io"]["auth"], "dTpw");
        assert_eq!(v["auths"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn a_prefix_or_a_chart_is_on_the_registry_or_refused() {
        let a = RegistryAccess::parse("https://ghcr.io", "u:p").unwrap();
        assert!(a.holds("ghcr.io/acme"));
        assert!(a.holds("ghcr.io"));
        assert!(!a.holds("ghcr.io.evil.example/acme"));
        assert!(same_registry(&a, "oci://ghcr.io/acme/charts/shop").is_ok());
        assert!(same_registry(&a, "oci://registry.example/acme/shop").is_err());
    }

    #[test]
    fn a_bearer_challenge_names_its_token_service() {
        assert_eq!(
            bearer_challenge(
                r#"Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:user/image:pull""#
            ),
            Some(Challenge {
                realm: "https://ghcr.io/token".into(),
                service: Some("ghcr.io".into()),
            })
        );
        assert_eq!(bearer_challenge(r#"Basic realm="Registry""#), None);
    }
}
