//! REST surface for the gears catalog.
//!
//! `POST /studio-components-catalog/v1/sync` enqueues a background sync of the
//! crates.io keyword into the graph and answers `202` with a `run_id`.
//! `GET /gears` and `GET /versions` read the catalog back.
//!
//! The sync is a `catalog.sync` run on `studio-tasks`, so
//! `GET /studio-tasks/v1/runs/{run_id}` is how it is polled; its
//! `result` carries the gear, version and stored counts as they tick up.

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::http::HeaderMap;
use axum::{Extension, Router};
use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;

use super::reference::ComponentReferenceListDto;
use super::roadmap::{RoadmapFields, RoadmapSource};
use super::service::{CatalogService, RepoSource, SyncSources};
use super::sync_task::TASK_TYPE;
use crate::org_scope::OrgCtx;
use crate::product::sdk::Gearbox;
use uuid::Uuid;

/// Errors attributable to a components-catalog resource (e.g. an unknown task).
#[resource_error(gts_id!("cf.studio._.components_catalog.v1~"))]
pub struct StudioComponentsCatalogError;

/// Service handle, injected into the handlers.
#[derive(Clone)]
pub struct Catalog {
    pub service: Arc<CatalogService>,
    /// Resolved per request rather than held: a sync is a run now, and both the
    /// enqueue and the poll endpoint read through here — lazily, so this gear
    /// does not care whether `studio-tasks` initialized first.
    hub: Arc<ClientHub>,
    /// Product previews; `None` when no corpus workdir is configured.
    gearbox: Option<Arc<Gearbox>>,
    /// What the components reference reuses between requests.
    reference: Arc<ReferenceCache>,
    /// `/activity` answers by tenant, window and comparison.
    activity: Arc<super::memo::Memo<ActivityKey, GearActivityListDto>>,
}

/// Whose `/activity` answer, over which window, with or without the previous
/// window: every query parameter the answer depends on.
type ActivityKey = (Uuid, u32, bool);

impl Catalog {
    pub fn new(
        service: Arc<CatalogService>,
        hub: Arc<ClientHub>,
        gearbox: Option<Arc<Gearbox>>,
    ) -> Self {
        Self {
            service,
            hub,
            gearbox,
            reference: Arc::new(ReferenceCache::default()),
            activity: Arc::new(super::memo::Memo::new(ACTIVITY_TTL, 256)),
        }
    }

    /// The delivery seam into studio-insight, resolved per request.
    ///
    /// Lazily like the queue, and for the same reason: this gear must not care
    /// which gear initialized first. Absent when studio-insight is not part of
    /// the assembly, which is a 503 rather than an empty chart — a screen that
    /// cannot ask must not draw zeros.
    fn delivery(&self) -> ApiResult<Arc<dyn crate::insight::port::ComponentDelivery>> {
        self.hub
            .get::<dyn crate::insight::port::ComponentDelivery>()
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "delivery activity is not available in this deployment \
                         (studio-insight is not configured)",
                    )
                    .create()
            })
    }

    fn queue(&self) -> ApiResult<Arc<dyn crate::tasks::TaskQueue>> {
        self.hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "catalog syncs are not available in this deployment \
                         (studio-tasks has no database configured)",
                    )
                    .create()
            })
    }
}

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// Acknowledgement that a sync was accepted and is running in the background.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CatalogSyncEnqueued {
    /// The studio-tasks run doing the sync: poll `GET /studio-tasks/v1/runs/{run_id}`
    /// for the outcome; its `result` carries the counts as they tick up.
    pub run_id: String,
    pub status: String,
}

/// One catalog node (gear or crate_version).
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CatalogNodeDto {
    /// GTS type id, e.g. `gts.cf.studio.catalog.gear.v1~`.
    pub type_id: String,
    /// Deterministic instance id.
    pub instance_id: String,
    /// The curated crate/version payload.
    #[schema(value_type = Object)]
    pub value: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CatalogNodeListResponse {
    pub nodes: Vec<CatalogNodeDto>,
    /// Whether a cap cut the list short. An organization can mark a type with
    /// six figures of instances as a component, and a page showing some of one
    /// without saying so is worse than a page that admits it.
    #[serde(default)]
    pub truncated: bool,
    /// The organization's components left out because the platform has one
    /// of the same name (ADR-0042): the platform's is listed, the
    /// organization's annotations over it. Empty outside `/components`.
    #[serde(default)]
    pub shadowed: Vec<String>,
}

/// Open, Studio-owned metadata for a gear. The payload is intentionally
/// extensible: it holds delivery metrics and links that crates.io cannot know.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SaveGearProfileRequest {
    #[schema(value_type = Object)]
    pub profile: Value,
}

/// The field schemas this tenant renders component pages against.
///
/// Open shape on purpose. A schema is a layout, and this endpoint's job is to
/// let a deployment describe a component kind this build has never heard of —
/// pinning the JSON into a closed response DTO would put that behind a
/// release, which is the thing the schemas moved out of the client to escape.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct FieldSchemaListResponse {
    /// One entry per component type, `{describes, groups, composition,
    /// statusLegend, docStateLegend, sourceClasses, owner}`. `owner` is
    /// `builtin` or `tenant`, so a screen can offer to revert what it shows.
    #[schema(value_type = Vec<Object>)]
    pub schemas: Vec<Value>,
}

/// One GTS type the graph holds, and what this organization says about it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CatalogTypeDto {
    /// The id graph-storage stores it under, ancestry and all. Empty when
    /// nothing has written a node of this type into this tenant's graph yet.
    pub type_id: String,
    /// The leaf of that id: how the type is named everywhere else, and the key
    /// a mark and a field schema are written against.
    pub leaf_id: String,
    /// A family or base. Derived from, never instantiated, so never a
    /// component — reported rather than filtered so a page can say why.
    pub is_abstract: bool,
    /// Whether this organization treats the type as a component.
    pub component: bool,
    /// Who authored the field schema it renders against: `builtin`, `tenant`
    /// or `none`.
    pub schema: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CatalogTypeListResponse {
    pub types: Vec<CatalogTypeDto>,
}

/// How many nodes of one type the graph holds.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TypeCountDto {
    pub leaf_id: String,
    /// Exact, unless `capped` — then it is a floor, not a total.
    pub count: u64,
    /// Whether the count stopped at the cap rather than at the end of the
    /// type. A page that shows a capped number as if it were a total is
    /// telling its reader something untrue about their own graph.
    pub capped: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TypeCountListResponse {
    pub counts: Vec<TypeCountDto>,
}

/// Whether a type is one of this organization's components.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SetTypeComponentRequest {
    pub component: bool,
}

/// This tenant's own schema for one component type, replacing what it inherits.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SaveFieldSchemaRequest {
    #[schema(value_type = Object)]
    pub schema: Value,
}

/// A repository source picked on the Gears page, and one the organization
/// keeps on the server (`GET`/`PUT /sources`).
#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct RepoSourceDto {
    /// Tenant whose connections the source reads through (usually the
    /// organization). On an organization's routes it must be the
    /// organization or within it (the nil id stands for the organization);
    /// the platform's sources read through the root's.
    pub tenant: Uuid,
    /// Connection to use; when omitted the first GitHub connection is taken.
    pub connection_id: Option<Uuid>,
    /// `owner/name` of the repository.
    pub repo: String,
    /// Git ref to read (default `HEAD`).
    pub git_ref: Option<String>,
    /// Discovery mode: `"gears"` (default), `"frontx"` or `"kits"`.
    ///
    /// It selects what the scan looks for and, with it, what kind of component
    /// the repository contributes: a `gear.toml` directory, a FrontX package,
    /// or a `.cf-studio-kit.toml` manifest. Kits land as their own node type
    /// rather than as gears wearing a label.
    pub mode: Option<String>,
    /// In an answer of `GET /sources`: the platform's catalogue already reads
    /// this repository in this mode (ADR-0042), so the organization's copy is
    /// shadowed and can be removed. Ignored in a request.
    pub shadowed_by_platform: Option<bool>,
}

/// A roadmap board: a GitHub Project whose items plan the gears.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct RoadmapSourceDto {
    /// Tenant that owns the GitHub connection: the organization or within it
    /// (the nil id stands for the organization).
    pub tenant: Uuid,
    /// Connection to use; when omitted the first GitHub connection is taken.
    /// It needs to read organization projects (`read:project`).
    pub connection_id: Option<Uuid>,
    /// Organization or user that owns the board.
    pub owner: String,
    /// The board's number, as in `/orgs/<owner>/projects/<number>`.
    pub number: u32,
    /// What each letter of the priority field stands for, e.g. `{"A": "Acronis"}`.
    pub consumers: Option<std::collections::BTreeMap<String, String>>,
    /// The single-select holding the stage (default `Status`).
    pub stage_field: Option<String>,
    /// The single-select saying whether the date is committed (default `Commitment`).
    pub commitment_field: Option<String>,
    /// The per-consumer priority (default: the field named like `Prio (A.C.V)`).
    pub priority_field: Option<String>,
    /// The effort estimate (default: a field with `effort` in its name, on
    /// the board or on the issue).
    pub effort_field: Option<String>,
    /// The issues whose direct sub-issues are the gears: `owner/repo#123`, or
    /// `123` for an issue on the board. Omitted: every board item is a gear.
    pub roots: Option<Vec<String>>,
}

impl RoadmapSourceDto {
    fn into_source(self) -> RoadmapSource {
        let named = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        RoadmapSource {
            tenant: self.tenant,
            connection_id: self.connection_id,
            owner: self.owner.trim().to_string(),
            number: self.number,
            consumers: self.consumers.unwrap_or_default(),
            fields: RoadmapFields {
                stage: named(self.stage_field),
                commitment: named(self.commitment_field),
                priority: named(self.priority_field),
                effort: named(self.effort_field),
            },
            roots: self
                .roots
                .unwrap_or_default()
                .into_iter()
                .map(|r| r.trim().to_string())
                .filter(|r| !r.is_empty())
                .collect(),
        }
    }
}

/// Which sources one sync should read. Omit the body to sync crates.io with the
/// default keyword (back-compatible).
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SyncRequestDto {
    /// crates.io keyword; `null`/absent disables the crates.io source.
    pub crates_io: Option<String>,
    /// Repository sources (gears repo, FrontX repo, …).
    pub repositories: Option<Vec<RepoSourceDto>>,
    /// Roadmap boards to read each gear's stage, due date and demand from.
    pub roadmaps: Option<Vec<RoadmapSourceDto>>,
}

