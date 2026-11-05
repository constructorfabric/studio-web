//! A project's images and charts as records (ADR-0062 §4): what a build, a
//! pipeline, an import or a promotion put into an organization's registry,
//! under the project's own path, and the rules about them that need no I/O --
//! where a reference points, what the project's path is, which records a
//! retention policy lets go, what an organization's registry holds that no
//! record explains.
//!
//! The registry itself is the truth of what is there; a record is what Studio
//! knows about how it got there. The two are compared, not merged: a record
//! whose digest the registry no longer has is `missing`, and a digest no
//! record names is an orphan.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Whether a record is an image or a chart (an OCI artifact either way).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageKind {
    Image,
    Chart,
}

impl ImageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Chart => "chart",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "image" => Some(Self::Image),
            "chart" => Some(Self::Chart),
            _ => None,
        }
    }
}

/// Where a recorded digest stands in its registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageState {
    /// In the registry, as far as Studio last knew.
    Present,
    /// The registry no longer has it, and nobody here deleted it.
    Missing,
    /// Deleted through Studio.
    Deleted,
    /// Kept past the retention policy because it runs somewhere or is pinned.
    Retained,
}

impl ImageState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Present => "present",
            Self::Missing => "missing",
            Self::Deleted => "deleted",
            Self::Retained => "retained",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "present" => Some(Self::Present),
            "missing" => Some(Self::Missing),
            "deleted" => Some(Self::Deleted),
            "retained" => Some(Self::Retained),
            _ => None,
        }
    }
}

/// One image or chart, as recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageRecord {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub project_id: Uuid,
    /// The `registry` connection it was pushed with, when Studio knows it.
    pub registry_connection_id: Option<Uuid>,
    /// `ghcr.io`.
    pub registry_host: String,
    /// `acme/shop/api`: the path under the host, without tag or digest.
    pub repository: String,
    pub tags: Vec<String>,
    /// `sha256:…`.
    pub digest: String,
    pub media_type: Option<String>,
    pub size_bytes: Option<i64>,
    /// `linux/amd64`, … when the registry said.
    pub platforms: Vec<String>,
    pub build_id: Option<String>,
    pub app: Option<String>,
    pub commit: Option<String>,
    pub description_revision: Option<i64>,
    pub lock_hash: Option<String>,
    /// The person's subject id, or `studio` for a build Studio ran.
    pub pushed_by: Option<String>,
    pub pushed_at_ms: i64,
    pub kind: ImageKind,
    pub state: ImageState,
    pub pinned: bool,
    /// The record it was copied from, for a promotion.
    pub promoted_from: Option<Uuid>,
    /// Where an imported external image came from, as asked
    /// (`docker.io/library/postgres:16`).
    pub source_ref: Option<String>,
}

impl ImageRecord {
    /// `ghcr.io/acme/shop/api@sha256:…`: how a deploy names it.
    pub fn reference(&self) -> String {
        format!("{}/{}@{}", self.registry_host, self.repository, self.digest)
    }

    /// A chart's reference as helm names it, `oci://host/repo`.
    pub fn chart_ref(&self) -> String {
        format!("oci://{}/{}", self.registry_host, self.repository)
    }
}

/// An image reference taken apart: `host/repository[:tag][@digest]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    pub host: String,
    pub repository: String,
    pub tag: Option<String>,
    pub digest: Option<String>,
}

impl Reference {
    /// Parse `reference`. A name without a registry host is Docker Hub's
    /// (`postgres:16` → `docker.io/library/postgres:16`), the way a container
    /// runtime reads it. `oci://` is dropped.
    pub fn parse(reference: &str) -> Option<Self> {
        let r = reference.trim();
        let r = r.strip_prefix("oci://").unwrap_or(r);
        if r.is_empty() || r.contains(char::is_whitespace) || r.contains("://") {
            return None;
        }
        let (rest, digest) = match r.split_once('@') {
            Some((rest, d)) => {
                if !is_digest(d) {
                    return None;
                }
                (rest, Some(d.to_owned()))
            }
            None => (r, None),
        };
        // A tag is after the last ':' that comes after the last '/', so a
        // registry port (`host:5000/x`) is not taken for one.
        let slash = rest.rfind('/');
        let (name, tag) = match rest.rfind(':') {
            Some(colon) if slash.is_none_or(|s| colon > s) => {
                (&rest[..colon], Some(rest[colon + 1..].to_owned()))
            }
            _ => (rest, None),
        };
        if tag.as_deref().is_some_and(|t| !is_tag(t)) {
            return None;
        }
        let (host, repository) = match name.split_once('/') {
            Some((h, repo)) if h.contains('.') || h.contains(':') || h == "localhost" => {
                (h.to_owned(), repo.to_owned())
            }
            Some(_) => ("docker.io".to_owned(), name.to_owned()),
            None => ("docker.io".to_owned(), format!("library/{name}")),
        };
        if repository.is_empty()
            || !repository.split('/').all(|seg| {
                !seg.is_empty()
                    && seg.bytes().all(|b| {
                        b.is_ascii_lowercase()
                            || b.is_ascii_digit()
                            || matches!(b, b'.' | b'_' | b'-')
                    })
            })
        {
            return None;
        }
        Some(Self {
            host,
            repository,
            tag,
            digest,
        })
    }

