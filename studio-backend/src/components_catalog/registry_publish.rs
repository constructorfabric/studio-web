//! Publish: a registered component given to the platform (ADR-0042 §4,
//! ADR-0041 P4).
//!
//! `POST /registry/{name}/decisions` with `action: publish`, on a
//! `registered` entry, opens a pull request into the platform's gear
//! repository -- the platform's catalogue source in mode `gears`, as a
//! platform administrator saved it in the root tenant. It copies the files of
//! the directory the entry is declared in (bounded: [`MAX_FILES`] files and
//! [`MAX_BYTES`] in all, by the tree listing's sizes, refused larger) under
//! the platform's own parent directory for gears -- the one most of its
//! catalogued gears live under, else `gears/` -- on the branch
//! `contribute/<organization>/<name>`. The write goes through studio-product
//! (`product::port::GearContributions`) with the platform source's
//! connection, acting in the root tenant (`registry::in_tenant`) -- and only
//! when that source names the root's own connection. The gear's files are
//! read through the organization's own connection, never one it inherits
//! from the platform (`PublishError::NotOwnConnection`).
//!
//! `dry_run: true` ([`CatalogService::plan_publish`]) answers the target
//! repository, branch, path and files, refusing what a publish would refuse,
//! and writes and records nothing.
//!
//! The entry stays `registered` and records the `contribution`; the walk
//! makes it `published` once the platform's catalogue has a component by its
//! name (`registry::plan`), and a platform administrator may mark it so by
//! hand (`mark_published`) when the names differ.

use std::collections::BTreeMap;

use async_trait::async_trait;
use toolkit_security::SecurityContext;

use super::candidates::kebab;
use super::gts;
use super::registry::{self, Contribution, OccurrenceRecord, RegistryEntry, STATE_REGISTERED};
use super::registry_decisions::{
    Action, DecideFailure, Decider, DecisionError, DecisionInput, DecisionRecord, transition,
};
use super::service::{CatalogService, RepoSource};
use crate::product::port::{DeclarationFile, GearContributions, PullRequestText, RepositoryTarget};

/// The most files a contribution carries.
pub const MAX_FILES: usize = 200;
/// The most bytes a contribution carries, by the tree listing's sizes.
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Where the platform keeps its gears when its catalogue does not say.
pub const DEFAULT_PARENT: &str = "gears";

/// Directories never copied: build output and vendored trees.
const SKIPPED: [&str; 4] = ["target", "node_modules", ".git", "dist"];

/// Why publishing was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublishError {
    NotFound(String),
    /// Only a `registered` entry is published.
    NotRegistered {
        state: String,
    },
    /// The platform has no catalogue source in mode `gears`.
    NoPlatformRepository,
    /// Nothing declares the entry: there is no directory to give.
    NoOccurrence,
    /// The occurrence was recorded before the walk kept its connection.
    NoConnection,
    /// The walk read the gear's repository through a connection the
    /// organization only inherits (the platform's): its files are not the
    /// organization's to read with that token and give.
    NotOwnConnection {
        tenant: uuid::Uuid,
    },
    /// The platform's gear source names a connection outside the root: a
    /// contribution is written only with the platform's own.
    PlatformConnectionNotOwned {
        tenant: uuid::Uuid,
    },
    /// The directory holds no file to give.
    Empty {
        path: String,
    },
    /// The directory is larger than a contribution carries.
    TooLarge {
        files: usize,
        bytes: u64,
    },
}

