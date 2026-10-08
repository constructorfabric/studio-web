//! GitHub writes of more than one file: a commit through the git-data API
//! (one tree, one commit, files inlined), and a new repository.
//!
//! The single-file write (`put_file`) is the contents API, one commit per
//! file. A gear skeleton or a product description is several files that belong
//! in one commit, so they take this path. Moved here from the catalogue's
//! scaffold, which used to talk to GitHub with a client of its own.

use anyhow::{Result, anyhow};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::json;

use super::driver::{ConnectionAuth, CreatedRepository, FileToWrite};
use super::github::GitHubDriver;

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
struct ContentObj {
    #[serde(default)]
    content: String,
}
#[derive(Deserialize)]
struct RepoCreated {
    full_name: String,
    html_url: String,
    default_branch: String,
}

/// See [`super::driver::ConnectorDriver::commit_files`].
pub(super) async fn commit_files(
    gh: &GitHubDriver,
    auth: &ConnectionAuth,
    repo: &str,
    base_branch: &str,
    branch: &str,
    files: &[FileToWrite],
    message: &str,
) -> Result<String> {
    // 1. tip of the base branch.
    let base_ref: RefObj = get_json(
        gh,
        auth,
        &format!("/repos/{repo}/git/ref/heads/{base_branch}"),
    )
    .await
    .map_err(|e| anyhow!("read base branch '{base_branch}': {e}"))?;
    let base_sha = base_ref.object.sha;

    // 2. its tree.
    let base_commit: CommitObj =
        get_json(gh, auth, &format!("/repos/{repo}/git/commits/{base_sha}")).await?;

    // 3. a new tree with the files inlined onto the base tree.
    let tree_items: Vec<_> = files
        .iter()
        .map(|f| json!({ "path": f.path, "mode": "100644", "type": "blob", "content": f.content }))
        .collect();
    let new_tree: NewSha = send_json(
        gh,
        auth,
        reqwest::Method::POST,
        &format!("/repos/{repo}/git/trees"),
        json!({ "base_tree": base_commit.tree.sha, "tree": tree_items }),
    )
    .await?;

    // 4. one commit on top of the base.
    let new_commit: NewSha = send_json(
        gh,
        auth,
        reqwest::Method::POST,
        &format!("/repos/{repo}/git/commits"),
        json!({ "message": message, "tree": new_tree.sha, "parents": [base_sha] }),
    )
    .await?;

    // 5. the branch pointing at it — or, when the target IS the base branch,
    // the base moved onto it. Not forced: a push that landed between step 1
    // and here makes this a non-fast-forward, which fails rather than drops it.
    if branch == base_branch {
        let _: serde_json::Value = send_json(
            gh,
            auth,
            reqwest::Method::PATCH,
            &format!("/repos/{repo}/git/refs/heads/{branch}"),
            json!({ "sha": new_commit.sha, "force": false }),
        )
        .await
        .map_err(|e| anyhow!("advance '{branch}' (did it move meanwhile?): {e}"))?;
        return Ok(new_commit.sha);
    }
    let created: Result<serde_json::Value> = send_json(
        gh,
        auth,
        reqwest::Method::POST,
        &format!("/repos/{repo}/git/refs"),
        json!({ "ref": format!("refs/heads/{branch}"), "sha": new_commit.sha }),
    )
    .await;
    match created {
        Ok(_) => Ok(new_commit.sha),
        // **Asking twice for the same thing is not a failure.** A product
        // description's branch is named after its content
        // (`product/<id>-<digest>`), so saving the same description again
        // finds its own branch. When that branch already holds exactly these
        // files it IS the answer — returned, not refused. When it holds
        // something else, the name is taken and nothing is moved.
        Err(e) if e.to_string().contains("Reference already exists") => {
            if !branch_holds(gh, auth, repo, branch, files).await? {
                return Err(anyhow!(
                    "branch '{branch}' already exists with different content; nothing was \
                     overwritten. Delete or rename it, or pick another branch"
                ));
            }
            let tip: RefObj = get_json(gh, auth, &format!("/repos/{repo}/git/ref/heads/{branch}"))
                .await
                .map_err(|e| anyhow!("read existing branch '{branch}': {e}"))?;
            Ok(tip.object.sha)
        }
        Err(e) => Err(anyhow!("create branch '{branch}': {e}")),
    }
}

/// Whether `branch` already has every one of `files`, byte for byte.
async fn branch_holds(
    gh: &GitHubDriver,
    auth: &ConnectionAuth,
    repo: &str,
    branch: &str,
    files: &[FileToWrite],
) -> Result<bool> {
    for f in files {
        let found: Result<ContentObj> = get_json(
            gh,
            auth,
            &format!("/repos/{repo}/contents/{}?ref={branch}", f.path),
        )
        .await;
        let Ok(found) = found else { return Ok(false) };
        // GitHub wraps the base64 body at 60 columns.
        let packed: String = found.content.split_whitespace().collect();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(packed)
            .map_err(|e| anyhow!("decode {} on '{branch}': {e}", f.path))?;
        if bytes != f.content.as_bytes() {
            return Ok(false);
        }
    }
    Ok(true)
}

