//! GitHub driver (github.com and GitHub Enterprise Server).

use async_trait::async_trait;
use serde::Deserialize;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, Contributor, DriverIdentity, RemoteFile,
    RemoteIssue, RemotePullRequest, RemoteRepo, RepoTree, RepoTreeEntry,
};

pub struct GitHubDriver {
    http: reqwest::Client,
}

impl GitHubDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    /// GitHub rejects requests without a User-Agent, and pins the response
    /// shape to the Accept header.
    fn request(&self, url: &str, auth: &ConnectionAuth) -> reqwest::RequestBuilder {
        self.http
            .get(url)
            .header("Authorization", format!("Bearer {}", auth.token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "constructor-studio")
    }
}

#[derive(Deserialize)]
struct GitHubUser {
    login: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct GitHubRepo {
    id: i64,
    name: String,
    full_name: String,
    clone_url: String,
    default_branch: Option<String>,
    description: Option<String>,
    private: bool,
}

#[derive(Deserialize)]
struct GitHubLabel {
    name: String,
}

/// `head`/`base` on a pull request carry the branch under `ref` — a Rust
/// keyword, so it is renamed on the way in.
#[derive(Deserialize)]
struct GitHubRef {
    #[serde(rename = "ref")]
    ref_name: String,
}

#[derive(Deserialize)]
struct GitHubIssue {
    id: i64,
    number: i64,
    title: String,
    state: String,
    #[serde(default)]
    user: Option<GitHubUser>,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    labels: Vec<GitHubLabel>,
    /// Present only when this "issue" is actually a pull request — GitHub's
    /// `/issues` endpoint returns both, and we drop the PRs here.
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

/// One entry of a recursive git tree (`GET /repos/{path}/git/trees/{ref}`).
#[derive(Deserialize)]
struct GitHubTreeEntry {
    path: String,
    /// `blob` (file), `tree` (directory) or `commit` (submodule).
    #[serde(rename = "type")]
    entry_type: String,
    sha: String,
    #[serde(default)]
    size: Option<i64>,
}

#[derive(Deserialize)]
struct GitHubTree {
    #[serde(default)]
    tree: Vec<GitHubTreeEntry>,
    /// GitHub caps the tree response; when set, some entries were dropped.
    #[serde(default)]
    truncated: bool,
}

/// One row of `/repos/{path}/contributors`.
#[derive(Deserialize)]
struct GitHubContributor {
    #[serde(default)]
    login: String,
    #[serde(default)]
    contributions: i64,
}

#[derive(Deserialize)]
struct GitHubPull {
    id: i64,
    number: i64,
    title: String,
    state: String,
    #[serde(default)]
    user: Option<GitHubUser>,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    head: Option<GitHubRef>,
    #[serde(default)]
    base: Option<GitHubRef>,
    #[serde(default)]
    merged_at: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[async_trait]
impl ConnectorDriver for GitHubDriver {
    fn provider(&self) -> &'static str {
        "github"
    }

    fn display_name(&self) -> &'static str {
        "GitHub"
    }

    fn default_base_url(&self) -> &'static str {
        "https://api.github.com"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::SourceCode
    }

