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

use axum::extract::{Path, Query, Request};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::{Extension, Router};
use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;

use super::gearbox::{CORPUS_SOURCE_ID, Gearbox, PROFILES, PreviewInput};
use super::reference::ComponentReferenceListDto;
use super::roadmap::{RoadmapFields, RoadmapSource};
use super::service::{CatalogService, RepoSource, SyncSources};
use super::sync_task::TASK_TYPE;
use crate::org_scope::OrgCtx;
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
}

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
        }
    }

    fn gearbox(&self) -> ApiResult<&Arc<Gearbox>> {
        self.gearbox.as_ref().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail(
                    "product previews are not available in this deployment \
                     (STUDIO_GEARBOX_WORKDIR is not set)",
                )
                .create()
        })
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
                        "delivery activity is not available in this deployment                          (studio-insight is not configured)",
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

/// One file of a scaffolded gear: sent in to be written, or handed back to say
/// what was written — which is why it is both halves of the contract.
#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct ScaffoldFileDto {
    pub path: String,
    pub content: String,
}

/// Write a scaffolded gear skeleton into the project's connected gear repo.
///
/// `files` is optional, and leaving it out is the ordinary case: the canonical
/// skeleton is generated here (`skeleton.rs`) from `capability` and the rest.
/// It used to be required, which meant the layout of a gear was known only to
/// whatever client had a copy of it — so "create a new gear" could not be asked
/// for without a browser, and a second copy of the layout was the price of
/// asking any other way.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ScaffoldRequest {
    /// Gear slug, used for the branch name `scaffold/<slug>`. With no `files`
    /// it is also what the skeleton is generated from, and what the gear's
    /// directory and crate are named after.
    pub slug: String,
    /// Explicit files to write. Omit to have the canonical skeleton generated.
    pub files: Option<Vec<ScaffoldFileDto>>,
    /// What the gear is being built for; named in its manifest and its PRD.
    pub app_title: Option<String>,
    /// The PRD's opening sentence. Omitted falls back to the capability-gap one.
    pub problem: Option<String>,
    /// Provenance note for the manifest and the crate header.
    pub origin: Option<String>,
    /// Directory the gear's own directory goes under (default `gears`). A
    /// shared store usually groups them — `gears/system`, `gears/bss`.
    pub parent_dir: Option<String>,
    /// Return the files that WOULD be written and touch nothing. Lets a caller
    /// show them first without a second generator to keep in step.
    pub dry_run: Option<bool>,
    /// Open a pull request back into the base branch (default false).
    pub open_pr: Option<bool>,
    /// The shape of the gear: `service` (default), `minimal` or `plugin`.
    /// With the Gearbox engine configured, it writes the gear's `gear.gdl`.
    pub gear_kind: Option<String>,
    /// For a `plugin`: the host whose extension point it fills, by crate
    /// name (`cf-gears-authn-resolver`), from `GET /gearbox/extension-points`.
    pub plugin_host: Option<String>,
    /// For a `plugin` whose host declares more than one extension point: which
    /// one, by its GTS spec id, from `GET /gearbox/extension-points`.
    pub plugin_spec: Option<String>,
}

/// Whether product previews can run here, and against which gear corpus.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearboxCatalogueDto {
    /// The source id the corpus's gears are joined on; every descriptor's
    /// `source` names it.
    pub source_id: String,
    /// `owner/repo@ref` of the checkout, as a person reads it.
    pub corpus: String,
    /// The repository the corpus is checked out from, without credentials.
    pub corpus_url: String,
    pub corpus_ref: String,
    pub corpus_commit: Option<String>,
    /// Whether cloning it takes a token. This backend never hands one out, so
    /// an IDE cannot clone such a corpus itself.
    pub corpus_needs_token: bool,
    /// Set when it does: the gateway-rooted path to clone the corpus through
    /// this backend with the member's Studio token, the corpus's own token
    /// attached upstream. Read-only.
    pub corpus_clone_path: Option<String>,
    /// `gearbox catalogue --format json` verbatim: `gears` by id, each a
    /// `GearDescriptor`, plus `contracts`, `sources` and `diagnostics`.
    pub catalogue: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearboxStatusDto {
    /// False when `STUDIO_GEARBOX_WORKDIR` is unset; nothing else is filled.
    pub enabled: bool,
    pub engine_version: Option<String>,
    /// The gear corpus a session should check out beside the project, under
    /// `source_id`, for the generated `product.gdl` to resolve there too.
    pub corpus_url: Option<String>,
    pub corpus_ref: Option<String>,
    pub corpus_commit: Option<String>,
    pub source_id: String,
    /// The deployment profiles a generated description declares.
    pub profiles: Vec<String>,
    /// Why previews will fail, when they will.
    pub problem: Option<String>,
}

/// Save what a project's product is made of. Every field is optional and
/// merged: the picks change as a person clicks, the profile separately.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SaveProjectProductRequest {
    pub product_id: Option<String>,
    pub name: Option<String>,
    /// Crate names (`cf-gears-api-gateway`) or engine ids.
    pub gears: Option<Vec<String>>,
    pub profile: Option<String>,
    /// How the product configures its gears: gear crate name -> {field: value},
    /// written into `product.gdl` as the gear's or plugin's `config`.
    pub config: Option<Value>,
}

/// Picks to complete into a set the engine can resolve.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CompleteProductRequest {
    pub gears: Vec<String>,
    /// The product's configuration so far (gear crate name -> {field: value});
    /// completion keeps it and adds what the result needs.
    pub config: Option<Value>,
}

/// One change completion made, and why.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductChangeDto {
    /// Crate name.
    pub gear: String,
    /// True when added, false when taken out.
    pub added: bool,
    pub reason: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CompleteProductDto {
    /// The completed picks, by crate name.
    pub gears: Vec<String>,
    pub changes: Vec<ProductChangeDto>,
    /// The configuration to keep with the picks: what was sent, plus what
    /// completion set (a plugin's `vendor` aligned with its host's).
    pub config: Value,
}

/// Compose a product from picked gears and ask the engine about it.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ProductPreviewRequest {
    /// The product's kebab-case id; also the self-hosted host application.
    pub product_id: String,
    /// Display name. Omitted means the id.
    pub name: Option<String>,
    /// Gears by crate name (`cf-gears-api-gateway`) or engine id (`api-gateway`).
    /// Empty only with `write`: the description a product project starts from.
    pub gears: Vec<String>,
    /// `dev` (embedded), `local` (self-hosted) or `prod` (kubernetes). Default `dev`.
    pub profile: Option<String>,
    /// Also commit `product.gdl` to the project's gear repo, on a new branch.
    pub write: Option<bool>,
    /// With `write`, open a pull request too.
    pub open_pr: Option<bool>,
    /// With `write` and no `open_pr`, commit straight onto the repo's base
    /// branch instead of a `product/…` branch. For a repository the product
    /// owns outright; default false, because a connected repo can be shared.
    pub onto_base: Option<bool>,
    /// How the product configures its gears: gear crate name -> {field: value}.
    /// Written into `product.gdl` and kept with the project's product.
    pub config: Option<Value>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearboxDiagnosticDto {
    pub code: String,
    /// `error`, `warning` or `info`.
    pub severity: String,
    pub message: String,
    pub help: Option<String>,
    /// `product.gdl`, or the corpus path of the `gear.gdl` it is about.
    pub file: Option<String>,
    /// One-based.
    pub line: Option<u32>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearboxListenDto {
    pub name: String,
    pub gear: String,
    pub address: String,
}

/// One generated binary and the gears co-located in it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearboxApplicationDto {
    pub name: String,
    pub kind: String,
    pub anchor: Option<String>,
    pub gears: Vec<String>,
    pub replicas: u32,
    pub listens: Vec<GearboxListenDto>,
}

