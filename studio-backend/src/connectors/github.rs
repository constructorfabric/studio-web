//! GitHub driver (github.com and GitHub Enterprise Server).

use async_trait::async_trait;
use serde::Deserialize;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, Contributor, DriverIdentity,
    OpenedPullRequest, RemoteComment, RemoteCommit, RemoteFile, RemoteIssue, RemotePullRequest,
    RemoteRepo, RepoTree, RepoTreeEntry, WrittenFile,
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
        self.headers(self.http.get(url), auth)
    }

    /// The same headers on any method — the write path needs PUT.
    fn headers(
        &self,
        rb: reqwest::RequestBuilder,
        auth: &ConnectionAuth,
    ) -> reqwest::RequestBuilder {
        rb.header("Authorization", format!("Bearer {}", auth.token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "constructor-studio")
    }
}

/// `GET/PUT /repos/{path}/contents/{path}` — the file's metadata after a write
/// (and, on the read before it, the sha the update must reference).
#[derive(Deserialize)]
struct GitHubContent {
    sha: String,
    #[serde(default)]
    html_url: Option<String>,
}

#[derive(Deserialize)]
struct GitHubContentWrite {
    #[serde(default)]
    content: Option<GitHubContent>,
    #[serde(default)]
    commit: Option<GitHubCommitRef>,
}

#[derive(Deserialize)]
struct GitHubCommitRef {
    sha: String,
}

/// `GET /repos/{path}/git/ref/heads/{branch}` — the commit a branch points at.
#[derive(Deserialize)]
struct GitHubGitRef {
    object: GitHubCommitRef,
}

/// The slice of a pull request the publish flow reports back.
#[derive(Deserialize)]
struct GitHubPullRef {
    number: i64,
    html_url: String,
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

/// One comment from `/repos/{path}/issues/comments` (covers issues AND PRs).
#[derive(Deserialize)]
struct GitHubComment {
    id: i64,
    #[serde(default)]
    user: Option<GitHubUser>,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    /// API URL of the issue/PR the comment is on; ends with `/issues/{number}`.
    issue_url: String,
}

/// The nested `commit` object inside a `/repos/{path}/commits` row.
#[derive(Deserialize)]
struct GitHubCommitAuthor {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    date: Option<String>,
}

#[derive(Deserialize)]
struct GitHubCommitMeta {
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    author: Option<GitHubCommitAuthor>,
}

/// One row of `/repos/{path}/commits`.
#[derive(Deserialize)]
struct GitHubCommit {
    sha: String,
    html_url: String,
    commit: GitHubCommitMeta,
    /// The account GitHub matched the commit to (may be null for unmatched).
    #[serde(default)]
    author: Option<GitHubUser>,
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

impl GitHubDriver {
    /// The open pull request for `head` → `base`, when there is one.
    ///
    /// GitHub wants `head` qualified by the owner of the fork it lives on;
    /// within one repository that is the repository's own owner.
    async fn find_open_pull_request(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        head: &str,
        base: &str,
    ) -> anyhow::Result<Option<OpenedPullRequest>> {
        let owner = repo_full_path.split('/').next().unwrap_or_default();
        let url = format!("{}/repos/{repo_full_path}/pulls", auth.root());
        let res = self
            .request(&url, auth)
            .query(&[
                ("state", "open"),
                ("head", &format!("{owner}:{head}")),
                ("base", base),
            ])
            .send()
            .await?;
        if !res.status().is_success() {
            return Ok(None);
        }
        let pulls: Vec<GitHubPullRef> = res.json().await?;
        Ok(pulls.into_iter().next().map(|pr| OpenedPullRequest {
            number: pr.number,
            url: Some(pr.html_url),
            created: false,
        }))
    }
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

