//! The two-level catalogue (ADR-0061).
//!
//! - **The organization's catalogue**: the sources its administrator adds,
//!   and the platform's sources, which every organization sees, cannot hide,
//!   and may hold at a version of its own -- a pin per platform source, its
//!   "platform release" ([`PlatformPin`]).
//! - **A project's catalogue**: the organization's, plus what the project's
//!   own repositories hold, found by their passports and read into the
//!   project's own tenant, so nobody outside the project sees it. A
//!   `catalog.sync` naming the project (`SyncSources::project`) reads them;
//!   the registry walk queues one when a project's repositories changed
//!   ([`project_fingerprint`]).
//! - **Publication**: a project proposes one of its components to the
//!   organization at a specific version -- a ref (tag or commit) and the
//!   passport's version -- and an organization administrator approves it
//!   ([`Publication`]). Approved, a copy of the component at that version
//!   joins the organization's catalogue; a new version is a new publication.
//!   A published artifact (crate, npm package, image) is a field for later.
//!
//! The list rules are pure and tested here; the reads and writes are
//! `CatalogService` methods below.

use std::collections::BTreeSet;

use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::gts;
use super::registry::{self, ReadRecord, RepoWalk};
use super::service::{CatalogNodeView, CatalogService, RepoSource, SyncSources, TieredNodes};
use super::tiers;

/// One platform source the organization holds at a version of its own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlatformPin {
    /// `owner/name` of the platform source.
    pub repo: String,
    /// The tag or commit it is held at.
    pub git_ref: String,
    #[serde(default)]
    pub note: Option<String>,
    pub pinned_by: String,
    #[serde(default)]
    pub pinned_by_name: Option<String>,
    /// RFC 3339.
    pub at: String,
}

/// A published artifact a publication points at (later: a crate, an npm
/// package, an image). Recorded when given; nothing builds one yet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishedArtifact {
    /// `crate`, `npm` or `image`.
    pub kind: String,
    /// `cf-studio-foo@1.2.0`, `@scope/pkg@1.2.0`, `ghcr.io/org/img@sha256:…`.
    pub reference: String,
}

/// `requested`, `approved` or `declined`.
pub const REQUESTED: &str = "requested";
pub const APPROVED: &str = "approved";
pub const DECLINED: &str = "declined";

/// A project's request to put one of its components into the
/// organization's catalogue at one version, and its answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Publication {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub project_id: Uuid,
    #[serde(default)]
    pub project_name: Option<String>,
    /// The component's node type and name in the project's catalogue.
    pub type_id: String,
    pub name: String,
    #[serde(default)]
    pub kind: Option<String>,
    /// Where it is: `owner/name` and the directory in it.
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    /// The version published: a tag or a commit.
    pub git_ref: String,
    #[serde(default)]
    pub commit: Option<String>,
    /// What its passport says its version is.
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub artifact: Option<PublishedArtifact>,
    #[serde(default)]
    pub reason: Option<String>,
    pub requested_by: String,
    #[serde(default)]
    pub requested_by_name: Option<String>,
    /// RFC 3339.
    pub at: String,
    pub state: String,
    #[serde(default)]
    pub decided_by: Option<String>,
    #[serde(default)]
    pub decided_by_name: Option<String>,
    #[serde(default)]
    pub decided_at: Option<String>,
    #[serde(default)]
    pub decline_reason: Option<String>,
}

/// Why a publication or a pin is refused, for the route's 4xx.
#[derive(Debug, PartialEq, Eq)]
pub enum LevelError {
    /// 400: what was sent does not hold.
    Invalid { field: &'static str, reason: String },
    /// 404: no such component, publication or project.
    NotFound(String),
    /// 400 failed precondition: the publication was already answered.
    Answered(String),
}

impl std::fmt::Display for LevelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid { field, reason } => write!(f, "{field}: {reason}"),
            Self::NotFound(what) => write!(f, "{what} was not found"),
            Self::Answered(state) => write!(f, "the publication is already {state}"),
        }
    }
}

/// Whether `a` and `b` name one repository.
fn same_repo(a: &str, b: &str) -> bool {
    a.trim()
        .trim_matches('/')
        .eq_ignore_ascii_case(b.trim().trim_matches('/'))
}