/// See [`super::driver::ConnectorDriver::create_repository`]. `auto_init`
/// gives it a first commit so a base branch exists to write onto.
pub(super) async fn create_repository(
    gh: &GitHubDriver,
    auth: &ConnectionAuth,
    owner: Option<&str>,
    is_org: bool,
    name: &str,
    private: bool,
) -> Result<CreatedRepository> {
    let path = match owner {
        Some(o) if is_org && !o.is_empty() => format!("/orgs/{o}/repos"),
        _ => "/user/repos".to_string(),
    };
    let created: RepoCreated = send_json(
        gh,
        auth,
        reqwest::Method::POST,
        &path,
        json!({ "name": name, "private": private, "auto_init": true }),
    )
    .await
    .map_err(|e| anyhow!("create repository '{name}': {e}"))?;
    Ok(CreatedRepository {
        full_name: created.full_name,
        html_url: created.html_url,
        default_branch: created.default_branch,
    })
}

async fn get_json<T: for<'de> Deserialize<'de>>(
    gh: &GitHubDriver,
    auth: &ConnectionAuth,
    path: &str,
) -> Result<T> {
    let url = format!("{}{path}", auth.root());
    let resp = gh.headers(gh.http().get(&url), auth).send().await?;
    let status = resp.status();
    if !status.is_success() {
        return Err(anyhow!(
            "GET {path}: HTTP {status} — {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    Ok(resp.json::<T>().await?)
}

async fn send_json<T: for<'de> Deserialize<'de>>(
    gh: &GitHubDriver,
    auth: &ConnectionAuth,
    method: reqwest::Method,
    path: &str,
    body: serde_json::Value,
) -> Result<T> {
    let url = format!("{}{path}", auth.root());
    let resp = gh
        .headers(gh.http().request(method.clone(), &url), auth)
        .json(&body)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        return Err(anyhow!(
            "{method} {path}: HTTP {status} — {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    Ok(resp.json::<T>().await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::driver::ConnectorDriver;
    use axum::http::{Method, StatusCode, Uri};
    use axum::response::IntoResponse;

    /// A GitHub that already has `product/p-1`, holding `on_branch` as its
    /// `product.gdl`, when `exists`; otherwise it creates the ref.
    async fn fake_github(exists: bool, on_branch: &'static str) -> String {
        let handler = move |method: Method, uri: Uri| async move {
            let path = uri.path().to_string();
            let json = |v: serde_json::Value| axum::Json(v).into_response();
            match (method.as_str(), path.as_str()) {
                ("GET", "/repos/o/r/git/ref/heads/main") => {
                    json(json!({"object": {"sha": "base"}}))
                }
                ("GET", "/repos/o/r/git/ref/heads/product/p-1") => {
                    json(json!({"object": {"sha": "tip-existing"}}))
                }
                ("GET", "/repos/o/r/git/commits/base") => json(json!({"tree": {"sha": "t0"}})),
                ("POST", "/repos/o/r/git/trees") => json(json!({"sha": "t1"})),
                ("POST", "/repos/o/r/git/commits") => json(json!({"sha": "c-new"})),
                ("POST", "/repos/o/r/git/refs") if exists => (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    r#"{"message":"Reference already exists","status":"422"}"#,
                )
                    .into_response(),
                ("POST", "/repos/o/r/git/refs") => json(json!({"ref": "refs/heads/product/p-1"})),
                ("GET", "/repos/o/r/contents/product.gdl") => {
                    let body = base64::engine::general_purpose::STANDARD.encode(on_branch);
                    // Wrapped, the way GitHub sends it.
                    let (a, b) = body.split_at(body.len() / 2);
                    json(json!({"content": format!("{a}\n{b}\n")}))
                }
                _ => (StatusCode::NOT_FOUND, path).into_response(),
            }
        };
        let app = axum::Router::new().fallback(handler);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
        format!("http://{addr}")
    }

    async fn save(base_url: String) -> Result<String> {
        let auth = ConnectionAuth {
            base_url,
            token: "t".into(),
        };
        GitHubDriver::new(reqwest::Client::new())
            .commit_files(
                &auth,
                "o/r",
                "main",
                "product/p-1",
                &[FileToWrite {
                    path: "product.gdl".into(),
                    content: "product(id = \"p\")\n".into(),
                }],
                "product: describe p",
            )
            .await
    }

    #[tokio::test]
    async fn saving_the_same_description_again_returns_the_branch_it_already_has() {
        let sha = save(fake_github(true, "product(id = \"p\")\n").await)
            .await
            .expect("idempotent save");
        assert_eq!(
            sha, "tip-existing",
            "the branch's own tip, not an orphan commit"
        );
    }

    #[tokio::test]
    async fn a_branch_holding_something_else_is_refused_and_left_alone() {
        let e = save(fake_github(true, "product(id = \"other\")\n").await)
            .await
            .expect_err("taken");
        assert!(
            e.to_string()
                .contains("already exists with different content"),
            "{e}"
        );
    }

    #[tokio::test]
    async fn a_new_branch_is_created_as_before() {
        let sha = save(fake_github(false, "").await).await.expect("created");
        assert_eq!(sha, "c-new");
    }
}