    /// Back as text.
    pub fn to_text(&self) -> String {
        let mut s = format!("{}/{}", self.host, self.repository);
        if let Some(t) = &self.tag {
            s.push(':');
            s.push_str(t);
        }
        if let Some(d) = &self.digest {
            s.push('@');
            s.push_str(d);
        }
        s
    }
}

/// `sha256:` and 64 hex digits.
pub fn is_digest(d: &str) -> bool {
    d.strip_prefix("sha256:")
        .is_some_and(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn is_tag(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 128
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !t.starts_with(['.', '-'])
}

/* ── a project's path in a registry (ADR-0062 §2) ── */

/// `ghcr.io/acme` + `shop` → `ghcr.io/acme/shop`: where every image and chart
/// of the project goes. Nothing of another project is under it, and a push
/// token minted for it reaches nothing else.
pub fn project_prefix(prefix: &str, slug: &str) -> String {
    format!("{}/{slug}", prefix.trim_end_matches('/'))
}

/// The mirror name an import takes when none is given: the source's last
/// path segment (`docker.io/library/postgres:16` → `postgres`).
pub fn default_mirror_name(source: &Reference) -> String {
    source
        .repository
        .rsplit('/')
        .next()
        .unwrap_or("image")
        .to_owned()
}

/// A mirror name a person gave: path segments of lowercase letters, digits,
/// `.`, `_`, `-`.
pub fn checked_mirror_name(name: &str) -> Result<String, String> {
    let n = name.trim().trim_matches('/').to_owned();
    let ok = !n.is_empty()
        && n.len() <= 128
        && n.split('/').all(|seg| {
            !seg.is_empty()
                && seg.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
                })
        });
    if ok {
        Ok(n)
    } else {
        Err(format!(
            "'{name}' is not an image name: lowercase letters, digits, '.', '_' and '-', in path segments"
        ))
    }
}

/// Whether `reference` is under the project's own path in the environment's
/// registry, which is all a deploy takes (ADR-0062 §4): an external image is
/// imported first.
pub fn is_under(reference: &str, project_prefix: &str) -> bool {
    let bare = reference.strip_prefix("oci://").unwrap_or(reference);
    bare.strip_prefix(project_prefix)
        .is_some_and(|rest| rest.starts_with('/'))
}

/* ── what a manifest says, as records ── */

/// The records a build's manifest makes: one per image, one for the chart.
/// `images` are `(app, host/repo:tag@digest)`; a reference without a digest
/// is skipped, since a record is a digest.
#[allow(clippy::too_many_arguments)]
pub fn from_manifest(
    organization: Uuid,
    project: Uuid,
    registry_connection: Option<Uuid>,
    build_id: &str,
    commit: Option<&str>,
    description_revision: Option<i64>,
    lock_hash: Option<&str>,
    pushed_by: &str,
    at_ms: i64,
    images: &[(String, String)],
    chart: Option<(&str, &str, Option<&str>)>,
) -> Vec<ImageRecord> {
    let base = |host: String, repository: String, digest: String, kind: ImageKind| ImageRecord {
        id: Uuid::new_v4(),
        organization_id: organization,
        project_id: project,
        registry_connection_id: registry_connection,
        registry_host: host,
        repository,
        tags: Vec::new(),
        digest,
        media_type: None,
        size_bytes: None,
        platforms: Vec::new(),
        build_id: Some(build_id.to_owned()),
        app: None,
        commit: commit.map(str::to_owned),
        description_revision,
        lock_hash: lock_hash.map(str::to_owned),
        pushed_by: Some(pushed_by.to_owned()),
        pushed_at_ms: at_ms,
        kind,
        state: ImageState::Present,
        pinned: false,
        promoted_from: None,
        source_ref: None,
    };
    let mut out = Vec::new();
    for (app, image) in images {
        let Some(r) = Reference::parse(image) else {
            continue;
        };
        let Some(digest) = r.digest.clone() else {
            continue;
        };
        let mut rec = base(r.host, r.repository, digest, ImageKind::Image);
        rec.app = Some(app.clone());
        rec.tags = r.tag.into_iter().collect();
        out.push(rec);
    }
    // `(oci://host/repo/charts/product, version, digest)`.
    if let Some((reference, version, Some(digest))) = chart
        && is_digest(digest)
        && let Some(r) = Reference::parse(reference)
    {
        let mut rec = base(r.host, r.repository, digest.to_owned(), ImageKind::Chart);
        rec.tags = vec![version.to_owned()];
        out.push(rec);
    }
    out
}