impl std::fmt::Display for PublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(name) => write!(f, "the registry has no component `{name}`"),
            Self::NotRegistered { state } => write!(
                f,
                "a `{state}` entry cannot be published; register it first"
            ),
            Self::NoPlatformRepository => {
                write!(f, "the platform has no gear repository to contribute to")
            }
            Self::NoOccurrence => write!(
                f,
                "no repository declares this component, so there is nothing to give"
            ),
            Self::NoConnection => write!(
                f,
                "the registry does not know which connection reads this component's repository yet; read the project again"
            ),
            Self::NotOwnConnection { tenant } => write!(
                f,
                "the component's repository is read through a connection of tenant {tenant}, which the organization only inherits; connect the repository on the project's or the organization's Connections page and read the project again"
            ),
            Self::PlatformConnectionNotOwned { tenant } => write!(
                f,
                "the platform's gear repository names a connection of tenant {tenant}, not the platform's own; a platform administrator sets the platform's source again"
            ),
            Self::Empty { path } => write!(f, "`{path}` holds no file to give"),
            Self::TooLarge { files, bytes } => write!(
                f,
                "the component's directory holds {files} files and {bytes} bytes; a contribution carries at most {MAX_FILES} files and {MAX_BYTES} bytes"
            ),
        }
    }
}

/// A refusal by the rules, a decision refused, or a failure.
#[derive(Debug)]
pub enum PublishFailure {
    Refused(PublishError),
    Decision(DecisionError),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for PublishFailure {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

/// The files of the repository an occurrence was found in. The registry's
/// connection-backed reader in production; a table in tests.
#[async_trait]
pub trait OccurrenceFiles: Send + Sync {
    /// Every file at the occurrence's ref, with its size when known.
    async fn listing(
        &self,
        ctx: &SecurityContext,
        occ: &OccurrenceRecord,
    ) -> anyhow::Result<Vec<(String, Option<i64>)>>;

    /// The text of each path; `None` for one that is not text.
    async fn read(
        &self,
        ctx: &SecurityContext,
        occ: &OccurrenceRecord,
        paths: &[String],
    ) -> anyhow::Result<Vec<(String, Option<String>)>>;
}

/// [`OccurrenceFiles`] through the occurrence's own connection, as the walk
/// read it.
pub struct RepositoryFiles<'a>(pub &'a CatalogService);

impl RepositoryFiles<'_> {
    fn reader(&self, occ: &OccurrenceRecord) -> anyhow::Result<super::repo_enrich::RepoEnricher> {
        let connectors = self
            .0
            .connector_service()
            .ok_or_else(|| anyhow::anyhow!("no connector service is available to read the gear"))?;
        let tenant = occ
            .tenant
            .ok_or_else(|| anyhow::anyhow!("the occurrence names no tenant"))?;
        super::repo_enrich::RepoEnricher::new(
            connectors,
            tenant,
            occ.connection_id,
            occ.repo.clone(),
            occ.git_ref.clone().unwrap_or_default(),
            super::repo_enrich::RepoMode::parse("gears"),
        )
        .ok_or_else(|| anyhow::anyhow!("the occurrence names no repository"))
    }
}

#[async_trait]
impl OccurrenceFiles for RepositoryFiles<'_> {
    async fn listing(
        &self,
        ctx: &SecurityContext,
        occ: &OccurrenceRecord,
    ) -> anyhow::Result<Vec<(String, Option<i64>)>> {
        self.reader(occ)?.file_listing(ctx).await
    }

    async fn read(
        &self,
        ctx: &SecurityContext,
        occ: &OccurrenceRecord,
        paths: &[String],
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        self.reader(occ)?.read_texts(ctx, paths).await
    }
}

/// The platform's gear repository: its first catalogue source in mode
/// `gears` (a blank mode is `gears`).
pub fn platform_gear_source(sources: &[RepoSource]) -> Option<&RepoSource> {
    sources.iter().find(|s| {
        let mode = s.mode.trim();
        (mode.is_empty() || mode.eq_ignore_ascii_case("gears")) && !s.repo.trim().is_empty()
    })
}

/// The occurrence whose directory is given: one that declares the entry
/// (never a detector's finding), the organization's gear repository first,
/// then by project and path.
pub fn declaring_occurrence(entry: &RegistryEntry) -> Option<&OccurrenceRecord> {
    entry
        .occurrences
        .iter()
        .filter(|o| !o.detected())
        .min_by(|a, b| {
            b.in_organization()
                .cmp(&a.in_organization())
                .then_with(|| a.project_name.cmp(&b.project_name))
                .then_with(|| a.path.cmp(&b.path))
        })
}

