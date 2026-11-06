//! A project's repositories: one record, `project.config` `sources[]`.
//!
//! The portal's project wizard writes each repository a project is made of as
//!
//! ```json
//! { "connection_id": "<uuid>", "full_path": "acme/api",
//!   "clone_url": "https://github.com/acme/api.git", "branch": "main",
//!   "share_mode": "pull_request" }
//! ```
//!
//! under the project's own tenant. Everything that asks "which repositories
//! does this project have" reads it through this module: the IDE session
//! (what to clone), the Git proxy (what a desktop may clone), the components
//! catalogue (whose dependencies to read), documents (which checkout to read)
//! and the push refresh (what to sync). The prototype's older record, the
//! workspace settings' `repos[]`, is no longer one of them; `backfill` moves
//! what it held into this one.
//!
//! The directory a source is checked out into is not stored. It is derived
//! from `full_path` here exactly as the portal derives it
//! (`checkoutDirectory`), so "open this file in the editor" and the clone
//! agree on where the file is.
//!
//! Two flags say what a source is for besides being cloned (ADR-0060):
//!
//! - `gears_here`: "Create a gear" puts new gears here. It is what the
//!   separate project gear repository (`project_gear_repo`) used to be;
//!   [`fold_gear_repo`] moves an old record into the list.
//! - `publish_here`: a product description published to the repository
//!   (ADR-0053 §3) goes here. Without one, Studio keeps the revisions only.
//!
//! Neither decides what a build clones: a build clones every source its
//! product uses ([`description_home`] for the `path(...)` ones).
//!
//! `share_mode` is how the IDE's "Share with the team" lands a person's edits
//! in that repository: `branch` commits and pushes to the working branch,
//! `pull_request` pushes to the person's own branch and opens a pull request
//! into it. Absent, or anything else, is `branch` — what every project did
//! before the choice existed.

use std::collections::HashSet;

use account_management_sdk::AccountManagementClient;
use gts::GtsTypeId;
use serde_json::Value;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::connectors::sdk::{check_owned, connection_by_id, holder_of_row};
use crate::git_proxy::sources::Source;

/// Project attributes, including the repositories it is made of.
pub const PROJECT_CONFIG_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~";

/// A connection whose token only its owner may use. Its repositories are still
/// the project's, but a session several people share must not clone them with
/// one person's credential.
pub const PERSONAL_SCOPE: &str = "personal";

/// The directory name for a source whose `full_path` has no last segment.
const FALLBACK_DIR: &str = "source";

/// How "Share with the team" lands edits in a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ShareMode {
    /// Commit and push to the working branch.
    #[default]
    Branch,
    /// Push to a per-person branch and open a pull request into the working
    /// branch.
    PullRequest,
}

impl ShareMode {
    /// `"pull_request"` is the one value with a meaning of its own; anything
    /// else, absent included, is [`ShareMode::Branch`].
    pub fn parse(raw: Option<&str>) -> Self {
        match raw {
            Some("pull_request") => Self::PullRequest,
            _ => Self::Branch,
        }
    }

    /// The value as the project config spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Branch => "branch",
            Self::PullRequest => "pull_request",
        }
    }
}

/// One repository of a project.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProjectSource {
    /// The connection it is read through. `None` when the entry names none or
    /// names it unreadably: it is still cloned, without credentials.
    pub connection_id: Option<Uuid>,
    /// `owner/repo` (or a GitLab group path) on the provider.
    pub full_path: String,
    pub clone_url: String,
    /// The branch to check out; the repository's default when absent.
    pub branch: Option<String>,
    /// The directory under the workspace root it is checked out into.
    pub dir: String,
    /// How "Share with the team" lands edits here.
    pub share_mode: ShareMode,
    /// "Create a gear" puts new gears here.
    pub gears_here: bool,
    /// A published `product.gdl` goes here.
    pub publish_here: bool,
}