/* ── retention (ADR-0062 §4) ── */

/// How long a project's images are kept. `None` everywhere keeps them all.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Retention {
    /// Keep the newest `n` of each repository.
    pub keep_last: Option<u32>,
    /// Keep anything pushed in the last `d` days.
    pub keep_days: Option<u32>,
}

impl Retention {
    pub fn keeps_everything(&self) -> bool {
        self.keep_last.is_none() && self.keep_days.is_none()
    }
}

/// The most a retention policy may say: a year, a thousand images.
pub const MAX_KEEP_DAYS: u32 = 366;
pub const MAX_KEEP_LAST: u32 = 1000;

pub fn checked_retention(r: Retention) -> Result<Retention, String> {
    if r.keep_last.is_some_and(|n| n == 0 || n > MAX_KEEP_LAST) {
        return Err(format!("keep_last is 1 to {MAX_KEEP_LAST}"));
    }
    if r.keep_days.is_some_and(|d| d == 0 || d > MAX_KEEP_DAYS) {
        return Err(format!("keep_days is 1 to {MAX_KEEP_DAYS}"));
    }
    Ok(r)
}

/// What a sweep does with one record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sweep {
    /// Past it, but it runs somewhere or is pinned: kept, marked `retained`.
    Retain,
    /// Past it, and nothing holds it: deleted from the registry.
    Delete,
}

/// What a sweep does with each of `records` (one project's), given which
/// digests run somewhere. A record is past the policy when it is older than
/// `keep_days` AND not among the newest `keep_last` of its repository; a
/// policy that says only one of them uses that one. Deleted and missing
/// records are left alone.
pub fn sweep(
    records: &[ImageRecord],
    policy: Retention,
    running: &dyn Fn(&ImageRecord) -> bool,
    now_ms: i64,
) -> Vec<(Uuid, Sweep)> {
    if policy.keeps_everything() {
        return Vec::new();
    }
    let mut by_repo: std::collections::BTreeMap<(&str, &str), Vec<&ImageRecord>> =
        std::collections::BTreeMap::new();
    for r in records
        .iter()
        .filter(|r| matches!(r.state, ImageState::Present | ImageState::Retained))
    {
        by_repo
            .entry((r.registry_host.as_str(), r.repository.as_str()))
            .or_default()
            .push(r);
    }
    let mut out = Vec::new();
    for (_, mut list) in by_repo {
        list.sort_by_key(|r| std::cmp::Reverse(r.pushed_at_ms));
        for (i, r) in list.iter().enumerate() {
            let within_last = policy
                .keep_last
                .is_some_and(|n| i < usize::try_from(n).unwrap_or(usize::MAX));
            let within_days = policy
                .keep_days
                .is_some_and(|d| now_ms - r.pushed_at_ms < i64::from(d) * 24 * 60 * 60 * 1000);
            if within_last || within_days {
                continue;
            }
            let held = r.pinned || running(r);
            out.push((r.id, if held { Sweep::Retain } else { Sweep::Delete }));
        }
    }
    out
}

/* ── an organization's registry against the records (ADR-0062 §5) ── */

/// One version a registry holds: a digest in a repository, with its tags.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryVersion {
    pub repository: String,
    pub digest: Option<String>,
    pub tags: Vec<String>,
    pub size_bytes: Option<i64>,
    pub pushed_at: Option<String>,
}

/// Why something in a registry, or a record of it, is an orphan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrphanReason {
    /// Under no project's path: nobody here owns it.
    Unowned,
    /// Under a project's path, but no record names its digest.
    Unrecorded,
    /// Recorded, not pinned, and running nowhere.
    Undeployed,
    /// Recorded as present, and the registry does not have it.
    Missing,
}

impl OrphanReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unowned => "unowned",
            Self::Unrecorded => "unrecorded",
            Self::Undeployed => "undeployed",
            Self::Missing => "missing",
        }
    }
}

/// One orphan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Orphan {
    pub repository: String,
    pub digest: Option<String>,
    pub tags: Vec<String>,
    pub reason: OrphanReason,
    pub image_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
}