    async fn list_comments(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteComment>> {
        let mut url = format!(
            "{}/repos/{repo_full_path}/issues/comments?sort=updated&direction=desc&per_page={}&page={}",
            auth.root(),
            per_page.clamp(1, 100),
            page.max(1),
        );
        if let Some(s) = since.map(str::trim).filter(|s| !s.is_empty()) {
            url.push_str("&since=");
            url.push_str(s);
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
        let comments: Vec<GitHubComment> = res.json().await?;
        Ok(comments
            .into_iter()
            .map(|c| {
                // The issue/PR number is the last path segment of issue_url.
                let target_number = c
                    .issue_url
                    .rsplit('/')
                    .next()
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(0);
                RemoteComment {
                    id: c.id.to_string(),
                    target_number,
                    author: c.user.map(|u| u.login),
                    body: c.body,
                    url: Some(c.html_url),
                    created_at: c.created_at,
                    updated_at: c.updated_at,
                }
            })
            .collect())
    }

    async fn list_commits(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteCommit>> {
        let mut url = format!(
            "{}/repos/{repo_full_path}/commits?per_page={}&page={}",
            auth.root(),
            per_page.clamp(1, 100),
            page.max(1),
        );
        if let Some(s) = since.map(str::trim).filter(|s| !s.is_empty()) {
            url.push_str("&since=");
            url.push_str(s);
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
        let commits: Vec<GitHubCommit> = res.json().await?;
        Ok(commits
            .into_iter()
            .map(|c| {
                let author_name = c.commit.author.as_ref().and_then(|a| a.name.clone());
                let created_at = c.commit.author.as_ref().and_then(|a| a.date.clone());
                RemoteCommit {
                    sha: c.sha,
                    message: c.commit.message,
                    author: c.author.map(|u| u.login),
                    author_name,
                    url: Some(c.html_url),
                    created_at,
                }
            })
            .collect())
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

    async fn put_file(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        branch: Option<&str>,
        path: &str,
        content: &str,
        message: &str,
    ) -> anyhow::Result<WrittenFile> {
        let path = normalize_repo_path(path)?;
        let url = format!(
            "{}/repos/{repo_full_path}/contents/{}",
            auth.root(),
            encode_path(&path)
        );

        // GitHub refuses to overwrite a file unless the request names the blob
        // it is replacing, so read first. A 404 means "create", and anything
        // else is a real failure we must not paper over by attempting a create
        // that would then fail more confusingly.
        let mut probe = self.request(&url, auth);
        if let Some(b) = branch {
            probe = probe.query(&[("ref", b)]);
        }
        let existing = probe.send().await?;
        let prior_sha = match existing.status() {
            s if s.is_success() => Some(existing.json::<GitHubContent>().await?.sha),
            reqwest::StatusCode::NOT_FOUND => None,
            status => {
                let body = existing.text().await.unwrap_or_default();
                anyhow::bail!(
                    "GitHub {status} reading {path}: {}",
                    body.chars().take(200).collect::<String>()
                );
            }
        };

        let mut payload = serde_json::json!({
            "message": message,
            "content": BASE64.encode(content.as_bytes()),
        });
        if let Some(b) = branch {
            payload["branch"] = serde_json::Value::String(b.to_string());
        }
        if let Some(sha) = &prior_sha {
            payload["sha"] = serde_json::Value::String(sha.clone());
        }

        let res = self
            .headers(self.http.put(&url), auth)
            .json(&payload)
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub {status} writing {path}: {}",
                body.chars().take(300).collect::<String>()
            );
        }
        let written: GitHubContentWrite = res.json().await?;
        let file = written
            .content
            .ok_or_else(|| anyhow::anyhow!("GitHub accepted the write but reported no file"))?;
        Ok(WrittenFile {
            path,
            branch: branch.map(str::to_string),
            sha: file.sha,
            commit: written.commit.map(|c| c.sha),
            url: file.html_url,
            updated: prior_sha.is_some(),
        })
    }

    async fn default_branch(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
    ) -> anyhow::Result<String> {
        let url = format!("{}/repos/{repo_full_path}", auth.root());
        let res = self.request(&url, auth).send().await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub {status} reading {repo_full_path}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let repo: GitHubRepo = res.json().await?;
        repo.default_branch.ok_or_else(|| {
            anyhow::anyhow!("{repo_full_path} reports no default branch (is it empty?)")
        })
    }

    async fn branch_head(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        branch: &str,
    ) -> anyhow::Result<Option<String>> {
        // `git/ref/heads/{branch}` takes the branch name with its slashes
        // intact (`docs/prd`), so only the other characters are escaped.
        let url = format!(
            "{}/repos/{repo_full_path}/git/ref/heads/{}",
            auth.root(),
            encode_path(branch)
        );
        let res = self.request(&url, auth).send().await?;
        let status = res.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub {status} reading branch {branch}: {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let git_ref: GitHubGitRef = res.json().await?;
        Ok(Some(git_ref.object.sha))
    }

    async fn create_branch(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        branch: &str,
        from_sha: &str,
    ) -> anyhow::Result<()> {
        let url = format!("{}/repos/{repo_full_path}/git/refs", auth.root());
        let res = self
            .headers(self.http.post(&url), auth)
            .json(&serde_json::json!({
                "ref": format!("refs/heads/{branch}"),
                "sha": from_sha,
            }))
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub {status} creating branch {branch}: {}",
                body.chars().take(300).collect::<String>()
            );
        }
        Ok(())
    }

    async fn open_pull_request(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        head: &str,
        base: &str,
        title: &str,
        body: Option<&str>,
    ) -> anyhow::Result<OpenedPullRequest> {
        let url = format!("{}/repos/{repo_full_path}/pulls", auth.root());
        let mut payload = serde_json::json!({ "title": title, "head": head, "base": base });
        if let Some(text) = body {
            payload["body"] = serde_json::Value::String(text.to_string());
        }
        let res = self
            .headers(self.http.post(&url), auth)
            .json(&payload)
            .send()
            .await?;
        let status = res.status();
        if status.is_success() {
            let pr: GitHubPullRef = res.json().await?;
            return Ok(OpenedPullRequest {
                number: pr.number,
                url: Some(pr.html_url),
                created: true,
            });
        }

        // 422 is how GitHub says "a pull request for this head and base is
        // already open" — among other things, so we look rather than assume.
        // Finding it turns a second publish into an update of the open
        // request, which is what the person meant.
        if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY
            && let Some(existing) = self
                .find_open_pull_request(auth, repo_full_path, head, base)
                .await?
        {
            return Ok(existing);
        }
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!(
            "GitHub {status} opening a pull request {head} → {base}: {}",
            body.chars().take(300).collect::<String>()
        );
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

/// A repo-relative path we are willing to write to.
///
/// Rejects what could let a caller write outside the tree it named — a `..` or
/// empty segment — and normalizes the harmless variations away: a leading or
/// trailing slash, a Windows separator. Checked here, closest to the write,
/// rather than trusting every caller to have checked.
fn normalize_repo_path(path: &str) -> anyhow::Result<String> {
    let cleaned = path.trim().replace('\\', "/");
    let cleaned = cleaned.trim_matches('/');
    if cleaned.is_empty() {
        anyhow::bail!("a file path is required");
    }
    if cleaned.len() > 512 {
        anyhow::bail!("file path is too long");
    }
    for segment in cleaned.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            anyhow::bail!("file path must not contain empty or relative segments: {path}");
        }
    }
    Ok(cleaned.to_string())
}

/// Percent-encode each path segment, keeping the separators. GitHub takes the
/// path in the URL, so a space or a non-ASCII character has to be escaped —
/// but escaping the slashes too would name one file with slashes in it.
fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            segment
                .bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        (b as char).to_string()
                    }
                    other => format!("%{other:02X}"),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::extract::{Path as AxumPath, RawQuery, State};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::{Value, json};