impl SyncRequestDto {
    fn into_sources(self, default_keyword: &str) -> SyncSources {
        let repos: Vec<RepoSource> = self
            .repositories
            .unwrap_or_default()
            .into_iter()
            .filter(|r| !r.repo.trim().is_empty())
            .map(|r| RepoSource {
                tenant: r.tenant,
                connection_id: r.connection_id,
                repo: r.repo,
                git_ref: r.git_ref.unwrap_or_default(),
                mode: r.mode.unwrap_or_else(|| "gears".to_string()),
            })
            .collect();
        let roadmaps: Vec<RoadmapSource> = self
            .roadmaps
            .unwrap_or_default()
            .into_iter()
            .filter(|r| !r.owner.trim().is_empty())
            .map(RoadmapSourceDto::into_source)
            .collect();
        let crates_io = match self.crates_io {
            Some(k) if !k.trim().is_empty() => Some(k.trim().to_string()),
            Some(_) => None,
            None => {
                if repos.is_empty() && roadmaps.is_empty() {
                    Some(default_keyword.to_string())
                } else {
                    None
                }
            }
        };
        SyncSources {
            crates_io,
            repos,
            roadmaps,
            registry: false,
            platform: false,
            project: None,
        }
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct VersionsQuery {
    /// Optional crate name (query param `crate`) to filter versions to one gear.
    #[serde(rename = "crate", default)]
    pub crate_name: Option<String>,
}

async fn sync(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    headers: HeaderMap,
    body: Option<Json<SyncRequestDto>>,
) -> ApiResult<(StatusCode, JsonBody<CatalogSyncEnqueued>)> {
    let idempotency_key = crate::idempotency::key(&headers)?;
    let (mut sources, names_repositories) = match body {
        Some(Json(req)) => {
            let names = req.repositories.is_some();
            (req.into_sources(catalog.service.default_keyword()), names)
        }
        None => (
            SyncSources {
                crates_io: Some(catalog.service.default_keyword().to_string()),
                ..SyncSources::default()
            },
            false,
        ),
    };
    // What the body names reads only through the organization's own
    // connections; the run checks each connection again (`retain_owned_sources`).
    sources.repos = owned_sources(&catalog, &ctx, std::mem::take(&mut sources.repos)).await?;
    sources.roadmaps =
        owned_roadmaps(&catalog, &ctx, std::mem::take(&mut sources.roadmaps)).await?;
    // A body that names no repositories syncs the ones the organization keeps
    // on the server, and walks its projects into the registry after them
    // (ADR-0041). One that names them is read as it always was.
    if !names_repositories {
        sources.repos = catalog
            .service
            .list_sources(&ctx)
            .await
            .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
        sources.registry = true;
    }
    let payload = serde_json::to_value(&sources)
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    let queue = catalog.queue()?;
    let run_id = queue
        .enqueue(
            &ctx,
            crate::tasks::sdk::NewRun {
                tenant: ctx.subject_tenant_id(),
                task_type: TASK_TYPE,
                payload,
                // One catalog per tenant, upserted by deterministic node key:
                // two syncs at once would write the same gear nodes, so they
                // queue behind each other instead.
                partition_key: Some("catalog"),
                idempotency_key: idempotency_key.as_deref(),
                coalesce_queued: true,
                notify_workspace_id: None,
            },
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    Ok((
        StatusCode::ACCEPTED,
        Json(CatalogSyncEnqueued {
            run_id: run_id.to_string(),
            status: "queued".to_string(),
        }),
    ))
}

fn to_dtos(nodes: Vec<super::gts::GtsNode>) -> Vec<CatalogNodeDto> {
    nodes
        .into_iter()
        .map(|n| CatalogNodeDto {
            type_id: n.type_id.to_string(),
            instance_id: n.instance_id,
            value: n.value,
        })
        .collect()
}

/// The components, which is now a question rather than a constant.
///
/// This used to read "nodes of `catalog.gear.v1~`", which put "what counts as
/// a component" in this file. It is a judgement about an organization's model,
/// so it belongs to the organization: the list is every node of every type it
/// marked on the Objects page.
/// One component of a project's repositories that is not a gear.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectComponentDto {
    /// `owner/repo`.
    pub repo: String,
    /// Repo-relative directory; empty for the root.
    pub dir: String,
    pub name: String,
    /// `go`, `python`, `java`, `node`, `rust`, `helm`, `container`, …
    pub kind: String,
    pub manifests: Vec<String>,
    pub contracts: Vec<String>,
    pub has_tests: bool,
    pub has_readme: bool,
    /// The people who changed it most, from the history read; first is the
    /// likeliest owner.
    pub owners: Vec<String>,
    pub last_change: Option<String>,
    pub open_pulls: u32,
    /// `open_pulls` is a lower bound: the repository has more open pull
    /// requests, or one with more files, than one read returns.
    pub open_pulls_partial: bool,
    /// `ready`, `caution` or `not_ready`.
    pub readiness: String,
    pub reasons: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectComponentListDto {
    pub items: Vec<ProjectComponentDto>,
    pub total: u32,
    /// Repositories read.
    pub repos: u32,
    /// The project's sources that could not be read, and why: their
    /// components are missing from `items`, not absent. An object beside the
    /// collection, so `items` stays the one array of the envelope.
    #[serde(default)]
    pub unreadable: UnreadableProjectSourcesDto,
}

/// The sources a read of a project's repositories left out.
#[derive(Debug, Default)]
#[toolkit_macros::api_dto(response)]
pub struct UnreadableProjectSourcesDto {
    pub sources: Vec<UnreadableProjectSourceDto>,
}

/// A project source a read left out, and why ("its connection … is not
/// visible here: it was deleted, or it belongs to another user").
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct UnreadableProjectSourceDto {
    /// `owner/repo`, or `project config` when the project's list of sources
    /// itself could not be read.
    pub source: String,
    pub reason: String,
}

impl From<super::service::SkippedSource> for UnreadableProjectSourceDto {
    fn from(s: super::service::SkippedSource) -> Self {
        Self {
            source: s.source,
            reason: s.reason,
        }
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct ProjectScopeQuery {
    pub project_id: String,
}

/// How many components one call reads the history of.
const COMPONENT_HISTORY_MAX: usize = 25;

const OPEN_PULL_FILES_QUERY: &str = r#"
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50) {
      pageInfo { hasNextPage }
      nodes { files(first: 100) { pageInfo { hasNextPage } nodes { path } } }
    }
  }
}
"#;

fn bot(login: &str) -> bool {
    let a = login.to_ascii_lowercase();
    a.ends_with("[bot]") || a.ends_with("-bot") || a == "github-actions" || a.contains("dependabot")
}

/// The services and applications a project's repositories hold beyond its
/// gears, each with who changed it, what is open against it, and whether it
/// is ready to be taken.
async fn list_project_components(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Query(query): Query<ProjectScopeQuery>,
) -> ApiResult<JsonBody<ProjectComponentListDto>> {
    use super::services::{Facts, detect, readiness};
    let project = uuid::Uuid::parse_str(query.project_id.trim()).map_err(|_| {
        StudioComponentsCatalogError::invalid_argument()
            .with_field_violation("project_id", "must be a UUID".to_owned(), "INVALID")
            .create()
    })?;
    let Some(connectors) = catalog.service.connector_service() else {
        return Ok(Json(ProjectComponentListDto {
            items: Vec::new(),
            total: 0,
            repos: 0,
            unreadable: UnreadableProjectSourcesDto::default(),
        }));
    };
    let now = time::OffsetDateTime::now_utc();
    let mut items = Vec::new();
    let mut repos_read = 0u32;
    let mut history_left = COMPONENT_HISTORY_MAX;
    let project_id = project.to_string();
    let (sources, mut skipped) = catalog
        .service
        .source_repos_checked(&ctx, &project_id)
        .await;
    for source in sources {
        let branch = (!source.branch.trim().is_empty()).then(|| source.branch.clone());
        let repo = match crate::connectors::sdk::Repository::open(
            &connectors,
            &ctx,
            source.tenant,
            source.connection_id,
            "github",
            &source.repo,
            branch.as_deref(),
        )
        .await
        {
            Ok(repo) => repo,
            Err(e) => {
                skipped.push(super::service::SkippedSource::new(
                    &project_id,
                    &source.repo,
                    format!("{e:#}"),
                ));
                continue;
            }
        };
        let tree = match repo.tree().await {
            Ok(tree) => tree,
            Err(e) => {
                skipped.push(super::service::SkippedSource::new(
                    &project_id,
                    &source.repo,
                    format!("its files could not be listed: {e:#}"),
                ));
                continue;
            }
        };
        repos_read += 1;
        let paths: Vec<String> = tree
            .files
            .into_iter()
            .filter(|f| !f.is_dir)
            .map(|f| f.path)
            .collect();
        let gear_dirs: std::collections::BTreeSet<String> = paths
            .iter()
            .filter(|p| p.ends_with("gear.gdl") || p.ends_with("gear.toml"))
            .map(|p| {
                p.rsplit_once('/')
                    .map_or(String::new(), |(d, _)| d.to_string())
            })
            .collect();
        let found = detect(&source.repo, &paths, &gear_dirs);
        // Open pull requests, once per repository: which files each changes,
        // and whether that is all of them.
        let (open_files, all_read): (Vec<Vec<String>>, bool) =
            match (source.repo.split_once('/'), source.connection_id) {
                (Some((owner, name)), Some(connection_id)) => {
                    match connectors
                        .driver_and_auth(&ctx, source.tenant, connection_id)
                        .await
                    {
                        Ok((driver, auth, _)) => driver
                            .graphql(
                                &auth,
                                &serde_json::json!({
                                    "query": OPEN_PULL_FILES_QUERY,
                                    "variables": { "owner": owner, "name": name },
                                }),
                            )
                            .await
                            .map_or((Vec::new(), true), |a| super::services::open_pull_files(&a)),
                        Err(_) => (Vec::new(), true),
                    }
                }
                _ => (Vec::new(), true),
            };
        for f in found {
            let prefix = if f.dir.is_empty() {
                String::new()
            } else {
                format!("{}/", f.dir)
            };
            let open_pulls = open_files
                .iter()
                .filter(|files| files.iter().any(|p| p.starts_with(&prefix)))
                .count();
            let (owners, last_change) = if history_left > 0 {
                history_left -= 1;
                let commits = repo
                    .history(if f.dir.is_empty() { "." } else { &f.dir }, 30)
                    .await
                    .unwrap_or_default();
                let mut counts: std::collections::BTreeMap<String, usize> =
                    std::collections::BTreeMap::new();
                for c in &commits {
                    if let Some(who) = c
                        .author
                        .clone()
                        .or(c.author_name.clone())
                        .filter(|w| !bot(w))
                    {
                        *counts.entry(who).or_default() += 1;
                    }
                }
                let mut owners: Vec<(String, usize)> = counts.into_iter().collect();
                owners.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
                let last = commits
                    .iter()
                    .filter_map(|c| c.committed_at.clone().or(c.created_at.clone()))
                    .max();
                (owners.into_iter().map(|(w, _)| w).collect::<Vec<_>>(), last)
            } else {
                (Vec::new(), None)
            };
            let days = last_change.as_deref().and_then(|t| {
                time::OffsetDateTime::parse(t, &time::format_description::well_known::Rfc3339)
                    .ok()
                    .map(|at| (now - at).whole_days())
            });
            let r = readiness(&Facts {
                days_since_change: days,
                authors: owners.len(),
                open_pulls,
                open_pulls_partial: !all_read,
                has_tests: f.has_tests,
                has_readme: f.has_readme,
                has_contract: !f.contracts.is_empty(),
            });
            items.push(ProjectComponentDto {
                repo: source.repo.clone(),
                dir: f.dir,
                name: f.name,
                kind: f.kind,
                manifests: f.manifests,
                contracts: f.contracts,
                has_tests: f.has_tests,
                has_readme: f.has_readme,
                owners: owners.into_iter().take(3).collect(),
                last_change,
                open_pulls: u32::try_from(open_pulls).unwrap_or(u32::MAX),
                open_pulls_partial: !all_read,
                readiness: r.signal.to_string(),
                reasons: r.reasons,
            });
        }
    }
    Ok(Json(ProjectComponentListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        repos: repos_read,
        unreadable: UnreadableProjectSourcesDto {
            sources: skipped
                .into_iter()
                .map(UnreadableProjectSourceDto::from)
                .collect(),
        },
    }))
}

async fn list_gears(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    access: Option<Extension<crate::org_scope::OrgAccess>>,
    Query(scope): Query<catalogue_levels_routes::OptionalProject>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    // A project's catalogue is the organization's and its own (ADR-0061);
    // without `project_id`, the organization's, its platform pins laid on.
    let tiered = match scope.project_id.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(raw) => {
            let pctx = catalogue_levels_routes::project_ctx(
                &catalog,
                &ctx,
                access.as_ref().map(|a| &a.0),
                raw,
            )
            .await?;
            catalog.service.project_catalogue(&ctx, &pctx).await
        }
        None => catalog.service.org_catalogue(&ctx).await,
    };
    let super::service::TieredNodes {
        nodes,
        truncated,
        shadowed,
    } = tiered.map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    // The reference's classification, laid onto each node: what it is, what
    // it is filed under, and why it is not a component when it is not. A
    // node another supersedes is left out, so the portal's list is clean
    // before the next sync deletes it. Never waits for a cold Gearbox cache.
    let (entries, _, _, _) = reference_entries(&ctx, &catalog, 0, false).await?;
    let by_instance: std::collections::HashMap<&str, &super::reference::ComponentReferenceDto> =
        entries
            .iter()
            .filter_map(|e| e.instance_id.as_deref().map(|id| (id, e)))
            .collect();
    Ok(Json(CatalogNodeListResponse {
        nodes: nodes
            .into_iter()
            .filter_map(|n| {
                let mut value = n.value;
                if let Some(entry) = by_instance.get(n.instance_id.as_str()) {
                    if entry.superseded_by.is_some() {
                        return None;
                    }
                    if let Some(obj) = value.as_object_mut() {
                        obj.insert("component_kind".into(), Value::String(entry.kind.clone()));
                        obj.insert(
                            "component_kind_reason".into(),
                            Value::String(entry.kind_reason.clone()),
                        );
                        obj.insert(
                            "component_category".into(),
                            entry.category.clone().map_or(Value::Null, Value::String),
                        );
                        obj.insert(
                            "component_excluded".into(),
                            entry
                                .excluded_reason
                                .clone()
                                .map_or(Value::Null, Value::String),
                        );
                        obj.insert("component_name".into(), Value::String(entry.name.clone()));
                    }
                }
                Some(CatalogNodeDto {
                    type_id: n.type_id,
                    instance_id: n.instance_id,
                    value,
                })
            })
            .collect(),
        truncated,
        shadowed,
    }))
}

/// The window a caller gets when it does not ask for one.
const DEFAULT_ACTIVITY_DAYS: u32 = 30;
/// The longest window offered. Two years of weekly buckets is already more
/// bars than a chart can draw, and a bigger window is a bigger upstream query
/// for a picture nobody can read.
const MAX_ACTIVITY_DAYS: u32 = 730;

/// One weekly bar of a gear's churn.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct ActivityPointDto {
    /// The bucket's first day (a Monday), `YYYY-MM-DD`.
    pub date: String,
    pub commits: u64,
    pub lines_added: i64,
    pub lines_removed: i64,
}

/// Pull requests touching one gear, by the state they are in now.
///
/// Attributed through the files their commits changed, so one touching three
/// gears is counted in all three: these rows do NOT partition the repository,
/// and a screen showing them has to say so. Dependable for what merged (~97%
/// of merged pull requests reach their files), only indicative for what was
/// abandoned (~29% of closed, ~46% of open).
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct GearPullRequestsDto {
    pub open: u64,
    pub merged: u64,
    pub closed: u64,
    pub total: u64,
    /// Mean hours from opened to merged. Null when nothing merged in the
    /// window — which is not the same fact as zero hours.
    pub merged_cycle_hours: Option<f64>,
    pub authors: u64,
}

/// What one gear did over the window.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct GearActivityDto {
    /// The component's catalogue name, so a caller can join it to its row.
    pub gear: String,
    pub commits: u64,
    pub files_changed: u64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub authors: u64,
    /// Null when no pull request in the window touched this gear. Not zeros:
    /// nobody opened one is a different fact from the question not being asked.
    pub pull_requests: Option<GearPullRequestsDto>,
    /// The same totals for the window of the same length just before, when
    /// the caller asked with `compare=previous`; what a trend is measured
    /// against. Null when not asked, or when no pull request touched the gear
    /// then.
    pub pull_requests_previous: Option<GearPullRequestsDto>,
    /// Ascending by date, gaps filled with zeros so a quiet week reads as
    /// quiet rather than as missing.
    pub points: Vec<ActivityPointDto>,
}

/// Where the numbers came from, and what was left out getting them.
///
/// Separate from the envelope because it is not a second collection anybody
/// pages through — it is what a reader needs in order to know whether the list
/// beside it is the whole answer. Rule B1: the envelope carries one collection,
/// and here that is the gears.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct ActivitySourcesDto {
    /// The window the warehouse actually used, which is not always the one
    /// asked for. Null when it answered nothing at all.
    pub from: Option<String>,
    pub to: Option<String>,
    /// A query was capped: the ranking is a prefix, not the whole of it.
    pub truncated: bool,
    /// The repositories asked about, most components first. Fewer than the
    /// catalogue spans when it spans more than the per-answer limit — so a
    /// partial answer is not read as a complete one.
    pub repositories: Vec<String>,
}

#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct GearActivityListDto {
    pub items: Vec<GearActivityDto>,
    pub total: u32,
    pub sources: ActivitySourcesDto,
}

#[derive(Debug, serde::Deserialize)]
pub struct ActivityQuery {
    /// How many days back to look, ending today. Defaults to 30.
    pub days: Option<u32>,
    /// `previous` also counts pull requests over the window of the same
    /// length just before, as `pull_requests_previous`. Anything else, or
    /// nothing, asks the warehouse once per repository, as before.
    pub compare: Option<String>,
}

/// GET /studio-components-catalog/v1/activity — what moved, per gear.
///
/// The catalogue is read here rather than sent: the rules that turn it into a
/// question — grouping by repository, naming each crate's directory, resolving
/// the collisions — are what this endpoint exists to own, and a caller passing
/// its own grouping would be keeping a copy of them.
async fn gear_activity(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Query(query): Query<ActivityQuery>,
) -> ApiResult<JsonBody<GearActivityListDto>> {
    let days = query.days.unwrap_or(DEFAULT_ACTIVITY_DAYS);
    if !(1..=MAX_ACTIVITY_DAYS).contains(&days) {
        // Named field, named reason: `invalid_argument` refuses to be built
        // without one, which is the discipline a query parameter wants.
        return Err(StudioComponentsCatalogError::invalid_argument()
            .with_field_violation(
                "days",
                format!("must be between 1 and {MAX_ACTIVITY_DAYS}, got {days}"),
                "INVALID",
            )
            .create());
    }
    let delivery = catalog.delivery()?;
    let compare_previous = match query.compare.as_deref() {
        None => false,
        Some("previous") => true,
        Some(other) => {
            return Err(StudioComponentsCatalogError::invalid_argument()
                .with_field_violation(
                    "compare",
                    format!("must be \"previous\", got \"{other}\""),
                    "INVALID",
                )
                .create());
        }
    };

    // `OrgCtx` has already shown the caller reaches this tenant; the answer
    // is the tenant's, the same for every member, and moves by the day, so
    // it is reused until the catalogue changes or `ACTIVITY_TTL` passes.
    let key = (ctx.subject_tenant_id(), days, compare_previous);
    let generation = catalog.service.generation();
    if let Some(kept) = catalog.activity.get(&key, generation) {
        tracing::info!(
            days,
            compare_previous,
            "components-catalog: activity served from memory"
        );
        return Ok(Json(kept));
    }

    let started = std::time::Instant::now();
    let (nodes, _truncated) = catalog
        .service
        .list_component_nodes(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let listed_ms = started.elapsed().as_millis();
    let components: Vec<Value> = nodes.into_iter().map(|n| n.value).collect();
    let answer = activity_of(delivery.as_ref(), &components, days, compare_previous)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    tracing::info!(
        days,
        compare_previous,
        components = components.len(),
        repositories = answer.sources.repositories.len(),
        listed_ms,
        warehouse_ms = started.elapsed().as_millis() - listed_ms,
        "components-catalog: activity read"
    );
    catalog.activity.put(key, generation, answer.clone());
    Ok(Json(answer))
}

/// What moved in each of `components` over the last `days`, from the
/// warehouse: one round trip per repository in the plan, never per component.
/// Shared by `/activity` and `/reference`, so the two cannot disagree on a
/// number.
async fn activity_of(
    delivery: &dyn crate::insight::port::ComponentDelivery,
    components: &[Value],
    days: u32,
    compare_previous: bool,
) -> anyhow::Result<GearActivityListDto> {
    let plan = super::activity::plan_requests(components);

    let from = super::activity::days_ago(days);
    let previous = super::activity::previous_window(days);
    let mut pages = Vec::with_capacity(plan.len());
    let mut pr_pages = Vec::with_capacity(plan.len());
    let mut previous_pages = Vec::new();
    let repositories: Vec<String> = plan.iter().map(|r| r.repository.clone()).collect();
    // Every repository, and every question about one, is its own warehouse
    // round trip: asked one after another they were up to twelve in a row.
    // They are independent, so they are asked together, and the answers are
    // put back in the plan's order so the merge below sees what it did.
    let (from, previous) = (&from, &previous);
    let asked = futures_util::future::join_all(plan.iter().map(|repo| async move {
        let query = crate::insight::port::DeliveryQuery {
            repository: repo.repository.clone(),
            from: Some(from.clone()),
            to: None,
            components: repo.components.clone(),
            limit: u32::try_from(repo.components.len()).ok(),
        };
        let earlier = compare_previous.then(|| crate::insight::port::DeliveryQuery {
            from: Some(previous.0.clone()),
            to: Some(previous.1.clone()),
            ..query.clone()
        });
        let (metrics, prs, earlier) = tokio::join!(
            delivery.metrics(&query),
            delivery.pull_requests(&query),
            async {
                match &earlier {
                    Some(q) => Some(delivery.pull_requests(q).await),
                    None => None,
                }
            }
        );
        (metrics, prs, earlier)
    }))
    .await;
    for (metrics, prs, earlier) in asked {
        pages.push(metrics?);
        // Pull requests are a second question with its own coverage, so they
        // get their own failure: a warehouse without them is not a reason to
        // lose the commit activity as well.
        if let Ok(page) = prs {
            pr_pages.push(page);
        }
        // As above: the comparison is an extra, and losing it loses only the
        // comparison.
        if let Some(Ok(page)) = earlier {
            previous_pages.push(page);
        }
    }

    let (rows, truncated, window) = super::activity::index_of(&pages, &pr_pages);
    let (earlier, earlier_truncated) = super::activity::pull_requests_by_gear(&previous_pages);
    let pr_dto = |pr: crate::insight::port::PullRequestTotals| GearPullRequestsDto {
        open: pr.open,
        merged: pr.merged,
        closed: pr.closed,
        total: pr.total,
        merged_cycle_hours: pr.merged_cycle_hours,
        authors: pr.authors,
    };
    let items: Vec<GearActivityDto> = rows
        .into_iter()
        .map(|row| GearActivityDto {
            // Before `gear`, which moves the name this looks up by.
            pull_requests_previous: earlier.get(&row.gear).cloned().map(pr_dto),
            gear: row.gear,
            commits: row.commits,
            files_changed: row.files_changed,
            lines_added: row.lines_added,
            lines_removed: row.lines_removed,
            authors: row.authors,
            pull_requests: row.pull_requests.map(pr_dto),
            points: row
                .points
                .into_iter()
                .map(|p| ActivityPointDto {
                    date: p.date,
                    commits: p.commits,
                    lines_added: p.lines_added,
                    lines_removed: p.lines_removed,
                })
                .collect(),
        })
        .collect();
    Ok(GearActivityListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        sources: ActivitySourcesDto {
            from: window.as_ref().map(|(f, _)| f.clone()),
            to: window.map(|(_, t)| t),
            truncated: truncated || earlier_truncated,
            repositories,
        },
    })
}