/// Pins once per platform source, each naming one the platform reads and a
/// ref without spaces. Answers the pins as stored, or why not.
pub fn normalize_pins(
    pins: Vec<PlatformPin>,
    platform: &[RepoSource],
) -> Result<Vec<PlatformPin>, LevelError> {
    let mut out: Vec<PlatformPin> = Vec::new();
    for mut p in pins {
        p.repo = p.repo.trim().trim_matches('/').to_owned();
        p.git_ref = p.git_ref.trim().to_owned();
        if p.git_ref.is_empty() || p.git_ref.chars().any(char::is_whitespace) {
            return Err(LevelError::Invalid {
                field: "git_ref",
                reason: format!("`{}` is not a tag or a commit", p.git_ref),
            });
        }
        if !platform.iter().any(|s| same_repo(&s.repo, &p.repo)) {
            return Err(LevelError::Invalid {
                field: "repo",
                reason: format!(
                    "`{}` is not one of the platform's sources; only those are pinned",
                    p.repo
                ),
            });
        }
        out.retain(|o| !same_repo(&o.repo, &p.repo));
        out.push(p);
    }
    out.sort_by(|a, b| a.repo.cmp(&b.repo));
    Ok(out)
}

/// Lay the organization's pins over the platform's components: each from a
/// pinned source says the version the organization holds it at
/// (`pinned_ref`). A platform component is never left out.
pub fn apply_pins(nodes: &mut [CatalogNodeView], pins: &[PlatformPin]) {
    if pins.is_empty() {
        return;
    }
    for n in nodes.iter_mut() {
        if n.value.get("tier").and_then(Value::as_str) != Some(tiers::PLATFORM) {
            continue;
        }
        let Some(from) = n.value.get("synced_from").and_then(Value::as_str) else {
            continue;
        };
        if let Some(pin) = pins.iter().find(|p| same_repo(&p.repo, from))
            && let Some(obj) = n.value.as_object_mut()
        {
            obj.insert("pinned_ref".into(), Value::String(pin.git_ref.clone()));
        }
    }
}

/// The organization's catalogue with one project's own components: each
/// project node marked `tier: project`, replacing an organization node of
/// the same type and id (the project's own copy is what it builds from).
pub fn join_project(
    org: Vec<CatalogNodeView>,
    project: Vec<CatalogNodeView>,
    project_id: Uuid,
) -> Vec<CatalogNodeView> {
    let own: BTreeSet<(String, String)> = project
        .iter()
        .map(|n| (n.type_id.clone(), n.instance_id.clone()))
        .collect();
    let mut out: Vec<CatalogNodeView> = org
        .into_iter()
        .filter(|n| !own.contains(&(n.type_id.clone(), n.instance_id.clone())))
        .collect();
    for mut n in project {
        if let Some(obj) = n.value.as_object_mut() {
            obj.insert("tier".into(), Value::String(tiers::PROJECT.to_owned()));
            obj.insert("project_id".into(), Value::String(project_id.to_string()));
        }
        out.push(n);
    }
    out
}

/// The organization's profiles with a project's own over them, by the gear
/// they profile: the project's marked `tier: project`.
pub fn join_project_profiles(org: Vec<gts::GtsNode>, own: Vec<gts::GtsNode>) -> Vec<gts::GtsNode> {
    let name = |n: &gts::GtsNode| {
        n.value
            .get("gear_name")
            .and_then(Value::as_str)
            .map(str::to_ascii_lowercase)
    };
    let mine: BTreeSet<String> = own.iter().filter_map(name).collect();
    let mut out: Vec<gts::GtsNode> = org
        .into_iter()
        .filter(|n| name(n).is_none_or(|k| !mine.contains(&k)))
        .collect();
    for mut n in own {
        if let Some(obj) = n.value.as_object_mut() {
            obj.insert("tier".into(), Value::String(tiers::PROJECT.to_owned()));
        }
        out.push(n);
    }
    out
}

