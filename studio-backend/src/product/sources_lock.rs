//! What a product description says about its sources, and the lock Studio
//! keeps beside each revision (ADR-0060).
//!
//! - [`sources`]: every `source(id = …, at = git(…) | path(…))` of a
//!   `product.gdl`, read by a line scan like `project_roots::describe`.
//! - [`duplicates`]: a description that names one repository twice is
//!   refused at save (§2). The GBX0105 "gear declared twice" of every Studio
//!   gear came from `studio-web` named both as a `git(...)` source and as
//!   `path("../..")`.
//! - [`SourcesLock`]: the commit of each source the description uses, taken
//!   when the revision is saved (§3). A protected environment builds only
//!   what a lock pins; a dev build takes each source's branch and records the
//!   commits it got.

use serde::{Deserialize, Serialize};

use crate::project_sources::{ProjectSource, same_repository};

/// Where a source of a description is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum At {
    /// `git(url = …, rev = …)`.
    Git { url: String, rev: String },
    /// `path("…")`, relative to the description's directory.
    Path(String),
}

/// One `source(...)` of a description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GdlSource {
    pub id: String,
    pub at: At,
}

/// The first `"…"` after `marker` in `text`.
fn quoted_after(text: &str, marker: &str) -> Option<String> {
    let at = text.find(marker)?;
    let rest = &text[at + marker.len()..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('"')?;
    rest.find('"').map(|end| rest[..end].to_owned())
}

/// Every `source(...)` declaration of `gdl`, in order. A line scan: comments
/// are skipped, and an entry it cannot read is left out (the engine still
/// reads the whole file when it checks it).
pub fn sources(gdl: &str) -> Vec<GdlSource> {
    let text: String = gdl
        .lines()
        .map(|l| l.split_once('#').map_or(l, |(code, _)| code))
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = Vec::new();
    let mut rest = text.as_str();
    while let Some(at) = rest.find("source(") {
        // `source(` inside an identifier (`frontx_source(`) is not one.
        let before = rest[..at].chars().next_back();
        rest = &rest[at + "source(".len()..];
        if before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        // The call ends at its closing parenthesis: count them.
        let mut depth = 1usize;
        let mut end = rest.len();
        for (i, c) in rest.char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let call = &rest[..end];
        let Some(id) = quoted_after(call, "id =") else {
            continue;
        };
        let at = if let Some(path) = quoted_after(call, "path(") {
            At::Path(path)
        } else if call.contains("git(") {
            let (Some(url), Some(rev)) = (quoted_after(call, "url ="), quoted_after(call, "rev ="))
            else {
                continue;
            };
            At::Git { url, rev }
        } else {
            continue;
        };
        out.push(GdlSource { id, at });
    }
    out
}

/// A `path(...)` of a description at `product_path`, as a directory of the
/// repository the description is laid in: `""` for its root, `None` for a
/// path that leaves it (`../gears-rust`, a checkout beside it).
pub fn resolve_path(product_path: &str, at: &str) -> Option<String> {
    let mut parts: Vec<&str> = product_path.split('/').filter(|s| !s.is_empty()).collect();
    parts.pop(); // the file
    for seg in at.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

/// Whether directory `a` of a repository holds `b` (or is it).
fn holds(a: &str, b: &str) -> bool {
    a.is_empty() || a == b || b.starts_with(&format!("{a}/"))
}

/// What is wrong with a description that names one repository more than
/// once (ADR-0060 §2), one sentence each; empty when nothing is. `home_url`
/// is the clone URL of the repository the description is laid in, where its
/// `path(...)` sources are.
///
/// - Two `git(...)` sources of one repository.
/// - A `git(...)` source of the home repository beside a `path(...)` inside
///   it.
/// - Two `path(...)` sources one of which holds the other: the engine finds
///   the inner one's gears twice. Two side by side (`studio-backend`,
///   `docs`) are two directories, and stand.
pub fn duplicates(
    sources: &[GdlSource],
    product_path: &str,
    home_url: Option<&str>,
) -> Vec<String> {
    let mut out = Vec::new();
    let gits: Vec<(&str, &str)> = sources
        .iter()
        .filter_map(|s| match &s.at {
            At::Git { url, .. } => Some((s.id.as_str(), url.as_str())),
            At::Path(_) => None,
        })
        .collect();
    let paths: Vec<(&str, String)> = sources
        .iter()
        .filter_map(|s| match &s.at {
            At::Path(p) => resolve_path(product_path, p).map(|d| (s.id.as_str(), d)),
            At::Git { .. } => None,
        })
        .collect();
    for (i, (a, ua)) in gits.iter().enumerate() {
        for (b, ub) in &gits[i + 1..] {
            if same_repository(ua, ub) {
                out.push(format!(
                    "sources `{a}` and `{b}` both name the repository {ua}: one repository is one source"
                ));
            }
        }
        if let (Some(home), Some((p, _))) = (home_url, paths.first())
            && same_repository(ua, home)
        {
            out.push(format!(
                "source `{a}` names the project's repository {ua} by git, and `{p}` names it by path: \
                 one repository is one source -- keep the `path(...)` one"
            ));
        }
    }
    for (i, (a, da)) in paths.iter().enumerate() {
        for (b, db) in &paths[i + 1..] {
            if holds(da, db) || holds(db, da) {
                let (outer, inner) = if holds(da, db) { (a, b) } else { (b, a) };
                out.push(format!(
                    "source `{outer}` holds source `{inner}`: the gears in `{inner}` would be \
                     declared twice (GBX0105) -- one repository is one source"
                ));
            }
        }
    }
    out
}

/// A save refused because its description names one repository twice
/// (ADR-0060 §2): what is wrong, one sentence each.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OneRepositoryTwice(pub Vec<String>);

impl std::fmt::Display for OneRepositoryTwice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0.join("; "))
    }
}

