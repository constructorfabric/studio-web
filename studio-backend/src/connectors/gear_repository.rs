//! Gear repository driver: one git repository of gears, at one ref, that a
//! tier's corpus is read from (ADR-0046).
//!
//! A connection of this kind is the repository itself, not a host: its
//! address is `https://github.com/<owner>/<repo>`, and its options say which
//! ref to read (`ref`, the default branch when blank) and the name the Gearbox
//! engine and `product.gdl` know it by (`source_id`, kebab-case, the
//! repository's name when blank). The token is optional: a public repository
//! is read without one, a private one with a read token.
//!
//! The engine reads it from a clone, so the driver answers the test -- is the
//! repository there, at that ref, and how many `gear.gdl` files does it hold
//! -- and the clone URL. A connection can also be where an organization's new
//! gears are written (`create_target`) and where the platform takes a
//! published one (ADR-0046 phases 3 and 4): the repository-level operations
//! (files, branches, pull requests) are GitHub's driver's, called with the API
//! root in place of the repository's address, and only ever for this
//! connection's own repository. GitHub only for now; GitLab and Bitbucket
//! follow the same shape.

use std::collections::BTreeMap;

use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;
use serde::Deserialize;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, FileToWrite,
    OpenedPullRequest, RemoteCommit, RemoteFileList, RemoteFileText, RepoTree, WrittenFile,
};
use super::github::GitHubDriver;
use super::url_guard::HostRule;

/// The provider key a gear repository connection is stored under.
pub const PROVIDER: &str = "gear-repository";
/// The option naming the ref to read.
pub const OPTION_REF: &str = "ref";
/// The option naming the repository for the engine (its root's directory).
pub const OPTION_SOURCE_ID: &str = "source_id";
/// The option marking an organization's repository as where "Create a gear"
/// writes (`"true"`); at most one per tenant.
pub const OPTION_CREATE_TARGET: &str = "create_target";

const API: &str = "https://api.github.com";

pub struct GearRepositoryDriver {
    http: reqwest::Client,
    github: GitHubDriver,
}

impl GearRepositoryDriver {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            github: GitHubDriver::new(http.clone()),
            http,
        }
    }

    /// GitHub's credentials for `repo`, which must be this connection's own:
    /// the connection is one repository, and its token is not lent to any
    /// other.
    fn api(&self, auth: &ConnectionAuth, repo: &str) -> anyhow::Result<ConnectionAuth> {
        let own = repository_of(&auth.base_url)?;
        if !own.eq_ignore_ascii_case(repo.trim().trim_matches('/')) {
            bail!("this gear repository connection reads {own}, not {repo}");
        }
        Ok(ConnectionAuth {
            base_url: API.to_string(),
            token: auth.token.clone(),
        })
    }

    fn get(&self, url: &str, token: &str) -> reqwest::RequestBuilder {
        let rb = self
            .http
            .get(url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "constructor-studio");
        // A public repository is read anonymously: an empty bearer is a 401.
        if token.trim().is_empty() {
            rb
        } else {
            rb.header("Authorization", format!("Bearer {}", token.trim()))
        }
    }
}

#[derive(Deserialize)]
struct RepoInfo {
    full_name: String,
    default_branch: String,
}

#[derive(Deserialize)]
struct Tree {
    #[serde(default)]
    tree: Vec<TreeEntry>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Deserialize)]
struct TreeEntry {
    path: String,
}

/// `owner/repo` from a gear repository's address, which must name one on
/// github.com: `https://github.com/<owner>/<repo>`, a trailing `.git` or `/`
/// tolerated, nothing below the repository.
pub fn repository_of(base_url: &str) -> anyhow::Result<String> {
    let url = reqwest::Url::parse(base_url.trim()).context("the address is not a URL")?;
    if url.host_str().map(str::to_ascii_lowercase).as_deref() != Some("github.com") {
        bail!("a gear repository is on github.com for now: https://github.com/<owner>/<repo>");
    }
    let parts: Vec<&str> = url
        .path()
        .trim_matches('/')
        .trim_end_matches(".git")
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    match parts.as_slice() {
        [owner, repo] => Ok(format!("{owner}/{repo}")),
        _ => bail!("the address names no repository: give it as https://github.com/<owner>/<repo>"),
    }
}