/// The files under `dir` (every file when `dir` is the root), build output
/// and vendored trees left out.
pub fn files_under(listing: &[(String, Option<i64>)], dir: &str) -> Vec<(String, Option<i64>)> {
    let dir = dir.trim().trim_matches('/');
    listing
        .iter()
        .filter(|(path, _)| dir.is_empty() || path.starts_with(&format!("{dir}/")))
        .filter(|(path, _)| {
            let rel = relative(path, dir);
            !rel.split('/').any(|seg| SKIPPED.contains(&seg))
        })
        .cloned()
        .collect()
}

/// Refuse a directory larger than a contribution carries.
pub fn bounded(files: &[(String, Option<i64>)]) -> Result<(), PublishError> {
    let bytes: u64 = files
        .iter()
        .map(|(_, s)| u64::try_from(s.unwrap_or(0)).unwrap_or(0))
        .sum();
    if files.len() > MAX_FILES || bytes > MAX_BYTES {
        return Err(PublishError::TooLarge {
            files: files.len(),
            bytes,
        });
    }
    Ok(())
}

fn relative<'a>(path: &'a str, dir: &str) -> &'a str {
    if dir.is_empty() {
        path
    } else {
        path.strip_prefix(dir)
            .map(|p| p.trim_start_matches('/'))
            .unwrap_or(path)
    }
}