/// One fingerprint for a project's repositories as the walk last read them:
/// equal while none of them changed, was added or went. `None` for a project
/// with no read repository.
pub fn project_fingerprint(reads: &[(String, ReadRecord)], project: Uuid) -> Option<String> {
    let mut parts: Vec<String> = reads
        .iter()
        .filter(|(_, r)| r.project_id == project)
        .map(|(_, r)| format!("{}\0{}", r.repo_key, r.fingerprint))
        .collect();
    if parts.is_empty() {
        return None;
    }
    parts.sort();
    Some(
        Uuid::new_v5(
            &Uuid::NAMESPACE_OID,
            format!("project-catalogue/1\n{}", parts.join("\n")).as_bytes(),
        )
        .to_string(),
    )
}

/// The project's catalogue sources: each of its repositories read for gears
/// (and own services and kits) and for FrontX packages.
pub fn project_sources(repos: &[super::service::ProjectRepo]) -> Vec<RepoSource> {
    let mut out = Vec::with_capacity(repos.len() * 2);
    for r in repos {
        for mode in ["gears", "frontx"] {
            out.push(RepoSource {
                tenant: r.tenant,
                connection_id: r.connection_id,
                repo: r.repo.clone(),
                git_ref: r.branch.clone(),
                mode: mode.to_owned(),
            });
        }
    }
    out
}

/// The node a publication puts into the organization's catalogue: the
/// project's, at the version published, marked as published from the
/// project. `synced_from` names the publication, never a repository, so no
/// sync of the organization's sources prunes it.
pub fn published_node(node: &CatalogNodeView, p: &Publication) -> gts::GtsNode {
    let mut value = node.value.clone();
    if let Some(obj) = value.as_object_mut() {
        obj.remove("tier");
        obj.remove("project_id");
        obj.insert(
            "synced_from".into(),
            Value::String(format!("publication:{}", p.id)),
        );
        obj.insert(
            "published_from".into(),
            json!({
                "publication_id": p.id,
                "project_id": p.project_id,
                "project_name": p.project_name,
                "repo": p.repo,
                "path": p.path,
                "git_ref": p.git_ref,
                "commit": p.commit,
                "version": p.version,
                "artifact": p.artifact,
                "approved_at": p.decided_at,
            }),
        );
        if let Some(v) = &p.version {
            obj.insert("version".into(), Value::String(v.clone()));
        }
    }
    gts::GtsNode {
        type_id: static_type(&node.type_id),
        instance_id: node.instance_id.clone(),
        value,
    }
}

/// The catalogue's own node type for a leaf id, so a published copy is
/// written under the type it was read as.
fn static_type(type_id: &str) -> &'static str {
    gts::ALL_NODE_TYPES
        .into_iter()
        .find(|t| *t == type_id || gts::graph_type_id(t) == type_id)
        .unwrap_or(gts::GEAR_TYPE)
}

/// What a component's passport says its version is.
pub fn passport_version(value: &Value) -> Option<String> {
    ["version", "newest_version", "max_version"]
        .iter()
        .find_map(|k| value.get(*k).and_then(Value::as_str))
        .map(str::to_owned)
}

/// The component's documents, from the repository root.
pub fn docs_of(value: &Value) -> Vec<String> {
    value
        .get("docs")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The queue with `p` answered: approved or declined, by whom and when.
pub fn answer(
    publications: &mut [Publication],
    id: Uuid,
    approve: bool,
    by: (String, Option<String>),
    at: String,
    reason: Option<String>,
) -> Result<Publication, LevelError> {
    let p = publications
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| LevelError::NotFound(format!("publication {id}")))?;
    if p.state != REQUESTED {
        return Err(LevelError::Answered(p.state.clone()));
    }
    if !approve && reason.as_deref().is_none_or(|r| r.trim().is_empty()) {
        return Err(LevelError::Invalid {
            field: "reason",
            reason: "a declined publication says why".into(),
        });
    }
    p.state = if approve { APPROVED } else { DECLINED }.to_owned();
    p.decided_by = Some(by.0);
    p.decided_by_name = by.1;
    p.decided_at = Some(at);
    p.decline_reason = if approve { None } else { reason };
    Ok(p.clone())
}

