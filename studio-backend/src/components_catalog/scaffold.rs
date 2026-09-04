//! Writing a scaffolded gear into a project's connected repository.
//!
//! Read paths elsewhere stay read-only; this is the one place that *writes*.
//! Given a resolved GitHub connection it creates a branch off the connected
//! base branch, commits the skeleton files through the git-data API (one tree +
//! one commit, files inlined), and optionally opens a pull request. The token
//! is borrowed from the connectors service and never stored here.

use anyhow::{Result, anyhow};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use crate::connectors::driver::ConnectionAuth;

/// One file to write into the repository.
#[derive(Clone, Debug)]
pub struct ScaffoldFile {
    pub path: String,
    pub content: String,
}

/// Where the scaffold landed.
#[derive(Debug)]
pub struct ScaffoldWrite {
    pub branch: String,
    pub commit_sha: String,
    pub pr_url: Option<String>,
}

fn api(auth: &ConnectionAuth, path: &str) -> String {
    format!("{}{}", auth.base_url.trim_end_matches('/'), path)
}

#[derive(Deserialize)]
struct RefObj {
    object: ShaObj,
}
#[derive(Deserialize)]
struct ShaObj {
    sha: String,
}
#[derive(Deserialize)]
struct CommitObj {
    tree: ShaObj,
}
#[derive(Deserialize)]
struct NewSha {
    sha: String,
}
#[derive(Deserialize)]
struct PrCreated {
    html_url: String,
}

/// Create `branch` off `base_branch`, commit `files` in one commit, and — when
/// `pr_title` is set — open a pull request back into `base_branch`.
#[allow(clippy::too_many_arguments)]
pub async fn write_scaffold(
    http: &Client,
    auth: &ConnectionAuth,
    repo: &str,
    base_branch: &str,
    branch: &str,
    files: &[ScaffoldFile],
    message: &str,
    pr_title: Option<&str>,
) -> Result<ScaffoldWrite> {
    // 1. tip of the base branch.
    let base_ref: RefObj = get_json(
        http,
        auth,
        &format!("/repos/{repo}/git/ref/heads/{base_branch}"),
    )
    .await
    .map_err(|e| anyhow!("read base branch '{base_branch}': {e}"))?;
    let base_sha = base_ref.object.sha;

    // 2. its tree.
    let base_commit: CommitObj =
        get_json(http, auth, &format!("/repos/{repo}/git/commits/{base_sha}")).await?;

    // 3. a new tree with the skeleton files inlined onto the base tree.
    let tree_items: Vec<_> = files
        .iter()
        .map(|f| json!({ "path": f.path, "mode": "100644", "type": "blob", "content": f.content }))
        .collect();
    let new_tree: NewSha = post_json(
        http,
        auth,
        &format!("/repos/{repo}/git/trees"),
        json!({ "base_tree": base_commit.tree.sha, "tree": tree_items }),
    )
    .await?;

    // 4. one commit on top of the base.
    let new_commit: NewSha = post_json(
        http,
        auth,
        &format!("/repos/{repo}/git/commits"),
        json!({ "message": message, "tree": new_tree.sha, "parents": [base_sha] }),
    )
    .await?;

    // 5. the branch pointing at it.
    let _: serde_json::Value = post_json(
        http,
        auth,
        &format!("/repos/{repo}/git/refs"),
        json!({ "ref": format!("refs/heads/{branch}"), "sha": new_commit.sha }),
    )
    .await
    .map_err(|e| anyhow!("create branch '{branch}' (does it already exist?): {e}"))?;

    // 6. optionally, a pull request.
    let pr_url = if let Some(title) = pr_title {
        let pr: PrCreated = post_json(
            http,
            auth,
            &format!("/repos/{repo}/pulls"),
            json!({
                "title": title,
                "head": branch,
                "base": base_branch,
                "body": "Scaffolded gear skeleton from an App Spec gap. Fill in the service, then review.",
            }),
        )
        .await?;
        Some(pr.html_url)
    } else {
        None
    };

    Ok(ScaffoldWrite {
        branch: branch.to_string(),
        commit_sha: new_commit.sha,
        pr_url,
    })
}

/// A repository created through the connector.
#[derive(Debug)]
pub struct CreatedRepo {
    pub full_name: String,
    pub html_url: String,
    pub default_branch: String,
}

#[derive(Deserialize)]
struct RepoCreated {
    full_name: String,
    html_url: String,
    default_branch: String,
}

/// Create a new repository via the GitHub connector. Under an organization when
/// `is_org` and `owner` are set, otherwise under the authenticated user.
/// `auto_init` gives it a first commit so a base branch exists to scaffold onto.
pub async fn create_repo(
    http: &Client,
    auth: &ConnectionAuth,
    owner: Option<&str>,
    is_org: bool,
    name: &str,
    private: bool,
) -> Result<CreatedRepo> {
    let path = match owner {
        Some(o) if is_org && !o.is_empty() => format!("/orgs/{o}/repos"),
        _ => "/user/repos".to_string(),
    };
    let created: RepoCreated = post_json(
        http,
        auth,
        &path,
        json!({ "name": name, "private": private, "auto_init": true }),
    )
    .await
    .map_err(|e| anyhow!("create repository '{name}': {e}"))?;
    Ok(CreatedRepo {
        full_name: created.full_name,
        html_url: created.html_url,
        default_branch: created.default_branch,
    })
}

async fn get_json<T: for<'de> Deserialize<'de>>(
    http: &Client,
    auth: &ConnectionAuth,
    path: &str,
) -> Result<T> {
    let resp = http
        .get(api(auth, path))
        .bearer_auth(&auth.token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "studio-components-catalog")
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        return Err(anyhow!(
            "GET {path}: HTTP {status} — {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    Ok(resp.json::<T>().await?)
}

async fn post_json<T: for<'de> Deserialize<'de>>(
    http: &Client,
    auth: &ConnectionAuth,
    path: &str,
    body: serde_json::Value,
) -> Result<T> {
    let resp = http
        .post(api(auth, path))
        .bearer_auth(&auth.token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "studio-components-catalog")
        .json(&body)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        return Err(anyhow!(
            "POST {path}: HTTP {status} — {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    Ok(resp.json::<T>().await?)
}