fn flag(entry: &Value, key: &str) -> bool {
    entry.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn text<'a>(entry: &'a Value, key: &str) -> Option<&'a str> {
    entry
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// `acme/Studio.Web` → `studio-web`: the last segment, lower case, anything
/// outside `[a-z0-9_-]` replaced by `-`.
pub fn checkout_dir(full_path: &str) -> String {
    let last = full_path.split('/').rfind(|s| !s.is_empty()).unwrap_or("");
    let dir: String = last
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if dir.is_empty() {
        FALLBACK_DIR.to_owned()
    } else {
        dir
    }
}

/// The `sources` of a project config, in order, each with its directory.
///
/// An entry without a `clone_url` has nothing to clone and is left out, and it
/// takes no directory: a second source with the same last segment is `-2`,
/// `-3`… in the order they are listed, the same suffixes the portal gives.
pub fn parse(config: &Value) -> Vec<ProjectSource> {
    let entries = config
        .get("sources")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut taken = HashSet::new();
    let mut out = Vec::new();
    for entry in entries {
        let Some(clone_url) = text(entry, "clone_url") else {
            continue;
        };
        let full_path = text(entry, "full_path").unwrap_or("");
        let base = checkout_dir(full_path);
        let mut dir = base.clone();
        let mut suffix = 2;
        while !taken.insert(dir.clone()) {
            dir = format!("{base}-{suffix}");
            suffix += 1;
        }
        out.push(ProjectSource {
            connection_id: text(entry, "connection_id").and_then(|id| Uuid::parse_str(id).ok()),
            full_path: full_path.to_owned(),
            clone_url: clone_url.to_owned(),
            branch: text(entry, "branch").map(str::to_owned),
            dir,
            share_mode: ShareMode::parse(text(entry, "share_mode")),
            gears_here: flag(entry, "gears_here"),
            publish_here: flag(entry, "publish_here"),
        });
    }
    out
}

/// A clone URL reduced to what names the repository: host and path, without
/// the scheme, credentials, a trailing slash or `.git`, in lower case.
fn repository_key(url: &str) -> Option<String> {
    let (_, rest) = url.trim().split_once("://")?;
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let path = path.trim_end_matches('/');
    let path = path
        .strip_suffix(".git")
        .unwrap_or(path)
        .trim_end_matches('/');
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{host}/{path}").to_ascii_lowercase())
}

/// Whether two clone URLs name the same repository: what differs between a
/// URL somebody pasted and the one the provider answered with does not count.
pub fn same_repository(a: &str, b: &str) -> bool {
    match (repository_key(a), repository_key(b)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// The source the product's description travels with: the one marked
/// `publish_here`, else the first read through a connection, else the first.
/// A `path(...)` source of the description resolves inside it, and a build
/// lays the description in its checkout. `None` for a project with no
/// sources.
pub fn description_home(sources: &[ProjectSource]) -> Option<&ProjectSource> {
    sources
        .iter()
        .find(|s| s.publish_here)
        .or_else(|| sources.iter().find(|s| s.connection_id.is_some()))
        .or_else(|| sources.first())
}

/// The source a published description goes to: only the one marked
/// `publish_here`. `None` keeps the revisions in Studio alone.
pub fn publish_source(sources: &[ProjectSource]) -> Option<&ProjectSource> {
    sources.iter().find(|s| s.publish_here)
}

/// The source "Create a gear" writes into: the one marked `gears_here`.
pub fn gears_source(sources: &[ProjectSource]) -> Option<&ProjectSource> {
    sources.iter().find(|s| s.gears_here)
}

/// The source whose clone URL names the repository `url` names.
pub fn source_for_url<'a>(sources: &'a [ProjectSource], url: &str) -> Option<&'a ProjectSource> {
    sources.iter().find(|s| same_repository(&s.clone_url, url))
}