// ── what a component's fields actually say ───────────────────────────────────

/// One component, with its three sources already reconciled.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentValuesDto {
    /// The component's catalogue name — how a caller joins this to its row.
    pub name: String,
    /// Field id to its answer. An answer is `{ v, b, n, s, l, u }`, every part
    /// optional: a source that knows the value but not its grade says so
    /// rather than inventing one. A field a person CLEARED is present and
    /// null, which is different from absent — absent means nothing answered.
    pub values: serde_json::Value,
    /// What to file the component under, out of the four places a category
    /// hides. Empty when nothing answers, which is a fact about the component
    /// and reads better than an "Uncategorised" invented for it.
    pub category: String,
    /// Every source that answered something about it, layered in order:
    /// crates.io, the repository, Gearbox, a roadmap board, a person.
    pub sources: Vec<ComponentSourceDto>,
    /// Known from a roadmap board alone: planned, no code catalogued yet.
    pub planned: bool,
    /// Whose catalogue it is in (ADR-0042): `platform` or `organization`.
    pub tier: String,
}

/// One place a component's facts came from.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentSourceDto {
    /// `crates_io`, `repository`, `roadmap`, `gearbox` or `person`.
    pub kind: String,
    /// The repository, the board's title, `crates.io`.
    pub label: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentValuesListDto {
    pub items: Vec<ComponentValuesDto>,
    pub total: u32,
    /// Insight's ranking capped a page, so this is a prefix of the catalogue
    /// rather than all of it.
    pub truncated: bool,
}

/// GET /studio-components-catalog/v1/component-values — the reconciled fields.
///
/// The whole catalogue in one answer, because the screen that wants it is a
/// table of the whole catalogue: asking per component would be one request per
/// row for something already read in one.
async fn component_values(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<ComponentValuesListDto>> {
    let (resolved, truncated) = resolved_components(&ctx, &catalog).await?;
    let items: Vec<ComponentValuesDto> = resolved
        .into_iter()
        .map(|c| ComponentValuesDto {
            name: c.name,
            values: Value::Object(c.values),
            category: c.category,
            sources: c
                .sources
                .into_iter()
                .map(|s| ComponentSourceDto {
                    kind: s.kind,
                    label: s.label,
                })
                .collect(),
            planned: c.planned,
            tier: c.tier,
        })
        .collect();

    Ok(Json(ComponentValuesListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        truncated,
    }))
}

use super::service::ResolvedComponent;

/// What one component's fields said on one day.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentSnapshotDto {
    pub component: String,
    /// `YYYY-MM-DD`, UTC.
    pub date: String,
    /// Per field id, the parts a comparison reads: `n` the number, `s` the
    /// grade, `b` the badge (cut to 80 characters). A field with none of them
    /// is not kept.
    pub fields: serde_json::Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentHistoryDto {
    pub items: Vec<ComponentSnapshotDto>,
    pub total: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct ComponentHistoryQuery {
    /// How many days back, ending today. Defaults to 30.
    pub days: Option<u32>,
    /// One component's every snapshot in the window. Without it, each
    /// component's earliest snapshot in the window.
    pub component: Option<String>,
}

const DEFAULT_HISTORY_DAYS: u32 = 30;
const MAX_HISTORY_DAYS: u32 = 366;

/// GET /studio-components-catalog/v1/component-history — what the fields said before.
async fn component_history(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Query(query): Query<ComponentHistoryQuery>,
) -> ApiResult<JsonBody<ComponentHistoryDto>> {
    let days = query.days.unwrap_or(DEFAULT_HISTORY_DAYS);
    if !(1..=MAX_HISTORY_DAYS).contains(&days) {
        return Err(StudioComponentsCatalogError::invalid_argument()
            .with_field_violation(
                "days",
                format!("must be between 1 and {MAX_HISTORY_DAYS}, got {days}"),
                "INVALID",
            )
            .create());
    }
    let rows = match query.component.as_deref().map(str::trim) {
        Some("") => {
            return Err(StudioComponentsCatalogError::invalid_argument()
                .with_field_violation("component", "must not be empty", "INVALID")
                .create());
        }
        Some(name) => catalog.service.component_history(&ctx, name, days).await,
        None => catalog.service.component_baselines(&ctx, days).await,
    }
    .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    let items: Vec<ComponentSnapshotDto> = rows
        .into_iter()
        .filter_map(|row| {
            Some(ComponentSnapshotDto {
                component: row.get("component")?.as_str()?.to_owned(),
                date: row
                    .get("date")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                fields: row
                    .get("fields")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Default::default())),
            })
        })
        .collect();
    Ok(Json(ComponentHistoryDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

/// Every catalogued component's reconciled, graded values, and whether the
/// component listing was truncated.
async fn resolved_components(
    ctx: &SecurityContext,
    catalog: &Catalog,
) -> ApiResult<(Vec<ResolvedComponent>, bool)> {
    catalog
        .service
        .resolved_components(ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())
}

// ── the components reference ─────────────────────────────────────────────────

/// The window the reference measures activity over when the caller does not
/// say: the portal's Components page defaults to ninety days, and the two
/// should show the same number for the same component.
const DEFAULT_REFERENCE_DAYS: u32 = 90;

/// How long the engine's catalogue is served from memory before a refresh is
/// started in the background. The answer never waits for that refresh: the
/// corpus checkout is a `git fetch` plus an engine run, seconds on a good day,
/// and the commit it lands on is part of the cache key anyway.
const ENGINE_TTL: std::time::Duration = std::time::Duration::from_secs(300);

/// How long the warehouse's activity is reused. It moves by the day; a
/// catalogue change (a sync) invalidates it sooner.
const ACTIVITY_TTL: std::time::Duration = std::time::Duration::from_secs(600);

#[derive(Clone)]
struct EngineHit {
    commit: Option<String>,
    label: String,
    index: Arc<super::reference::EngineIndex>,
    at: std::time::Instant,
}

#[derive(Clone)]
struct ActivityHit {
    generation: u64,
    at: std::time::Instant,
    rows: Arc<std::collections::HashMap<String, super::reference::ReferenceActivityDto>>,
    from: Option<String>,
    to: Option<String>,
}

#[derive(Clone)]
struct BuiltHit {
    generation: u64,
    commit: Option<String>,
    activity_at: Option<std::time::Instant>,
    entries: Arc<Vec<super::reference::ComponentReferenceDto>>,
    truncated: bool,
    sources: super::reference::ReferenceSourcesDto,
}

/// What `/reference` (and the `/components` listing) reuse between requests.
///
/// Keyed so that a stale answer cannot be served: the engine's index by the
/// corpus commit, activity and the built join by the catalogue generation
/// (`CatalogService::generation`, moved by every sync and every profile or
/// field-schema write), the tenant and the window.
#[derive(Default)]
pub struct ReferenceCache {
    engine: tokio::sync::Mutex<Option<EngineHit>>,
    engine_refreshing: std::sync::atomic::AtomicBool,
    activity: tokio::sync::Mutex<std::collections::HashMap<(Uuid, u32), ActivityHit>>,
    built: tokio::sync::Mutex<std::collections::HashMap<(Uuid, u32), BuiltHit>>,
}

/// Where the last engine catalogue is kept across restarts, beside the corpus
/// checkout. Not a secret: it is the engine's projection of a public corpus.
fn engine_cache_file(gearbox: &Gearbox) -> std::path::PathBuf {
    gearbox.workdir().join("components-reference-engine.json")
}

/// Read the engine's catalogue into the cache, and keep a copy on disk so the
/// first reference after a restart does not wait for a fetch and an engine run.
async fn load_engine(gearbox: &Gearbox) -> anyhow::Result<EngineHit> {
    // The platform's corpus: the reference is the common set.
    let (raw, commit) = gearbox.catalogue_json(None).await?;
    let mut label = gearbox.corpus_label(None);
    if let Some(c) = &commit {
        label = format!("{label} ({})", &c[..c.len().min(7)]);
    }
    let saved = serde_json::json!({ "commit": commit, "label": label, "catalogue": &*raw });
    if let Ok(bytes) = serde_json::to_vec(&saved)
        && let Err(e) = tokio::fs::write(engine_cache_file(gearbox), bytes).await
    {
        tracing::debug!(error = %e, "components-catalog: engine catalogue not saved");
    }
    Ok(EngineHit {
        index: Arc::new(super::reference::EngineIndex::from_catalogue(&raw)),
        commit,
        label,
        at: std::time::Instant::now(),
    })
}

/// The engine catalogue a previous run saved, marked old so that a refresh
/// starts at once. `None` when there is none or it does not parse.
async fn load_engine_from_disk(gearbox: &Gearbox) -> Option<EngineHit> {
    let bytes = tokio::fs::read(engine_cache_file(gearbox)).await.ok()?;
    let saved: Value = serde_json::from_slice(&bytes).ok()?;
    let catalogue = saved.get("catalogue")?;
    Some(EngineHit {
        index: Arc::new(super::reference::EngineIndex::from_catalogue(catalogue)),
        commit: saved
            .get("commit")
            .and_then(Value::as_str)
            .map(str::to_string),
        label: saved
            .get("label")
            .and_then(Value::as_str)
            .map_or_else(|| gearbox.corpus_label(None), str::to_string),
        at: std::time::Instant::now()
            .checked_sub(ENGINE_TTL)
            .unwrap_or_else(std::time::Instant::now),
    })
}

/// Refresh the engine's catalogue in the background, once at a time.
fn refresh_engine_later(gearbox: Arc<Gearbox>, cache: Arc<ReferenceCache>) {
    use std::sync::atomic::Ordering;
    if cache.engine_refreshing.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        match load_engine(&gearbox).await {
            Ok(hit) => *cache.engine.lock().await = Some(hit),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "components-catalog: engine catalogue refresh failed; serving the last one")
            }
        }
        cache.engine_refreshing.store(false, Ordering::SeqCst);
    });
}

/// The engine's index, from memory when there is one. `wait` says whether a
/// cold cache may be filled in this request (the reference) or only in the
/// background (the `/components` listing, which must not wait on a clone).
async fn engine_index(catalog: &Catalog, wait: bool) -> Result<Option<EngineHit>, String> {
    let Some(gearbox) = &catalog.gearbox else {
        return Err(
            "Gearbox is not configured in this deployment (STUDIO_GEARBOX_WORKDIR is not set)"
                .to_string(),
        );
    };
    let mut hit = catalog.reference.engine.lock().await.clone();
    if hit.is_none()
        && let Some(saved) = load_engine_from_disk(gearbox).await
    {
        let mut slot = catalog.reference.engine.lock().await;
        if slot.is_none() {
            *slot = Some(saved);
        }
        hit = slot.clone();
    }
    match hit {
        Some(hit) => {
            if hit.at.elapsed() >= ENGINE_TTL {
                refresh_engine_later(Arc::clone(gearbox), Arc::clone(&catalog.reference));
            }
            Ok(Some(hit))
        }
        None if wait => match load_engine(gearbox).await {
            Ok(hit) => {
                *catalog.reference.engine.lock().await = Some(hit.clone());
                Ok(Some(hit))
            }
            Err(e) => Err(format!("the Gearbox catalogue could not be read: {e:#}")),
        },
        None => {
            refresh_engine_later(Arc::clone(gearbox), Arc::clone(&catalog.reference));
            Ok(None)
        }
    }
}

/// Every reference entry — components, non-components and superseded nodes —
/// for this tenant, from the cache when the catalogue, the corpus commit and
/// the activity it was built from are unchanged. Returns the entries, whether
/// the listing was truncated, the sources, and whether the cache answered.
async fn reference_entries(
    ctx: &SecurityContext,
    catalog: &Catalog,
    days: u32,
    wait_for_engine: bool,
) -> ApiResult<(
    Arc<Vec<super::reference::ComponentReferenceDto>>,
    bool,
    super::reference::ReferenceSourcesDto,
    bool,
)> {
    use super::reference::{ReferenceInputs, ReferenceSourcesDto};

    let tenant = ctx.subject_tenant_id();
    let generation = catalog.service.generation();
    let (engine, gearbox_problem) = match engine_index(catalog, wait_for_engine).await {
        Ok(hit) => (hit, None),
        Err(problem) => (None, Some(problem)),
    };
    let commit = engine.as_ref().and_then(|e| e.commit.clone());

    let activity_hit = if days == 0 {
        None
    } else {
        catalog
            .reference
            .activity
            .lock()
            .await
            .get(&(tenant, days))
            .filter(|a| a.generation == generation && a.at.elapsed() < ACTIVITY_TTL)
            .cloned()
    };
    let delivery = if days == 0 {
        None
    } else {
        catalog.delivery().ok()
    };

    // The whole answer, when nothing it was built from has moved.
    if let Some(hit) = catalog.reference.built.lock().await.get(&(tenant, days))
        && hit.generation == generation
        && hit.commit == commit
        && hit.activity_at == activity_hit.as_ref().map(|a| a.at)
        && (engine.is_some() || gearbox_problem.is_some() || hit.sources.gearbox_corpus.is_none())
        && (activity_hit.is_some() || delivery.is_none())
    {
        return Ok((
            Arc::clone(&hit.entries),
            hit.truncated,
            hit.sources.clone(),
            true,
        ));
    }

    let internal = |e: anyhow::Error| CanonicalError::internal(format!("{e:#}")).create();
    let (nodes, truncated) = catalog
        .service
        .list_component_nodes(ctx)
        .await
        .map_err(internal)?;
    let mut profiles: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for node in catalog.service.list_profiles(ctx).await.map_err(internal)? {
        if let Some(name) = node.value.get("gear_name").and_then(Value::as_str) {
            profiles.insert(name.to_owned(), node.value);
        }
    }
    let schemas = catalog
        .service
        .list_field_schemas(ctx)
        .await
        .map_err(internal)?;

    let mut activity_problem = None;
    let activity = match (days, activity_hit, delivery) {
        (0, _, _) => {
            activity_problem = Some("activity was not asked for (days=0)".to_string());
            None
        }
        (_, Some(hit), _) => Some(hit),
        (_, None, None) => {
            activity_problem =
                Some("studio-insight is not configured in this deployment".to_string());
            None
        }
        (_, None, Some(delivery)) => {
            let components: Vec<Value> = nodes.iter().map(|n| n.value.clone()).collect();
            match activity_of(delivery.as_ref(), &components, days, false).await {
                Ok(answer) => {
                    let hit = ActivityHit {
                        generation,
                        at: std::time::Instant::now(),
                        from: answer.sources.from,
                        to: answer.sources.to,
                        rows: Arc::new(
                            answer
                                .items
                                .into_iter()
                                .map(|row| {
                                    (
                                        row.gear,
                                        super::reference::ReferenceActivityDto {
                                            commits: row.commits,
                                            files_changed: row.files_changed,
                                            lines_added: row.lines_added,
                                            lines_removed: row.lines_removed,
                                            authors: row.authors,
                                        },
                                    )
                                })
                                .collect(),
                        ),
                    };
                    catalog
                        .reference
                        .activity
                        .lock()
                        .await
                        .insert((tenant, days), hit.clone());
                    Some(hit)
                }
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), "components-catalog: reference activity unavailable");
                    activity_problem =
                        Some(format!("the delivery warehouse did not answer: {e:#}"));
                    None
                }
            }
        }
    };

    let entries = super::reference::build(&ReferenceInputs {
        nodes: &nodes,
        profiles: &profiles,
        schemas: &schemas,
        engine: engine.as_ref().map(|e| e.index.as_ref()),
        activity: activity.as_ref().map(|a| a.rows.as_ref()),
    });
    let excluded = entries.iter().filter(|e| !e.component).count();
    let sources = ReferenceSourcesDto {
        gearbox_corpus: engine.as_ref().map(|e| e.label.clone()),
        gearbox_problem: gearbox_problem.or_else(|| {
            engine.is_none().then(|| {
                "the Gearbox catalogue is still being read; reload in a moment".to_string()
            })
        }),
        activity_days: activity.as_ref().map(|_| days),
        activity_from: activity.as_ref().and_then(|a| a.from.clone()),
        activity_to: activity.as_ref().and_then(|a| a.to.clone()),
        activity_problem,
        excluded: u32::try_from(excluded).unwrap_or(u32::MAX),
        cached: false,
    };
    let entries = Arc::new(entries);
    catalog.reference.built.lock().await.insert(
        (tenant, days),
        BuiltHit {
            generation,
            commit,
            activity_at: activity.as_ref().map(|a| a.at),
            entries: Arc::clone(&entries),
            truncated,
            sources: sources.clone(),
        },
    );
    Ok((entries, truncated, sources, false))
}

#[derive(Debug, serde::Deserialize)]
pub struct ReferenceQuery {
    /// Activity window in days; `0` skips the warehouse. Defaults to 90.
    pub days: Option<u32>,
    /// `components` (default) lists components only; `all` adds what is not
    /// a component and what another node supersedes, each with its reason.
    pub include: Option<String>,
}