/// A gear the resolved product contains, and why.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearboxGearDto {
    pub id: String,
    pub crate_name: String,
    /// `selected`, `colocated with <gear>`, `plugin of <host>`.
    pub reasons: Vec<String>,
}

/// A picked host that needs a plugin, and the gears that could be it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearboxPluginOptionDto {
    pub host: String,
    /// Crate names, like every other pick; send one back in `gears`.
    pub available: Vec<String>,
}

/// A gear the description gained that nobody picked.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearboxAddedDto {
    pub id: String,
    pub reason: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductWriteDto {
    pub branch: String,
    pub commit_sha: String,
    pub pr_url: Option<String>,
}

/// What the engine made of the picked gears.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductPreviewDto {
    /// The description, exactly as it would be committed.
    pub product_gdl: String,
    pub profile: String,
    /// No error diagnostics: the product resolves for this profile.
    pub ok: bool,
    pub diagnostics: Vec<GearboxDiagnosticDto>,
    /// Empty when validation failed before resolving.
    pub applications: Vec<GearboxApplicationDto>,
    pub gears: Vec<GearboxGearDto>,
    pub added: Vec<GearboxAddedDto>,
    /// Picked names no `gear.gdl` declares; left out of the description.
    pub not_described: Vec<String>,
    /// Hosts picked without the plugin their extension point needs.
    pub plugin_options: Vec<GearboxPluginOptionDto>,
    pub corpus_commit: Option<String>,
    /// Set when `write` was asked for.
    pub written: Option<ProductWriteDto>,
}

/// Where the scaffold landed, and what it wrote.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ScaffoldResultDto {
    pub branch: String,
    pub commit_sha: String,
    pub pr_url: Option<String>,
    /// The files written, or — on a dry run — the ones that would be. Always
    /// returned, so a caller never has to guess what it just asked for.
    pub files: Vec<ScaffoldFileDto>,
}

/// Create a new repository via the connector and set it as the project's gear repo.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateRepoRequest {
    /// Tenant that owns the connection (usually the workspace/organization).
    pub tenant: Uuid,
    /// Connector connection id; when omitted the first GitHub connection is used.
    pub connection_id: Option<Uuid>,
    /// Organization login when `is_org`; empty/None = under the authed user.
    pub owner: Option<String>,
    /// Create under an organization (`owner`) rather than the user.
    pub is_org: Option<bool>,
    /// New repository name (without owner).
    pub name: String,
    /// Private repository (default true).
    pub private: Option<bool>,
}

/// The created repository.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CreateRepoResultDto {
    pub full_name: String,
    pub html_url: String,
    pub default_branch: String,
}

/// The gear repository connected to a project — where its gears live and where
/// scaffolded gears are written.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SetProjectRepoRequest {
    /// Tenant that owns the connection (usually the workspace/organization).
    pub tenant: Uuid,
    /// Connector connection id; when omitted the first GitHub connection is used.
    pub connection_id: Option<Uuid>,
    /// `owner/name` of the repository.
    pub repo: String,
    /// Branch scaffolded gears are written to (default `main`).
    pub branch: Option<String>,
}

/// A repository source picked on the Gears page.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct RepoSourceDto {
    /// Tenant that owns the connection (usually the workspace/organization).
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
}

/// A roadmap board: a GitHub Project whose items plan the gears.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct RoadmapSourceDto {
    /// Tenant that owns the GitHub connection.
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
    let queue = catalog.queue()?;
    let sources = match body {
        Some(Json(req)) => req.into_sources(catalog.service.default_keyword()),
        None => SyncSources {
            crates_io: Some(catalog.service.default_keyword().to_string()),
            ..SyncSources::default()
        },
    };
    let payload = serde_json::to_value(&sources)
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    let run_id = queue
        .enqueue(
            &ctx,
            crate::tasks::service::NewRun {
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
async fn list_gears(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let (nodes, truncated) = catalog
        .service
        .list_component_nodes(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
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
    }))
}

/// One capability, and what could fill it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlanRowDto {
    pub capability: String,
    pub candidates: Vec<CandidateDto>,
    /// No candidate at all — nothing here to build this from.
    pub gap: bool,
    /// Candidates exist and none of them is built. Not a gap, and not an
    /// answer either.
    pub unbuilt: bool,
}

/// One component offered for one capability.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CandidateDto {
    pub name: String,
    pub kind: String,
    /// Which step proposed it: `contract` (the engine reports the gear provides
    /// one of the capability's contracts) or `evidence` (its words were found in
    /// what the gear says about itself). Every `contract` ranks first.
    pub step: String,
    /// The provided contracts that satisfy the capability. Empty for `evidence`.
    pub contracts: Vec<String>,
    /// For `evidence`, the text around the first term found. Null otherwise.
    pub passage: Option<String>,
    /// The document the passage is quoted from, when the match came from the
    /// gear's own documentation. Such a match ranks after every evidence match
    /// from the catalogue's text. Null otherwise.
    pub cites: Option<String>,
    /// The version the catalogue knows the component at. Send it back with a
    /// decision, so a later version reopens it.
    pub version: Option<String>,
    /// A member's earlier decision on this gear for this capability. Null when
    /// nobody has decided.
    pub decision: Option<DecisionMarkDto>,
    /// The gear declares this capability itself, rather than being found by
    /// the words in its name and description.
    pub declared: bool,
    /// How many of the capability's terms it mentions.
    pub score: u32,
    /// Which terms they were, so a suggestion can be argued with rather than
    /// only accepted.
    pub why: Vec<String>,
    /// `built`, `docs-only`, or `unknown` — and `unknown` is not a maybe: it
    /// means the question does not apply or was never asked.
    pub built: String,
    /// What the Gearbox engine said: `runs`, `blocked`, or `undescribed`.
    /// A different question from `built` — that one says somebody wrote code,
    /// this one says the engine can put it into a product.
    pub composable: String,
    /// The engine's reason, when `blocked`. Null otherwise.
    pub composable_why: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ComposePlanDto {
    pub items: Vec<PlanRowDto>,
    pub total: u32,
}

/// A member's earlier decision on a mapping, as the composer is given it.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PastDecisionDto {
    pub capability: String,
    pub gear: String,
    /// `confirmed` or `rejected`.
    pub decision: String,
    /// The gear's version when it was decided.
    #[serde(default)]
    pub gear_version: Option<String>,
    /// The declaring document's revision is no longer the one decided
    /// against. The caller compares, because it holds the current revision.
    #[serde(default)]
    pub document_changed: bool,
}

/// What an earlier decision says about a candidate now.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DecisionMarkDto {
    /// `confirmed` or `rejected`.
    pub decision: String,
    /// The document or the gear changed since: decide again. It ranks as if
    /// nobody had decided.
    pub needs_review: bool,
}

fn past_decision(d: PastDecisionDto) -> super::compose::PastDecision {
    super::compose::PastDecision {
        capability: d.capability,
        gear: d.gear,
        decision: d.decision,
        gear_version: d.gear_version,
        document_changed: d.document_changed,
    }
}

/// What a product needs, and the vocabulary to look for it with.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ComposeRequest {
    /// The capabilities to fill, in the order they should be answered.
    pub capabilities: Vec<String>,
    /// The workspace's effective capability vocabulary: capability key to the
    /// terms to search for. A capability absent from it is matched against its
    /// own name, which is what it meant before vocabularies existed
    /// (ADR-0014 §5).
    #[serde(default)]
    pub terms: std::collections::BTreeMap<String, Vec<String>>,
    /// Capability key to the contracts that satisfy it, from the same
    /// vocabulary. Matched before `terms`; a capability absent from it is
    /// found by its terms alone.
    #[serde(default)]
    pub contracts: std::collections::BTreeMap<String, Vec<String>>,
    /// What members already decided in this scope, newest first, as
    /// `GET /studio-artifact-ingest/v1/mapping-decisions` lists them. A
    /// confirmed gear ranks first within its step and a rejected one last.
    #[serde(default)]
    pub decisions: Vec<PastDecisionDto>,
}