    use super::*;

    /// What the repository looks like to the driver under test.
    struct Fixture {
        /// Blob sha of the file being written, or `None` when it is new.
        existing_file: Option<&'static str>,
        /// Branches that exist, name → head sha.
        branches: Vec<(&'static str, &'static str)>,
        default_branch: &'static str,
        /// Whether `POST /pulls` answers 422 — GitHub's "already open".
        pull_conflict: bool,
    }

    impl Default for Fixture {
        fn default() -> Self {
            Self {
                existing_file: None,
                branches: vec![("main", "sha-main")],
                default_branch: "main",
                pull_conflict: false,
            }
        }
    }

    /// What the fake GitHub saw, so a test can assert on the request sent and
    /// not only on the reply that came back.
    #[derive(Default)]
    struct Seen {
        put_body: Option<Value>,
        probe_query: Option<String>,
        ref_body: Option<Value>,
        pull_body: Option<Value>,
        pull_query: Option<String>,
    }

    type FakeState = (Arc<Mutex<Seen>>, Arc<Fixture>);

    /// A GitHub stand-in serving exactly the calls the write path makes.
    ///
    /// Worth the lines: this half is the wire format — which URL, which verb,
    /// which JSON shape — and the only alternative way to check it is pushing
    /// to a real repository with someone's real token.
    async fn fake_github(fixture: Fixture) -> (String, Arc<Mutex<Seen>>) {
        let seen = Arc::new(Mutex::new(Seen::default()));

        async fn repo(State((_, fx)): State<FakeState>) -> Json<Value> {
            Json(json!({
                "id": 1,
                "name": "specs",
                "full_name": "acme/specs",
                "clone_url": "https://example.test/acme/specs.git",
                "default_branch": fx.default_branch,
                "private": true,
            }))
        }

        async fn read_ref(
            State((_, fx)): State<FakeState>,
            AxumPath((_owner, _repo, branch)): AxumPath<(String, String, String)>,
        ) -> Response {
            match fx.branches.iter().find(|(n, _)| *n == branch) {
                Some((_, sha)) => Json(json!({ "object": { "sha": sha } })).into_response(),
                None => (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "message": "Not Found" })),
                )
                    .into_response(),
            }
        }

