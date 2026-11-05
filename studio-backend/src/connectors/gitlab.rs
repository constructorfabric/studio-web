//! GitLab driver (works against gitlab.com and self-hosted installations).

use async_trait::async_trait;
use serde::Deserialize;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, RemoteRepo,
};

pub struct GitLabDriver {
    http: reqwest::Client,
}

impl GitLabDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }
}

#[derive(Deserialize)]
struct GitLabUser {
    username: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct GitLabProject {
    id: i64,
    name: String,
    path_with_namespace: String,
    http_url_to_repo: String,
    default_branch: Option<String>,
    description: Option<String>,
    visibility: Option<String>,
}

#[async_trait]
impl ConnectorDriver for GitLabDriver {
    fn provider(&self) -> &'static str {
        "gitlab"
    }

    fn display_name(&self) -> &'static str {
        "GitLab"
    }

    fn default_base_url(&self) -> &'static str {
        "https://gitlab.com"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::SourceCode
    }

    fn credential_hint(&self) -> &'static str {
        "glpat-…"
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let url = format!("{}/api/v4/user", auth.root());
        let res = self
            .http
            .get(&url)
            .header("PRIVATE-TOKEN", &auth.token)
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitLab {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let user: GitLabUser = res.json().await?;
        Ok(DriverIdentity {
            checks: Vec::new(),
            account: user.username,
            display_name: user.name,
        })
    }

    async fn list_repositories(
        &self,
        auth: &ConnectionAuth,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<RemoteRepo>> {
        // `membership=true` keeps the listing to projects the token's owner
        // actually belongs to — without it a large instance answers with the
        // entire public catalogue.
        let mut url = format!(
            "{}/api/v4/projects?membership=true&order_by=last_activity_at&per_page={}",
            auth.root(),
            limit.clamp(1, 100)
        );
        if let Some(q) = search.map(str::trim).filter(|q| !q.is_empty()) {
            url.push_str("&search=");
            url.push_str(&urlencode(q));
        }
        let res = self
            .http
            .get(&url)
            .header("PRIVATE-TOKEN", &auth.token)
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitLab {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let projects: Vec<GitLabProject> = res.json().await?;
        Ok(projects
            .into_iter()
            .map(|p| RemoteRepo {
                id: p.id.to_string(),
                name: p.name,
                full_path: p.path_with_namespace,
                clone_url: p.http_url_to_repo,
                default_branch: p.default_branch,
                description: p.description,
                visibility: p.visibility,
            })
            .collect())
    }
}

/// Minimal percent-encoding for a query value. Avoids pulling in a URL crate
/// for the one place we interpolate user input into a query string.
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