/// POST /studio-components-catalog/v1/compose — match needs to components.
///
/// A POST because the vocabulary travels with the question: a workspace's terms
/// are a map, and a map does not belong in a query string.
/// Gear profiles keyed by the gear they describe.
///
/// A profile names its gear `gear_name` (`gts::gear_profile_node`); keying by
/// `name` -- which no profile has -- left the map empty, so the Composer never
/// saw a gear's build state or what the Gearbox engine knows about it, and
/// every suggestion read `undescribed`.
fn profiles_by_gear(
    values: impl IntoIterator<Item = serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut profiles = serde_json::Map::new();
    for value in values {
        if let Some(name) = value.get("gear_name").and_then(serde_json::Value::as_str) {
            profiles.insert(name.to_owned(), value);
        }
    }
    profiles
}

#[cfg(test)]
mod profiles_by_gear_tests {
    use super::profiles_by_gear;
    use serde_json::json;

    /// The shape the sync writes, read back the way the Composer needs it.
    #[test]
    fn a_profile_is_found_by_the_gear_it_describes() {
        let map = profiles_by_gear([
            json!({ "gear_name": "cf-gears-api-gateway", "auto": { "gdl_runs": { "s": "good" } } }),
            json!({ "auto": {} }),
        ]);
        assert_eq!(map.len(), 1);
        assert_eq!(map["cf-gears-api-gateway"]["auto"]["gdl_runs"]["s"], "good");
    }
}

/// Compare what a project's specs ask for with what its code is made of.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ConformanceRequest {
    /// The project whose gear repository is read.
    pub project_id: String,
    /// The capabilities the project's documents declare
    /// (`GET /studio-documents/v1/declared-capabilities`).
    pub capabilities: Vec<String>,
    /// The workspace's capability vocabulary, as for `/compose`.
    #[serde(default)]
    pub terms: std::collections::BTreeMap<String, Vec<String>>,
    /// The contracts of the same vocabulary, as for `/compose`.
    #[serde(default)]
    pub contracts: std::collections::BTreeMap<String, Vec<String>>,
    /// Earlier mapping decisions, as for `/compose`.
    #[serde(default)]
    pub decisions: Vec<PastDecisionDto>,
}

/// A component the code depends on.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ImplementerDto {
    pub name: String,
    /// It declares the capability itself, rather than matching by words.
    pub declared: bool,
}

/// One capability the specs declare, and whether the code has it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ConformanceRowDto {
    pub capability: String,
    /// `implemented` -- the code depends on a component that fills it --
    /// or `missing`.
    pub status: String,
    /// The components in the code that fill it.
    pub implemented_by: Vec<ImplementerDto>,
    /// When missing: the best catalogue candidates, as `/compose` ranks them.
    pub candidates: Vec<String>,
}

/// A component the code uses that no declared capability accounts for.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct UnexplainedDto {
    pub name: String,
    /// The capabilities it declares itself, if any: what the specs may be
    /// missing.
    pub declares: Vec<String>,
}

/// Spec against code, for one project.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ConformanceDto {
    /// The repository read (`owner/name`).
    pub repo: String,
    /// Catalogue components the code depends on.
    pub components_in_code: Vec<String>,
    /// One row per declared capability.
    pub items: Vec<ConformanceRowDto>,
    pub total: u32,
    /// Components the code uses that the specs do not account for.
    pub unexplained: Vec<UnexplainedDto>,
    /// What the Gearbox engine says about the code's own set of gears: what
    /// it would have to add for them to resolve, and what cannot run. Empty
    /// when the engine is not configured or has nothing to say.
    pub gearbox: Vec<ProductChangeDto>,
}

async fn conformance(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Json(req): Json<ConformanceRequest>,
) -> ApiResult<JsonBody<ConformanceDto>> {
    let invalid = |msg: String| {
        StudioComponentsCatalogError::invalid_argument()
            .with_constraint(msg)
            .create()
    };
    let internal = |e: anyhow::Error| CanonicalError::internal(format!("{e:#}")).create();
    let project_id = req.project_id.trim();
    if Uuid::parse_str(project_id).is_err() {
        return Err(invalid(format!("project_id `{project_id}` is not a uuid")));
    }
    let Some((repo, deps)) = catalog
        .service
        .project_dependencies(&ctx, project_id)
        .await
        .map_err(internal)?
    else {
        return Err(invalid(
            "the project has no gear repository and no GitHub source whose Cargo manifests \
             could be read, so there is no code to compare"
                .into(),
        ));
    };

    let (nodes, _truncated) = catalog
        .service
        .list_component_nodes(&ctx)
        .await
        .map_err(internal)?;
    let components: Vec<Value> = nodes.into_iter().map(|n| n.value).collect();
    let mut profiles = serde_json::Map::new();
    for node in catalog
        .service
        .list_profiles(&ctx)
        .await
        .map_err(internal)?
    {
        if let Some(name) = node.value.get("gear_name").and_then(Value::as_str) {
            profiles.insert(name.to_owned(), node.value);
        }
    }

    // The catalogue components the code is made of: gears and plugins its
    // manifests depend on. SDK crates and libraries are how a gear is used,
    // not what the product is made of.
    let mut in_code: Vec<String> = components
        .iter()
        .filter(|c| {
            matches!(
                c.get("kind").and_then(Value::as_str),
                Some("gear" | "plugin")
            )
        })
        .filter_map(|c| c.get("name").and_then(Value::as_str))
        .filter(|name| deps.contains(*name))
        .map(str::to_owned)
        .collect();
    in_code.sort();
    in_code.dedup();

    let all = super::compose::plan_all(
        &req.capabilities,
        &components,
        &profiles,
        &super::compose::Vocabulary {
            terms: req.terms,
            contracts: req.contracts,
            decisions: req.decisions.into_iter().map(past_decision).collect(),
        },
    );
    let mut explained: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let items: Vec<ConformanceRowDto> = all
        .into_iter()
        .map(|row| {
            let implemented_by: Vec<ImplementerDto> = row
                .candidates
                .iter()
                .filter(|c| in_code.contains(&c.name))
                .map(|c| ImplementerDto {
                    name: c.name.clone(),
                    declared: c.declared,
                })
                .collect();
            explained.extend(implemented_by.iter().map(|i| i.name.clone()));
            let missing = implemented_by.is_empty();
            ConformanceRowDto {
                capability: row.capability,
                status: if missing { "missing" } else { "implemented" }.to_string(),
                candidates: if missing {
                    row.candidates
                        .iter()
                        .take(3)
                        .map(|c| c.name.clone())
                        .collect()
                } else {
                    Vec::new()
                },
                implemented_by,
            }
        })
        .collect();

    let declares = |name: &str| -> Vec<String> {
        let node = components
            .iter()
            .find(|c| c.get("name").and_then(Value::as_str) == Some(name));
        let Some(node) = node else { return Vec::new() };
        let values = super::values::resolve(node, profiles.get(name));
        values
            .get("capabilities")
            .and_then(|f| f.get("v").and_then(Value::as_str).or_else(|| f.as_str()))
            .unwrap_or_default()
            .split(',')
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty())
            .collect()
    };
    let unexplained: Vec<UnexplainedDto> = in_code
        .iter()
        .filter(|name| !explained.contains(*name))
        .map(|name| UnexplainedDto {
            name: name.clone(),
            declares: declares(name),
        })
        .collect();

    // The engine's view of the code's own set: what it would add, and what it
    // says cannot run. Best-effort -- the comparison stands without it.
    let gearbox: Vec<ProductChangeDto> = match catalog.gearbox.as_ref() {
        Some(gb) => match gb
            .complete(&in_code, &super::gearbox::GearConfig::new())
            .await
        {
            Ok(done) => done
                .changes
                .into_iter()
                .map(|c| ProductChangeDto {
                    gear: c.gear,
                    added: c.added,
                    reason: c.reason,
                })
                .collect(),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "conformance: the Gearbox engine did not answer");
                Vec::new()
            }
        },
        None => Vec::new(),
    };

    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(ConformanceDto {
        repo,
        components_in_code: in_code,
        items,
        total,
        unexplained,
        gearbox,
    }))
}