/// A project gear repository as it was recorded before it became a source
/// (`project_gear_repo`: `{tenant, connection_id, repo, branch}`), folded
/// into `config`'s `sources[]` as the source marked `gears_here`.
///
/// The source that is that repository already takes the flag; otherwise the
/// repository is appended, with `clone_url` on `host` (GitHub when the
/// connection's host is not known). Idempotent: a config with a `gears_here`
/// source already is left as it is. `true` when `config` changed.
pub fn fold_gear_repo(config: &mut Value, gear_repo: &Value, host: Option<&str>) -> bool {
    let Some(repo) = text(gear_repo, "repo").map(str::to_owned) else {
        return false;
    };
    if !config.is_object() {
        *config = Value::Object(serde_json::Map::new());
    }
    let Some(obj) = config.as_object_mut() else {
        return false;
    };
    let sources = obj
        .entry("sources")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !sources.is_array() {
        *sources = Value::Array(Vec::new());
    }
    let Some(list) = sources.as_array_mut() else {
        return false;
    };
    if list.iter().any(|e| flag(e, "gears_here")) {
        return false;
    }
    let host = host
        .map(|h| h.trim().trim_end_matches('/'))
        .filter(|h| !h.is_empty())
        .unwrap_or("https://github.com");
    let url = format!("{host}/{repo}.git");
    let same = |e: &Value| {
        text(e, "clone_url").is_some_and(|u| same_repository(u, &url))
            || text(e, "full_path").is_some_and(|p| p.eq_ignore_ascii_case(&repo))
    };
    if let Some(entry) = list.iter_mut().find(|e| same(e)) {
        if let Some(e) = entry.as_object_mut() {
            e.insert("gears_here".into(), Value::Bool(true));
        }
        return true;
    }
    let mut entry = serde_json::Map::new();
    if let Some(c) = text(gear_repo, "connection_id") {
        entry.insert("connection_id".into(), Value::String(c.to_owned()));
    }
    entry.insert("full_path".into(), Value::String(repo));
    entry.insert("clone_url".into(), Value::String(url));
    if let Some(b) = text(gear_repo, "branch") {
        entry.insert("branch".into(), Value::String(b.to_owned()));
    }
    entry.insert("gears_here".into(), Value::Bool(true));
    entry.insert(
        "folded_from".into(),
        Value::String("project_gear_repo".into()),
    );
    list.push(Value::Object(entry));
    true
}

/// Make `repo` (`{connection_id, repo, branch}`, cloned from `url`) the
/// source marked `gears_here`: the flag moves to it, and it is added to the
/// sources when it is not one. Always a change.
pub fn set_gears_here(config: &mut Value, repo: &Value, url: &str, host: Option<&str>) -> bool {
    if !mark_only(config, "gears_here", Some(url)) {
        mark_only(config, "gears_here", None);
        fold_gear_repo(config, repo, host);
    }
    true
}

/// Mark the source of `config` that is `url`'s repository with `key`, and
/// clear it on every other: one source carries each flag. `false` when no
/// source is that repository.
pub fn mark_only(config: &mut Value, key: &str, url: Option<&str>) -> bool {
    let Some(list) = config.get_mut("sources").and_then(Value::as_array_mut) else {
        return url.is_none();
    };
    let mut found = url.is_none();
    for entry in list.iter_mut() {
        let this =
            url.is_some_and(|u| text(entry, "clone_url").is_some_and(|c| same_repository(c, u)));
        found |= this;
        if let Some(e) = entry.as_object_mut() {
            if this {
                e.insert(key.into(), Value::Bool(true));
            } else {
                e.remove(key);
            }
        }
    }
    found
}

/// The project's sources, read under the caller's identity. `None` when its
/// config is not there or not visible to the caller (account-management
/// answers both as not found); a config that could not be read for any other
/// reason is `None` too, and logged with its cause. A reader that must tell
/// the two apart -- an unreadable config is not "no sources" -- asks
/// [`read_checked`].
pub async fn read(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    project: Uuid,
) -> Option<Vec<ProjectSource>> {
    match read_checked(am, ctx, project).await {
        Ok(sources) => sources,
        Err(reason) => {
            tracing::warn!(project_id = %project, %reason, "project sources: the project's config could not be read");
            None
        }
    }
}

/// What a reader names as the source that could not be read when the
/// project's config itself, its list of sources, could not be.
pub const CONFIG_SOURCE: &str = "project config";

/// The project's sources, read under the caller's identity: `Ok(None)` when
/// it has no config the caller sees, `Err` with the reason when its config
/// could not be read.
pub async fn read_checked(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    project: Uuid,
) -> Result<Option<Vec<ProjectSource>>, String> {
    sources_of(
        am.get_metadata(ctx, project, GtsTypeId::new(PROJECT_CONFIG_TYPE))
            .await
            .map(|entry| entry.value),
    )
}