/// The platform's parent directory for gears: the one most of its
/// catalogued gears' directories (`repo_path`) sit in, else
/// [`DEFAULT_PARENT`]. Ties go to the shorter, then the first by name.
pub fn contribution_parent(paths: &[String]) -> String {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for path in paths {
        let path = path.trim().trim_matches('/');
        if let Some((parent, _)) = path.rsplit_once('/')
            && !parent.is_empty()
        {
            *counts.entry(parent.to_owned()).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .max_by(|(a, x), (b, y)| {
            x.cmp(y)
                .then_with(|| b.len().cmp(&a.len()))
                .then_with(|| b.cmp(a))
        })
        .map(|(p, _)| p)
        .unwrap_or_else(|| DEFAULT_PARENT.to_owned())
}

/// The branch a contribution is written on.
pub fn branch_of(organization: &str, name: &str) -> String {
    let org = kebab(organization);
    let org = if org.is_empty() {
        "organization".to_owned()
    } else {
        org
    };
    format!("contribute/{org}/{}", kebab(name))
}

/// The branch the pull request goes back to: the platform source's ref,
/// unless it names no branch.
pub fn base_of(source: &RepoSource) -> String {
    match source.git_ref.trim() {
        "" | "HEAD" => "main".to_owned(),
        r => r.trim_start_matches("refs/heads/").to_owned(),
    }
}

/// The words of a contribution: the organization, the entry, its owner and
/// capabilities, and why it is given.
pub fn contribution_text(
    organization: &str,
    entry: &RegistryEntry,
    occ: &OccurrenceRecord,
    dest: &str,
    reason: Option<&str>,
    skipped: &[String],
) -> PullRequestText {
    let e = &entry.entry;
    let owner = e
        .owner
        .as_ref()
        .map(|o| format!("{} ({})", o.name, o.kind))
        .unwrap_or_else(|| "nobody named".to_owned());
    let capabilities = if e.capabilities.is_empty() {
        "none named".to_owned()
    } else {
        e.capabilities.join(", ")
    };
    let mut body = format!(
        "**{organization}** contributes the gear `{name}` to the platform.\n\n\
         - Organization: {organization}\n\
         - Component: `{name}` ({kind}){description}\n\
         - Owner: {owner}\n\
         - Capabilities: {capabilities}\n\
         - From: `{repo}` at `{path}`{commit}\n\
         - Placed at: `{dest}`\n\n\
         Why: {reason}\n\n\
         Opened by Studio's component registry. Once this is merged, the \
         platform's catalogue lists the gear and the organization's registry \
         marks it published.",
        name = e.name,
        kind = e.kind,
        description = e
            .description
            .as_deref()
            .map(|d| format!(" -- {d}"))
            .unwrap_or_default(),
        repo = occ.repo,
        path = occ.path,
        commit = occ
            .commit
            .as_deref()
            .map(|c| format!(" (commit {c})"))
            .unwrap_or_default(),
        reason = reason.unwrap_or("no reason given"),
    );
    if !skipped.is_empty() {
        body.push_str(&format!(
            "\n\nNot copied (not text): {}",
            skipped
                .iter()
                .map(|s| format!("`{s}`"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    PullRequestText {
        message: format!("contribute: {} from {organization}", e.name),
        title: format!("Contribute {} from {organization}", e.name),
        body,
    }
}

/// What a publish writes, before it is written: a dry run's answer.
#[derive(Clone, Debug, PartialEq)]
pub struct PublishPlan {
    /// The platform's gear repository and the connection it is written
    /// through, in the root tenant.
    pub target: RepositoryTarget,
    /// `contribute/<organization>/<name>`.
    pub branch: String,
    /// Where the gear is placed in the platform's repository.
    pub path: String,
    /// The files, at their places there.
    pub files: Vec<DeclarationFile>,
    /// What is not copied (not text), relative to the gear's directory.
    pub skipped: Vec<String>,
    pub text: PullRequestText,
}

impl CatalogService {
    /// What publishing the registered entry `name` would write, and where:
    /// its declaring directory read (bounded) and placed in the platform's
    /// gear repository. Nothing is written. Every refusal of
    /// [`Self::publish_registry`] is made here.
    pub async fn plan_publish(
        &self,
        ctx: &SecurityContext,
        name: &str,
        input: &DecisionInput,
        files: &dyn OccurrenceFiles,
    ) -> Result<(RegistryEntry, PublishPlan), PublishFailure> {
        let wanted = name.trim();
        let entry = self
            .registry_entry(ctx, wanted)
            .await?
            .ok_or_else(|| PublishFailure::Refused(PublishError::NotFound(wanted.to_owned())))?;
        if transition(Action::Publish, &entry.entry.state, true).is_none()
            || entry.entry.state != STATE_REGISTERED
        {
            return Err(PublishFailure::Refused(PublishError::NotRegistered {
                state: entry.entry.state.clone(),
            }));
        }

        // The platform's gear repository, as its administrator saved it --
        // and written only through the platform's own connection, in the
        // root: a source naming any other tenant's is not the platform's.
        let pctx = platform_ctx(ctx)?;
        let sources = self.list_sources(&pctx).await?;
        let source = platform_gear_source(&sources)
            .cloned()
            .ok_or(PublishFailure::Refused(PublishError::NoPlatformRepository))?;
        if source.tenant != super::tiers::PLATFORM_TENANT {
            return Err(PublishFailure::Refused(
                PublishError::PlatformConnectionNotOwned {
                    tenant: source.tenant,
                },
            ));
        }

        // The directory to give, read as the walk read it -- and only
        // through the organization's own connection, never the platform's
        // token it inherits.
        let occ = declaring_occurrence(&entry)
            .ok_or(PublishFailure::Refused(PublishError::NoOccurrence))?
            .clone();
        let Some(occ_tenant) = occ.tenant else {
            return Err(PublishFailure::Refused(PublishError::NoConnection));
        };
        if !self
            .connection_is_organizations(ctx, occ_tenant, occ.project_id)
            .await
        {
            return Err(PublishFailure::Refused(PublishError::NotOwnConnection {
                tenant: occ_tenant,
            }));
        }
        let octx = match occ.project_id {
            Some(project_id) => registry::in_tenant(ctx, project_id)?,
            None if occ.in_organization() => ctx.clone(),
            None => return Err(PublishFailure::Refused(PublishError::NoConnection)),
        };
        let listing = files.listing(&octx, &occ).await?;
        let wanted_files = files_under(&listing, &occ.path);
        if wanted_files.is_empty() {
            return Err(PublishFailure::Refused(PublishError::Empty {
                path: occ.path.clone(),
            }));
        }
        bounded(&wanted_files).map_err(PublishFailure::Refused)?;
        let paths: Vec<String> = wanted_files.into_iter().map(|(p, _)| p).collect();
        let texts = files.read(&octx, &occ, &paths).await?;

        // Where the platform keeps its gears.
        let platform_paths: Vec<String> = self
            .sink
            .list(&pctx, Some(gts::GEAR_TYPE))
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|n| {
                n.value
                    .get("synced_from")
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(|s| s.eq_ignore_ascii_case(&source.repo))
            })
            .filter_map(|n| {
                n.value
                    .get("repo_path")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .collect();
        let dest = format!(
            "{}/{}",
            contribution_parent(&platform_paths),
            kebab(&entry.entry.name)
        );
        let src_dir = occ.path.trim().trim_matches('/').to_owned();
        let mut placed = Vec::new();
        let mut skipped = Vec::new();
        for (path, text) in texts {
            let rel = relative(&path, &src_dir).to_owned();
            match text {
                Some(content) => placed.push(DeclarationFile {
                    path: format!("{dest}/{rel}"),
                    content,
                }),
                None => skipped.push(rel),
            }
        }
        if placed.is_empty() {
            return Err(PublishFailure::Refused(PublishError::Empty {
                path: occ.path.clone(),
            }));
        }

        let org = ctx.subject_tenant_id();
        let organization = self.organization_name(ctx, org).await;
        let branch = branch_of(&organization, &entry.entry.name);
        let text = contribution_text(
            &organization,
            &entry,
            &occ,
            &dest,
            input
                .reason
                .as_deref()
                .map(str::trim)
                .filter(|r| !r.is_empty()),
            &skipped,
        );
        let target = RepositoryTarget {
            tenant: source.tenant,
            connection_id: source.connection_id,
            repo: source.repo.clone(),
            base_branch: base_of(&source),
        };
        Ok((
            entry,
            PublishPlan {
                target,
                branch,
                path: dest,
                files: placed,
                skipped,
                text,
            },
        ))
    }

    /// Publish the registered entry `name`: plan it ([`Self::plan_publish`]),
    /// open a pull request into the platform's gear repository through
    /// `contributions`, and record a `publish` decision carrying the
    /// contribution. Whether `by` may is the caller's question.
    #[allow(clippy::too_many_arguments)]
    pub async fn publish_registry(
        &self,
        ctx: &SecurityContext,
        name: &str,
        input: &DecisionInput,
        by: &Decider,
        files: &dyn OccurrenceFiles,
        contributions: &dyn GearContributions,
    ) -> Result<(RegistryEntry, Vec<DecisionRecord>), PublishFailure> {
        let (entry, plan) = self.plan_publish(ctx, name, input, files).await?;
        let pctx = platform_ctx(ctx)?;
        let written = contributions
            .contribute(&pctx, &plan.target, &plan.branch, &plan.files, &plan.text)
            .await?;
        let org = ctx.subject_tenant_id();
        tracing::info!(organization_id = %org, entry = %entry.entry.name, repo = %plan.target.repo, branch = %written.branch, pr = ?written.pr_url, files = plan.files.len(), "components-catalog: registry: a gear was contributed to the platform");

        let mut decided = input.clone();
        decided.dry_run = false;
        decided.contribution = Some(Contribution {
            repo: plan.target.repo.clone(),
            branch: written.branch,
            pr_url: written.pr_url,
            path: plan.path,
            files: plan.files.len(),
            at: registry::now(),
            by: by.id.clone(),
            by_name: by.name.clone(),
        });
        self.decide_registry(ctx, &entry.entry.name, &decided, by)
            .await
            .map_err(|e| match e {
                DecideFailure::Refused(e) => PublishFailure::Decision(e),
                DecideFailure::Failed(e) => PublishFailure::Failed(e),
            })
    }
}

/// The caller acting in the platform's (root) tenant, where its gear
/// repository's source and connection are.
fn platform_ctx(ctx: &SecurityContext) -> anyhow::Result<SecurityContext> {
    if super::tiers::is_platform(ctx) {
        Ok(ctx.clone())
    } else {
        registry::in_tenant(ctx, super::tiers::PLATFORM_TENANT)
    }
}

#[cfg(test)]
#[path = "registry_publish_tests.rs"]
mod tests;