async fn compose_plan(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Json(req): Json<ComposeRequest>,
) -> ApiResult<JsonBody<ComposePlanDto>> {
    let (nodes, _truncated) = catalog
        .service
        .list_component_nodes(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let components: Vec<serde_json::Value> = nodes.into_iter().map(|n| n.value).collect();

    let profile_nodes = catalog
        .service
        .list_profiles(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let profiles = profiles_by_gear(profile_nodes.into_iter().map(|n| n.value));

    let rows = super::compose::plan(
        &req.capabilities,
        &components,
        &profiles,
        &super::compose::Vocabulary {
            terms: req.terms,
            contracts: req.contracts,
            decisions: req.decisions.into_iter().map(past_decision).collect(),
        },
    );
    let items: Vec<PlanRowDto> = rows
        .into_iter()
        .map(|row| PlanRowDto {
            capability: row.capability,
            gap: row.gap,
            unbuilt: row.unbuilt,
            candidates: row
                .candidates
                .into_iter()
                .map(|c| CandidateDto {
                    name: c.name,
                    kind: c.kind,
                    step: c.step.as_str().to_owned(),
                    contracts: c.contracts,
                    passage: c.passage,
                    cites: c.cites,
                    version: c.version,
                    decision: c.decision.map(|d| DecisionMarkDto {
                        decision: d.decision,
                        needs_review: d.needs_review,
                    }),
                    declared: c.declared,
                    score: u32::try_from(c.score).unwrap_or(u32::MAX),
                    why: c.why,
                    built: c.built.as_str().to_owned(),
                    composable: c.composable.as_str().to_owned(),
                    composable_why: c.composable_why,
                })
                .collect(),
        })
        .collect();
    Ok(Json(ComposePlanDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

/// The window a caller gets when it does not ask for one.
const DEFAULT_ACTIVITY_DAYS: u32 = 30;
/// The longest window offered. Two years of weekly buckets is already more
/// bars than a chart can draw, and a bigger window is a bigger upstream query
/// for a picture nobody can read.
const MAX_ACTIVITY_DAYS: u32 = 730;

/// One weekly bar of a gear's churn.
#[derive(Debug)]
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
#[derive(Debug)]
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
#[derive(Debug)]
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
#[derive(Debug)]
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

#[derive(Debug)]
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

    let (nodes, _truncated) = catalog
        .service
        .list_component_nodes(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let components: Vec<Value> = nodes.into_iter().map(|n| n.value).collect();
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
    let answer = activity_of(delivery.as_ref(), &components, days, compare_previous)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
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
    let mut repositories = Vec::with_capacity(plan.len());
    for repo in &plan {
        let query = crate::insight::port::DeliveryQuery {
            repository: repo.repository.clone(),
            from: Some(from.clone()),
            to: None,
            components: repo.components.clone(),
            limit: u32::try_from(repo.components.len()).ok(),
        };
        repositories.push(repo.repository.clone());
        pages.push(delivery.metrics(&query).await?);
        // Pull requests are a second question with its own coverage, so they
        // get their own failure: a warehouse without them is not a reason to
        // lose the commit activity as well.
        if let Ok(page) = delivery.pull_requests(&query).await {
            pr_pages.push(page);
        }
        if compare_previous {
            let earlier = crate::insight::port::DeliveryQuery {
                from: Some(previous.0.clone()),
                to: Some(previous.1.clone()),
                ..query
            };
            // As above: the comparison is an extra, and losing it loses
            // only the comparison.
            if let Ok(page) = delivery.pull_requests(&earlier).await {
                previous_pages.push(page);
            }
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
    let (raw, commit) = gearbox.catalogue_json().await?;
    let mut label = gearbox.corpus_label();
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
            .map_or_else(|| gearbox.corpus_label(), str::to_string),
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
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let nodes = catalog
        .service
        .list_profiles(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogNodeListResponse {
        nodes: to_dtos(nodes),
        truncated: false,
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

async fn get_project_repo(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(project_id): Path<Uuid>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let node = catalog
        .service
        .get_project_repo(&ctx, &project_id.to_string())
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogNodeListResponse {
        nodes: to_dtos(node.into_iter().collect()),
        truncated: false,
    }))
}

async fn set_project_repo(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<SetProjectRepoRequest>,
) -> ApiResult<JsonBody<CatalogNodeDto>> {
    let repo = serde_json::json!({
        "tenant": body.tenant,
        "connection_id": body.connection_id,
        "repo": body.repo,
        "branch": body.branch.unwrap_or_else(|| "main".to_string()),
    });
    let node = catalog
        .service
        .set_project_repo(&ctx, &project_id.to_string(), repo)
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("invalid gear repo: {e:#}"))
                .create()
        })?;
    let dto = to_dtos(vec![node])
        .into_iter()
        .next()
        .expect("one node converts to one DTO");
    Ok(Json(dto))
}

async fn scaffold_gear(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<ScaffoldRequest>,
) -> ApiResult<JsonBody<ScaffoldResultDto>> {
    // Explicit files win, because a caller that has already decided what to
    // write is not asking for a skeleton. Everything else is generated here.
    let files: Vec<super::scaffold::ScaffoldFile> = match body.files {
        Some(files) => files
            .into_iter()
            .map(|f| super::scaffold::ScaffoldFile {
                path: f.path,
                content: f.content,
            })
            .collect(),
        None => {
            let parent_dir = body.parent_dir.clone().unwrap_or_default();
            let (gear_gdl, plugin) =
                describe_new_gear(&ctx, &project_id.to_string(), &catalog, &body, &parent_dir)
                    .await?;
            super::skeleton::generate(&super::skeleton::SkeletonSpec {
                capability: body.slug.clone(),
                app_title: body.app_title.clone().unwrap_or_default(),
                problem: body.problem.clone().unwrap_or_default(),
                origin: body.origin.clone().unwrap_or_default(),
                parent_dir,
                gear_gdl,
                plugin,
            })
            .1
        }
    };
    let written: Vec<ScaffoldFileDto> = files
        .iter()
        .map(|f| ScaffoldFileDto {
            path: f.path.clone(),
            content: f.content.clone(),
        })
        .collect();
    if body.dry_run.unwrap_or(false) {
        return Ok(Json(ScaffoldResultDto {
            branch: format!("scaffold/{}", super::skeleton::gear_slug(&body.slug)),
            commit_sha: String::new(),
            pr_url: None,
            files: written,
        }));
    }
    let w = catalog
        .service
        .scaffold_into_repo(
            &ctx,
            &project_id.to_string(),
            &body.slug,
            files,
            body.open_pr.unwrap_or(false),
        )
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("scaffold failed: {e:#}"))
                .create()
        })?;
    Ok(Json(ScaffoldResultDto {
        branch: w.branch,
        commit_sha: w.commit_sha,
        pr_url: w.pr_url,
        files: written,
    }))
}

async fn get_project_product(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(project_id): Path<Uuid>,
) -> ApiResult<JsonBody<CatalogNodeListResponse>> {
    let node = catalog
        .service
        .get_project_product(&ctx, &project_id.to_string())
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(CatalogNodeListResponse {
        nodes: to_dtos(node.into_iter().collect()),
        truncated: false,
    }))
}

async fn save_project_product(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<SaveProjectProductRequest>,
) -> ApiResult<JsonBody<CatalogNodeDto>> {
    let invalid = |msg: String| {
        StudioComponentsCatalogError::invalid_argument()
            .with_constraint(msg)
            .create()
    };
    let mut patch = serde_json::Map::new();
    if let Some(id) = body.product_id {
        if !super::gearbox::is_kebab_id(&id) {
            return Err(invalid(format!("product id `{id}` is not a kebab-case id")));
        }
        patch.insert("product_id".into(), id.into());
    }
    if let Some(name) = body.name {
        patch.insert("name".into(), name.into());
    }
    if let Some(gears) = body.gears {
        let gears: Vec<String> = gears
            .into_iter()
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .collect();
        patch.insert("gears".into(), serde_json::json!(gears));
    }
    if let Some(profile) = body.profile {
        if !PROFILES.contains(&profile.as_str()) {
            return Err(invalid(format!(
                "profile `{profile}` is not one of {}",
                PROFILES.join(", ")
            )));
        }
        patch.insert("profile".into(), profile.into());
    }
    if body.config.is_some() {
        let config = super::gearbox::gear_config_from(body.config.as_ref())
            .map_err(|e| invalid(format!("{e:#}")))?;
        patch.insert(
            "config".into(),
            serde_json::to_value(&config).unwrap_or(Value::Null),
        );
    }
    let node = catalog
        .service
        .update_project_product(&ctx, &project_id.to_string(), patch)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let dto = to_dtos(vec![node])
        .into_iter()
        .next()
        .expect("one node converts to one DTO");
    Ok(Json(dto))
}

/// The `gear.gdl` for a gear the scaffold is about to write, from the engine's
/// own scaffold, and whether it is a plugin. `(None, false)` when the engine
/// is not configured: the skeleton is then what it always was. A kind the
/// engine does not know, or a plugin host it does not describe, is the
/// caller's mistake and says so.
async fn describe_new_gear(
    ctx: &SecurityContext,
    project_id: &str,
    catalog: &Catalog,
    body: &ScaffoldRequest,
    parent_dir: &str,
) -> ApiResult<(Option<String>, bool)> {
    let invalid = |msg: String| {
        StudioComponentsCatalogError::invalid_argument()
            .with_constraint(msg)
            .create()
    };
    let Some(gearbox) = catalog.gearbox.as_ref() else {
        return Ok((None, false));
    };
    let kind_text = body.gear_kind.clone().unwrap_or_default();
    let kind = super::gearbox::GearKind::parse(&kind_text).ok_or_else(|| {
        invalid(format!(
            "gear kind `{kind_text}` is not one of minimal, service, plugin"
        ))
    })?;
    let plugin = if kind == super::gearbox::GearKind::Plugin {
        let host = body
            .plugin_host
            .as_deref()
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .ok_or_else(|| {
                invalid(
                    "a plugin needs `plugin_host`, the gear whose extension point it fills".into(),
                )
            })?;
        // Which repository the gear goes into decides how the SDK is reached
        // from it: inside the corpus, a path within the repository; in the
        // project's own, the `gears-rust` checkout beside it. The plugin's
        // `gear.gdl` names its point by spec (`fills = "..."`), which the
        // engine joins across sources, so either validates.
        let project_repo = catalog
            .service
            .get_project_repo(ctx, project_id)
            .await
            .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
            .and_then(|n| {
                n.value
                    .get("repo")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default();
        let in_corpus = super::gearbox::repo_key(&project_repo) == gearbox.corpus_repo();
        let points = gearbox
            .extension_points()
            .await
            .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
        let wanted_spec = body
            .plugin_spec
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let mut of_host: Vec<_> = points
            .into_iter()
            .filter(|p| p.host_crate == host || p.host_id == host)
            .filter(|p| wanted_spec.is_none_or(|s| p.spec == s))
            .collect();
        if of_host.len() > 1 {
            let specs: Vec<&str> = of_host.iter().map(|p| p.spec.as_str()).collect();
            return Err(invalid(format!(
                "`{host}` declares several extension points; name one as `plugin_spec`: {}",
                specs.join(", ")
            )));
        }
        let point = of_host.pop().ok_or_else(|| {
            invalid(format!(
                "`{host}` has no such extension point the Gearbox engine knows of"
            ))
        })?;
        Some(super::gearbox::SdkLocator {
            spec: super::gearbox::spec_segment(&point.spec).to_string(),
            trait_ident: point.trait_ident,
            crate_name: point.sdk_crate,
            lib_ident: point.sdk_lib,
            path: if in_corpus {
                super::gearbox::sdk_path_in_repo(parent_dir, &point.sdk_path)
            } else {
                super::gearbox::sdk_path_beside(parent_dir, &point.sdk_path)
            },
        })
    } else {
        None
    };
    let slug = super::skeleton::gear_slug(&body.slug);
    let spec = super::gearbox::GearScaffold {
        crate_name: format!("cf-gears-{slug}"),
        name: super::skeleton::title_case(&slug),
        kind,
        plugin,
    };
    let is_plugin = spec.plugin.is_some();
    match gearbox.scaffold_gdl(spec).await {
        Ok(gdl) => Ok((Some(gdl), is_plugin)),
        // The skeleton is still worth writing; the description can be added
        // in the IDE, where the engine's New Gear wizard writes the same file.
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "gearbox: no gear.gdl for the scaffold");
            Ok((None, is_plugin))
        }
    }
}

/// A host a new plugin can fill.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ExtensionPointDto {
    pub host: String,
    pub host_id: String,
    /// The SDK crate its extension point is declared in.
    pub sdk: String,
    /// The point's GTS spec id: its identity, and what a scaffold names as
    /// `plugin_spec` when the host declares more than one.
    pub spec: String,
    /// The interface a plugin of this point implements.
    pub trait_ident: String,
    /// Whether the host can run in a product from this corpus.
    pub runs: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ExtensionPointListDto {
    pub items: Vec<ExtensionPointDto>,
    /// Every point is in `items`: the corpus is read whole, never paged.
    pub total: u32,
}

async fn extension_points(
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<ExtensionPointListDto>> {
    let points = catalog
        .gearbox()?
        .extension_points()
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let items: Vec<ExtensionPointDto> = points
        .into_iter()
        .map(|p| ExtensionPointDto {
            host: p.host_crate,
            host_id: p.host_id,
            sdk: p.sdk_crate,
            spec: p.spec,
            trait_ident: p.trait_ident,
            runs: p.runs,
        })
        .collect();
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(ExtensionPointListDto { items, total }))
}

async fn complete_product(
    Extension(catalog): Extension<Catalog>,
    Json(body): Json<CompleteProductRequest>,
) -> ApiResult<JsonBody<CompleteProductDto>> {
    let config = super::gearbox::gear_config_from(body.config.as_ref()).map_err(|e| {
        StudioComponentsCatalogError::invalid_argument()
            .with_constraint(format!("{e:#}"))
            .create()
    })?;
    let completion = catalog
        .gearbox()?
        .complete(&body.gears, &config)
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok(Json(CompleteProductDto {
        gears: completion.gears,
        changes: completion
            .changes
            .into_iter()
            .map(|c| ProductChangeDto {
                gear: c.gear,
                added: c.added,
                reason: c.reason,
            })
            .collect(),
        config: serde_json::to_value(&completion.config).unwrap_or(Value::Null),
    }))
}

async fn gearbox_catalogue(
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<GearboxCatalogueDto>> {
    let gearbox = catalog.gearbox()?;
    let (raw, commit) = gearbox
        .catalogue_json()
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let (corpus_url, corpus_ref, corpus_needs_token) = gearbox.corpus_origin();
    Ok(Json(GearboxCatalogueDto {
        source_id: CORPUS_SOURCE_ID.to_string(),
        corpus: gearbox.corpus_label(),
        corpus_url,
        corpus_ref,
        corpus_commit: commit,
        corpus_clone_path: corpus_needs_token.then(|| CORPUS_GIT_PATH.to_string()),
        corpus_needs_token,
        catalogue: Value::clone(&raw),
    }))
}

/// Where the corpus is cloned from through this backend; `git` appends the
/// protocol paths (`/info/refs`, `/git-upload-pack`).
const CORPUS_GIT_PATH: &str = "/studio-components-catalog/v1/gearbox/corpus";

#[derive(Debug, serde::Deserialize)]
pub struct CorpusRefsQuery {
    pub service: Option<String>,
}

/// The client that relays corpus packs. No overall timeout, because a clone
/// streams for as long as it takes; the connect timeout keeps a dead host from
/// hanging one.
fn corpus_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

/// One smart-HTTP request for the gear corpus, relayed with the corpus's own
/// token so a laptop can clone a private corpus without ever holding it
/// (ADR-0027). Any signed-in member may read it: the catalogue it describes is
/// already listed to them. Fetch only -- a push is refused here, whatever the
/// token upstream would allow.
async fn corpus_git(
    catalog: &Catalog,
    protocol_path: &str,
    service: crate::git_proxy::sources::Service,
    request: Request,
) -> Response {
    use crate::git_proxy::rest::{authenticate_member, refuse, send_upstream, stream_back};
    use crate::git_proxy::sources::{Service, upstream_url};

    let Ok(authn) = catalog
        .hub
        .get::<dyn authn_resolver_sdk::AuthNResolverClient>()
    else {
        return refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "Studio cannot check sign-ins right now; try again.",
        );
    };
    if let Err(refused) = authenticate_member(authn.as_ref(), request.headers()).await {
        return refused;
    }
    let Some(gearbox) = catalog.gearbox.as_ref() else {
        return refuse(StatusCode::NOT_FOUND, "This Studio keeps no gear corpus.");
    };
    if service != Service::UploadPack {
        return refuse(
            StatusCode::FORBIDDEN,
            "The gear corpus is read-only through Studio.",
        );
    }
    let (url, token) = gearbox.corpus_fetch();
    let Some(url) = upstream_url(&url, protocol_path) else {
        return refuse(
            StatusCode::NOT_FOUND,
            "The gear corpus is not an http(s) repository, so it cannot be cloned through Studio.",
        );
    };
    let token = (!token.is_empty()).then_some(token.as_str());
    match send_upstream(
        corpus_client(),
        &url,
        protocol_path,
        service,
        token,
        request,
        "The corpus's host refused its token; ask an administrator to update the gears connection.",
    )
    .await
    {
        Ok((_, response, answer)) => stream_back(response, answer),
        Err(refused) => refused,
    }
}

/// GET …/gearbox/corpus/info/refs?service= — the first request of a clone.
async fn corpus_refs(
    Extension(catalog): Extension<Catalog>,
    Query(query): Query<CorpusRefsQuery>,
    request: Request,
) -> Response {
    use crate::git_proxy::sources::Service;
    let Some(service) = query.service.as_deref().and_then(Service::parse) else {
        return crate::git_proxy::rest::refuse(
            StatusCode::BAD_REQUEST,
            "Only the smart HTTP protocol is served (service=git-upload-pack).",
        );
    };
    corpus_git(&catalog, "info/refs", service, request).await
}

/// POST …/gearbox/corpus/git-upload-pack — the pack a clone downloads.
async fn corpus_pack(Extension(catalog): Extension<Catalog>, request: Request) -> Response {
    corpus_git(
        &catalog,
        "git-upload-pack",
        crate::git_proxy::sources::Service::UploadPack,
        request,
    )
    .await
}

async fn gearbox_status(
    Extension(catalog): Extension<Catalog>,
) -> ApiResult<JsonBody<GearboxStatusDto>> {
    let profiles = PROFILES.iter().map(|p| (*p).to_string()).collect();
    let Some(gearbox) = catalog.gearbox.as_ref() else {
        return Ok(Json(GearboxStatusDto {
            enabled: false,
            engine_version: None,
            corpus_url: None,
            corpus_ref: None,
            corpus_commit: None,
            source_id: CORPUS_SOURCE_ID.to_string(),
            profiles,
            problem: Some("STUDIO_GEARBOX_WORKDIR is not set".to_string()),
        }));
    };
    let status = gearbox.status().await;
    Ok(Json(GearboxStatusDto {
        enabled: true,
        engine_version: status.engine_version,
        corpus_url: Some(status.corpus_url),
        corpus_ref: Some(status.corpus_ref),
        corpus_commit: status.corpus_commit,
        source_id: CORPUS_SOURCE_ID.to_string(),
        profiles,
        problem: status.problem,
    }))
}

/// Where a project's product description lives in its repository: the root,
/// which both the portal and the IDE's Gearbox look in first. Recorded with
/// every write, so a reader follows the record rather than this constant.
const PRODUCT_GDL_PATH: &str = "product.gdl";

async fn preview_product(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<ProductPreviewRequest>,
) -> ApiResult<JsonBody<ProductPreviewDto>> {
    let gearbox = catalog.gearbox()?;
    let invalid = |e: anyhow::Error| {
        StudioComponentsCatalogError::invalid_argument()
            .with_constraint(format!("{e:#}"))
            .create()
    };
    // Saving no gears is how a product project gets its `product.gdl` when it
    // is created; previewing none has nothing to show.
    if body.gears.is_empty() && !body.write.unwrap_or(false) {
        return Err(invalid(anyhow::anyhow!("pick at least one gear")));
    }
    let profile = body.profile.clone().unwrap_or_else(|| "dev".to_string());
    let name = body
        .name
        .clone()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| body.product_id.clone());
    let name_for_record = name.clone();
    let config = super::gearbox::gear_config_from(body.config.as_ref()).map_err(invalid)?;
    let preview = gearbox
        .preview(PreviewInput {
            product_id: body.product_id.clone(),
            name,
            gears: body.gears.clone(),
            profile: profile.clone(),
            config: config.clone(),
        })
        .await
        .map_err(invalid)?;

    let written = if body.write.unwrap_or(false) {
        // A `product/…` branch named after the content by default, so the
        // same description saved twice lands on the branch it already has
        // (`write_scaffold` returns it rather than refusing), and a
        // connected repository that is shared never has its base branch moved
        // by a preview. `onto_base` is for a repository the product owns
        // outright: a session opens the base branch, so there the description
        // is in the IDE the moment "Open in IDE" lands.
        let open_pr = body.open_pr.unwrap_or(false);
        let onto_base = body.onto_base.unwrap_or(false) && !open_pr;
        let branch = (!onto_base).then(|| {
            use sha2::Digest as _;
            let hash = sha2::Sha256::digest(preview.product_gdl.as_bytes());
            let digest: String = hash.iter().take(4).map(|b| format!("{b:02x}")).collect();
            format!("product/{}-{digest}", body.product_id)
        });
        let pr_title = open_pr.then(|| format!("Describe the {} product", body.product_id));
        let w = catalog
            .service
            .write_to_project_repo(
                &ctx,
                &project_id.to_string(),
                branch.as_deref(),
                &[super::scaffold::ScaffoldFile {
                    path: PRODUCT_GDL_PATH.to_string(),
                    content: preview.product_gdl.clone(),
                }],
                &format!("product: describe {} for Gearbox", body.product_id),
                pr_title.as_deref(),
            )
            .await
            .map_err(|e| {
                StudioComponentsCatalogError::invalid_argument()
                    .with_constraint(format!("writing product.gdl failed: {e:#}"))
                    .create()
            })?;
        Some(ProductWriteDto {
            branch: w.branch,
            commit_sha: w.commit_sha,
            pr_url: w.pr_url,
        })
    } else {
        None
    };

    let r = preview.resolution;

    // The preview is the project's product now: what was asked, what the
    // engine said, and where it was saved. Recorded on every run, so the
    // project remembers its product without anybody pressing a second button.
    let errors = r.diagnostics.iter().filter(|d| d.is_error()).count();
    let warnings = r
        .diagnostics
        .iter()
        .filter(|d| d.severity == "warning")
        .count();
    let mut record = serde_json::Map::new();
    record.insert("product_id".into(), body.product_id.clone().into());
    record.insert("name".into(), name_for_record.into());
    record.insert("gears".into(), serde_json::json!(body.gears));
    record.insert(
        "config".into(),
        serde_json::to_value(&config).unwrap_or(Value::Null),
    );
    record.insert("profile".into(), profile.clone().into());
    record.insert(
        "last_preview".into(),
        serde_json::json!({
            "profile": profile,
            "ok": errors == 0,
            "errors": errors,
            "warnings": warnings,
            "applications": r.applications.iter().map(|a| &a.name).collect::<Vec<_>>(),
            "gears": r.gears.iter().map(|g| &g.crate_name).collect::<Vec<_>>(),
            "corpus_commit": preview.corpus_commit,
        }),
    );
    if let Some(w) = &written {
        record.insert(
            "written".into(),
            serde_json::json!({
                "branch": w.branch,
                "commit_sha": w.commit_sha,
                "pr_url": w.pr_url,
                "path": PRODUCT_GDL_PATH,
            }),
        );
    }
    if let Err(e) = catalog
        .service
        .update_project_product(&ctx, &project_id.to_string(), record)
        .await
    {
        // The preview itself stands; only its memory is lost.
        tracing::warn!(error = %format!("{e:#}"), "gearbox: could not record the project's product");
    }

    Ok(Json(ProductPreviewDto {
        ok: !r.diagnostics.iter().any(|d| d.is_error()),
        product_gdl: preview.product_gdl,
        profile,
        diagnostics: r
            .diagnostics
            .into_iter()
            .map(|d| GearboxDiagnosticDto {
                code: d.code,
                severity: d.severity,
                message: d.message,
                help: d.help,
                file: d.file,
                line: d.line,
            })
            .collect(),
        applications: r
            .applications
            .into_iter()
            .map(|a| GearboxApplicationDto {
                name: a.name,
                kind: a.kind,
                anchor: a.anchor,
                gears: a.gears,
                replicas: a.replicas,
                listens: a
                    .listens
                    .into_iter()
                    .map(|l| GearboxListenDto {
                        name: l.name,
                        gear: l.gear,
                        address: l.address,
                    })
                    .collect(),
            })
            .collect(),
        gears: r
            .gears
            .into_iter()
            .map(|g| GearboxGearDto {
                id: g.id,
                crate_name: g.crate_name,
                reasons: g.reasons,
            })
            .collect(),
        added: preview
            .composition
            .added_hosts
            .into_iter()
            .map(|(host, plugin)| GearboxAddedDto {
                reason: format!("host of {plugin}"),
                id: host,
            })
            .collect(),
        plugin_options: preview
            .composition
            .plugin_options
            .into_iter()
            .map(|(host, available)| GearboxPluginOptionDto { host, available })
            .collect(),
        not_described: preview.composition.not_described,
        corpus_commit: preview.corpus_commit,
        written,
    }))
}