/// A source id the engine takes as a root's directory name: lowercase
/// letters, digits and single hyphens, starting with a letter.
pub fn is_source_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !id.is_empty()
        && bytes[0].is_ascii_lowercase()
        && !id.ends_with('-')
        && !id.contains("--")
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// The options a gear repository is stored with: `ref` trimmed (blank is the
/// default branch, and not stored), `source_id` given or taken from the
/// repository's name. Anything else is refused.
pub fn normalize_options(
    base_url: &str,
    given: &BTreeMap<String, String>,
) -> anyhow::Result<BTreeMap<String, String>> {
    if let Some(k) = given
        .keys()
        .find(|k| *k != OPTION_REF && *k != OPTION_SOURCE_ID && *k != OPTION_CREATE_TARGET)
    {
        bail!("a gear repository takes `ref`, `source_id` and `create_target`, not `{k}`");
    }
    let repo = repository_of(base_url)?;
    let mut out = BTreeMap::new();
    if let Some(r) = given
        .get(OPTION_REF)
        .map(|r| r.trim())
        .filter(|r| !r.is_empty())
    {
        // A branch or tag name as git spells them; it goes into a URL path
        // as is, so nothing that would change the path.
        if r.starts_with('/')
            || r.contains("..")
            || !r
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
        {
            bail!("`{r}` is not a branch or tag name");
        }
        out.insert(OPTION_REF.to_string(), r.to_string());
    }
    let source_id = match given
        .get(OPTION_SOURCE_ID)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        Some(s) => s.to_string(),
        None => repo
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .replace(['_', '.'], "-"),
    };
    if !is_source_id(&source_id) {
        bail!(
            "`{source_id}` is not a source id: lowercase letters, digits and single hyphens, \
             starting with a letter"
        );
    }
    out.insert(OPTION_SOURCE_ID.to_string(), source_id);
    match given.get(OPTION_CREATE_TARGET).map(|v| v.trim()) {
        None | Some("" | "false") => {}
        Some("true") => {
            out.insert(OPTION_CREATE_TARGET.to_string(), "true".to_string());
        }
        Some(other) => bail!("`create_target` is `true` or `false`, not `{other}`"),
    }
    Ok(out)
}

/// Whether a connection's options mark it where "Create a gear" writes.
pub fn is_create_target(options: &BTreeMap<String, String>) -> bool {
    options.get(OPTION_CREATE_TARGET).map(String::as_str) == Some("true")
}