/// GET /studio-components-catalog/v1/reference — the catalogue and the
/// Gearbox engine's catalogue as one list (see [`super::reference`]).
async fn component_reference(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Query(query): Query<ReferenceQuery>,
) -> ApiResult<JsonBody<ComponentReferenceListDto>> {
    let days = query.days.unwrap_or(DEFAULT_REFERENCE_DAYS);
    if days > MAX_ACTIVITY_DAYS {
        return Err(StudioComponentsCatalogError::invalid_argument()
            .with_field_violation(
                "days",
                format!("must be between 0 and {MAX_ACTIVITY_DAYS}, got {days}"),
                "INVALID",
            )
            .create());
    }
    let all = match query.include.as_deref() {
        None | Some("components") => false,
        Some("all") => true,
        Some(other) => {
            return Err(StudioComponentsCatalogError::invalid_argument()
                .with_field_violation(
                    "include",
                    format!("must be `components` or `all`, got `{other}`"),
                    "INVALID",
                )
                .create());
        }
    };
    let (entries, truncated, mut sources, cached) =
        reference_entries(&ctx, &catalog, days, true).await?;
    sources.cached = cached;
    let items: Vec<_> = entries
        .iter()
        .filter(|e| all || e.component)
        .cloned()
        .collect();
    Ok(Json(ComponentReferenceListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        truncated,
        sources,
    }))
}

async fn list_profiles(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    access: Option<Extension<crate::org_scope::OrgAccess>>,
    Query(scope): Query<catalogue_levels_routes::OptionalProject>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let mut nodes = catalog
        .service
        .list_profiles(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    // A project's own components' profiles, over the organization's (ADR-0061).
    if let Some(raw) = scope.project_id.as_deref().filter(|p| !p.trim().is_empty()) {
        let pctx = catalogue_levels_routes::project_ctx(
            &catalog,
            &ctx,
            access.as_ref().map(|a| &a.0),
            raw,
        )
        .await?;
        let own = catalog
            .service
            .project_profiles(&pctx)
            .await
            .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
        nodes = super::catalogue_levels::join_project_profiles(nodes, own);
    }
    Ok(Json(CatalogNodeListResponse {
        nodes: to_dtos(nodes),
        truncated: false,
        shadowed: Vec::new(),
    }))
}

async fn save_profile(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(name): Path<String>,
    Json(body): Json<SaveGearProfileRequest>,
) -> ApiResult<JsonBody<CatalogNodeDto>> {
    let node = catalog
        .service
        .save_profile(&ctx, &name, body.profile)
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("invalid gear profile: {e:#}"))
                .create()
        })?;
    let dto = to_dtos(vec![node])
        .into_iter()
        .next()
        .expect("one profile node converts to one DTO");
    Ok(Json(dto))
}

async fn list_types(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<CatalogTypeListResponse>> {
    let types = catalog
        .service
        .list_types(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogTypeListResponse {
        types: types
            .into_iter()
            .map(|t| CatalogTypeDto {
                type_id: t.type_id,
                leaf_id: t.leaf_id,
                is_abstract: t.is_abstract,
                component: t.component,
                schema: t.schema,
            })
            .collect(),
    }))
}

/// The instance count per type.
///
/// Its own endpoint because it costs one projection per type where the type
/// list costs two reads in total. The Objects page draws its table from
/// `/types` and fills these in after, so a graph with hundreds of types still
/// renders at once.
async fn count_types(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<TypeCountListResponse>> {
    let counts = catalog
        .service
        .count_types(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(TypeCountListResponse {
        counts: counts
            .into_iter()
            .map(|c| TypeCountDto {
                leaf_id: c.leaf_id,
                count: c.count as u64,
                capped: c.capped,
            })
            .collect(),
    }))
}

async fn set_type_component(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(type_id): Path<String>,
    Json(body): Json<SetTypeComponentRequest>,
) -> ApiResult<JsonBody<CatalogTypeDto>> {
    let record = catalog
        .service
        .set_type_component(&ctx, &type_id, body.component)
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok(Json(CatalogTypeDto {
        // The caller named a leaf; reporting a graph id here would be
        // inventing one for a type the graph may not hold a node of.
        type_id: String::new(),
        leaf_id: record.describes,
        is_abstract: false,
        component: record.component,
        schema: record.owner,
    }))
}

async fn list_field_schemas(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<FieldSchemaListResponse>> {
    let schemas = catalog
        .service
        .list_field_schemas(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let schemas = schemas
        .into_iter()
        .map(|s| serde_json::to_value(s).unwrap_or(Value::Null))
        .filter(|v| !v.is_null())
        .collect();
    Ok(Json(FieldSchemaListResponse { schemas }))
}

async fn save_field_schema(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(describes): Path<String>,
    Json(body): Json<SaveFieldSchemaRequest>,
) -> ApiResult<JsonBody<CatalogNodeDto>> {
    let saved = catalog
        .service
        .save_field_schema(&ctx, &describes, body.schema)
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("invalid field schema: {e:#}"))
                .create()
        })?;
    let value = serde_json::to_value(&saved)
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogNodeDto {
        type_id: super::gts::FIELD_SCHEMA_TYPE.to_string(),
        instance_id: super::gts::field_schema_instance_id(&saved.describes),
        value,
    }))
}

async fn delete_field_schema(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(describes): Path<String>,
) -> ApiResult<StatusCode> {
    catalog
        .service
        .delete_field_schema(&ctx, &describes)
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_versions(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Query(q): Query<VersionsQuery>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let mut nodes = catalog
        .service
        .list_nodes(&ctx, Some("crate_version"))
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    if let Some(name) = q
        .crate_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        nodes.retain(|n| n.value.get("crate").and_then(Value::as_str) == Some(name));
    }
    // Newest first, decided here. The projection has no order worth relying
    // on, so whoever displayed this used to sort it — and "which version is
    // newer" is a judgement, not a formatting choice.
    nodes.sort_by(|a, b| {
        let num = |value: &Value| {
            value
                .get("num")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        super::values::newer_first(&num(&a.value), &num(&b.value))
    });
    Ok(Json(CatalogNodeListResponse {
        nodes: to_dtos(nodes),
        truncated: false,
        shadowed: Vec::new(),
    }))
}

// ── Sources and the registry (ADR-0041) ──────────────────────────────────────

/// The organization's catalogue sources.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RepoSourceListDto {
    pub items: Vec<RepoSourceDto>,
    pub total: u32,
}

/// The sources that replace the organization's.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ReplaceSourcesRequest {
    pub items: Vec<RepoSourceDto>,
}

/// The projects the registry walk skips.
#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct ExcludedProjectsDto {
    pub project_ids: Vec<Uuid>,
}

/// What the last registry walk saw of one project.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryProjectDto {
    pub project_id: Uuid,
    pub project_name: String,
    /// When the walk read it, RFC 3339.
    pub at: String,
    /// The project's repositories could not be listed at all.
    pub error: Option<String>,
    pub repos: Vec<RegistryRepoStatusDto>,
}

/// What the last registry walk did with one repository of a project.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryRepoStatusDto {
    pub repo: String,
    /// `read` (read anew), `unchanged` (nothing it reads changed) or `failed`.
    pub status: String,
    /// Components found in it: read now, or still recorded for it.
    pub components: u32,
    pub error: Option<String>,
    /// What a person can do about `error`, when the walk knows -- for a
    /// repository connected with a personal token, share the connection.
    pub hint: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryProjectListDto {
    pub items: Vec<RegistryProjectDto>,
    pub total: u32,
}

/// One place a registry entry was found.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct OccurrenceDto {
    pub project_id: Option<Uuid>,
    pub project_name: Option<String>,
    /// `owner/name`.
    pub repo: String,
    pub git_ref: Option<String>,
    /// The component's directory, or the file when several share one.
    pub path: String,
    /// The newest commit on the ref when the repository was read.
    pub commit: Option<String>,
    /// `gear.toml`, `gear.gdl`, `attribute`, `package` or `kit`; `detected`
    /// where a candidate detector found it and nothing declares it.
    pub declared_in: String,
    /// `project`, or `organization` for the organization's gear repository
    /// (ADR-0042), which belongs to no project: `project_id` is then null and
    /// `project_name` is the organization's.
    pub scope: String,
}

/// Who answers for a registry entry.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(request, response)]
pub struct RegistryOwnerDto {
    /// `person` or `team`.
    pub kind: String,
    /// The person's Studio id, or the team's key, when known.
    pub id: Option<String>,
    pub name: String,
}

/// One decision a person made about a registry entry.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryDecisionDto {
    /// `register`, `reject`, `deprecate`, `restore`, `publish`,
    /// `mark_published`, `merge` or `edit`; `declare` (Declare it) and
    /// `published` (by `platform-sync`, when the platform's catalogue has a
    /// contributed gear) are recorded too.
    pub action: String,
    /// The state before; equal to `to` for an edit.
    pub from: String,
    pub to: String,
    /// The person who decided: their Studio id, else the token's subject.
    pub by: String,
    pub by_name: Option<String>,
    /// RFC 3339.
    pub at: String,
    pub reason: Option<String>,
    /// The fields the decision set (`owner`, `replaced_by`, `merge_into`,
    /// `version`, `merged_from`, …).
    pub details: Value,
}

/// A decision about a registry entry.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct RegistryDecisionRequest {
    /// `register`, `reject`, `deprecate`, `restore`, `request_publication`,
    /// `publish`, `decline_publication`, `mark_published`, `merge`, `edit`,
    /// `extract` or `complete_extraction` (ADR-0044). `publish`,
    /// `decline_publication` and `mark_published` are a platform curator's;
    /// the rest an organization administrator's.
    pub action: String,
    /// Why. Required to reject; for `publish`, said in the pull request.
    pub reason: Option<String>,
    /// Required to register (unless the entry has one); set by an edit.
    pub owner: Option<RegistryOwnerDto>,
    pub kind: Option<String>,
    pub category: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub description: Option<String>,
    /// For `deprecate`: an existing entry to use instead.
    pub replaced_by: Option<String>,
    /// For `merge`: the existing entry to fold this one into.
    pub merge_into: Option<String>,
    /// For `request_publication`: the version asked for; for
    /// `mark_published`: the version the platform published.
    pub version: Option<String>,
    /// For `publish` and `extract` only: answer what would be written (in
    /// `publish_preview` or `extract_preview`), writing and recording
    /// nothing.
    pub dry_run: Option<bool>,
    /// For `publish` only: which of the platform's gear repositories it goes
    /// into, by source id (ADR-0046 phase 4). Absent: the one holding most
    /// gears of the entry's category, as `publish_preview.targets` shows.
    pub target: Option<String>,
}

/// One component of the organization's registry.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryEntryDto {
    pub name: String,
    /// `gear`, `plugin`, `frontx` or `kit`.
    pub kind: String,
    /// `candidate`, `declared`, `registered`, `extracted`, `published`,
    /// `rejected`, `deprecated` or `merged`. A walk writes `declared` and
    /// never moves it; the rest are people's decisions.
    pub state: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub owner: Option<RegistryOwnerDto>,
    pub capabilities: Vec<String>,
    /// Names merged into this entry; a walk finding any of them puts it here.
    pub aliases: Vec<String>,
    /// For a `merged` entry, the entry it was folded into.
    pub merged_into: Option<String>,
    /// For a `deprecated` entry, the entry to use instead.
    pub replaced_by: Option<String>,
    /// For a `published` entry, the platform's version of it when known.
    pub version: Option<String>,
    /// The pull request that gave it to the platform (ADR-0042 §4), once a
    /// `publish` decision opened one; it stays `registered` until the
    /// platform's catalogue has it.
    pub contribution: Option<RegistryContributionDto>,
    /// Extract (ADR-0044 §1): the two pull requests that move it into the
    /// organization's gear repository; `completed_at` once both were merged
    /// and the version tagged (the entry is then `extracted`).
    pub extraction: Option<RegistryExtractionDto>,
    /// The projects that use it without declaring it (P4): by a Cargo
    /// dependency of their code, by their product's picks, or both.
    pub consumers: Vec<RegistryConsumerDto>,
    /// What a model last proposed for it (`POST /registry/{name}/suggest`);
    /// never a state change.
    pub suggestion: Option<RegistrySuggestionDto>,
    /// No occurrence is left; the entry is kept with its state.
    pub orphaned: bool,
    /// RFC 3339.
    pub first_seen: Option<String>,
    /// RFC 3339: the last walk that read a repository declaring it.
    pub last_seen: Option<String>,
    /// For a `candidate`: the sum of its evidence's weights (P3).
    pub score: Option<u32>,
    /// For a `candidate`: why it looks like a gear, signal by signal.
    pub evidence: Vec<EvidenceDto>,
    pub occurrences: Vec<OccurrenceDto>,
    /// The decisions made about it, newest first. Only on the single-entry
    /// read and a decision's answer; null in the list.
    pub decisions: Option<Vec<RegistryDecisionDto>>,
    /// What a `publish` with `dry_run: true` would write; null otherwise.
    pub publish_preview: Option<RegistryPublishPreviewDto>,
    /// What an `extract` with `dry_run: true` would write; null otherwise.
    pub extract_preview: Option<RegistryExtractPreviewDto>,
}

/// A gear leaving its project (ADR-0044 §1).
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryExtractionDto {
    pub crate_name: String,
    pub version: String,
    /// `<gear>/v<version>`, made once both pull requests are merged.
    pub tag: String,
    /// The organization's gear repository, `owner/name`, and the crate's
    /// directory there.
    pub gear_repo: String,
    pub gear_path: String,
    pub gear_pr_url: Option<String>,
    /// The project it leaves.
    pub project_id: Option<Uuid>,
    pub project_name: Option<String>,
    pub source_repo: String,
    pub source_path: String,
    pub source_pr_url: Option<String>,
    /// RFC 3339; who opened it.
    pub at: String,
    pub by: String,
    pub by_name: Option<String>,
    /// RFC 3339: when both were merged and the version tagged.
    pub completed_at: Option<String>,
    pub tagged_commit: Option<String>,
}

/// What Extract would write: the answer of an `extract` with `dry_run: true`.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryExtractPreviewDto {
    pub crate_name: String,
    pub version: String,
    pub tag: String,
    /// The organization's gear repository, its base branch, and the files
    /// written there.
    pub gear_repo: String,
    pub gear_base: String,
    pub gear_path: String,
    pub gear_files: Vec<String>,
    /// The project's repository, its base branch, the files changed there
    /// and the files deleted.
    pub source_repo: String,
    pub source_base: String,
    pub source_files: Vec<String>,
    pub source_deleted: Vec<String>,
    /// `extract/<name>`, in both.
    pub branch: String,
    /// What is not moved (not text).
    pub skipped: Vec<String>,
    /// The new crate's `Cargo.toml`, as written.
    pub manifest: Option<String>,
}

/// What publishing would write into the platform's gear repository: the
/// answer of a `publish` decision with `dry_run: true`.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryPublishPreviewDto {
    /// The platform's gear repository, `owner/name`.
    pub repo: String,
    /// The branch the pull request goes back to.
    pub base_branch: String,
    /// `contribute/<organization>/<name>`.
    pub branch: String,
    /// Where the gear's files go in the platform's repository.
    pub path: String,
    /// The files, at their places there.
    pub files: Vec<String>,
    /// What is not copied (not text), relative to the gear's directory.
    pub skipped: Vec<String>,
    /// The pull request's title.
    pub title: String,
    /// The platform's gear repository it goes into, by source id; absent
    /// while the platform names its gear repository the old way (a catalogue
    /// source).
    pub source_id: Option<String>,
    /// Every gear repository of the platform it could go into, with how many
    /// gears of the entry's category each holds (ADR-0046 phase 4).
    pub targets: Vec<RegistryPublishTargetDto>,
}

/// One of the platform's gear repositories a published gear can go into.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryPublishTargetDto {
    pub source_id: String,
    /// `owner/name`.
    pub repo: String,
    /// Gears of the entry's category the engine found in it.
    pub gears_in_category: u32,
}

/// A gear given to the platform: the pull request into the platform's gear
/// repository.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryContributionDto {
    /// The platform's gear repository, `owner/name`.
    pub repo: String,
    /// `contribute/<organization>/<name>`.
    pub branch: String,
    pub pr_url: Option<String>,
    /// Where the gear's files went in the platform's repository.
    pub path: String,
    pub files: u32,
    /// RFC 3339.
    pub at: String,
    pub by: String,
    pub by_name: Option<String>,
}

/// A project that uses a registry entry it does not declare.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryConsumerDto {
    pub project_id: Uuid,
    pub project_name: String,
    /// `cargo`, `product`, or both.
    pub via: Vec<String>,
}

/// What a model proposed for a registry entry.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RegistrySuggestionDto {
    pub description: Option<String>,
    /// One of the platform's categories, or null.
    pub category: Option<String>,
    /// Keys of the organization's capability vocabulary only.
    pub capabilities: Vec<String>,
    /// RFC 3339.
    pub at: String,
    /// `provider:model`.
    pub model: String,
}