async fn create_repo(
    OrgCtx(ctx): OrgCtx,
    Extension(catalog): Extension<Catalog>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<CreateRepoRequest>,
) -> ApiResult<(StatusCode, JsonBody<CreateRepoResultDto>)> {
    let created = catalog
        .service
        .create_project_repo(
            &ctx,
            &project_id.to_string(),
            body.tenant,
            body.connection_id,
            body.owner.as_deref(),
            body.is_org.unwrap_or(false),
            &body.name,
            body.private.unwrap_or(true),
        )
        .await
        .map_err(|e| {
            StudioComponentsCatalogError::invalid_argument()
                .with_constraint(format!("create repo failed: {e:#}"))
                .create()
        })?;
    Ok((
        StatusCode::CREATED,
        Json(CreateRepoResultDto {
            full_name: created.full_name,
            html_url: created.html_url,
            default_branch: created.default_branch,
        }),
    ))
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
    }))
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<CatalogService>,
    hub: Arc<ClientHub>,
    gearbox: Option<Arc<Gearbox>>,
) -> Router {
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
             answers the same run.",
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
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-components-catalog/v1/conformance")
        .operation_id("studio_components_catalog.create_conformance_report")
        .summary("Compare what a project's specs ask for with what its code is made of")
        .description(
            "For each capability the project's documents declare: whether the code depends on a \
             catalogue component that fills it, and which. Then the components the code uses that \
             no declared capability accounts for -- what the specs may be missing -- and what the \
             Gearbox engine says about the code's own set of gears. The code is the project's gear \
             repository, read as the run-time dependencies of every Cargo.toml in it.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ConformanceRequest>(openapi, "The project and its declared capabilities")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(conformance)
        .json_response_with_schema::<ConformanceDto>(openapi, StatusCode::OK, "The comparison")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-components-catalog/v1/compose")
        .operation_id("studio_components_catalog.create_compose_plan")
        .summary("Match what a product needs against the components that exist")
        .description(
            "Answers `what can we build this from?` for a list of capabilities, and answers it              the same way wherever it is asked. The App Spec's Compose button and a project's              Components tab ask it from two directions and must not get two answers.

             CONTRACT MATCHES COME FIRST. A gear the Gearbox engine reports as providing one              of the capability's `contracts` is a `contract` match; a gear whose words mention              the capability's `terms` is an `evidence` match and cites its `passage`. Every              evidence match ranks below every contract match, and the order below applies              within each step.

             CANDIDATES COME BACK BUILT FIRST, and the shortlist is cut after that sort rather              than before it — a well-written stub is mostly prose, prose is what keywords              match, and a stub that outranked a shipped component would answer the question              with something nobody can build from. Components that were never built are              LABELLED rather than dropped, because a design may legitimately name a component              that is still only a design.

             `unbuilt` says candidates exist and none is built: not a gap, and not an answer              either. `why` names the terms that matched, so a suggestion can be argued with.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ComposeRequest>(openapi, "The capabilities to fill")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(compose_plan)
        .json_response_with_schema::<ComposePlanDto>(openapi, StatusCode::OK, "The plan")
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

    let router =
        OperationBuilder::get("/studio-components-catalog/v1/projects/{project_id}/gear-repo")
            .operation_id("studio_components_catalog.get_project_repo")
            .summary("The gear repository connected to a project (0 or 1 node)")
            .description(
                "Returns the repository a project's gears are scaffolded into, as \
                 zero or one node — a project with none has simply not connected \
                 one yet.",
            )
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("project_id", "Project tenant id")
            .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
            .handler(get_project_repo)
            .json_response_with_schema::<CatalogNodeListResponse>(
                openapi,
                StatusCode::OK,
                "Connected gear repo",
            )
            .error_401(openapi)
            .error_500(openapi)
            .register(router, openapi);

    let router =
        OperationBuilder::post("/studio-components-catalog/v1/projects/{project_id}/gear-repo")
            .operation_id("studio_components_catalog.set_project_repo")
            .summary("Connect (or update) the gear repository for a project")
            .description(
                "Connects a project to the repository its gears are scaffolded \
                 into, or replaces that connection. The branch defaults to \
                 `main`. The repository is reached through a studio-connector \
                 connection, so its credential stays in credstore.",
            )
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("project_id", "Project tenant id")
            .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
            .handler(set_project_repo)
            .json_request::<SetProjectRepoRequest>(openapi, "Gear repository")
            .json_response_with_schema::<CatalogNodeDto>(
                openapi,
                StatusCode::OK,
                "Connected gear repo",
            )
            .error_400(openapi)
            .error_401(openapi)
            .error_500(openapi)
            .register(router, openapi);

    let router =
        OperationBuilder::post("/studio-components-catalog/v1/projects/{project_id}/scaffold")
            .operation_id("studio_components_catalog.scaffold_gear")
            .summary("Write a scaffolded gear skeleton into the project's connected gear repo")
            .description(
                "Writes a gear skeleton into the project's connected repository, \
                 on a branch named after the slug, and opens a pull request when \
                 asked to. Returns what was written and where.",
            )
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("project_id", "Project tenant id")
            .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
            .handler(scaffold_gear)
            .json_request::<ScaffoldRequest>(openapi, "Gear scaffold")
            .json_response_with_schema::<ScaffoldResultDto>(
                openapi,
                StatusCode::OK,
                "Scaffold written",
            )
            .error_400(openapi)
            .error_401(openapi)
            .error_500(openapi)
            .register(router, openapi);

    let router =
        OperationBuilder::post("/studio-components-catalog/v1/projects/{project_id}/create-repo")
            .operation_id("studio_components_catalog.create_repo")
            .summary(
                "Create a new repository via the connector and set it as the project's gear repo",
            )
            .description(
                "Creates a repository through the project's connector and records \
                 it as that project's gear repository in one step, so a new \
                 project does not need the repository to exist first. Answers 201; \
                 `GET …/projects/{project_id}/gear-repo` reads the record back.",
            )
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("project_id", "Project tenant id")
            .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
            .handler(create_repo)
            .json_request::<CreateRepoRequest>(openapi, "New repository")
            .json_response_with_schema::<CreateRepoResultDto>(
                openapi,
                StatusCode::CREATED,
                "Created repository",
            )
            .error_400(openapi)
            .error_401(openapi)
            .error_500(openapi)
            .register(router, openapi);

    let router =
        OperationBuilder::get("/studio-components-catalog/v1/projects/{project_id}/product")
            .operation_id("studio_components_catalog.get_project_product")
            .summary("The product a project is composing out of gears")
            .description(
                "The gears picked for the project's product, its deployment \
                 profile, and what the Gearbox engine said at the last preview. \
                 Empty until something is picked.",
            )
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("project_id", "Project tenant id")
            .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
            .handler(get_project_product)
            .json_response_with_schema::<CatalogNodeListResponse>(
                openapi,
                StatusCode::OK,
                "Project product",
            )
            .error_401(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);

    let router =
        OperationBuilder::put("/studio-components-catalog/v1/projects/{project_id}/product")
            .operation_id("studio_components_catalog.upsert_project_product")
            .summary("Save which gears a project's product is made of")
            .description(
                "Merges the given fields into the project's product record; \
                 fields left out keep their value.",
            )
            .tag("StudioComponentsCatalog")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("project_id", "Project tenant id")
            .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
            .handler(save_project_product)
            .json_request::<SaveProjectProductRequest>(openapi, "Product fields")
            .json_response_with_schema::<CatalogNodeDto>(openapi, StatusCode::OK, "Saved product")
            .error_400(openapi)
            .error_401(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/gearbox/extension-points")
        .operation_id("studio_components_catalog.list_extension_points")
        .summary("The hosts a new plugin gear can fill, from the Gearbox engine's catalogue")
        .description(
            "One entry per host extension point in the gear corpus: the host crate, \
             the SDK crate the point is declared in, and whether the host can run \
             in a product. A scaffold with `gear_kind: plugin` names one as \
             `plugin_host`.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(extension_points)
        .json_response_with_schema::<ExtensionPointListDto>(
            openapi,
            StatusCode::OK,
            "Extension points",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-components-catalog/v1/gearbox/complete")
        .operation_id("studio_components_catalog.resolve_product")
        .summary("Complete picked gears into a set the Gearbox engine can resolve")
        .description(
            "Drops what the gear catalogue proves cannot run (a gear with required \
             configuration nobody set, a host no plugin fills, a plugin with no \
             host, a gear that must run with one of those), adds a plugin for a \
             host that has none and a REST host for REST gears, and says why for \
             each. Writes nothing.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(complete_product)
        .json_request::<CompleteProductRequest>(openapi, "Picked gears")
        .json_response_with_schema::<CompleteProductDto>(openapi, StatusCode::OK, "Completed picks")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/gearbox/catalogue")
        .operation_id("studio_components_catalog.get_gearbox_catalogue")
        .summary("The gear corpus's catalogue, as the Gearbox engine reads it")
        .description(
            "Every gear the corpus describes, read by the engine from the one              checkout this backend keeps. An IDE whose workspace holds no gear              corpus lists the gears from here instead of cloning it.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(gearbox_catalogue)
        .json_response_with_schema::<GearboxCatalogueDto>(openapi, StatusCode::OK, "Catalogue")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // The corpus Git relay. `.anonymous().exposed()` for the reason studio-git
    // gives: `git` sends Basic credentials, which the gateway's Bearer-only
    // layer would refuse before they arrive; `authenticate_member` is the check.
    let router = OperationBuilder::get("/studio-components-catalog/v1/gearbox/corpus/info/refs")
        .operation_id("studio_components_catalog.get_corpus_refs")
        .summary("Git smart-HTTP ref advertisement for the gear corpus")
        .description(
            "The first request of a clone of the gear corpus through this backend. \
             Authenticated with the member's Studio token as the Basic password (or a \
             Bearer token); the corpus's own token is attached upstream and never \
             returned. Fetch only.",
        )
        .tag("StudioComponentsCatalog")
        .anonymous()
        .exposed()
        .handler(corpus_refs)
        .text_response(
            StatusCode::OK,
            "Ref advertisement",
            "application/x-git-upload-pack-advertisement",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router =
        OperationBuilder::post("/studio-components-catalog/v1/gearbox/corpus/git-upload-pack")
            .operation_id("studio_components_catalog.pull_corpus_pack")
            .summary("Git smart-HTTP upload-pack (clone and fetch) for the gear corpus")
            .description(
                "Streams the negotiation to the corpus's host with its token attached, \
                 and streams the pack back.",
            )
            .tag("StudioComponentsCatalog")
            .anonymous()
            .exposed()
            .handler(corpus_pack)
            .text_response(
                StatusCode::OK,
                "Pack",
                "application/x-git-upload-pack-result",
            )
            .error_401(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/gearbox")
        .operation_id("studio_components_catalog.get_gearbox_status")
        .summary("Whether product previews can run, and against which gear corpus")
        .description(
            "Reports the Gearbox engine version and the gear corpus checkout \
             previews resolve against. A session opened for a product project \
             checks out the same corpus beside the project, under `source_id`.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(gearbox_status)
        .json_response_with_schema::<GearboxStatusDto>(openapi, StatusCode::OK, "Engine status")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post(
        "/studio-components-catalog/v1/projects/{project_id}/product/preview",
    )
    .operation_id("studio_components_catalog.materialize_product_preview")
    .summary("Compose a product.gdl from picked gears and resolve it")
    .description(
        "Writes a product.gdl naming the picked gears (a plugin under the host \
         whose extension point it fills), then asks the Gearbox engine to \
         validate and resolve it for one deployment profile. Returns the \
         description, the engine's diagnostics, and the applications and gears \
         the resolution arrived at. With `write`, also commits product.gdl to \
         the project's gear repo on a new branch. `write` with no gears commits \
         the description a new product project starts from, without resolving it.",
    )
    .tag("StudioComponentsCatalog")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("project_id", "Project tenant id")
    .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
    .handler(preview_product)
    .json_request::<ProductPreviewRequest>(openapi, "Picked gears")
    .json_response_with_schema::<ProductPreviewDto>(openapi, StatusCode::OK, "Preview")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router.layer(Extension(Catalog::new(service, hub, gearbox)))
}
