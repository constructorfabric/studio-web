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
#[derive(Debug, Clone, PartialEq, Eq)]
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

/// The project's sources, read under the caller's identity. `None` when its
/// config cannot be read — not there, or not visible to the caller, which
/// account-management does not tell apart and neither does this.
pub async fn read(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    project: Uuid,
) -> Option<Vec<ProjectSource>> {
    let entry = am
        .get_metadata(ctx, project, GtsTypeId::new(PROJECT_CONFIG_TYPE))
        .await
        .ok()?;
    Some(parse(&entry.value))
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
    let mut out = Vec::with_capacity(sources.len());
    for source in sources {
        let found = match source.connection_id {
            Some(id) => connection_by_id(am, ctx, project, id).await,
            None => None,
        };
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

#[cfg(test)]
#[path = "project_sources_tests.rs"]
mod tests;