/// One signal a candidate detector found (ADR-0041 P3).
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct EvidenceDto {
    /// `rest`, `persistence`, `types`, `boundary`, `docs`, `consumers` or
    /// `copied`.
    pub signal: String,
    /// What it fired on: "own REST surface: rest.rs", "used by 3 modules",
    /// "copied in insight".
    pub detail: String,
    pub weight: u32,
}

/// What Declare it takes. Every field is optional; the entry's own facts
/// fill what is left out.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct RegistryDeclareRequest {
    pub description: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub category: Option<String>,
    /// Answer the files only: nothing is written or recorded.
    pub dry_run: Option<bool>,
    /// The project whose occurrence to declare, when the candidate was found
    /// in several; else its highest-scoring one.
    pub project_id: Option<Uuid>,
}

/// One file Declare it writes.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct DeclaredFileDto {
    pub path: String,
    pub content: String,
}

/// What Declare it did, or -- for a dry run -- would do.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryDeclareResultDto {
    /// `declare/<name>`.
    pub branch: String,
    /// The pull request; null for a dry run.
    pub pr_url: Option<String>,
    pub files: Vec<DeclaredFileDto>,
    /// `owner/name` written into, and the module's directory there.
    pub repo: String,
    pub path: String,
    pub dry_run: bool,
    /// The manifest written: `gear.gdl` (the Gearbox engine's description)
    /// when the engine is configured, else `gear.toml` -- and always
    /// `gear.toml` inside a crate's `src/`.
    pub manifest: String,
}

/// The registry, narrowed and paged.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryEntryListDto {
    pub items: Vec<RegistryEntryDto>,
    pub total: u32,
}

#[derive(Debug, Default, serde::Deserialize)]
pub struct RegistryQuery {
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(flatten)]
    pub page: crate::pagination::PageQuery,
}

fn source_dto(s: RepoSource) -> RepoSourceDto {
    RepoSourceDto {
        tenant: s.tenant,
        connection_id: s.connection_id,
        repo: s.repo,
        git_ref: Some(s.git_ref).filter(|r| !r.is_empty()),
        mode: Some(s.mode).filter(|m| !m.is_empty()),
        shadowed_by_platform: None,
    }
}

/// The organization's sources as `GET /sources` answers them: each marked
/// whether the platform already reads it (ADR-0042). The platform's own
/// sources, read as the platform, are never marked.
async fn marked_sources(
    catalog: &Catalog,
    ctx: &SecurityContext,
    sources: Vec<RepoSource>,
) -> Vec<RepoSourceDto> {
    let platform = match catalog.service.platform_ctx(ctx) {
        Some(p) => catalog
            .service
            .list_sources(&p)
            .await
            .inspect_err(|e| {
                tracing::warn!(error = %format!("{e:#}"), "components-catalog: the platform's sources unreadable");
            })
            .unwrap_or_default(),
        None => Vec::new(),
    };
    sources
        .into_iter()
        .map(|s| {
            let shadowed = super::tiers::shadowed_by_platform(&s, &platform);
            let mut dto = source_dto(s);
            dto.shadowed_by_platform = Some(shadowed);
            dto
        })
        .collect()
}

fn source_of(d: RepoSourceDto) -> RepoSource {
    RepoSource {
        tenant: d.tenant,
        connection_id: d.connection_id,
        repo: d.repo,
        git_ref: d.git_ref.unwrap_or_default(),
        mode: d.mode.unwrap_or_else(|| "gears".to_string()),
    }
}

/// An entry as the registry routes answer it.
pub(crate) fn registry_entry_dto(e: super::registry::RegistryEntry) -> RegistryEntryDto {
    RegistryEntryDto {
        name: e.entry.name,
        kind: e.entry.kind,
        state: e.entry.state,
        description: e.entry.description,
        category: e.entry.category,
        owner: e.entry.owner.map(|o| RegistryOwnerDto {
            kind: o.kind,
            id: o.id,
            name: o.name,
        }),
        capabilities: e.entry.capabilities,
        aliases: e.entry.aliases,
        merged_into: e.entry.merged_into,
        replaced_by: e.entry.replaced_by,
        version: e.entry.version,
        extraction: e.entry.extraction.map(extraction_dto),
        contribution: e.entry.contribution.map(|c| RegistryContributionDto {
            repo: c.repo,
            branch: c.branch,
            pr_url: c.pr_url,
            path: c.path,
            files: u32::try_from(c.files).unwrap_or(u32::MAX),
            at: c.at,
            by: c.by,
            by_name: c.by_name,
        }),
        consumers: e
            .entry
            .consumers
            .into_iter()
            .map(|c| RegistryConsumerDto {
                project_id: c.project_id,
                project_name: c.project_name,
                via: c.via,
            })
            .collect(),
        suggestion: e.entry.suggestion.map(suggestion_dto),
        orphaned: e.entry.orphaned,
        first_seen: e.entry.first_seen,
        last_seen: e.entry.last_seen,
        score: e.entry.score,
        evidence: e
            .entry
            .evidence
            .into_iter()
            .map(|v| EvidenceDto {
                signal: v.signal,
                detail: v.detail,
                weight: v.weight,
            })
            .collect(),
        occurrences: e
            .occurrences
            .into_iter()
            .map(|o| OccurrenceDto {
                scope: o.scope_name().to_owned(),
                project_id: o.project_id,
                project_name: o.project_name,
                repo: o.repo,
                git_ref: o.git_ref,
                path: o.path,
                commit: o.commit,
                declared_in: o.declared_in,
            })
            .collect(),
        decisions: None,
        publish_preview: None,
        extract_preview: None,
    }
}

/// An extraction as the registry routes answer it.
pub(crate) fn extraction_dto(x: super::registry::Extraction) -> RegistryExtractionDto {
    RegistryExtractionDto {
        crate_name: x.crate_name,
        version: x.version,
        tag: x.tag,
        gear_repo: x.gear_repo,
        gear_path: x.gear_path,
        gear_pr_url: x.gear_pr_url,
        project_id: x.project_id,
        project_name: x.project_name,
        source_repo: x.source_repo,
        source_path: x.source_path,
        source_pr_url: x.source_pr_url,
        at: x.at,
        by: x.by,
        by_name: x.by_name,
        completed_at: x.completed_at,
        tagged_commit: x.tagged_commit,
    }
}

/// An extraction's plan as a dry run answers it.
pub(crate) fn extract_preview_dto(
    p: super::registry_extract::ExtractPlan,
) -> RegistryExtractPreviewDto {
    let manifest_path = format!("{}/Cargo.toml", p.extraction.gear_path);
    RegistryExtractPreviewDto {
        manifest: p
            .gear_files
            .iter()
            .find(|f| f.path == manifest_path)
            .map(|f| f.content.clone()),
        crate_name: p.extraction.crate_name,
        version: p.extraction.version,
        tag: p.extraction.tag,
        gear_repo: p.gear_target.repo,
        gear_base: p.gear_target.base_branch,
        gear_path: p.extraction.gear_path,
        gear_files: p.gear_files.into_iter().map(|f| f.path).collect(),
        source_repo: p.source_target.repo,
        source_base: p.source_target.base_branch,
        source_files: p.source_files.into_iter().map(|f| f.path).collect(),
        source_deleted: p.source_deleted,
        branch: p.extraction.gear_branch,
        skipped: p.skipped,
    }
}

/// A publish's plan as a dry run answers it.
pub(crate) fn publish_preview_dto(
    p: super::registry_publish::PublishPlan,
) -> RegistryPublishPreviewDto {
    RegistryPublishPreviewDto {
        repo: p.target.repo,
        base_branch: p.target.base_branch,
        branch: p.branch,
        path: p.path,
        files: p.files.into_iter().map(|f| f.path).collect(),
        skipped: p.skipped,
        title: p.text.title,
        source_id: p.source_id,
        targets: p
            .targets
            .into_iter()
            .map(|t| RegistryPublishTargetDto {
                source_id: t.source_id,
                repo: t.repo,
                gears_in_category: u32::try_from(t.gears_in_category).unwrap_or(u32::MAX),
            })
            .collect(),
    }
}

/// A suggestion as the registry routes answer it.
pub(crate) fn suggestion_dto(s: super::registry::Suggestion) -> RegistrySuggestionDto {
    RegistrySuggestionDto {
        description: s.description,
        category: s.category,
        capabilities: s.capabilities,
        at: s.at,
        model: s.model,
    }
}

/// A decision as the registry routes answer it.
pub(crate) fn registry_decision_dto(
    d: super::registry_decisions::DecisionRecord,
) -> RegistryDecisionDto {
    RegistryDecisionDto {
        action: d.action,
        from: d.from,
        to: d.to,
        by: d.by,
        by_name: d.by_name,
        at: d.at,
        reason: d.reason,
        details: d.details,
    }
}

/// An entry with its decisions, as the single-entry read answers it.
pub(crate) fn registry_entry_detail_dto(
    e: super::registry::RegistryEntry,
    decisions: Vec<super::registry_decisions::DecisionRecord>,
) -> RegistryEntryDto {
    RegistryEntryDto {
        decisions: Some(decisions.into_iter().map(registry_decision_dto).collect()),
        ..registry_entry_dto(e)
    }
}

/// The decision a request carries, in the service's terms.
fn decision_input(body: RegistryDecisionRequest) -> super::registry_decisions::DecisionInput {
    super::registry_decisions::DecisionInput {
        action: body.action,
        reason: body.reason,
        owner: body.owner.map(|o| super::registry::Owner {
            kind: o.kind,
            id: o.id,
            name: o.name,
        }),
        kind: body.kind,
        category: body.category,
        capabilities: body.capabilities,
        description: body.description,
        replaced_by: body.replaced_by,
        merge_into: body.merge_into,
        version: body.version,
        contribution: None,
        extraction: None,
        dry_run: body.dry_run.unwrap_or(false),
        target: body
            .target
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty()),
    }
}

/// The privilege that moves a registry entry's lifecycle (ADR-0041 P2).
///
/// Deciding what is the organization's component is administration: one
/// answer per organization, asked of studio-user (ADR-0040), never of the
/// PDP, whose clamp would admit every member.
pub(crate) const REGISTRY_PRIVILEGE: &str = "component.registry";

/// May the caller decide about the organization's registry? Its owner or a
/// platform administrator may; on the roles model, so may whoever holds
/// [`REGISTRY_PRIVILEGE`]. Without studio-user nobody can be shown to hold
/// it, so nobody does.
pub(crate) async fn may_decide(
    authority: Option<&dyn crate::user_profile::OrgAuthority>,
    ctx: &SecurityContext,
) -> bool {
    match authority {
        Some(authority) => {
            authority
                .may_administer(ctx, ctx.subject_tenant_id(), REGISTRY_PRIVILEGE)
                .await
        }
        None => false,
    }
}

/// A refused decision as a problem: 404 for an entry that is not there, 400
/// `failed_precondition` for a move its state does not allow, 400
/// `invalid_argument` for an incomplete request.
fn decision_problem(e: super::registry_decisions::DecisionError) -> CanonicalError {
    use super::registry_decisions::DecisionError as E;
    let message = e.to_string();
    match e {
        E::NotFound(name) => StudioComponentsCatalogError::not_found(message)
            .with_resource(name)
            .create(),
        E::Illegal { action, from } => StudioComponentsCatalogError::failed_precondition()
            .with_precondition_violation(
                format!("state:{from}"),
                format!("{message}; `{action}` applies to {}", allowed_from(&action)),
                "REGISTRY_TRANSITION_NOT_ALLOWED",
            )
            .create(),
        E::UnknownAction(_) => StudioComponentsCatalogError::invalid_argument()
            .with_field_violation("action", message, "INVALID")
            .create(),
        E::Invalid { field, .. } => StudioComponentsCatalogError::invalid_argument()
            .with_field_violation(field, message, "INVALID")
            .create(),
        E::UnknownEntry { field, .. } => StudioComponentsCatalogError::invalid_argument()
            .with_field_violation(field, message, "UNKNOWN_ENTRY")
            .create(),
    }
}

/// The states an action applies to, for the refusal's words.
fn allowed_from(action: &str) -> String {
    use super::registry_decisions::{Action, transition};
    let Some(action) = Action::parse(action) else {
        return "nothing".to_owned();
    };
    let from: Vec<&str> = super::registry::STATES
        .into_iter()
        .filter(|s| transition(action, s, true).is_some())
        .collect();
    from.join(", ")
}

fn internal(e: anyhow::Error) -> CanonicalError {
    CanonicalError::internal(format!("{e:#}")).create()
}

impl Catalog {
    /// Make sure the organization's registry is walked every hour: a
    /// platform-level schedule naming it (see `registry_task`). Best effort --
    /// without a scheduler the registry is still walked by a sync and a push.
    async fn ensure_registry_schedule(&self, ctx: &SecurityContext) {
        let Ok(schedules) = self.hub.get::<dyn crate::scheduler::port::Schedules>() else {
            tracing::info!(
                "components-catalog: no scheduler; the registry is walked on sync and push only"
            );
            return;
        };
        let spec = super::registry_task::schedule_spec(ctx.subject_tenant_id());
        if let Err(e) = schedules.ensure(ctx, spec).await {
            tracing::warn!(error = %format!("{e:#}"), "components-catalog: the registry schedule could not be ensured");
        }
    }
}

async fn list_sources(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<RepoSourceListDto>> {
    let stored = catalog.service.list_sources(&ctx).await.map_err(internal)?;
    let items = marked_sources(&catalog, &ctx, stored).await;
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(RepoSourceListDto { items, total }))
}

async fn update_sources(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Json(body): Json<ReplaceSourcesRequest>,
) -> ApiResult<JsonBody<RepoSourceListDto>> {
    let sources = owned_sources(
        &catalog,
        &ctx,
        body.items.into_iter().map(source_of).collect(),
    )
    .await?;
    let stored = catalog
        .service
        .replace_sources(&ctx, sources)
        .await
        .map_err(internal)?;
    let items = marked_sources(&catalog, &ctx, stored).await;
    catalog.ensure_registry_schedule(&ctx).await;
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(RepoSourceListDto { items, total }))
}

/// An organization's sources, each naming the tenant its connection is read
/// from: the organization when none is named (the nil id), else one within
/// it. One naming a tenant outside it -- the platform's root, whose
/// connections the organization only inherits -- is a 400
/// (`SOURCE_TENANT_NOT_OWNED`). See [`super::ownership`].
async fn owned_sources(
    catalog: &Catalog,
    ctx: &SecurityContext,
    sources: Vec<RepoSource>,
) -> ApiResult<Vec<RepoSource>> {
    let org = ctx.subject_tenant_id();
    let mut out = Vec::with_capacity(sources.len());
    for s in sources {
        let tree = super::service::TreeAs(catalog.service.as_ref(), ctx);
        let owned = super::ownership::owned_source(org, s, &tree)
            .await
            .map_err(source_tenant_refusal)?;
        out.push(owned);
    }
    Ok(out)
}

/// [`owned_sources`] for the roadmap boards a sync body names.
async fn owned_roadmaps(
    catalog: &Catalog,
    ctx: &SecurityContext,
    roadmaps: Vec<RoadmapSource>,
) -> ApiResult<Vec<RoadmapSource>> {
    let org = ctx.subject_tenant_id();
    let mut out = Vec::with_capacity(roadmaps.len());
    for mut r in roadmaps {
        let tree = super::service::TreeAs(catalog.service.as_ref(), ctx);
        r.tenant = super::ownership::source_tenant(org, r.tenant, &tree)
            .await
            .map_err(source_tenant_refusal)?;
        out.push(r);
    }
    Ok(out)
}

fn source_tenant_refusal(tenant: Uuid) -> CanonicalError {
    StudioComponentsCatalogError::failed_precondition()
        .with_precondition_violation(
            format!("tenant:{tenant}"),
            format!(
                "the source names tenant {tenant}, which is not this organization nor within \
                 it; a source reads only through a connection of the organization's own"
            ),
            super::ownership::SOURCE_TENANT_NOT_OWNED,
        )
        .create()
}

// ── the platform's catalogue (ADR-0042) ─────────────────────────────────────

/// The platform's catalogue sources and crates.io keyword.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlatformSourcesDto {
    pub items: Vec<RepoSourceDto>,
    pub total: u32,
    /// The crates.io keyword the platform's catalogue syncs; null for none.
    pub crates_io: Option<String>,
}

/// What replaces the platform's catalogue sources.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ReplacePlatformSourcesRequest {
    pub items: Vec<RepoSourceDto>,
    /// The crates.io keyword; null or blank for no crates.io source.
    pub crates_io: Option<String>,
}

/// May the caller run the platform's catalogue? Only a platform
/// administrator, as studio-user answers it; without studio-user nobody can
/// be shown to be one, so nobody is.
pub(crate) async fn may_run_platform(
    reader: Option<&dyn crate::user_profile::OrganizationReader>,
    ctx: &SecurityContext,
) -> bool {
    match reader {
        Some(reader) => reader
            .is_platform_admin(&ctx.subject_id().to_string())
            .await
            .unwrap_or(false),
        None => false,
    }
}

fn platform_refusal() -> CanonicalError {
    StudioComponentsCatalogError::permission_denied()
        .with_reason("PLATFORM_ADMIN_REQUIRED")
        .create()
}

