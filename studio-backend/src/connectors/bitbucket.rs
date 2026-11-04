//! Bitbucket Cloud driver.
//!
//! Only the token path is implemented. Bitbucket's OAuth flow needs a
//! registered consumer and a redirect endpoint on our side, so offering a
//! "Connect with OAuth" button before that exists would be a dead control —
//! the driver reports what it can actually do and the UI follows.
//!
//! A Repository / Workspace / Project Access Token works as a bearer token.
//! Legacy app passwords use Basic auth and are deliberately not supported:
//! they carry the whole account's permissions.

use async_trait::async_trait;
use serde::Deserialize;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, RemoteRepo,
};

pub struct BitbucketDriver {
    http: reqwest::Client,
}

impl BitbucketDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }
}

#[derive(Deserialize)]
struct BbUser {
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    nickname: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct BbCloneLink {
    name: String,
    href: String,
}

#[derive(Deserialize)]
struct BbLinks {
    #[serde(default)]
    clone: Vec<BbCloneLink>,
}

#[derive(Deserialize)]
struct BbBranch {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct BbRepo {
    uuid: String,
    name: String,
    full_name: String,
    links: BbLinks,
    #[serde(default)]
    mainbranch: Option<BbBranch>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    is_private: bool,
}

#[derive(Deserialize)]
struct BbPage {
    #[serde(default)]
    values: Vec<BbRepo>,
}

#[async_trait]
impl ConnectorDriver for BitbucketDriver {
    fn provider(&self) -> &'static str {
        "bitbucket"
    }

    fn display_name(&self) -> &'static str {
        "Bitbucket"
    }

    fn default_base_url(&self) -> &'static str {
        "https://api.bitbucket.org/2.0"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::SourceCode
    }

    fn credential_hint(&self) -> &'static str {
        "access token"
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let url = format!("{}/user", auth.root());
        let res = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", auth.token))
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "Bitbucket {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let user: BbUser = res.json().await?;
        Ok(DriverIdentity {
            checks: Vec::new(),
            account: user
                .username
                .or(user.nickname)
                .unwrap_or_else(|| "bitbucket".to_string()),
            display_name: user.display_name,
        })
    }

    async fn list_repositories(
        &self,
        auth: &ConnectionAuth,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<RemoteRepo>> {
        // `role=member` keeps the listing to repositories the token can reach;
        // `q` is Bitbucket's own filter language, so quote the value.
        let mut url = format!(
            "{}/repositories?role=member&sort=-updated_on&pagelen={}",
            auth.root(),
            limit.clamp(1, 100)
        );
        if let Some(q) = search.map(str::trim).filter(|q| !q.is_empty()) {
            let escaped = q.replace('"', "");
            url.push_str("&q=");
            url.push_str(&urlencode(&format!("name~\"{escaped}\"")));
        }
        let res = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", auth.token))
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "Bitbucket {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let page: BbPage = res.json().await?;
        Ok(page
            .values
            .into_iter()
            .map(|r| {
                let clone_url = r
                    .links
                    .clone
                    .iter()
                    .find(|l| l.name == "https")
                    .map(|l| l.href.clone())
                    .unwrap_or_default();
                RemoteRepo {
                    id: r.uuid,
                    name: r.name,
                    full_path: r.full_name,
                    clone_url,
                    default_branch: r.mainbranch.and_then(|b| b.name),
                    description: r.description,
                    visibility: Some(if r.is_private { "private" } else { "public" }.to_string()),
                }
            })
            .collect())
    }
}

/// Percent-encode a query value (see the note in `gitlab.rs`).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