/// What a person asks a project's component be published as.
#[derive(Clone, Debug, Default)]
pub struct PublicationAsk {
    pub type_id: Option<String>,
    pub name: String,
    pub git_ref: Option<String>,
    pub commit: Option<String>,
    pub artifact: Option<PublishedArtifact>,
    pub reason: Option<String>,
}

/// A read component document: its path, where it is and its text.
#[derive(Clone, Debug)]
pub struct ComponentDoc {
    pub path: String,
    pub repo: String,
    pub git_ref: String,
    pub url: String,
    pub text: String,
    pub truncated: bool,
}

/// A document is shown up to this many bytes.
const DOC_MAX_BYTES: usize = 200 * 1024;

impl CatalogService {
    /// The organization's pins on the platform's sources.
    pub async fn platform_pins(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<PlatformPin>> {
        Ok(self.settings(ctx).await?.platform_pins)
    }

    /// The platform's sources, as the organization sees them: every one, with
    /// the ref the platform reads it at. Empty without a platform tier.
    pub async fn platform_sources_seen(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<Vec<RepoSource>> {
        if tiers::is_platform(ctx) {
            return self.list_sources(ctx).await;
        }
        match self.platform_ctx(ctx) {
            Some(pctx) => self.list_sources(&pctx).await,
            None => Ok(Vec::new()),
        }
    }

    /// Replace the organization's pins. Every pin names a platform source.
    pub async fn set_platform_pins(
        &self,
        ctx: &SecurityContext,
        pins: Vec<PlatformPin>,
    ) -> anyhow::Result<Result<Vec<PlatformPin>, LevelError>> {
        let platform = self.platform_sources_seen(ctx).await?;
        let pins = match normalize_pins(pins, &platform) {
            Ok(p) => p,
            Err(e) => return Ok(Err(e)),
        };
        let mut settings = self.settings(ctx).await?;
        settings.platform_pins = pins.clone();
        self.save_settings(ctx, settings).await?;
        Ok(Ok(pins))
    }

    pub(super) async fn save_settings(
        &self,
        ctx: &SecurityContext,
        mut settings: registry::SettingsRecord,
    ) -> anyhow::Result<()> {
        self.sink.register_types(ctx).await?;
        let org = ctx.subject_tenant_id();
        settings.organization_id = Some(org);
        self.sink
            .upsert(
                ctx,
                &[gts::registry_settings_node(
                    &org.to_string(),
                    serde_json::to_value(settings)?,
                )],
                &[],
            )
            .await
    }

    /// The organization's catalogue with its pins laid on.
    pub async fn org_catalogue(&self, ctx: &SecurityContext) -> anyhow::Result<TieredNodes> {
        let mut tiered = self.list_component_nodes_tiered(ctx).await?;
        match self.platform_pins(ctx).await {
            Ok(pins) => apply_pins(&mut tiered.nodes, &pins),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "components-catalog: the platform pins could not be read; the platform's versions are shown");
            }
        }
        Ok(tiered)
    }