        async fn create_ref(
            State((seen, _)): State<FakeState>,
            AxumPath((_owner, _repo)): AxumPath<(String, String)>,
            Json(body): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            seen.lock().unwrap().ref_body = Some(body);
            (StatusCode::CREATED, Json(json!({})))
        }

        async fn create_pull(
            State((seen, fx)): State<FakeState>,
            AxumPath((_owner, _repo)): AxumPath<(String, String)>,
            Json(body): Json<Value>,
        ) -> Response {
            seen.lock().unwrap().pull_body = Some(body);
            if fx.pull_conflict {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(json!({ "message": "A pull request already exists" })),
                )
                    .into_response();
            }
            (
                StatusCode::CREATED,
                Json(json!({ "number": 42, "html_url": "https://example.test/pull/42" })),
            )
                .into_response()
        }

        async fn list_pulls(
            State((seen, fx)): State<FakeState>,
            AxumPath((_owner, _repo)): AxumPath<(String, String)>,
            RawQuery(query): RawQuery,
        ) -> Json<Value> {
            seen.lock().unwrap().pull_query = query;
            if fx.pull_conflict {
                Json(json!([{ "number": 9, "html_url": "https://example.test/pull/9" }]))
            } else {
                Json(json!([]))
            }
        }

        async fn probe(
            State((seen, fx)): State<FakeState>,
            AxumPath((_owner, _repo, _path)): AxumPath<(String, String, String)>,
            RawQuery(query): RawQuery,
        ) -> Response {
            seen.lock().unwrap().probe_query = query;
            match fx.existing_file {
                Some(sha) => Json(json!({ "sha": sha })).into_response(),
                None => (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "message": "Not Found" })),
                )
                    .into_response(),
            }
        }

        async fn write(
            State((seen, _)): State<FakeState>,
            AxumPath((_owner, _repo, _path)): AxumPath<(String, String, String)>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            seen.lock().unwrap().put_body = Some(body);
            Json(json!({
                "content": { "sha": "blob-after", "html_url": "https://example.test/file" },
                "commit": { "sha": "commit-after" },
            }))
        }

        let app = Router::new()
            .route("/repos/{owner}/{repo}", get(repo))
            .route(
                "/repos/{owner}/{repo}/git/ref/heads/{*branch}",
                get(read_ref),
            )
            .route("/repos/{owner}/{repo}/git/refs", post(create_ref))
            .route(
                "/repos/{owner}/{repo}/pulls",
                get(list_pulls).post(create_pull),
            )
            .route(
                "/repos/{owner}/{repo}/contents/{*path}",
                get(probe).put(write),
            )
            .with_state((Arc::clone(&seen), Arc::new(fixture)));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), seen)
    }

    fn driver_and_auth(base_url: String) -> (GitHubDriver, ConnectionAuth) {
        (
            GitHubDriver::new(reqwest::Client::new()),
            ConnectionAuth {
                base_url,
                token: "test-token".to_string(),
            },
        )
    }

    fn decoded_content(body: &Value) -> String {
        let encoded = body["content"].as_str().expect("content is a string");
        String::from_utf8(BASE64.decode(encoded).expect("valid base64")).unwrap()
    }

    /// A file that is not there yet is created — and GitHub must not be told to
    /// replace a blob that does not exist.
    #[tokio::test]
    async fn a_new_file_is_created_without_a_prior_sha() {
        let (base, seen) = fake_github(Fixture::default()).await;
        let (driver, auth) = driver_and_auth(base);

        let written = driver
            .put_file(
                &auth,
                "acme/specs",
                None,
                "docs/prd.md",
                "# PRD\n",
                "docs: publish",
            )
            .await
            .unwrap();

        assert!(!written.updated);
        assert_eq!(written.sha, "blob-after");
        assert_eq!(written.commit.as_deref(), Some("commit-after"));

        let body = seen
            .lock()
            .unwrap()
            .put_body
            .clone()
            .expect("a PUT arrived");
        assert!(body.get("sha").is_none(), "{body}");
        assert!(body.get("branch").is_none(), "{body}");
        assert_eq!(decoded_content(&body), "# PRD\n");
        assert_eq!(body["message"], "docs: publish");
    }

    /// A file that is already there is replaced, and GitHub is told which blob
    /// is being replaced — without that it refuses the write.
    #[tokio::test]
    async fn an_existing_file_is_replaced_on_the_named_branch() {
        let (base, seen) = fake_github(Fixture {
            existing_file: Some("blob-before"),
            ..Fixture::default()
        })
        .await;
        let (driver, auth) = driver_and_auth(base);

        let written = driver
            .put_file(
                &auth,
                "acme/specs",
                Some("main"),
                "docs/prd.md",
                "# PRD v2\n",
                "docs: update",
            )
            .await
            .unwrap();

        assert!(written.updated);
        assert_eq!(written.branch.as_deref(), Some("main"));
        assert_eq!(written.url.as_deref(), Some("https://example.test/file"));

        let seen = seen.lock().unwrap();
        assert_eq!(seen.probe_query.as_deref(), Some("ref=main"));
        let body = seen.put_body.clone().expect("a PUT arrived");
        assert_eq!(body["sha"], "blob-before");
        assert_eq!(body["branch"], "main");
        assert_eq!(decoded_content(&body), "# PRD v2\n");
    }

    #[tokio::test]
    async fn the_default_branch_comes_from_the_repository() {
        let (base, _) = fake_github(Fixture {
            default_branch: "trunk",
            ..Fixture::default()
        })
        .await;
        let (driver, auth) = driver_and_auth(base);
        assert_eq!(
            driver.default_branch(&auth, "acme/specs").await.unwrap(),
            "trunk"
        );
    }

    /// A branch that is not there is a `None`, not an error — that absence is
    /// how the publish flow decides to cut it.
    #[tokio::test]
    async fn a_missing_branch_reads_as_absent_rather_than_failing() {
        let (base, _) = fake_github(Fixture::default()).await;
        let (driver, auth) = driver_and_auth(base);

        assert_eq!(
            driver
                .branch_head(&auth, "acme/specs", "main")
                .await
                .unwrap()
                .as_deref(),
            Some("sha-main")
        );
        assert!(
            driver
                .branch_head(&auth, "acme/specs", "docs/prd")
                .await
                .unwrap()
                .is_none()
        );
    }

    /// Git wants the fully-qualified ref, not the bare branch name.
    #[tokio::test]
    async fn creating_a_branch_sends_a_fully_qualified_ref() {
        let (base, seen) = fake_github(Fixture::default()).await;
        let (driver, auth) = driver_and_auth(base);

        driver
            .create_branch(&auth, "acme/specs", "docs/prd", "sha-main")
            .await
            .unwrap();

        let body = seen
            .lock()
            .unwrap()
            .ref_body
            .clone()
            .expect("a POST arrived");
        assert_eq!(body["ref"], "refs/heads/docs/prd");
        assert_eq!(body["sha"], "sha-main");
    }

    #[tokio::test]
    async fn opening_a_pull_request_reports_its_number_and_url() {
        let (base, seen) = fake_github(Fixture::default()).await;
        let (driver, auth) = driver_and_auth(base);

        let pr = driver
            .open_pull_request(
                &auth,
                "acme/specs",
                "docs/prd",
                "main",
                "Publish the PRD",
                Some("From Studio."),
            )
            .await
            .unwrap();

        assert!(pr.created);
        assert_eq!(pr.number, 42);
        assert_eq!(pr.url.as_deref(), Some("https://example.test/pull/42"));

        let body = seen
            .lock()
            .unwrap()
            .pull_body
            .clone()
            .expect("a POST arrived");
        assert_eq!(body["head"], "docs/prd");
        assert_eq!(body["base"], "main");
        assert_eq!(body["title"], "Publish the PRD");
        assert_eq!(body["body"], "From Studio.");
    }

    /// Publishing a second revision must land on the request already open, not
    /// collide with it — GitHub says so with a 422, and we go and look.
    #[tokio::test]
    async fn an_already_open_pull_request_is_reused_rather_than_failing() {
        let (base, seen) = fake_github(Fixture {
            pull_conflict: true,
            ..Fixture::default()
        })
        .await;
        let (driver, auth) = driver_and_auth(base);

        let pr = driver
            .open_pull_request(&auth, "acme/specs", "docs/prd", "main", "Publish", None)
            .await
            .unwrap();

        assert!(!pr.created);
        assert_eq!(pr.number, 9);

        // The lookup must be qualified by the repository owner, or GitHub
        // silently matches nothing and we would report a failure instead.
        let query = seen
            .lock()
            .unwrap()
            .pull_query
            .clone()
            .expect("a GET arrived");
        assert!(query.contains("head=acme%3Adocs%2Fprd"), "{query}");
        assert!(query.contains("base=main"), "{query}");
        assert!(query.contains("state=open"), "{query}");
    }

    #[test]
    fn a_path_may_not_escape_the_repository() {
        for bad in [
            "../etc/passwd",
            "docs/../../secrets.md",
            "docs//empty.md",
            "docs\\..\\win.md",
            "   ",
        ] {
            assert!(normalize_repo_path(bad).is_err(), "{bad} should be refused");
        }
    }

    /// A leading slash is how people write "from the repository root", and it
    /// cannot reach outside the repository — so it is normalized away, not
    /// refused. `..` is the segment that could escape, and that one is.
    #[test]
    fn ordinary_paths_are_normalized_not_refused() {
        assert_eq!(
            normalize_repo_path("docs/adr/0001.md").unwrap(),
            "docs/adr/0001.md"
        );
        assert_eq!(normalize_repo_path("/docs/prd.md/").unwrap(), "docs/prd.md");
        assert_eq!(normalize_repo_path(r"docs\prd.md").unwrap(), "docs/prd.md");
    }

    #[test]
    fn separators_survive_encoding_and_the_rest_is_escaped() {
        assert_eq!(encode_path("docs/my file.md"), "docs/my%20file.md");
        assert_eq!(encode_path("docs/adr/0001-a_b.md"), "docs/adr/0001-a_b.md");
    }
}