    fn credential_hint(&self) -> &'static str {
        "ghp_…"
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let url = format!("{}/user", auth.root());
        let res = self.request(&url, auth).send().await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let user: GitHubUser = res.json().await?;
        Ok(DriverIdentity {
            account: user.login,
            display_name: user.name,
        })
    }

    async fn list_repositories(
        &self,
        auth: &ConnectionAuth,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<RemoteRepo>> {
        // `/user/repos` has no server-side repo search, so we page through the
        // account's repositories (100 per request, GitHub's max) and filter
        // locally. With a search we must scan every page; without one the
        // `sort=updated` order means the first `limit` rows are already the
        // answer, so we stop as soon as we hold them. `MAX_PAGES` bounds the
        // walk for accounts with very many repos (we log and return what we got).
        const PER_PAGE: u32 = 100;
        const MAX_PAGES: u32 = 20;
        let needle = search
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());
        let want = limit.max(1) as usize;
        let mut out: Vec<RemoteRepo> = Vec::new();
        for page in 1..=MAX_PAGES {
            let url = format!(
                "{}/user/repos?sort=updated&per_page={PER_PAGE}&page={page}",
                auth.root(),
            );
            let res = self.request(&url, auth).send().await?;
            let status = res.status();
            if !status.is_success() {
                let body = res.text().await.unwrap_or_default();
                anyhow::bail!(
                    "GitHub {status}: {}",
                    body.chars().take(200).collect::<String>()
                );
            }
            let repos: Vec<GitHubRepo> = res.json().await?;
            let full_page = repos.len() == PER_PAGE as usize;
            out.extend(
                repos
                    .into_iter()
                    .filter(|r| {
                        needle
                            .as_ref()
                            .is_none_or(|n| r.full_name.to_lowercase().contains(n))
                    })
                    .map(|r| RemoteRepo {
                        id: r.id.to_string(),
                        name: r.name,
                        full_path: r.full_name,
                        clone_url: r.clone_url,
                        default_branch: r.default_branch,
                        description: r.description,
                        visibility: Some(if r.private { "private" } else { "public" }.to_string()),
                    }),
            );
            // Stop at the last page, or (no search) once we already hold the
            // most-recent `limit` repositories.
            if !full_page || (needle.is_none() && out.len() >= want) {
                break;
            }
            if page == MAX_PAGES {
                tracing::warn!(
                    max_pages = MAX_PAGES,
                    "github: repository listing hit the {}-repo scan cap; returning what was scanned",
                    MAX_PAGES * PER_PAGE
                );
            }
        }
        out.truncate(want);
        Ok(out)
    }

    async fn list_issues(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteIssue>> {
        // /issues returns both issues and PRs; a PR carries a `pull_request`
        // object, which we drop so this endpoint means issues only.
        let mut url = format!(
            "{}/repos/{repo_full_path}/issues?state=all&sort=updated&direction=desc&per_page={}&page={}",
            auth.root(),
            per_page.clamp(1, 100),
            page.max(1),
        );
        if let Some(since) = since.map(str::trim).filter(|s| !s.is_empty()) {
            url.push_str("&since=");
            url.push_str(since);
        }
        let res = self.request(&url, auth).send().await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let issues: Vec<GitHubIssue> = res.json().await?;
        Ok(issues
            .into_iter()
            .filter(|i| i.pull_request.is_none())
            .map(|i| RemoteIssue {
                id: i.id.to_string(),
                number: i.number,
                title: i.title,
                state: i.state,
                author: i.user.map(|u| u.login),
                body: i.body,
                url: Some(i.html_url),
                created_at: i.created_at,
                updated_at: i.updated_at,
                labels: i.labels.into_iter().map(|l| l.name).collect(),
            })
            .collect())
    }

    async fn list_pull_requests(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemotePullRequest>> {
        // /pulls has no `since` filter; we sort by most-recent activity and let
        // the caller stop once it walks past the incremental cursor.
        let _ = since;
        let url = format!(
            "{}/repos/{repo_full_path}/pulls?state=all&sort=updated&direction=desc&per_page={}&page={}",
            auth.root(),
            per_page.clamp(1, 100),
            page.max(1),
        );
        let res = self.request(&url, auth).send().await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let pulls: Vec<GitHubPull> = res.json().await?;
        Ok(pulls
            .into_iter()
            .map(|p| {
                let merged = p.merged_at.is_some();
                RemotePullRequest {
                    id: p.id.to_string(),
                    number: p.number,
                    title: p.title,
                    state: if merged {
                        "merged".to_string()
                    } else {
                        p.state
                    },
                    author: p.user.map(|u| u.login),
                    body: p.body,
                    url: Some(p.html_url),
                    source_branch: p.head.map(|r| r.ref_name),
                    target_branch: p.base.map(|r| r.ref_name),
                    merged,
                    created_at: p.created_at,
                    updated_at: p.updated_at,
                }
            })
            .collect())
    }

    async fn pull_request_files(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        number: i64,
    ) -> anyhow::Result<Vec<String>> {
        #[derive(serde::Deserialize)]
        struct PrFile {
            filename: String,
        }
        // Best-effort and paged: a non-2xx (e.g. a huge diff GitHub declines to
        // list) just stops the walk, so the sync keeps whatever links it got.
        let mut out: Vec<String> = Vec::new();
        for page in 1..=10u32 {
            let url = format!(
                "{}/repos/{repo_full_path}/pulls/{number}/files?per_page=100&page={page}",
                auth.root()
            );
            let res = self.request(&url, auth).send().await?;
            if !res.status().is_success() {
                break;
            }
            let files: Vec<PrFile> = res.json().await?;
            let n = files.len();
            out.extend(files.into_iter().map(|f| f.filename));
            if n < 100 {
                break;
            }
        }
        Ok(out)
    }

    async fn list_files(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<Vec<RemoteFile>> {
        // Resolve the ref: the caller's, or the repo's default branch (one
        // extra call, only when no ref was given).
        let git_ref = match git_ref.map(str::trim).filter(|s| !s.is_empty()) {
            Some(r) => r.to_string(),
            None => {
                let url = format!("{}/repos/{repo_full_path}", auth.root());
                let res = self.request(&url, auth).send().await?;
                let status = res.status();
                if !status.is_success() {
                    let body = res.text().await.unwrap_or_default();
                    anyhow::bail!(
                        "GitHub {status}: {}",
                        body.chars().take(200).collect::<String>()
                    );
                }
                let repo: GitHubRepo = res.json().await?;
                repo.default_branch.unwrap_or_else(|| "main".to_string())
            }
        };

        // One recursive call returns the whole tree; GitHub may truncate it for
        // very large repos (we log, and take what we got).
        let url = format!(
            "{}/repos/{repo_full_path}/git/trees/{git_ref}?recursive=1",
            auth.root()
        );
        let res = self.request(&url, auth).send().await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let tree: GitHubTree = res.json().await?;
        if tree.truncated {
            tracing::warn!(
                repo = repo_full_path,
                git_ref = git_ref,
                "GitHub truncated the recursive tree — file listing is partial"
            );
        }
        Ok(tree
            .tree
            .into_iter()
            .filter(|e| e.entry_type == "blob" || e.entry_type == "tree")
            .map(|e| RemoteFile {
                is_dir: e.entry_type == "tree",
                path: e.path,
                sha: e.sha,
                size: e.size,
            })
            .collect())
    }

    fn clone_url(&self, base_url: &str, repo_full_path: &str) -> anyhow::Result<String> {
        // The API root differs from the git host: github.com serves its API at
        // api.github.com, and GitHub Enterprise Server serves it at
        // `<host>/api/v3`. Map both back to the git host.
        let root = base_url.trim_end_matches('/');
        let host = if root.contains("api.github.com") {
            "https://github.com".to_string()
        } else {
            root.trim_end_matches("/api/v3").to_string()
        };
        Ok(format!("{host}/{repo_full_path}.git"))
    }

    async fn repo_tree(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<RepoTree> {
        // Resolve the ref: the caller's, or the repo's default branch.
        let git_ref = match git_ref.map(str::trim).filter(|s| !s.is_empty()) {
            Some(r) => r.to_string(),
            None => {
                let url = format!("{}/repos/{repo_full_path}", auth.root());
                let res = self.request(&url, auth).send().await?;
                let status = res.status();
                if !status.is_success() {
                    let body = res.text().await.unwrap_or_default();
                    anyhow::bail!(
                        "GitHub {status}: {}",
                        body.chars().take(200).collect::<String>()
                    );
                }
                let repo: GitHubRepo = res.json().await?;
                repo.default_branch.unwrap_or_else(|| "main".to_string())
            }
        };

        let url = format!(
            "{}/repos/{repo_full_path}/git/trees/{git_ref}?recursive=1",
            auth.root()
        );
        let res = self.request(&url, auth).send().await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let tree: GitHubTree = res.json().await?;
        let entries = tree
            .tree
            .into_iter()
            .filter(|e| e.entry_type == "blob" || e.entry_type == "tree")
            .map(|e| RepoTreeEntry {
                is_dir: e.entry_type == "tree",
                path: e.path,
            })
            .collect();
        Ok(RepoTree {
            git_ref,
            entries,
            truncated: tree.truncated,
        })
    }

    async fn contributors(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        max: u32,
    ) -> anyhow::Result<Vec<Contributor>> {
        let per_page = max.clamp(1, 100);
        let url = format!(
            "{}/repos/{repo_full_path}/contributors?per_page={per_page}",
            auth.root()
        );
        let res = self.request(&url, auth).send().await?;
        let status = res.status();
        // GitHub answers 204 (no body) for a repository with no contributor
        // history — an empty list, not an error.
        if status == reqwest::StatusCode::NO_CONTENT {
            return Ok(Vec::new());
        }
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub {status}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let list: Vec<GitHubContributor> = res.json().await?;
        Ok(list
            .into_iter()
            .take(max as usize)
            .map(|c| Contributor {
                login: c.login,
                display_name: None,
                contributions: c.contributions.max(0) as u64,
            })
            .collect())
    }
}