/// What a read of `project.config` says of the sources: not found is no
/// config; any other failure is a reason, never "no sources".
fn sources_of(
    read: Result<Value, toolkit_canonical_errors::CanonicalError>,
) -> Result<Option<Vec<ProjectSource>>, String> {
    match read {
        Ok(value) => Ok(Some(parse(&value))),
        Err(toolkit_canonical_errors::CanonicalError::NotFound { .. }) => Ok(None),
        Err(e) => Err(format!("the project's config could not be read: {e}")),
    }
}

/// Every repository the project's config names, as `owner/name` paths: its
/// sources (path and clone url), the git url it was seeded from, and the
/// repository its build runs in. A project working on a fork names the fork
/// as its source and the upstream as `source_git_url`; analytics keyed by
/// repository (Insight) hold the upstream, so a reader asking about the
/// project's work wants both.
pub fn repositories(config: &Value) -> Vec<String> {
    let str_at = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let mut out: Vec<String> = Vec::new();
    for s in parse(config) {
        out.push(s.full_path);
        out.extend(url_path(&s.clone_url));
    }
    out.extend(str_at(config, "source_git_url").and_then(|u| url_path(&u)));
    out.extend(config.get("build").and_then(|b| str_at(b, "repo")));
    let mut seen = HashSet::new();
    out.into_iter()
        .map(|r| r.trim().trim_matches('/').to_ascii_lowercase())
        .filter(|r| r.contains('/') && seen.insert(r.clone()))
        .collect()
}

/// The `owner/name` path of a git url: `https://host/owner/name(.git)` or
/// `git@host:owner/name(.git)`. `None` for anything without a path.
fn url_path(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = if let Some((_, after)) = url.split_once("://") {
        after.split_once('/')?.1
    } else {
        url.split_once(':')?.1
    };
    let path = rest.split(['?', '#']).next()?.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    path.contains('/').then(|| path.to_owned())
}

/// The repositories the project is made of ([`repositories`]), read under the
/// caller's identity. `None` when its config cannot be read.
pub async fn read_repositories(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    project: Uuid,
) -> Option<Vec<String>> {
    let entry = am
        .get_metadata(ctx, project, GtsTypeId::new(PROJECT_CONFIG_TYPE))
        .await
        .ok()?;
    Some(repositories(&entry.value))
}

/// The workflow that builds the project's product (ADR-0045): `build` in
/// `project.config`, `{ "repo": "acme/api", "workflow": "build.yml" }`, set
/// from the project's Builds tab. Build starts it, and the tab speaks of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildWorkflow {
    pub repo: String,
    pub workflow: String,
}

/// The project's build workflow, when its config names one in full.
pub fn build_workflow(config: &Value) -> Option<BuildWorkflow> {
    let build = config.get("build")?;
    Some(BuildWorkflow {
        repo: text(build, "repo")?.to_owned(),
        workflow: text(build, "workflow")?.to_owned(),
    })
}

/// The project's config as it is stored, read under the caller's identity.
/// `None` when it cannot be read, as [`read`].
pub async fn read_config(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    project: Uuid,
) -> Option<Value> {
    am.get_metadata(ctx, project, GtsTypeId::new(PROJECT_CONFIG_TYPE))
        .await
        .ok()
        .map(|entry| entry.value)
}