/// Compare what a registry holds under `prefix` (repositories relative to
/// the host) with the records of it. `slugs` are `(slug, project)` of the
/// organization's projects; a repository under `<prefix>/<slug>/` is that
/// project's.
pub fn orphans(
    prefix_path: &str,
    held: &[RegistryVersion],
    records: &[ImageRecord],
    slugs: &[(String, Uuid)],
    running: &dyn Fn(&ImageRecord) -> bool,
) -> Vec<Orphan> {
    let owner = |repo: &str| repository_owner(prefix_path, repo, slugs);
    let mut out = Vec::new();
    for v in held {
        let recorded = records.iter().find(|r| {
            r.repository == v.repository && v.digest.as_deref() == Some(r.digest.as_str())
        });
        match (owner(&v.repository), recorded) {
            (None, None) => out.push(Orphan {
                repository: v.repository.clone(),
                digest: v.digest.clone(),
                tags: v.tags.clone(),
                reason: OrphanReason::Unowned,
                image_id: None,
                project_id: None,
            }),
            (Some(project), None) => out.push(Orphan {
                repository: v.repository.clone(),
                digest: v.digest.clone(),
                tags: v.tags.clone(),
                reason: OrphanReason::Unrecorded,
                image_id: None,
                project_id: Some(project),
            }),
            (_, Some(r)) if !r.pinned && !running(r) => out.push(Orphan {
                repository: v.repository.clone(),
                digest: v.digest.clone(),
                tags: v.tags.clone(),
                reason: OrphanReason::Undeployed,
                image_id: Some(r.id),
                project_id: Some(r.project_id),
            }),
            _ => {}
        }
    }
    for r in records.iter().filter(|r| r.state == ImageState::Present) {
        let there = held
            .iter()
            .any(|v| v.repository == r.repository && v.digest.as_deref() == Some(&r.digest));
        if !there {
            out.push(Orphan {
                repository: r.repository.clone(),
                digest: Some(r.digest.clone()),
                tags: r.tags.clone(),
                reason: OrphanReason::Missing,
                image_id: Some(r.id),
                project_id: Some(r.project_id),
            });
        }
    }
    out
}

/// Which project a repository under `prefix_path` belongs to, by its first
/// segment after the prefix.
pub fn repository_owner(
    prefix_path: &str,
    repository: &str,
    slugs: &[(String, Uuid)],
) -> Option<Uuid> {
    let rest = repository
        .strip_prefix(prefix_path.trim_matches('/'))
        .and_then(|r| r.strip_prefix('/'))?;
    let first = rest.split('/').next()?;
    slugs.iter().find(|(s, _)| s == first).map(|(_, p)| *p)
}

/* ── where a record runs ── */

/// The releases that run now: for each project, environment and namespace,
/// the newest deployment that succeeded, when it installed (not uninstalled)
/// and, for a preview, was not removed. `list` is newest first, as the
/// history keeps it.
pub fn live_deployments(list: &[super::model::Deployment]) -> Vec<&super::model::Deployment> {
    use super::model::{DeploymentAction, DeploymentState};
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for d in list
        .iter()
        .filter(|d| d.state == DeploymentState::Succeeded)
    {
        if !seen.insert((d.project_id, d.environment_id, d.namespace.clone())) {
            continue;
        }
        let removed = d.preview.as_ref().is_some_and(|p| p.removed_at.is_some());
        if d.action == DeploymentAction::Install && !removed {
            out.push(d);
        }
    }
    out
}

/// Whether deployment `d` runs record `r`: one of its images by digest, or
/// its published chart at one of the record's versions.
pub fn runs(r: &ImageRecord, d: &super::model::Deployment) -> bool {
    match r.kind {
        ImageKind::Image => d
            .images
            .iter()
            .any(|i| i.image.ends_with(&format!("@{}", r.digest))),
        ImageKind::Chart => d
            .chart_ref
            .as_ref()
            .is_some_and(|c| c.reference == r.chart_ref() && r.tags.contains(&c.version)),
    }
}

/// The digest `chart` was pushed as, from a build's records: the chart
/// record at its reference and version.
pub fn chart_digest(records: &[ImageRecord], chart: &super::model::ChartRef) -> Option<String> {
    records
        .iter()
        .find(|r| {
            r.kind == ImageKind::Chart
                && r.chart_ref() == chart.reference
                && r.tags.contains(&chart.version)
                && is_digest(&r.digest)
        })
        .map(|r| r.digest.clone())
}

#[cfg(test)]
#[path = "images_tests.rs"]
mod tests;