#[async_trait]
impl ConnectorDriver for GearRepositoryDriver {
    fn provider(&self) -> &'static str {
        PROVIDER
    }

    fn display_name(&self) -> &'static str {
        "Gear repository"
    }

    /// None: the connection is one repository, and which one only the person
    /// adding it knows. A default would quietly connect someone else's.
    fn default_base_url(&self) -> &'static str {
        ""
    }

    fn base_url_rule(&self) -> HostRule {
        HostRule::OneOf(&["github.com"])
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Gears
    }

    fn credential_label(&self) -> &'static str {
        "Read token (blank for a public repository)"
    }

    fn credential_hint(&self) -> &'static str {
        "github_pat_… with Contents: read"
    }

    fn token_optional(&self) -> bool {
        true
    }

    fn check_options(
        &self,
        base_url: &str,
        options: &BTreeMap<String, String>,
    ) -> anyhow::Result<BTreeMap<String, String>> {
        normalize_options(base_url, options)
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        self.test_with_options(auth, &BTreeMap::new()).await
    }

    /// Reachable, at the ref, with how many gears: `owner/repo` as the
    /// account, "<n> gear.gdl files at <ref>" beside it.
    async fn test_with_options(
        &self,
        auth: &ConnectionAuth,
        options: &BTreeMap<String, String>,
    ) -> anyhow::Result<DriverIdentity> {
        let repo = repository_of(&auth.base_url)?;
        let res = self
            .get(&format!("{API}/repos/{repo}"), &auth.token)
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            bail!(
                "GitHub {status} for {repo}{}",
                if auth.token.trim().is_empty() {
                    ": a private repository needs a read token"
                } else {
                    ""
                }
            );
        }
        let info: RepoInfo = res.json().await?;
        let git_ref = options
            .get(OPTION_REF)
            .map(|r| r.trim())
            .filter(|r| !r.is_empty())
            .unwrap_or(&info.default_branch)
            .to_string();
        let res = self
            .get(
                &format!(
                    "{API}/repos/{}/git/trees/{}?recursive=1",
                    info.full_name, git_ref
                ),
                &auth.token,
            )
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            return Err(anyhow!(
                "{} has no ref `{git_ref}` (GitHub {status})",
                info.full_name
            ));
        }
        let tree: Tree = res.json().await?;
        let gears = tree
            .tree
            .iter()
            .filter(|e| e.path == "gear.gdl" || e.path.ends_with("/gear.gdl"))
            .count();
        let more = if tree.truncated { "+" } else { "" };
        Ok(DriverIdentity {
            checks: Vec::new(),
            account: info.full_name,
            display_name: Some(format!("{gears}{more} gear.gdl files at {git_ref}")),
        })
    }

    fn clone_url(&self, base_url: &str, _repo_full_path: &str) -> anyhow::Result<String> {
        Ok(format!(
            "https://github.com/{}.git",
            repository_of(base_url)?
        ))
    }

    async fn list_files(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<RemoteFileList> {
        self.github
            .list_files(&self.api(auth, repo)?, repo, git_ref)
            .await
    }

    async fn repo_tree(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<RepoTree> {
        self.github
            .repo_tree(&self.api(auth, repo)?, repo, git_ref)
            .await
    }

    async fn read_file(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        path: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<Option<RemoteFileText>> {
        self.github
            .read_file(&self.api(auth, repo)?, repo, path, git_ref)
            .await
    }

    async fn path_history(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        path: &str,
        git_ref: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<RemoteCommit>> {
        self.github
            .path_history(&self.api(auth, repo)?, repo, path, git_ref, limit)
            .await
    }

    async fn list_tags(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<String>> {
        self.github
            .list_tags(&self.api(auth, repo)?, repo, page, per_page)
            .await
    }

    async fn put_file(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        branch: Option<&str>,
        path: &str,
        content: &str,
        message: &str,
    ) -> anyhow::Result<WrittenFile> {
        self.github
            .put_file(&self.api(auth, repo)?, repo, branch, path, content, message)
            .await
    }

    async fn default_branch(&self, auth: &ConnectionAuth, repo: &str) -> anyhow::Result<String> {
        self.github
            .default_branch(&self.api(auth, repo)?, repo)
            .await
    }

    async fn branch_head(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        branch: &str,
    ) -> anyhow::Result<Option<String>> {
        self.github
            .branch_head(&self.api(auth, repo)?, repo, branch)
            .await
    }

    async fn create_branch(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        branch: &str,
        from_sha: &str,
    ) -> anyhow::Result<()> {
        self.github
            .create_branch(&self.api(auth, repo)?, repo, branch, from_sha)
            .await
    }

    async fn commit_files(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        base_branch: &str,
        branch: &str,
        files: &[FileToWrite],
        message: &str,
    ) -> anyhow::Result<String> {
        self.github
            .commit_files(
                &self.api(auth, repo)?,
                repo,
                base_branch,
                branch,
                files,
                message,
            )
            .await
    }

    async fn open_pull_request(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        head: &str,
        base: &str,
        title: &str,
        body: Option<&str>,
    ) -> anyhow::Result<OpenedPullRequest> {
        self.github
            .open_pull_request(&self.api(auth, repo)?, repo, head, base, title, body)
            .await
    }

    fn supports_pull_requests(&self) -> bool {
        true
    }

    async fn find_open_pull_request(
        &self,
        auth: &ConnectionAuth,
        repo: &str,
        head: &str,
        base: &str,
    ) -> anyhow::Result<Option<OpenedPullRequest>> {
        self.github
            .find_open_pull_request(&self.api(auth, repo)?, repo, head, base)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn the_address_names_one_repository_on_github() {
        assert_eq!(
            repository_of("https://github.com/constructorfabric/gears-rust").unwrap(),
            "constructorfabric/gears-rust"
        );
        assert_eq!(
            repository_of("https://github.com/constructorfabric/gears-bss.git/").unwrap(),
            "constructorfabric/gears-bss"
        );
        assert!(repository_of("https://github.com/constructorfabric").is_err());
        assert!(repository_of("https://github.com/a/b/tree/main").is_err());
        assert!(repository_of("https://gitlab.com/a/b").is_err());
    }

    #[test]
    fn the_source_id_defaults_to_the_repositorys_name_and_a_blank_ref_is_not_stored() {
        let o = normalize_options(
            "https://github.com/constructorfabric/Gears_Rust",
            &opts(&[("ref", " ")]),
        )
        .unwrap();
        assert_eq!(o, opts(&[("source_id", "gears-rust")]));
        let o = normalize_options(
            "https://github.com/constructorfabric/gears-rust",
            &opts(&[("ref", "feature/gearbox"), ("source_id", "platform-core")]),
        )
        .unwrap();
        assert_eq!(
            o,
            opts(&[("ref", "feature/gearbox"), ("source_id", "platform-core")])
        );
    }

    #[test]
    fn create_target_is_kept_only_when_true() {
        let url = "https://github.com/acme/gears";
        let o = normalize_options(url, &opts(&[("create_target", "true")])).unwrap();
        assert!(is_create_target(&o));
        let o = normalize_options(url, &opts(&[("create_target", "false")])).unwrap();
        assert!(!is_create_target(&o) && !o.contains_key("create_target"));
        assert!(normalize_options(url, &opts(&[("create_target", "yes")])).is_err());
    }

    #[test]
    fn the_connection_lends_its_token_to_its_own_repository_only() {
        let d = GearRepositoryDriver::new(reqwest::Client::new());
        let auth = ConnectionAuth {
            base_url: "https://github.com/acme/gears".into(),
            token: "t".into(),
        };
        let api = d.api(&auth, "Acme/Gears").expect("its own, in any case");
        assert_eq!(api.base_url, API);
        assert_eq!(api.token, "t");
        assert!(d.api(&auth, "acme/other").is_err());
    }

    #[test]
    fn a_source_id_is_a_directory_name_the_engine_takes() {
        for bad in ["", "Gears", "-a", "a-", "a--b", "1a", "a_b", "a/b"] {
            assert!(!is_source_id(bad), "{bad}");
        }
        assert!(is_source_id("gears-bss2"));
        assert!(
            normalize_options("https://github.com/o/r", &opts(&[("source_id", "Bad Id")])).is_err()
        );
        assert!(normalize_options("https://github.com/o/r", &opts(&[("branch", "x")])).is_err());
    }
}