/// Change the project's config as `ctx` and write it back, version-checked so
/// a concurrent writer is not lost: `change` answers whether it changed
/// anything, and nothing is written when it did not. `Ok(false)` when there
/// was nothing to change.
pub async fn update_config(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    project: Uuid,
    mut change: impl FnMut(&mut Value) -> bool,
) -> anyhow::Result<bool> {
    let mut last = None;
    for _ in 0..3 {
        let (mut value, version) = match am
            .get_metadata(ctx, project, GtsTypeId::new(PROJECT_CONFIG_TYPE))
            .await
        {
            Ok(entry) => (entry.value, entry.version),
            Err(e) => return Err(anyhow::anyhow!("the project's config cannot be read: {e}")),
        };
        if !change(&mut value) {
            return Ok(false);
        }
        let mut request = account_management_sdk::UpsertMetadataRequest::new(
            GtsTypeId::new(PROJECT_CONFIG_TYPE),
            value,
        );
        if version > 0 {
            request = request.with_expected_version(version);
        }
        match am.upsert_metadata(ctx, project, request).await {
            Ok(_) => return Ok(true),
            Err(e) => last = Some(e.to_string()),
        }
    }
    Err(anyhow::anyhow!(
        "the project's config could not be written: {}",
        last.unwrap_or_default()
    ))
}

/// A source with what its connection says about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub source: ProjectSource,
    /// The connection's credstore reference, when the connection is found
    /// from this project. It also keys the server's synced clone.
    pub secret_ref: Option<String>,
    /// The connection is one person's: its token is theirs alone.
    pub personal: bool,
    /// The tenant whose catalogue row holds the connection -- possibly
    /// above the project, which sees its ancestors' connections.
    pub holder: Option<Uuid>,
    /// Set by [`git_sources`] when that holder is outside the project's
    /// organization (the platform's root, another organization): the
    /// connection is not the organization's to clone or push with
    /// (`cpt-studio-constraint-connector-own-connections`).
    pub held_outside: Option<Uuid>,
}

/// The project's sources, each with its connection's reference.
pub async fn resolve(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    project: Uuid,
) -> Option<Vec<Resolved>> {
    let sources = read(am, ctx, project).await?;
    // Each lookup walks the catalogue up from the project, and they do not
    // depend on one another: asked together, a project of several sources
    // waits for one walk rather than one per source. `join_all` keeps the
    // sources' order.
    let lookups = futures_util::future::join_all(sources.iter().map(|source| async move {
        match source.connection_id {
            Some(id) => connection_by_id(am, ctx, project, id).await,
            None => None,
        }
    }))
    .await;
    let mut out = Vec::with_capacity(sources.len());
    for (source, found) in sources.into_iter().zip(lookups) {
        let holder = found.as_ref().map(|(at, c)| holder_of_row(c, *at));
        let connection = found.map(|(_, c)| c);
        out.push(Resolved {
            secret_ref: connection.as_ref().map(|c| c.secret_ref.clone()),
            personal: connection
                .as_ref()
                .is_some_and(|c| c.scope == PERSONAL_SCOPE),
            holder,
            held_outside: None,
            source,
        });
    }
    Some(out)
}

/// A resolved source as a Git source to clone: named by its directory, with
/// the connection's token reference — unless the connection is personal,
/// whose token a session several people share must not carry, or held
/// outside the project's organization, whose token is not the
/// organization's to use.
pub fn to_git_source(resolved: Resolved) -> Source {
    let lends = !resolved.personal && resolved.held_outside.is_none();
    Source {
        name: resolved.source.dir,
        url: resolved.source.clone_url,
        branch: resolved.source.branch,
        target: None,
        token_ref: resolved.secret_ref.filter(|_| lends),
        held_outside: resolved.held_outside,
    }
}

/// The project's sources as Git sources to clone (see [`to_git_source`]).
/// A source whose connection is held outside the project's organization
/// carries no token and says whose it was ([`Source::held_outside`]).
pub async fn git_sources(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    project: Uuid,
) -> Option<Vec<Source>> {
    let mut resolved = resolve(am, ctx, project).await?;
    for r in &mut resolved {
        if let Some(holder) = r.holder
            && let Err(refused) = check_owned(am, ctx, project, project, Some(holder)).await
        {
            tracing::warn!(%project, repo = %r.source.full_path, holder = %refused.holder, "a project source's connection is held outside its organization; its token is not used");
            r.held_outside = Some(refused.holder);
        }
    }
    Some(resolved.into_iter().map(to_git_source).collect())
}

#[path = "project_sources_mcp.rs"]
mod mcp;
pub(crate) use mcp::tools as mcp_tools;

#[cfg(test)]
#[path = "project_sources_tests.rs"]
mod tests;