impl Catalog {
    /// studio-user's reader, resolved per request like every other port.
    fn organizations(&self) -> Option<Arc<dyn crate::user_profile::OrganizationReader>> {
        self.hub
            .get_scoped::<dyn crate::user_profile::OrganizationReader>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            ))
            .ok()
    }

    /// The caller acting in the platform's tenant, once shown to be a
    /// platform administrator; 403 otherwise.
    async fn as_platform(&self, ctx: &SecurityContext) -> ApiResult<SecurityContext> {
        if !may_run_platform(self.organizations().as_deref(), ctx).await {
            return Err(platform_refusal());
        }
        super::registry::in_tenant(ctx, super::tiers::PLATFORM_TENANT).map_err(internal)
    }

    /// Make sure the platform's catalogue is synced daily. Best effort, like
    /// the registry's schedule.
    async fn ensure_platform_schedule(&self, pctx: &SecurityContext) {
        let Ok(schedules) = self.hub.get::<dyn crate::scheduler::port::Schedules>() else {
            tracing::info!(
                "components-catalog: no scheduler; the platform's catalogue syncs when asked"
            );
            return;
        };
        if let Err(e) = schedules
            .ensure(pctx, super::sync_task::platform_schedule_spec())
            .await
        {
            tracing::warn!(error = %format!("{e:#}"), "components-catalog: the platform's schedule could not be ensured");
        }
    }
}

async fn list_platform_sources(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<PlatformSourcesDto>> {
    let pctx = catalog.as_platform(&ctx).await?;
    let items: Vec<RepoSourceDto> = catalog
        .service
        .list_sources(&pctx)
        .await
        .map_err(internal)?
        .into_iter()
        .map(source_dto)
        .collect();
    let crates_io = catalog
        .service
        .stored_keyword(&pctx)
        .await
        .map_err(internal)?;
    Ok(Json(PlatformSourcesDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        crates_io,
    }))
}

async fn update_platform_sources(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    Json(body): Json<ReplacePlatformSourcesRequest>,
) -> ApiResult<JsonBody<PlatformSourcesDto>> {
    let pctx = catalog.as_platform(&ctx).await?;
    let items: Vec<RepoSourceDto> = catalog
        .service
        .replace_sources(&pctx, body.items.into_iter().map(source_of).collect())
        .await
        .map_err(internal)?
        .into_iter()
        .map(source_dto)
        .collect();
    let crates_io = catalog
        .service
        .set_stored_keyword(&pctx, body.crates_io)
        .await
        .map_err(internal)?;
    catalog.ensure_platform_schedule(&pctx).await;
    Ok(Json(PlatformSourcesDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        crates_io,
    }))
}

async fn sync_platform(
    Extension(ctx): Extension<SecurityContext>,
    Extension(catalog): Extension<Catalog>,
    headers: HeaderMap,
) -> ApiResult<(StatusCode, JsonBody<CatalogSyncEnqueued>)> {
    let pctx = catalog.as_platform(&ctx).await?;
    let idempotency_key = crate::idempotency::key(&headers)?;
    let queue = catalog.queue()?;
    let run_id = queue
        .enqueue(
            &pctx,
            crate::tasks::sdk::NewRun {
                tenant: super::tiers::PLATFORM_TENANT,
                task_type: TASK_TYPE,
                payload: super::sync_task::platform_payload(),
                partition_key: Some("catalog"),
                idempotency_key: idempotency_key.as_deref(),
                coalesce_queued: true,
                notify_workspace_id: None,
            },
        )
        .await
        .map_err(internal)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(CatalogSyncEnqueued {
            run_id: run_id.to_string(),
            status: "queued".to_string(),
        }),
    ))
}

async fn list_registry_entries(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Query(q): Query<RegistryQuery>,
) -> ApiResult<JsonBody<RegistryEntryListDto>> {
    let project_id = match q.project_id.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(raw) => Some(Uuid::parse_str(raw).map_err(|_| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("project_id `{raw}` is not a UUID"))
                .create()
        })?),
    };
    let state = q.state.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(s) = state
        && !super::registry::STATES.contains(&s)
    {
        return Err(StudioComponentsCatalogError::invalid_argument()
            .with_constraint(format!(
                "state `{s}` is not one of {:?}",
                super::registry::STATES
            ))
            .create());
    }
    let entries = catalog
        .service
        .registry_entries(&ctx)
        .await
        .map_err(internal)?;
    let matched = super::registry::filter_entries(entries, state, project_id, q.q.as_deref());
    let (page, total) = crate::pagination::page_of(matched, q.page);
    Ok(Json(RegistryEntryListDto {
        items: page.into_iter().map(registry_entry_dto).collect(),
        total,
    }))
}

async fn get_registry_entry(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(name): Path<String>,
) -> ApiResult<JsonBody<RegistryEntryDto>> {
    match catalog
        .service
        .registry_entry_with_decisions(&ctx, &name)
        .await
        .map_err(internal)?
    {
        Some((entry, decisions)) => Ok(Json(registry_entry_detail_dto(entry, decisions))),
        None => Err(StudioComponentsCatalogError::not_found(format!(
            "the registry has no component `{name}`"
        ))
        .with_resource(name)
        .create()),
    }
}

impl Catalog {
    /// Who may decide about the registry: studio-user's answer, resolved per
    /// request like every other port.
    fn authority(&self) -> Option<Arc<dyn crate::user_profile::OrgAuthority>> {
        self.hub
            .get_scoped::<dyn crate::user_profile::OrgAuthority>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            ))
            .ok()
    }

    /// The caller as a person with the name their profile carries, when
    /// studio-user can say; else the token's subject and no name, which is
    /// what a decision records then. The name is stored on the decision
    /// (`by_name`), so the page shows a person, not an id.
    async fn decider(&self, ctx: &SecurityContext) -> super::registry_decisions::Decider {
        let person = match self
            .hub
            .get_scoped::<dyn crate::user_profile::PersonResolver>(&ClientScope::gts_id(
                crate::user_profile::IDENTITY_INSTANCE_ID,
            )) {
            Ok(people) => match people.resolve_caller_named(ctx).await {
                Ok(named) => Some(named),
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), "components-catalog: the decider could not be resolved as a person; the token's subject is recorded");
                    None
                }
            },
            Err(_) => None,
        };
        match person {
            Some((id, name)) => super::registry_decisions::Decider { id, name },
            None => super::registry_decisions::Decider {
                id: ctx.subject_id().to_string(),
                name: None,
            },
        }
    }
}

async fn decide_registry_entry(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(name): Path<String>,
    Json(body): Json<RegistryDecisionRequest>,
) -> ApiResult<JsonBody<RegistryEntryDto>> {
    let input = decision_input(body);
    decide_as(&catalog, &ctx, &name, input).await.map(Json)
}

/// The platform's answers to a publication: a platform curator's, never an
/// organization administrator's (ADR-0042 §4).
fn is_curators_action(action: Option<super::registry_decisions::Action>) -> bool {
    use super::registry_decisions::Action;
    matches!(
        action,
        Some(Action::Publish | Action::DeclinePublication | Action::MarkPublished)
    )
}

fn curator_refusal() -> CanonicalError {
    StudioComponentsCatalogError::permission_denied()
        .with_reason("PLATFORM_CURATOR_REQUIRED")
        .create()
}

/// One decision about an entry of the organization `ctx` acts in, checked
/// and made: the decisions route, and a curator's answer from the platform's
/// queue (acting in the requesting organization).
pub(super) async fn decide_as(
    catalog: &Catalog,
    ctx: &SecurityContext,
    name: &str,
    input: super::registry_decisions::DecisionInput,
) -> ApiResult<RegistryEntryDto> {
    use super::registry_decisions::Action;
    let action = Action::parse(&input.action);
    if is_curators_action(action) {
        if !catalog.may_curate(ctx).await {
            return Err(curator_refusal());
        }
    } else if !may_decide(catalog.authority().as_deref(), ctx).await {
        return Err(StudioComponentsCatalogError::permission_denied()
            .with_reason("REGISTRY_ADMIN_REQUIRED")
            .create());
    }
    let org = ctx.subject_tenant_id();
    if input.dry_run && !matches!(action, Some(Action::Publish | Action::Extract)) {
        return Err(StudioComponentsCatalogError::invalid_argument()
            .with_field_violation(
                "dry_run",
                "only a publish or an extract has a dry run; every other decision is recorded as made",
                "INVALID",
            )
            .create());
    }
    // Extract opens two pull requests, and completing it checks them and
    // tags the version (ADR-0044 §1).
    match action {
        Some(Action::Extract) => return extract::extract(catalog, ctx, name, &input).await,
        Some(Action::CompleteExtraction) => {
            return extract::complete(catalog, ctx, name, &input).await;
        }
        _ => {}
    }
    // Publishing opens a pull request into the platform (ADR-0042 §4), and
    // only on the organization's request.
    if action == Some(Action::Publish) {
        let requested = catalog
            .service
            .publication_request(ctx, org, name)
            .await
            .map_err(internal)?;
        if requested.is_none() {
            return Err(StudioComponentsCatalogError::failed_precondition()
                .with_precondition_violation(
                    format!("publication:{name}"),
                    "the organization has not asked the platform to take this component: an \
                     organization administrator requests publication first",
                    "PUBLICATION_NOT_REQUESTED",
                )
                .create());
        }
        let published = publish::publish(catalog, ctx, name, &input).await?.0;
        if !input.dry_run
            && let Err(e) = catalog
                .service
                .drop_publication_request(ctx, org, name)
                .await
        {
            tracing::warn!(error = %format!("{e:#}"), %org, entry = %name, "components-catalog: published, but the request stays in the platform's queue");
        }
        return Ok(published);
    }
    let by = catalog.decider(ctx).await;
    let (entry, decisions) = match catalog
        .service
        .decide_registry(ctx, name, &input, &by)
        .await
    {
        Ok(done) => done,
        Err(super::registry_decisions::DecideFailure::Refused(e)) => {
            return Err(decision_problem(e));
        }
        Err(super::registry_decisions::DecideFailure::Failed(e)) => return Err(internal(e)),
    };
    // The queue follows the decision: a request joins it, an answer leaves it.
    let queued = match action {
        Some(Action::RequestPublication) => {
            let request = super::registry_curation::PublicationRequest {
                organization_id: org,
                organization_name: catalog.service.tenant_name(ctx, org).await,
                name: entry.entry.name.clone(),
                version: input
                    .version
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned),
                reason: input
                    .reason
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned),
                requested_by: by.id.clone(),
                requested_by_name: by.name.clone(),
                at: super::registry::now(),
            };
            catalog.service.put_publication_request(ctx, request).await
        }
        Some(Action::DeclinePublication | Action::Deprecate | Action::Merge) => catalog
            .service
            .drop_publication_request(ctx, org, &entry.entry.name)
            .await
            .map(|_| ()),
        _ => Ok(()),
    };
    if let Err(e) = queued {
        tracing::warn!(error = %format!("{e:#}"), %org, entry = %entry.entry.name, "components-catalog: the decision is recorded, but the platform's queue did not follow it");
    }
    Ok(registry_entry_detail_dto(entry, decisions))
}

impl Catalog {
    /// May the caller answer publications -- publish, decline, mark published?
    /// A platform administrator, or one of the platform's gear curators
    /// (`platform-gear-curator`, `registry_curation.rs`).
    pub(super) async fn may_curate(&self, ctx: &SecurityContext) -> bool {
        if may_run_platform(self.organizations().as_deref(), ctx).await {
            return true;
        }
        let me = self.decider(ctx).await;
        match self.service.gear_curators(ctx).await {
            Ok(curators) => super::registry_curation::is_curator(&curators, &me.id),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "components-catalog: the platform's gear curators could not be read; nobody but a platform administrator curates");
                false
            }
        }
    }

    /// May the caller name the platform's gear curators? Its administrators.
    pub(super) async fn may_run_the_platform(&self, ctx: &SecurityContext) -> bool {
        may_run_platform(self.organizations().as_deref(), ctx).await
    }
}

impl Catalog {
    /// Declare it's writer, studio-product's, resolved per request: a 503
    /// in an assembly without it.
    fn declarations(&self) -> ApiResult<Arc<dyn crate::product::port::GearDeclarations>> {
        self.hub
            .get::<dyn crate::product::port::GearDeclarations>()
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "declaring a gear is not available in this deployment \
                         (studio-product is not part of it)",
                    )
                    .create()
            })
    }
}

/// The request in the service's terms; no body is an empty one.
fn declare_input(body: Option<RegistryDeclareRequest>) -> super::registry_declare::DeclareInput {
    match body {
        Some(b) => super::registry_declare::DeclareInput {
            description: b.description,
            capabilities: b.capabilities,
            category: b.category,
            dry_run: b.dry_run.unwrap_or(false),
            project_id: b.project_id,
        },
        None => super::registry_declare::DeclareInput::default(),
    }
}

/// A refused Declare it as a problem: 404 for no such entry, 400
/// `failed_precondition` for an entry that is not a candidate or cannot be
/// written to yet.
fn declare_problem(e: super::registry_declare::DeclareError) -> CanonicalError {
    use super::registry_declare::DeclareError as E;
    let message = e.to_string();
    let precondition = |subject: String, kind: &str| {
        StudioComponentsCatalogError::failed_precondition()
            .with_precondition_violation(subject, message.clone(), kind)
            .create()
    };
    match e {
        E::NotFound(name) => StudioComponentsCatalogError::not_found(message.clone())
            .with_resource(name)
            .create(),
        E::NotCandidate { state } => {
            precondition(format!("state:{state}"), "REGISTRY_NOT_A_CANDIDATE")
        }
        E::NoOccurrence => precondition("occurrence".to_owned(), "REGISTRY_NO_OCCURRENCE"),
        E::NoConnection => precondition("connection".to_owned(), "REGISTRY_CONNECTION_UNKNOWN"),
        E::NotOwnConnection { tenant } => {
            precondition(format!("connection:{tenant}"), "CONNECTION_NOT_OWNED")
        }
    }
}

fn declared_dto(d: super::registry_declare::Declared, dry_run: bool) -> RegistryDeclareResultDto {
    RegistryDeclareResultDto {
        branch: d.branch,
        pr_url: d.pr_url,
        files: d
            .files
            .into_iter()
            .map(|f| DeclaredFileDto {
                path: f.path,
                content: f.content,
            })
            .collect(),
        repo: d.repo,
        path: d.path,
        dry_run,
        manifest: d.manifest,
    }
}

async fn declare_registry_entry(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(name): Path<String>,
    body: Option<Json<RegistryDeclareRequest>>,
) -> ApiResult<JsonBody<RegistryDeclareResultDto>> {
    if !may_decide(catalog.authority().as_deref(), &ctx).await {
        return Err(StudioComponentsCatalogError::permission_denied()
            .with_reason("REGISTRY_ADMIN_REQUIRED")
            .create());
    }
    let declarations = catalog.declarations()?;
    let by = catalog.decider(&ctx).await;
    let input = declare_input(body.map(|Json(b)| b));
    match catalog
        .service
        .declare_candidate(&ctx, &name, &input, &by, declarations.as_ref())
        .await
    {
        Ok(done) => Ok(Json(declared_dto(done, input.dry_run))),
        Err(super::registry_declare::DeclareFailure::Refused(e)) => Err(declare_problem(e)),
        Err(super::registry_declare::DeclareFailure::Failed(e)) => Err(internal(e)),
    }
}