    /// The project's own components, as its last sync stored them in its
    /// tenant. `pctx` acts in the project.
    pub async fn project_nodes(
        &self,
        pctx: &SecurityContext,
    ) -> anyhow::Result<Vec<CatalogNodeView>> {
        let marked: Vec<String> = self
            .list_field_schemas(pctx)
            .await?
            .into_iter()
            .filter(|s| s.component)
            .map(|s| gts::graph_type_id(&s.describes))
            .collect();
        if marked.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self.sink.list_of_types(pctx, &marked, 2000).await?.0)
    }

    /// The project's own components' profiles, as its last sync stored them.
    pub async fn project_profiles(
        &self,
        pctx: &SecurityContext,
    ) -> anyhow::Result<Vec<gts::GtsNode>> {
        self.sink.list(pctx, Some("gear_profile")).await
    }

    /// A project's catalogue: the organization's (`ctx`), and the project's
    /// own (`pctx`, acting in the project).
    pub async fn project_catalogue(
        &self,
        ctx: &SecurityContext,
        pctx: &SecurityContext,
    ) -> anyhow::Result<TieredNodes> {
        let org = self.org_catalogue(ctx).await?;
        let own = self.project_nodes(pctx).await?;
        Ok(TieredNodes {
            nodes: join_project(org.nodes, own, pctx.subject_tenant_id()),
            truncated: org.truncated,
            shadowed: org.shadowed,
        })
    }

    /// What a project's own catalogue reads: its repositories the
    /// organization owns the connections of, for gears and for FrontX, and
    /// those refused. `org_ctx` is the organization's, `pctx` the project's.
    pub async fn project_sync_sources(
        &self,
        org_ctx: &SecurityContext,
        pctx: &SecurityContext,
    ) -> anyhow::Result<(SyncSources, Vec<RepoWalk>)> {
        let project = pctx.subject_tenant_id().to_string();
        let (repos, refused) = self.project_repos(pctx, org_ctx, &project).await?;
        Ok((
            SyncSources {
                repos: project_sources(&repos),
                ..SyncSources::default()
            },
            refused,
        ))
    }

    /// Queue a sync of one project's own catalogue, in the organization's
    /// tenant and its `catalog` partition. Answers the run.
    pub async fn queue_project_sync(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> anyhow::Result<Uuid> {
        let hub = self
            .hub
            .get()
            .ok_or_else(|| anyhow!("studio-tasks is not available in this deployment"))?;
        let queue = super::registry_task::queue(hub)?;
        queue
            .enqueue(
                ctx,
                crate::tasks::sdk::NewRun {
                    tenant: ctx.subject_tenant_id(),
                    task_type: super::sync_task::TASK_TYPE,
                    payload: serde_json::to_value(SyncSources {
                        project: Some(project),
                        ..SyncSources::default()
                    })?,
                    partition_key: Some(super::registry_task::PARTITION),
                    idempotency_key: None,
                    coalesce_queued: true,
                    notify_workspace_id: None,
                },
            )
            .await
    }

    /// After a walk: queue a sync of each walked project's own catalogue
    /// whose repositories moved since its last one, and remember what each
    /// was queued at. Best effort: a project whose sync could not be queued
    /// is tried again by the next walk.
    pub(super) async fn queue_changed_project_catalogues(
        &self,
        ctx: &SecurityContext,
        projects: &[Uuid],
    ) {
        let reads = match self.sink.list(ctx, Some(gts::REGISTRY_READ_TYPE)).await {
            Ok(nodes) => registry::records::<ReadRecord>(nodes),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "components-catalog: the reads could not be listed; no project catalogue queued");
                return;
            }
        };
        let Ok(mut settings) = self.settings(ctx).await else {
            return;
        };
        let mut changed = false;
        for project in projects {
            let Some(print) = project_fingerprint(&reads, *project) else {
                continue;
            };
            if settings.project_catalogues.get(project) == Some(&print) {
                continue;
            }
            match self.queue_project_sync(ctx, *project).await {
                Ok(run) => {
                    tracing::info!(project_id = %project, %run, "components-catalog: a project's repositories moved; its catalogue is synced");
                    settings.project_catalogues.insert(*project, print);
                    changed = true;
                }
                Err(e) => {
                    tracing::warn!(project_id = %project, error = %format!("{e:#}"), "components-catalog: a project's catalogue sync could not be queued");
                }
            }
        }
        if changed && let Err(e) = self.save_settings(ctx, settings).await {
            tracing::warn!(error = %format!("{e:#}"), "components-catalog: the project catalogue fingerprints could not be stored");
        }
    }

    /// The organization's publications, newest first, optionally one
    /// project's.
    pub async fn publications(
        &self,
        ctx: &SecurityContext,
        project: Option<Uuid>,
    ) -> anyhow::Result<Vec<Publication>> {
        let mut out: Vec<Publication> = self
            .settings(ctx)
            .await?
            .publications
            .into_iter()
            .filter(|p| project.is_none_or(|id| p.project_id == id))
            .collect();
        out.sort_by(|a, b| b.at.cmp(&a.at));
        Ok(out)
    }

    /// A project asks that one of its components join the organization's
    /// catalogue at a version. `pctx` acts in the project; `by` is who asks.
    pub async fn request_publication(
        &self,
        ctx: &SecurityContext,
        pctx: &SecurityContext,
        ask: PublicationAsk,
        project_name: Option<String>,
        by: (String, Option<String>),
    ) -> anyhow::Result<Result<Publication, LevelError>> {
        let name = ask.name.trim().to_owned();
        if name.is_empty() {
            return Ok(Err(LevelError::Invalid {
                field: "name",
                reason: "names the component to publish".into(),
            }));
        }
        let own = self.project_nodes(pctx).await?;
        let Some(node) = own.iter().find(|n| {
            n.value
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|v| v.eq_ignore_ascii_case(&name))
                && ask
                    .type_id
                    .as_deref()
                    .is_none_or(|t| n.type_id == t || n.type_id == gts::graph_type_id(t))
        }) else {
            return Ok(Err(LevelError::NotFound(format!(
                "component `{name}` in the project's own catalogue"
            ))));
        };
        let git_ref = ask
            .git_ref
            .map(|r| r.trim().to_owned())
            .filter(|r| !r.is_empty())
            .or_else(|| {
                node.value
                    .get("git_ref")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "HEAD".to_owned());
        if git_ref.chars().any(char::is_whitespace) {
            return Ok(Err(LevelError::Invalid {
                field: "git_ref",
                reason: format!("`{git_ref}` is not a tag or a commit"),
            }));
        }
        let text = |k: &str| node.value.get(k).and_then(Value::as_str).map(str::to_owned);
        let p = Publication {
            id: Uuid::new_v4(),
            organization_id: ctx.subject_tenant_id(),
            project_id: pctx.subject_tenant_id(),
            project_name,
            type_id: node.type_id.clone(),
            name: text("name").unwrap_or(name),
            kind: text("kind"),
            repo: text("synced_from"),
            path: text("repo_path").or_else(|| text("passport_path")),
            git_ref,
            commit: ask.commit.filter(|c| !c.trim().is_empty()),
            version: passport_version(&node.value),
            artifact: ask.artifact,
            reason: ask.reason.filter(|r| !r.trim().is_empty()),
            requested_by: by.0,
            requested_by_name: by.1,
            at: registry::now(),
            state: REQUESTED.to_owned(),
            decided_by: None,
            decided_by_name: None,
            decided_at: None,
            decline_reason: None,
        };
        let mut settings = self.settings(ctx).await?;
        // One open request per component and project: a second replaces it.
        settings.publications.retain(|o| {
            !(o.state == REQUESTED
                && o.project_id == p.project_id
                && o.type_id == p.type_id
                && o.name.eq_ignore_ascii_case(&p.name))
        });
        settings.publications.push(p.clone());
        self.save_settings(ctx, settings).await?;
        Ok(Ok(p))
    }

    /// An organization administrator answers a publication. Approved, the
    /// project's component at the published version joins the
    /// organization's catalogue (with its profile, when it has one).
    pub async fn decide_publication(
        &self,
        ctx: &SecurityContext,
        id: Uuid,
        approve: bool,
        reason: Option<String>,
        by: (String, Option<String>),
    ) -> anyhow::Result<Result<Publication, LevelError>> {
        let mut settings = self.settings(ctx).await?;
        let p = match answer(
            &mut settings.publications,
            id,
            approve,
            by,
            registry::now(),
            reason,
        ) {
            Ok(p) => p,
            Err(e) => return Ok(Err(e)),
        };
        if approve {
            let pctx = registry::in_tenant(ctx, p.project_id)?;
            let own = self.project_nodes(&pctx).await?;
            let Some(node) = own.iter().find(|n| {
                n.type_id == p.type_id
                    && n.value
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|v| v.eq_ignore_ascii_case(&p.name))
            }) else {
                return Ok(Err(LevelError::NotFound(format!(
                    "component `{}` in project {}'s catalogue",
                    p.name, p.project_id
                ))));
            };
            let mut nodes = vec![published_node(node, &p)];
            let profiles = self
                .sink
                .list(&pctx, Some("gear_profile"))
                .await
                .unwrap_or_default();
            if let Some(profile) = profiles.into_iter().find(|n| {
                n.value
                    .get("gear_name")
                    .and_then(Value::as_str)
                    .is_some_and(|v| v.eq_ignore_ascii_case(&p.name))
            }) {
                nodes.push(profile);
            }
            self.sink.register_types(ctx).await?;
            self.sink.upsert(ctx, &nodes, &[]).await?;
        }
        self.save_settings(ctx, settings).await?;
        Ok(Ok(p))
    }

    /// One of a component's documents, read from its repository at the ref
    /// it was read at: only a path its passport (or the README rule) names.
    /// `pctx` is the project's, for a project's own component.
    pub async fn component_doc(
        &self,
        ctx: &SecurityContext,
        pctx: Option<&SecurityContext>,
        name: &str,
        path: &str,
    ) -> anyhow::Result<Result<ComponentDoc, LevelError>> {
        let nodes = match pctx {
            Some(p) => self.project_catalogue(ctx, p).await?.nodes,
            None => self.org_catalogue(ctx).await?.nodes,
        };
        let Some(node) = nodes.iter().find(|n| {
            n.value
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|v| v.eq_ignore_ascii_case(name))
        }) else {
            return Ok(Err(LevelError::NotFound(format!("component `{name}`"))));
        };
        let path = path.trim().trim_start_matches('/');
        if !docs_of(&node.value).iter().any(|d| d == path) {
            return Ok(Err(LevelError::Invalid {
                field: "path",
                reason: format!("`{path}` is not one of `{name}`'s documents"),
            }));
        }
        let Some(repo) = node
            .value
            .get("synced_from")
            .and_then(Value::as_str)
            .filter(|r| !r.starts_with("publication:"))
            .map(str::to_owned)
        else {
            return Ok(Err(LevelError::NotFound(format!(
                "a source repository for `{name}`"
            ))));
        };
        // Where to read it through: the source the catalogue read it from,
        // found by address in the tier it belongs to.
        let tier = node.value.get("tier").and_then(Value::as_str);
        let sources: Vec<RepoSource> = match (tier, pctx) {
            (Some(tiers::PROJECT), Some(p)) => self.project_sync_sources(ctx, p).await?.0.repos,
            (Some(tiers::PLATFORM), _) => self.platform_sources_seen(ctx).await?,
            _ => self.list_sources(ctx).await?,
        };
        let Some(source) = sources.into_iter().find(|s| same_repo(&s.repo, &repo)) else {
            return Ok(Err(LevelError::NotFound(format!(
                "the source `{repo}` `{name}` was read from"
            ))));
        };
        let read_ctx = match tier {
            Some(tiers::PLATFORM) => self.platform_ctx(ctx).unwrap_or_else(|| ctx.clone()),
            Some(tiers::PROJECT) => pctx.cloned().unwrap_or_else(|| ctx.clone()),
            _ => ctx.clone(),
        };
        let connectors = self
            .connector_service()
            .ok_or_else(|| anyhow!("no connector service is available to read a document"))?;
        let reader = super::repo_enrich::RepoEnricher::new(
            connectors,
            source.tenant,
            source.connection_id,
            source.repo.clone(),
            source.git_ref.clone(),
            super::repo_enrich::RepoMode::parse(&source.mode),
        )
        .ok_or_else(|| anyhow!("invalid source"))?;
        let read = reader.read_texts(&read_ctx, &[path.to_owned()]).await?;
        let Some(Some(mut text)) = read.into_iter().next().map(|(_, t)| t) else {
            return Ok(Err(LevelError::NotFound(format!(
                "`{path}` in {repo}@{}",
                reader.git_ref()
            ))));
        };
        let truncated = text.len() > DOC_MAX_BYTES;
        if truncated {
            let mut end = DOC_MAX_BYTES;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        Ok(Ok(ComponentDoc {
            url: format!("https://github.com/{repo}/blob/{}/{path}", reader.git_ref()),
            path: path.to_owned(),
            git_ref: reader.git_ref().to_owned(),
            repo,
            text,
            truncated,
        }))
    }
}

/// Every project id a walk resolved, to ask whose catalogue moved.
pub fn walked_projects(statuses: &[registry::ProjectWalk], org: Uuid) -> Vec<Uuid> {
    statuses
        .iter()
        .filter(|s| s.project_id != org && s.error.is_none())
        .map(|s| s.project_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(test)]
#[path = "catalogue_levels_tests.rs"]
mod tests;