impl std::error::Error for OneRepositoryTwice {}

/// One source of a description as its revision pins it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockedSource {
    /// The source's id in the description.
    pub id: String,
    /// `path` or `git`.
    pub kind: String,
    /// `owner/name` of the project source it is, when it is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// Its clone URL: the project source's, or the description's own.
    pub url: String,
    /// The branch a dev build takes it at: the project source's branch, or
    /// the description's `rev` for a source that is not the project's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The commit pinned at save; `None` when it could not be read then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// The lock of one revision: its sources, each at a commit.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourcesLock {
    pub sources: Vec<LockedSource>,
}

impl SourcesLock {
    /// Whether every source is pinned to a commit: what a protected
    /// environment builds.
    pub fn complete(&self) -> bool {
        !self.sources.is_empty() && self.sources.iter().all(|s| s.commit.is_some())
    }
}

#[cfg(test)]
impl SourcesLock {
    /// The pinned commit of source `id`.
    pub fn commit_of(&self, id: &str) -> Option<&str> {
        self.sources
            .iter()
            .find(|s| s.id == id)
            .and_then(|s| s.commit.as_deref())
    }
}

/// A full commit id: 40 (SHA-1) or 64 (SHA-256) hex digits.
pub fn is_commit(rev: &str) -> bool {
    matches!(rev.len(), 40 | 64) && rev.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Which project source each description source is, and the branch it is
/// built at in dev, before any commit is read. A `path(...)` inside the
/// home repository is `home`; a `git(...)` of a project's repository is that
/// source; any other `git(...)` is the description's own, at its `rev` --
/// pinned already when the `rev` is a commit.
pub fn plan(
    sources: &[GdlSource],
    product_path: &str,
    project: &[ProjectSource],
    home: Option<&ProjectSource>,
) -> Vec<(LockedSource, Option<ProjectSource>)> {
    sources
        .iter()
        .filter_map(|s| match &s.at {
            At::Path(p) => {
                // A path beside the repository is a desktop's checkout, which a
                // server has none of: not the project's to pin.
                resolve_path(product_path, p)?;
                let home = home?;
                Some((
                    LockedSource {
                        id: s.id.clone(),
                        kind: "path".into(),
                        repository: Some(home.full_path.clone()),
                        url: home.clone_url.clone(),
                        branch: home.branch.clone(),
                        commit: None,
                    },
                    Some(home.clone()),
                ))
            }
            At::Git { url, rev } => {
                let own = crate::project_sources::source_for_url(project, url);
                Some(match own {
                    Some(p) => (
                        LockedSource {
                            id: s.id.clone(),
                            kind: "git".into(),
                            repository: Some(p.full_path.clone()),
                            url: p.clone_url.clone(),
                            branch: p.branch.clone(),
                            commit: None,
                        },
                        Some(p.clone()),
                    ),
                    None => (
                        LockedSource {
                            id: s.id.clone(),
                            kind: "git".into(),
                            repository: None,
                            url: url.clone(),
                            branch: (!is_commit(rev)).then(|| rev.clone()),
                            commit: is_commit(rev).then(|| rev.clone()),
                        },
                        None,
                    ),
                })
            }
        })
        .collect()
}

/// How a build takes each project source (ADR-0060 §3).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceRefs {
    /// The ref the home repository is cloned at.
    pub home: Option<String>,
    /// `(description source id, ref)` for each `git(...)` source that is a
    /// project's repository: fetched at this ref instead of the `rev` the
    /// description names.
    pub git: Vec<(String, String)>,
}

/// The refs a build takes: a dev build each project source's branch, a
/// protected one the lock's commits. `Err` names what a protected build is
/// missing.
pub fn build_refs(
    lock: Option<&SourcesLock>,
    planned: &[LockedSource],
    protected: bool,
) -> Result<SourceRefs, String> {
    let mut refs = SourceRefs {
        home: None,
        git: Vec::new(),
    };
    if protected {
        let lock = lock.ok_or_else(|| {
            "a protected environment builds only what a revision pins, and this revision pins \
             nothing: save the description again so Studio records each source's commit"
                .to_owned()
        })?;
        for s in lock.sources.iter().filter(|s| s.repository.is_some()) {
            let commit = s.commit.clone().ok_or_else(|| {
                format!(
                    "the revision pins no commit of source `{}` ({}): save the description again",
                    s.id,
                    s.repository.as_deref().unwrap_or(&s.url)
                )
            })?;
            match s.kind.as_str() {
                "path" => refs.home = Some(commit),
                _ => refs.git.push((s.id.clone(), commit)),
            }
        }
        return Ok(refs);
    }
    for s in planned.iter().filter(|s| s.repository.is_some()) {
        let Some(branch) = s.branch.clone() else {
            continue;
        };
        match s.kind.as_str() {
            "path" => refs.home = Some(branch),
            _ => refs.git.push((s.id.clone(), branch)),
        }
    }
    Ok(refs)
}

#[cfg(test)]
#[path = "sources_lock_tests.rs"]
mod tests;
