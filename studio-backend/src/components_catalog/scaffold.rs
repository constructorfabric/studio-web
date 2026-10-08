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

use crate::connectors::sdk::ConnectionAuth;

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

    // 5. the branch pointing at it — or, when the target IS the base branch,
    // the base moved onto it. Not forced: a push that landed between step 1
    // and here makes this a non-fast-forward, which fails rather than drops it.
    let onto_base = branch == base_branch;
    // What the branch points at once this is done: the commit just made, or —
    // when the branch was already there holding these very files — its own tip.
    let mut commit_sha = new_commit.sha.clone();
    if onto_base {
        let _: serde_json::Value = patch_json(
            http,
            auth,
            &format!("/repos/{repo}/git/refs/heads/{branch}"),
            json!({ "sha": new_commit.sha, "force": false }),
        )
        .await
        .map_err(|e| anyhow!("advance '{branch}' (did it move meanwhile?): {e}"))?;
    } else {
        let created: Result<serde_json::Value> = post_json(
            http,
            auth,
            &format!("/repos/{repo}/git/refs"),
            json!({ "ref": format!("refs/heads/{branch}"), "sha": new_commit.sha }),
        )
        .await;
        match created {
            Ok(_) => {}
            // **Asking twice for the same thing is not a failure.** A product
            // description's branch is named after its content
            // (`product/<id>-<digest>`), so saving the same description again
            // finds its own branch. When that branch already holds exactly
            // these files it IS the answer — returned, not refused. When it
            // holds something else, the name is taken and nothing is moved.
            Err(e) if e.to_string().contains("Reference already exists") => {
                let holds = branch_holds(http, auth, repo, branch, files).await?;
                if !holds {
                    return Err(anyhow!(
                        "branch '{branch}' already exists with different content; nothing was \
                         overwritten. Delete or rename it, or pick another branch"
                    ));
                }
                let tip: RefObj =
                    get_json(http, auth, &format!("/repos/{repo}/git/ref/heads/{branch}"))
                        .await
                        .map_err(|e| anyhow!("read existing branch '{branch}': {e}"))?;
                commit_sha = tip.object.sha;
            }
            Err(e) => return Err(anyhow!("create branch '{branch}': {e}")),
        }
    }

    // 6. optionally, a pull request. There is nothing to request when the
    // commit is already on the base branch. A branch found already there may
    // already have its pull request, which is then the one returned.
    let pr_url = if let (Some(title), false) = (pr_title, onto_base) {
        let pr: Result<PrCreated> = post_json(
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
        .await;
        match pr {
            Ok(pr) => Some(pr.html_url),
            Err(e) if e.to_string().contains("A pull request already exists") => {
                let owner = repo.split('/').next().unwrap_or_default();
                let open: Vec<PrCreated> = get_json(
                    http,
                    auth,
                    &format!("/repos/{repo}/pulls?state=open&head={owner}:{branch}"),
                )
                .await?;
                open.into_iter().next().map(|pr| pr.html_url)
            }
            Err(e) => return Err(e),
        }
    } else {
        None
    };

    Ok(ScaffoldWrite {
        branch: branch.to_string(),
        commit_sha,
        pr_url,
    })
}

#[derive(Deserialize)]
struct ContentObj {
    #[serde(default)]
    content: String,
}

/// Whether `branch` already has every one of `files`, byte for byte.
async fn branch_holds(
    http: &Client,
    auth: &ConnectionAuth,
    repo: &str,
    branch: &str,
    files: &[ScaffoldFile],
) -> Result<bool> {
    use base64::Engine as _;
    for f in files {
        let found: Result<ContentObj> = get_json(
            http,
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
    send_json(http.post(api(auth, path)), auth, "POST", path, body).await
}

async fn patch_json<T: for<'de> Deserialize<'de>>(
    http: &Client,
    auth: &ConnectionAuth,
    path: &str,
    body: serde_json::Value,
) -> Result<T> {
    send_json(http.patch(api(auth, path)), auth, "PATCH", path, body).await
}

async fn send_json<T: for<'de> Deserialize<'de>>(
    request: reqwest::RequestBuilder,
    auth: &ConnectionAuth,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<T> {
    let resp = request
        .bearer_auth(&auth.token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "studio-components-catalog")
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
    use axum::http::{Method, StatusCode, Uri};
    use axum::response::IntoResponse;
    use base64::Engine as _;

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

    async fn save(base_url: String) -> Result<ScaffoldWrite> {
        let auth = ConnectionAuth {
            base_url,
            token: "t".into(),
        };
        write_scaffold(
            &Client::new(),
            &auth,
            "o/r",
            "main",
            "product/p-1",
            &[ScaffoldFile {
                path: "product.gdl".into(),
                content: "product(id = \"p\")\n".into(),
            }],
            "product: describe p",
            None,
        )
        .await
    }

    #[tokio::test]
    async fn saving_the_same_description_again_returns_the_branch_it_already_has() {
        let w = save(fake_github(true, "product(id = \"p\")\n").await)
            .await
            .expect("idempotent save");
        assert_eq!(w.branch, "product/p-1");
        assert_eq!(
            w.commit_sha, "tip-existing",
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
        let w = save(fake_github(false, "").await).await.expect("created");
        assert_eq!(w.commit_sha, "c-new");
    }
}