async fn list_registry_projects(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<RegistryProjectListDto>> {
    let walked = catalog.service.last_walk(&ctx).await.map_err(internal)?;
    let items: Vec<RegistryProjectDto> = walked
        .into_iter()
        .map(|p| RegistryProjectDto {
            project_id: p.project_id,
            project_name: p.project_name,
            at: p.at,
            error: p.error,
            repos: p
                .repos
                .into_iter()
                .map(|r| RegistryRepoStatusDto {
                    repo: r.repo,
                    status: r.status,
                    components: u32::try_from(r.components).unwrap_or(u32::MAX),
                    error: r.error,
                    hint: r.hint,
                })
                .collect(),
        })
        .collect();
    Ok(Json(RegistryProjectListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

async fn get_registry_excluded_projects(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<ExcludedProjectsDto>> {
    let project_ids = catalog
        .service
        .excluded_projects(&ctx)
        .await
        .map_err(internal)?;
    Ok(Json(ExcludedProjectsDto { project_ids }))
}

async fn update_registry_excluded_projects(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Json(body): Json<ExcludedProjectsDto>,
) -> ApiResult<JsonBody<ExcludedProjectsDto>> {
    let project_ids = catalog
        .service
        .set_excluded_projects(&ctx, body.project_ids)
        .await
        .map_err(internal)?;
    catalog.ensure_registry_schedule(&ctx).await;
    Ok(Json(ExcludedProjectsDto { project_ids }))
}

fn register_platform_routes(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    let router = OperationBuilder::get("/studio-components-catalog/v1/platform/sources")
        .operation_id("studio_components_catalog.list_platform_sources")
        .summary("The platform's catalogue sources")
        .description(
            "The repositories and the crates.io keyword the platform's catalogue \
             reads (ADR-0042), stored in the platform's tenant. Every \
             organization's catalogue reads the platform's beside its own. 403 \
             for anyone but a platform administrator.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_platform_sources)
        .json_response_with_schema::<PlatformSourcesDto>(openapi, StatusCode::OK, "Sources")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-components-catalog/v1/platform/sources")
        .operation_id("studio_components_catalog.update_platform_sources")
        .summary("Replace the platform's catalogue sources")
        .description(
            "Replaces the platform's catalogue sources and crates.io keyword \
             (ADR-0042), normalized as `PUT /sources` normalizes an \
             organization's. Also makes sure the platform's catalogue is synced \
             daily (a `catalog.sync` schedule with `{\"platform\": true}`). 403 \
             for anyone but a platform administrator.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(update_platform_sources)
        .json_request::<ReplacePlatformSourcesRequest>(openapi, "The sources")
        .json_response_with_schema::<PlatformSourcesDto>(openapi, StatusCode::OK, "Stored sources")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    OperationBuilder::post("/studio-components-catalog/v1/platform/sync")
        .operation_id("studio_components_catalog.sync_platform")
        .summary("Enqueue a sync of the platform's catalogue")
        .description(
            "Queues a `catalog.sync` run in the platform's tenant that reads the \
             platform's stored sources when it starts (ADR-0042). Answers 202 \
             with the `run_id` to follow at `GET /studio-tasks/v1/runs/{run_id}`. \
             Send an `Idempotency-Key` header to make a retry safe. 403 for \
             anyone but a platform administrator.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .param(crate::idempotency::param())
        .handler(sync_platform)
        .json_response_with_schema::<CatalogSyncEnqueued>(
            openapi,
            StatusCode::ACCEPTED,
            "Sync enqueued",
        )
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
}

#[path = "registry_gear_repository_rest.rs"]
mod gear_repository;

#[path = "registry_publish_rest.rs"]
mod publish;

#[path = "registry_curation_rest.rs"]
mod curation;

#[path = "catalogue_levels_rest.rs"]
mod catalogue_levels_routes;

#[path = "registry_readiness_rest.rs"]
mod readiness_routes;

#[path = "registry_extract_rest.rs"]
mod extract;

#[path = "screen_previews_rest.rs"]
mod screen_previews;

#[cfg(test)]
#[path = "sources_rest_tests.rs"]
mod sources_tests;

fn register_registry_routes(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    let router = register_platform_routes(router, openapi);
    // Before `/registry/{name}`'s routes, though axum prefers the literal
    // segment either way.
    let router = gear_repository::register(router, openapi);
    let router = publish::register(router, openapi);
    let router = curation::register(router, openapi);
    let router = catalogue_levels_routes::register(router, openapi);
    let router = readiness_routes::register(router, openapi);
    let router = OperationBuilder::get("/studio-components-catalog/v1/sources")
        .operation_id("studio_components_catalog.list_sources")
        .summary("The organization's catalogue sources, kept on the server")
        .description(
            "The repositories the organization's catalogue reads, each with its \
             connection, ref and mode, in the order they were saved. A sync whose \
             body names no `repositories` reads these (ADR-0041); they replace the \
             browser's `cf.components.sources`.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_sources)
        .json_response_with_schema::<RepoSourceListDto>(openapi, StatusCode::OK, "Sources")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-components-catalog/v1/sources")
        .operation_id("studio_components_catalog.update_sources")
        .summary("Replace the organization's catalogue sources")
        .description(
            "Replaces the organization's catalogue sources with the ones sent: a \
             blank repository is dropped, one named twice (same ref and mode) is \
             kept once, a missing mode is `gears`. A source's `tenant` (whose \
             connection it reads through) is the organization when nil, else must \
             be the organization or within it: one outside it, such as the \
             platform's root, is a 400 `SOURCE_TENANT_NOT_OWNED`. Answers what was stored. Also \
             makes sure the organization's registry is walked hourly (a \
             platform-level `catalog.registry` schedule naming it).",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(update_sources)
        .json_request::<ReplaceSourcesRequest>(openapi, "The sources")
        .json_response_with_schema::<RepoSourceListDto>(openapi, StatusCode::OK, "Stored sources")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/registry")
        .operation_id("studio_components_catalog.list_registry_entries")
        .summary("The organization's registry of components, each with where it was found")
        .description(
            "Every component the organization's projects declare (ADR-0041): one \
             entry per name, with its lifecycle `state` and its occurrences \
             (project, repository, ref, path, commit and what declares it). \
             Filled by the `catalog.registry` walk -- hourly, after a push through \
             studio-git, and as the last phase of a sync of the stored sources. \
             `state`, `project_id` and `q` (name or description) narrow it; \
             sorted by name; `offset`/`limit` page it. An entry with no \
             occurrence left is `orphaned` and kept.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(
            "state",
            false,
            "candidate, declared, registered, published, rejected, deprecated or merged",
        )
        .query_param("project_id", false, "Only entries found in this project")
        .query_param("q", false, "Text in the name or the description")
        .query_param_typed(
            "offset",
            false,
            "Zero-based index of the first entry",
            "integer",
        )
        .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_registry_entries)
        .json_response_with_schema::<RegistryEntryListDto>(openapi, StatusCode::OK, "Entries")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/registry/{name}")
        .operation_id("studio_components_catalog.get_registry_entry")
        .summary("One component of the organization's registry, with its occurrences")
        .description(
            "One registry entry by name (case-blind), with every place it was \
             found and the decisions people made about it, newest first. 404 \
             when the registry has no such component.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("name", "Component name")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_registry_entry)
        .json_response_with_schema::<RegistryEntryDto>(openapi, StatusCode::OK, "The entry")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-components-catalog/v1/registry/{name}/decisions")
        .operation_id("studio_components_catalog.decide_registry_entry")
        .summary("Move a registry entry through its lifecycle, as a recorded decision")
        .description(
            "An organization administrator's decision about one entry (ADR-0041 \
             P2): `register` (candidate or declared, with an `owner`), `reject` \
             (candidate or declared, with a `reason`), `deprecate` (registered or \
             published, optionally `replaced_by` an existing entry), `restore` \
             (rejected back to declared, or candidate when nothing declares it; \
             deprecated back to registered), `publish` (registered: opens a \
             pull request into the platform's gear repository -- the platform's \
             catalogue source in mode `gears` -- copying the directory the entry \
             is declared in, at most 200 files and 2 MiB, under the platform's \
             parent directory for gears, on `contribute/<organization>/<name>`; \
             the entry stays registered with its `contribution`, and becomes \
             `published` when the platform's catalogue has it; 400 \
             `failed_precondition` when the platform has no gear repository, \
             nothing declares the entry, the directory is larger, or the \
             entry's repository is read through a connection the organization \
             only inherits (`CONNECTION_NOT_OWNED`); 503 without \
             studio-product; with `dry_run: true` it writes and records \
             nothing and answers the target repository, branches, path and \
             files in `publish_preview` -- a dry run is a publish's only), \
             `mark_published` (registered to \
             published, optionally with the platform's `version`; a platform \
             administrator only, for when the names differ), `merge` (into the \
             existing entry `merge_into`, \
             which takes this one's occurrences and its name as an alias, so a \
             later walk puts what it finds under that name there) and `edit` \
             (owner, kind, category, capabilities, description; no state move). \
             Every decision is recorded with who, when, the states and why. \
             A move the entry's state does not allow is `failed_precondition`; \
             403 for anyone but the organization's owner, a platform \
             administrator, or a holder of `component.registry`. Answers the \
             entry with its decisions and its `consumers`.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("name", "Component name")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(decide_registry_entry)
        .json_request::<RegistryDecisionRequest>(openapi, "The decision")
        .json_response_with_schema::<RegistryEntryDto>(
            openapi,
            StatusCode::OK,
            "The entry after it",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-components-catalog/v1/registry/{name}/declare")
        .operation_id("studio_components_catalog.open_registry_declaration")
        .summary("Declare a candidate a gear, by a pull request in its repository")
        .description(
            "Declare it (ADR-0041 P3), for a `candidate` entry: opens a pull request \
             in the repository the candidate was detected in, through that \
             repository's connection and in its project's tenant, adding the \
             module's manifest in its directory on the branch `declare/<name>`: \
             the Gearbox engine's `gear.gdl` when the engine is configured, else \
             a `gear.toml` -- and always a `gear.toml` inside a crate's `src/`, \
             where the catalogue skips a `gear.gdl`. `manifest` says which. A \
             repository read through a connection the organization only \
             inherits (the platform's) is refused (400 `CONNECTION_NOT_OWNED`). \
             The body is optional: `description`, \
             `capabilities` and `category` override the entry's own; `project_id` \
             picks the occurrence when the candidate was found in several; \
             `dry_run` answers the files and writes nothing. A `declare` decision \
             is recorded; the entry stays a candidate until a walk reads the merged \
             declaration and makes it `declared`. 403 for anyone but an \
             organization administrator (`component.registry`); 400 \
             `failed_precondition` for an entry that is not a candidate; 503 \
             without studio-product.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("name", "Component name")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(declare_registry_entry)
        .json_request::<RegistryDeclareRequest>(openapi, "What to declare it with (optional)")
        .json_response_with_schema::<RegistryDeclareResultDto>(
            openapi,
            StatusCode::OK,
            "The branch, the pull request and the files",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/registry/projects")
        .operation_id("studio_components_catalog.list_registry_projects")
        .summary("What the last registry walk saw of each project")
        .description(
            "Per project the last walk read: when, and per repository whether it was \
             read anew, unchanged or not readable, how many components it holds, and \
             for a failure what a person can do. A repository connected with a \
             personal token is not readable to the walk, which runs as the service.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_registry_projects)
        .json_response_with_schema::<RegistryProjectListDto>(
            openapi,
            StatusCode::OK,
            "The last walk, per project",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/registry/excluded-projects")
        .operation_id("studio_components_catalog.get_registry_excluded_projects")
        .summary("The projects the registry walk skips")
        .description(
            "The projects of the organization the registry walk leaves out. Every \
             other project is walked: a project is excluded, never opted in.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_registry_excluded_projects)
        .json_response_with_schema::<ExcludedProjectsDto>(
            openapi,
            StatusCode::OK,
            "Excluded projects",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    OperationBuilder::put("/studio-components-catalog/v1/registry/excluded-projects")
        .operation_id("studio_components_catalog.update_registry_excluded_projects")
        .summary("Replace the projects the registry walk skips")
        .description(
            "Replaces the projects the registry walk leaves out, deduplicated. The \
             next full walk retires the occurrences found in them; their entries \
             stay, `orphaned` when nothing else declares them. Also makes sure the \
             organization's registry is walked hourly.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(update_registry_excluded_projects)
        .json_request::<ExcludedProjectsDto>(openapi, "The excluded projects")
        .json_response_with_schema::<ExcludedProjectsDto>(
            openapi,
            StatusCode::OK,
            "Excluded projects",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi)
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<CatalogService>,
    hub: Arc<ClientHub>,
    gearbox: Option<Arc<Gearbox>>,
) -> Router {
    let router = register_registry_routes(router, openapi);
    let router = screen_previews::register(router, openapi);
    let router = OperationBuilder::post("/studio-components-catalog/v1/sync")
        .operation_id("studio_components_catalog.sync")
        .summary("Enqueue a background sync of the crates.io keyword into the graph")
        .description(
            "Lists every crate under the configured keyword (constructorfabric), \
             fetches each crate's detail and version history from crates.io, and \
             upserts gear + crate_version nodes (joined by has_version) into the \
             graph. Answers 202 with the `run_id` to follow at \
             `GET /studio-tasks/v1/runs/{run_id}`. Send an `Idempotency-Key` header \
             to make a retry of this request safe: a repeat with the same key \
             answers the same run. A body that names no `repositories` (or no \
             body) reads the organization's stored sources (`GET /sources`) and \
             then walks its projects into the registry; the run's result carries \
             `registry` counts, or `registry_error`. A repository or board in the \
             body naming a tenant outside the organization is a 400 \
             `SOURCE_TENANT_NOT_OWNED` (nil is the organization); the run reads no \
             source whose connection is held outside the organization and names \
             those in `not_owned`.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .param(crate::idempotency::param())
        .json_request::<SyncRequestDto>(openapi, "Sources to sync")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(sync)
        .json_response_with_schema::<CatalogSyncEnqueued>(
            openapi,
            StatusCode::ACCEPTED,
            "Sync enqueued",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/activity")
        .operation_id("studio_components_catalog.list_gear_activity")
        .summary("What moved in each catalogued gear, over a window")
        .description(
            "Commits, churn, authors and pull requests per GEAR, from the \
             delivery warehouse. The warehouse keys its git metrics by \
             repository and a gear is a directory inside one — `gears-rust` \
             alone holds around ninety — so this operation groups the \
             catalogue by repository, names the directory each crate publishes \
             from, and joins the answers back together. A caller that did that \
             itself would be keeping a second copy of the rules, which is where \
             this came from.\n\n\
             The busiest repositories are asked, up to a small limit, because \
             each is one round trip upstream; `repositories` names the ones \
             that were. `points` is weekly with the gaps filled, so a quiet \
             week draws as a quiet week rather than being skipped.\n\n\
             PULL REQUESTS ARE ATTRIBUTED THROUGH THE FILES their commits \
             touched, so one touching three gears is counted in all three and \
             these rows do not partition the repository. Dependable for what \
             merged (~97% reach their files), indicative for what was \
             abandoned (~29% of closed, ~46% of open). A gear no pull request \
             touched carries null rather than zeros. CI is absent and cannot \
             be added: a pipeline run names a commit, not a file.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(
            "days",
            false,
            "How many days back to look, ending today (default 30)",
        )
        .query_param(
            "compare",
            false,
            "`previous` also returns pull requests over the window of the same length just before, as `pull_requests_previous`",
        )
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(gear_activity)
        .json_response_with_schema::<GearActivityListDto>(
            openapi,
            StatusCode::OK,
            "Per-gear delivery activity",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/component-values")
        .operation_id("studio_components_catalog.list_component_values")
        .summary("What each component's fields say, with its three sources reconciled")
        .description(
            "A catalogued component has three sources and they disagree on purpose: what \
             crates.io published, what the repository scan read (`profile.auto`), and what a \
             PERSON set (`profile.values`). LATER WINS. That order is the whole rule, and it is \
             not obvious from any one of them — a person's correction must survive the next \
             sync, and a sync must still fill in what nobody has corrected.\n\n\
             A field a person CLEARED comes back present and null. That is different from \
             absent: clearing is a decision, and falling back to what the scan found would \
             quietly undo it. Absent means nothing answered at all.\n\n\
             Flat keys from the old editor (`domain`, `code_loc`, `api_spec_link`, …) fill only \
             what is still unanswered. They are the oldest and least trustworthy source, and \
             reading them any earlier would overwrite an edit with a stale field in a way \
             nobody notices.\n\n\
             `category` is looked for in four places in order: the scan, the profile, the node \
             itself, then the first published category. Empty when nothing answers — a fact \
             about the component, and better than an `Uncategorised` invented for it.\n\n\
             NUMBERS COME BACK AS DIGITS, with the number itself in `n`. Thousands separators \
             are a locale decision and this side does not hold one; a portal that does formats \
             `n`. The same reason the access catalogue serves privilege ids and not their \
             English names.\n\n\
             This used to run in the portal, per row, on every render.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(component_values)
        .json_response_with_schema::<ComponentValuesListDto>(
            openapi,
            StatusCode::OK,
            "The reconciled fields",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/component-history")
        .operation_id("studio_components_catalog.list_component_history")
        .summary("What each component's fields said before: one snapshot per component per day")
        .description(
            "The catalogue answers what is true now; a sync rewrites the scan's answers in \
             place. Every sync also keeps a snapshot of each component's fields, one per \
             component per day (a later sync that day replaces it), with the parts a \
             comparison reads: the number `n`, the grade `s`, and the badge `b`.\n\n\
             With `component`: that component's every snapshot in the window, oldest first -- \
             a trend.\n\n\
             Without: each component's earliest snapshot from the window's start on -- the \
             `before` to set against `component-values` for a better/worse mark. Read a week at \
             a time from the start and stopping at the first week with any snapshot, so a \
             component first seen after that week has no row: it is new in the window, and has \
             nothing to compare with.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(
            "days",
            false,
            "How many days back to look, ending today (default 30, at most 366)",
        )
        .query_param(
            "component",
            false,
            "One component's every snapshot in the window, instead of each component's earliest",
        )
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(component_history)
        .json_response_with_schema::<ComponentHistoryDto>(
            openapi,
            StatusCode::OK,
            "Component snapshots",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/reference")
        .operation_id("studio_components_catalog.list_component_reference")
        .summary("The components reference: the catalogue joined with the Gearbox engine's gears")
        .description(
            "One entry per component, for a screen that lists them all and lets a person \
             take a gear into a product. It joins what the Components page shows (crates.io \
             release and downloads, the repository scan, the profile ratio, delivery activity) \
             with what the Gearbox engine reads from each `gear.gdl` (engine id, service or \
             plugin, extension points, hosts, plugins).\n\n\
             THE JOIN IS THE CRATE NAME: the engine's `package.crate_name` is the catalogue's \
             component name. A component catalogued before the scan read crate names is joined \
             by the directory it was read from instead. One crate can be several engine gears \
             (`engine` is a list); an engine gear no component matches is listed on its own \
             with `type_id: null` and every portal fact null.\n\n\
             UNKNOWN IS NULL, NEVER ZERO. `related` names a gear's SDK and plugin crates from \
             its manifests and its descriptor, not from a naming convention.\n\n\
             Gearbox and Insight are best-effort: without them the catalogue is still served \
             and `sources.gearbox_problem` / `sources.activity_problem` say why a half is \
             missing. `days` (default 90, `0` to skip) is the activity window.\n\n\
             KINDS AND CATEGORIES come from one vocabulary each (`kind`, `category`), with \
             the evidence in `kind_reason` / `category_reason`. What is not a component \
             (config, test support, docs, templates, examples) and nodes another supersedes \
             (an older copy, a guessed name) are left out unless `include=all`; then they \
             carry `component: false` and `excluded_reason`. `sources.excluded` counts them.\n\n\
             Answers are cached per catalogue generation, corpus commit and activity window \
             (`sources.cached`); a sync or a profile edit invalidates them.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(
            "days",
            false,
            "Activity window in days, ending today (default 90; 0 skips the warehouse)",
        )
        .query_param(
            "include",
            false,
            "`components` (default) or `all` (adds non-components and superseded nodes, with reasons)",
        )
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(component_reference)
        .json_response_with_schema::<ComponentReferenceListDto>(
            openapi,
            StatusCode::OK,
            "The reference",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/project-components")
        .operation_id("studio_components_catalog.list_project_components")
        .summary("The services and applications in a project's repositories beyond its gears")
        .description(
            "Reads the project's repositories through its connections and finds every \
             component a build tool declares that is not a gear (go.mod, pyproject.toml, \
             pom.xml, package.json, Cargo.toml, Dockerfile, Helm chart), with its contract \
             files, tests and README, the people who changed it most (from the history, not \
             typed in), its open pull requests, and a `ready` / `caution` / `not_ready` \
             signal with every reason (issue #739). History is read for at most 25 \
             components a call.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .query_param("project_id", true, "The project")
        .handler(list_project_components)
        .json_response_with_schema::<ProjectComponentListDto>(
            openapi,
            StatusCode::OK,
            "The components",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/components")
        .operation_id("studio_components_catalog.list_gears")
        .summary("List every node of every type this organization marks as a component")
        .description(
            "Returns every node whose type this organization marks as a \
             component, rather than a fixed type: what counts as a component is a \
             judgement about the organization's model, made on the Objects page.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .query_param(
            "project_id",
            false,
            "A project: its catalogue, the organization's components and its own (`tier: project`, ADR-0061)",
        )
        .handler(list_gears)
        .json_response_with_schema::<CatalogNodeListResponse>(openapi, StatusCode::OK, "Components")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/versions")
        .operation_id("studio_components_catalog.list_versions")
        .summary("List ingested crate versions, optionally filtered to one crate")
        .description(
            "Returns the crate versions ingested from crates.io. Narrow it to one \
             gear's history by naming the crate.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_versions)
        .json_response_with_schema::<CatalogNodeListResponse>(openapi, StatusCode::OK, "Versions")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/profiles")
        .operation_id("studio_components_catalog.list_profiles")
        .summary("List Studio-managed, editable Gear profiles")
        .description(
            "Returns the Studio-managed profiles: the editable metadata this \
             tenant keeps beside a gear, as opposed to what crates.io publishes \
             about it.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .query_param(
            "project_id",
            false,
            "A project: its own components' profiles over the organization's (ADR-0061)",
        )
        .handler(list_profiles)
        .json_response_with_schema::<CatalogNodeListResponse>(
            openapi,
            StatusCode::OK,
            "Gear profiles",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-components-catalog/v1/components/{name}/profile")
        .operation_id("studio_components_catalog.save_profile")
        .summary("Create or replace Studio-managed metadata for one Gear")
        .description(
            "Creates the profile for one gear or replaces it wholesale. The crate \
             name in the path identifies the gear; a body that does not fit the \
             profile schema is refused with a constraint violation.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("name", "Crate name")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(save_profile)
        .json_request::<SaveGearProfileRequest>(openapi, "Gear profile")
        .json_response_with_schema::<CatalogNodeDto>(openapi, StatusCode::OK, "Saved Gear profile")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/types")
        .operation_id("studio_components_catalog.list_types")
        .summary("Every node type the graph holds, and which are components here")
        .description(
            "Returns every node type the graph holds, each with whether this \
             organization marks it as a component and which field schema renders \
             it — the built-in one or this tenant's own.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_types)
        .json_response_with_schema::<CatalogTypeListResponse>(
            openapi,
            StatusCode::OK,
            "Node types with their component mark and schema owner",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/types/counts")
        .operation_id("studio_components_catalog.count_types")
        .summary("How many nodes of each type the graph holds")
        .description(
            "Returns how many nodes the graph holds of each type, so the Objects \
             page can show sizes without fetching the nodes themselves.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(count_types)
        .json_response_with_schema::<TypeCountListResponse>(
            openapi,
            StatusCode::OK,
            "Instance counts, exact up to a cap",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-components-catalog/v1/types/{type_id}/component")
        .operation_id("studio_components_catalog.set_type_component")
        .summary("Mark a type as one of this organization's components, or unmark it")
        .description(
            "Marks a node type as one of this organization's components, or \
             unmarks it. This is what `GET /components` then lists.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("type_id", "GTS type id (the leaf form)")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(set_type_component)
        .json_request::<SetTypeComponentRequest>(openapi, "The mark")
        .json_response_with_schema::<CatalogTypeDto>(
            openapi,
            StatusCode::OK,
            "The type as it now reads",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/field-schemas")
        .operation_id("studio_components_catalog.list_field_schemas")
        .summary("The field schema each component type is rendered against")
        .description(
            "Returns the field schema each component type is rendered against, \
             whether it is the built-in default or one this tenant has replaced.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_field_schemas)
        .json_response_with_schema::<FieldSchemaListResponse>(
            openapi,
            StatusCode::OK,
            "Field schemas, built-ins overlaid by this tenant's own",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-components-catalog/v1/field-schemas/{describes}")
        .operation_id("studio_components_catalog.save_field_schema")
        .summary("Replace the field schema this tenant renders one component type against")
        .description(
            "Replaces the field schema this tenant renders one component type \
             against. It applies to this tenant only; the built-in schema stays \
             the default elsewhere.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("describes", "GTS type id the schema describes")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(save_field_schema)
        .json_request::<SaveFieldSchemaRequest>(openapi, "Field schema")
        .json_response_with_schema::<CatalogNodeDto>(openapi, StatusCode::OK, "Saved field schema")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router =
        OperationBuilder::delete("/studio-components-catalog/v1/field-schemas/{describes}")
            .operation_id("studio_components_catalog.delete_field_schema")
            .summary("Revert one component type to the built-in field schema")
            .description(
                "Drops this tenant's field schema for a component type, so it \
                 renders against the built-in one again. Reverting a type that \
                 was never overridden is not an error.",
            )
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("describes", "GTS type id the schema describes")
            .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
            .handler(delete_field_schema)
            .no_content_response(StatusCode::NO_CONTENT, "Reverted")
            .error_400(openapi)
            .error_401(openapi)
            .error_500(openapi)
            .register(router, openapi);

    router.layer(Extension(Catalog::new(service, hub, gearbox)))
}

#[cfg(test)]
mod registry_dto_tests {
    use super::*;
    use crate::components_catalog::registry::{EntryRecord, OccurrenceRecord, RegistryEntry};

    #[test]
    fn an_entry_is_answered_in_the_shape_the_portal_reads() {
        let project = Uuid::from_u128(5);
        let entry = RegistryEntry {
            entry: EntryRecord {
                organization_id: Uuid::from_u128(1),
                name: "studio-tasks".into(),
                kind: "gear".into(),
                state: "declared".into(),
                description: Some("durable runs".into()),
                category: None,
                owner: None,
                capabilities: vec!["tasks".into()],
                aliases: vec!["tasks".into()],
                merged_into: None,
                replaced_by: None,
                version: None,
                orphaned: false,
                first_seen: Some("2026-10-09T10:00:00Z".into()),
                last_seen: Some("2026-10-09T11:00:00Z".into()),
                fingerprint: Some("f".into()),
                ..EntryRecord::default()
            },
            occurrences: vec![OccurrenceRecord {
                organization_id: Uuid::from_u128(1),
                entry: "studio-tasks".into(),
                entry_id: "e".into(),
                project_id: Some(project),
                project_name: Some("Studio".into()),
                repo: "acme/studio".into(),
                repo_key: "k".into(),
                git_ref: Some("main".into()),
                path: "studio-backend/src/tasks".into(),
                commit: Some("abc".into()),
                declared_in: "attribute".into(),
                declared_file: "studio-backend/src/tasks/mod.rs".into(),
                kind: "gear".into(),
                description: None,
                category: None,
                capabilities: Vec::new(),
                runtime: vec!["rest".into()],
                built: true,
                doc_path: None,
                doc_text: None,
                fingerprint: "f".into(),
                seen_at: "2026-10-09T11:00:00Z".into(),
                ..OccurrenceRecord::default()
            }],
        };
        let json = serde_json::to_value(registry_entry_dto(entry)).unwrap();
        for (key, want) in [
            ("name", serde_json::json!("studio-tasks")),
            ("kind", serde_json::json!("gear")),
            ("state", serde_json::json!("declared")),
            ("description", serde_json::json!("durable runs")),
            ("capabilities", serde_json::json!(["tasks"])),
            ("orphaned", serde_json::json!(false)),
            ("first_seen", serde_json::json!("2026-10-09T10:00:00Z")),
            ("last_seen", serde_json::json!("2026-10-09T11:00:00Z")),
        ] {
            assert_eq!(json[key], want, "{key}");
        }
        // Absent or null, the portal reads both as no owner.
        assert!(json.get("owner").is_none_or(serde_json::Value::is_null));
        let occ = &json["occurrences"][0];
        for (key, want) in [
            ("project_id", serde_json::json!(project)),
            ("project_name", serde_json::json!("Studio")),
            ("repo", serde_json::json!("acme/studio")),
            ("git_ref", serde_json::json!("main")),
            ("path", serde_json::json!("studio-backend/src/tasks")),
            ("commit", serde_json::json!("abc")),
            ("declared_in", serde_json::json!("attribute")),
        ] {
            assert_eq!(occ[key], want, "{key}");
        }
        // Only the contract's fields: nothing of the stored record leaks.
        assert!(occ.get("repo_key").is_none() && occ.get("doc_text").is_none());
    }

    #[test]
    fn a_source_round_trips_through_its_dto() {
        let s = RepoSource {
            tenant: Uuid::from_u128(2),
            connection_id: None,
            repo: "acme/gears".into(),
            git_ref: String::new(),
            mode: "frontx".into(),
        };
        let dto = source_dto(s);
        assert_eq!(dto.git_ref, None);
        assert_eq!(dto.mode.as_deref(), Some("frontx"));
        let back = source_of(dto);
        assert_eq!(back.repo, "acme/gears");
        assert_eq!(back.git_ref, "");
        assert_eq!(back.mode, "frontx");
    }

    #[test]
    fn an_entry_with_decisions_carries_owner_aliases_and_history() {
        use crate::components_catalog::registry::Owner;
        use crate::components_catalog::registry_decisions::DecisionRecord;
        let entry = RegistryEntry {
            entry: EntryRecord {
                organization_id: Uuid::from_u128(1),
                name: "billing".into(),
                kind: "gear".into(),
                state: "deprecated".into(),
                description: None,
                category: Some("payments".into()),
                owner: Some(Owner {
                    kind: "team".into(),
                    id: None,
                    name: "Payments".into(),
                }),
                capabilities: Vec::new(),
                aliases: vec!["billing-old".into()],
                merged_into: None,
                replaced_by: Some("invoicing".into()),
                version: Some("1.2.0".into()),
                orphaned: false,
                first_seen: None,
                last_seen: None,
                fingerprint: None,
                ..EntryRecord::default()
            },
            occurrences: Vec::new(),
        };
        let list = serde_json::to_value(registry_entry_dto(entry.clone())).unwrap();
        assert!(list["decisions"].is_null(), "the list stays light");
        assert_eq!(
            list["owner"],
            serde_json::json!({"kind": "team", "id": null, "name": "Payments"})
        );
        assert_eq!(list["aliases"], serde_json::json!(["billing-old"]));
        assert_eq!(list["replaced_by"], "invoicing");
        assert_eq!(list["category"], "payments");
        assert_eq!(list["version"], "1.2.0");
        let decision = DecisionRecord {
            organization_id: Uuid::from_u128(1),
            entry: "billing".into(),
            entry_id: "e".into(),
            action: "deprecate".into(),
            from: "registered".into(),
            to: "deprecated".into(),
            by: "person-1".into(),
            by_name: None,
            at: "2026-10-09T12:00:00Z".into(),
            reason: Some("replaced".into()),
            details: serde_json::json!({"replaced_by": "invoicing"}),
        };
        let one = serde_json::to_value(registry_entry_detail_dto(entry, vec![decision])).unwrap();
        let d = &one["decisions"][0];
        assert_eq!(d["action"], "deprecate");
        assert_eq!(d["from"], "registered");
        assert_eq!(d["to"], "deprecated");
        assert_eq!(d["by"], "person-1");
        assert_eq!(d["reason"], "replaced");
        assert_eq!(d["details"]["replaced_by"], "invoicing");
        assert!(d.get("organization_id").is_none() && d.get("entry_id").is_none());
    }

    #[test]
    fn a_decision_request_reads_into_the_services_terms() {
        let body: RegistryDecisionRequest = serde_json::from_value(serde_json::json!({
            "action": "register",
            "owner": {"kind": "person", "id": "u1", "name": "Ada"},
            "capabilities": ["billing"]
        }))
        .unwrap();
        let input = decision_input(body);
        assert_eq!(input.action, "register");
        assert_eq!(input.owner.as_ref().map(|o| o.name.as_str()), Some("Ada"));
        assert_eq!(input.capabilities, Some(vec!["billing".to_owned()]));
        assert_eq!(input.reason, None);
    }

    /// A fake studio-user: grants the registry privilege to one subject.
    struct Authority(Uuid);

    #[async_trait::async_trait]
    impl crate::user_profile::OrgAuthority for Authority {
        async fn may_administer(&self, ctx: &SecurityContext, _org: Uuid, privilege: &str) -> bool {
            privilege == REGISTRY_PRIVILEGE && ctx.subject_id() == self.0
        }
        async fn may_dispose(&self, _ctx: &SecurityContext, _org: Uuid) -> bool {
            false
        }
    }

    fn caller(id: u128) -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(id))
            .subject_tenant_id(Uuid::from_u128(1))
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn only_an_administrator_decides_and_without_studio_user_nobody_does() {
        let authority = Authority(Uuid::from_u128(7));
        assert!(may_decide(Some(&authority), &caller(7)).await);
        assert!(
            !may_decide(Some(&authority), &caller(8)).await,
            "a member is refused"
        );
        assert!(!may_decide(None, &caller(7)).await);
    }

    #[test]
    fn a_candidate_carries_its_score_and_evidence_and_declare_reads_its_body() {
        use crate::components_catalog::candidates::Evidence;
        let entry = RegistryEntry {
            entry: EntryRecord {
                name: "documents".into(),
                state: "candidate".into(),
                score: Some(8),
                evidence: vec![Evidence {
                    signal: "rest".into(),
                    detail: "own REST surface: rest.rs".into(),
                    weight: 3,
                }],
                ..EntryRecord::default()
            },
            occurrences: Vec::new(),
        };
        let json = serde_json::to_value(registry_entry_dto(entry)).unwrap();
        assert_eq!(json["score"], 8);
        assert_eq!(
            json["evidence"][0],
            serde_json::json!({"signal": "rest", "detail": "own REST surface: rest.rs", "weight": 3})
        );

        // No body is an empty one; a dry run says so.
        assert_eq!(
            declare_input(None),
            crate::components_catalog::registry_declare::DeclareInput::default()
        );
        let body: RegistryDeclareRequest =
            serde_json::from_value(serde_json::json!({"dry_run": true, "capabilities": ["docs"]}))
                .unwrap();
        let input = declare_input(Some(body));
        assert!(input.dry_run);
        assert_eq!(input.capabilities, Some(vec!["docs".to_owned()]));

        let problem = format!(
            "{:?}",
            declare_problem(
                crate::components_catalog::registry_declare::DeclareError::NotCandidate {
                    state: "declared".into()
                }
            )
        );
        assert!(problem.contains("REGISTRY_NOT_A_CANDIDATE"), "{problem}");
    }

    #[test]
    fn a_refused_move_says_which_states_the_action_applies_to() {
        use crate::components_catalog::registry_decisions::DecisionError;
        assert_eq!(allowed_from("publish"), "registered, extracted");
        assert_eq!(
            allowed_from("deprecate"),
            "registered, extracted, published"
        );
        assert_eq!(allowed_from("complete_extraction"), "registered");
        let problem = decision_problem(DecisionError::Illegal {
            action: "publish".into(),
            from: "declared".into(),
        });
        let text = format!("{problem:?}");
        assert!(text.contains("REGISTRY_TRANSITION_NOT_ALLOWED"), "{text}");
    }
}
