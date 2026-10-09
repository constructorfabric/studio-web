//! REST surface of studio-product: a project's product, the repository it
//! is written to, and the Gearbox engine behind both.
//!
//! These routes lived under `/studio-components-catalog/v1/` until the product
//! became a gear of its own. Two of the old paths stay, registered here: an IDE
//! released before the move reads the corpus catalogue from the old path, and
//! a desktop corpus clone keeps the URL it was cloned from (see
//! [`register_legacy_routes`]).

use std::sync::Arc;

use axum::extract::{Path, Query, Request};
use axum::response::Response;
use axum::{Extension, Router};
use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit::client_hub::ClientHub;
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::gearbox::{CORPUS_SOURCE_ID, Gearbox, PROFILES, PreviewInput};
use super::service::ProductService;
use crate::catalog_graph::gts::GtsNode;
use crate::org_scope::OrgCtx;

/// Errors attributable to a product resource.
#[resource_error(gts_id!("cf.studio._.product.v1~"))]
pub struct StudioProductError;

/// A write that did not happen, as a problem: 400 `failed_precondition`
/// `CONNECTION_NOT_OWNED` when its connection is not the organization's
/// (`cpt-studio-constraint-connector-own-connections`), else 400 with `what`
/// and the cause.
pub(super) fn write_problem(what: &str, e: &anyhow::Error) -> CanonicalError {
    use crate::connectors::sdk::ownership::{CONNECTION_NOT_OWNED, NotOwned};
    if let Some(refused) = e.downcast_ref::<NotOwned>() {
        return StudioProductError::failed_precondition()
            .with_precondition_violation(
                format!("connection:{}", refused.holder),
                format!("{what}: {refused}"),
                CONNECTION_NOT_OWNED,
            )
            .create();
    }
    StudioProductError::invalid_argument()
        .with_constraint(format!("{what}: {e:#}"))
        .create()
}

/// Service handle, injected into the handlers.
#[derive(Clone)]
pub struct Product {
    pub service: Arc<ProductService>,
    /// Resolved per request: the corpus relay checks sign-ins through the
    /// AuthN resolver.
    hub: Arc<ClientHub>,
    /// Product previews; `None` when no corpus workdir is configured.
    gearbox: Option<Arc<Gearbox>>,
}

impl Product {
    pub fn new(
        service: Arc<ProductService>,
        hub: Arc<ClientHub>,
        gearbox: Option<Arc<Gearbox>>,
    ) -> Self {
        Self {
            service,
            hub,
            gearbox,
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
}

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// One record of a project's product: its gear repository or its product.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductRecordDto {
    /// GTS type id, e.g. `gts.cf.studio.catalog.project_product.v1~`.
    pub type_id: String,
    /// Deterministic instance id, keyed on the project.
    pub instance_id: String,
    #[schema(value_type = Object)]
    pub value: Value,
}

/// Zero or one record: a project with none has simply not made one yet.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProductRecordListDto {
    pub nodes: Vec<ProductRecordDto>,
    /// Always false: a project has at most one of each record.
    #[serde(default)]
    pub truncated: bool,
}

fn to_dtos(nodes: Vec<GtsNode>) -> Vec<ProductRecordDto> {
    nodes
        .into_iter()
        .map(|n| ProductRecordDto {
            type_id: n.type_id.to_string(),
            instance_id: n.instance_id,
            value: n.value,
        })
        .collect()
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
    /// Capability keys the gear provides, written into its `gear.toml`, so the
    /// gear declares them once the catalogue syncs it (`auth`, `storage`).
    /// Ignored with `files`.
    pub capabilities: Option<Vec<String>>,
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

/// The most gears one config-schema request may name; a product is a few
/// dozen at most.
const MAX_SCHEMA_GEARS: usize = 200;

/// The gears whose configuration a form is about to ask for.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct GearConfigSchemaRequest {
    /// Crate names (`cf-gears-api-gateway`) or engine ids, as the product's
    /// picks name them. At most 200.
    pub gears: Vec<String>,
}

/// One field of a gear's configuration, from its `gear.gdl`.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearConfigFieldDto {
    pub name: String,
    /// Declared required. With no `default`, not `derived`, and not set by
    /// the product, the engine refuses the product.
    pub required: bool,
    /// What the gear falls back to when the product sets nothing; absent when
    /// it has no default.
    pub default: Option<Value>,
    /// Written by generation from the topology (an endpoint's address), so
    /// not the product's to set.
    pub derived: bool,
}

/// One requested gear's configuration schema.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearConfigSchemaDto {
    /// The name as it was sent; the key the product's `config` uses.
    pub gear: String,
    /// The engine id; absent when no `gear.gdl` in the corpus describes the
    /// gear (then `fields` is empty).
    pub id: Option<String>,
    /// In the order the gear declares them.
    pub fields: Vec<GearConfigFieldDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GearConfigSchemaListDto {
    /// One per distinct requested gear, in request order.
    pub items: Vec<GearConfigSchemaDto>,
    /// Every requested gear is in `items`: nothing is paged.
    pub total: u32,
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
    /// `owner/name` of the repository written into, or — on a dry run — the
    /// one it would be; absent when the project has nowhere to write.
    pub repo: Option<String>,
    /// Why that repository (ADR-0042 §2): `project` (the project's gear
    /// repository), `organization` (the organization's gear repository) or
    /// `sources` (the project's own repository from its sources).
    pub target: Option<String>,
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

async fn get_project_repo(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Path(project_id): Path<Uuid>,
) -> ApiResult<JsonBody<ProductRecordListDto>> {
    let node = product
        .service
        .get_project_repo(&ctx, &project_id.to_string())
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(ProductRecordListDto {
        nodes: to_dtos(node.into_iter().collect()),
        truncated: false,
    }))
}

async fn set_project_repo(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<SetProjectRepoRequest>,
) -> ApiResult<JsonBody<ProductRecordDto>> {
    // Every write to it would go through this connection: refuse one the
    // organization does not own before it is recorded.
    product
        .service
        .ensure_owned(
            &ctx,
            project_id,
            &super::port::RepositoryTarget {
                tenant: body.tenant,
                connection_id: body.connection_id,
                repo: body.repo.clone(),
                base_branch: String::new(),
            },
        )
        .await
        .map_err(|e| write_problem("invalid gear repo", &e))?;
    let repo = serde_json::json!({
        "tenant": body.tenant,
        "connection_id": body.connection_id,
        "repo": body.repo,
        "branch": body.branch.unwrap_or_else(|| "main".to_string()),
    });
    let node = product
        .service
        .set_project_repo(&ctx, &project_id.to_string(), repo)
        .await
        .map_err(|e| {
            StudioProductError::invalid_argument()
                .with_constraint(format!("invalid gear repo: {e:#}"))
                .create()
        })?;
    let dto = to_dtos(vec![node])
        .into_iter()
        .next()
        .expect("one node converts to one DTO");
    Ok(Json(dto))
}

/// The organization's gear repository, as the catalogue keeps it, for the
/// organization `project_id` hangs under: the second place a project's new
/// gear may go (ADR-0042 §2). Best effort -- an assembly without the
/// catalogue, or an organization that cannot be read, has none -- and
/// answered with the caller acting in the organization, where its
/// connection is readable.
async fn organization_gear_repo(
    ctx: &SecurityContext,
    product: &Product,
    project_id: Uuid,
) -> Option<(SecurityContext, super::port::RepositoryTarget)> {
    let registry = product
        .hub
        .get::<dyn crate::components_catalog::port::Registry>()
        .ok()?;
    let org = product
        .service
        .organization_of_project(ctx, project_id)
        .await
        .unwrap_or_else(|| ctx.subject_tenant_id());
    let repo = match registry.gear_repository(ctx, org).await {
        Ok(repo) => repo?,
        Err(e) => {
            tracing::warn!(organization_id = %org, error = %format!("{e:#}"), "studio-product: the organization's gear repository could not be read");
            return None;
        }
    };
    let octx = crate::org_scope::acting_in(ctx, org).ok()?;
    Some((
        octx,
        super::port::RepositoryTarget {
            tenant: repo.tenant,
            connection_id: Some(repo.connection_id),
            repo: repo.repo,
            base_branch: repo.branch,
        },
    ))
}

/// The request's gear, in the port's terms.
fn new_gear_of(body: &ScaffoldRequest) -> super::port::NewGear {
    super::port::NewGear {
        slug: body.slug.clone(),
        app_title: body.app_title.clone(),
        problem: body.problem.clone(),
        origin: body.origin.clone(),
        parent_dir: body.parent_dir.clone(),
        gear_kind: body.gear_kind.clone(),
        plugin_host: body.plugin_host.clone(),
        plugin_spec: body.plugin_spec.clone(),
        capabilities: body.capabilities.clone().unwrap_or_default(),
        open_pr: body.open_pr.unwrap_or(false),
        dry_run: body.dry_run.unwrap_or(false),
    }
}

/// A scaffold that did not happen, as a problem.
fn scaffold_problem(e: super::port::ScaffoldFailure) -> CanonicalError {
    match e {
        super::port::ScaffoldFailure::Invalid(msg) => StudioProductError::invalid_argument()
            .with_constraint(msg)
            .create(),
        super::port::ScaffoldFailure::Failed(e) => {
            CanonicalError::internal(format!("{e:#}")).create()
        }
    }
}

async fn scaffold_gear(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<ScaffoldRequest>,
) -> ApiResult<JsonBody<ScaffoldResultDto>> {
    let dry_run = body.dry_run.unwrap_or(false);
    // Where it goes: the project's gear repository, else the organization's,
    // else the project's sources (ADR-0042 §2). Asked of the catalogue only
    // when the project has none of its own.
    let has_own = product
        .service
        .get_project_repo(&ctx, &project_id.to_string())
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
        .is_some();
    let org = if has_own {
        None
    } else {
        organization_gear_repo(&ctx, &product, project_id).await
    };
    let (org_ctx, org_target) = match org {
        Some((octx, target)) => (Some(octx), Some(target)),
        None => (None, None),
    };
    let target = product
        .service
        .scaffold_target(&ctx, &project_id.to_string(), org_target)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let target_repo = target
        .as_ref()
        .map(|t| t.target.repo.clone())
        .unwrap_or_default();

    // Explicit files win, because a caller that has already decided what to
    // write is not asking for a skeleton. Everything else is generated here.
    let gear = new_gear_of(&body);
    let files: Vec<super::scaffold::ScaffoldFile> = match body.files {
        Some(files) => files
            .into_iter()
            .map(|f| super::scaffold::ScaffoldFile {
                path: f.path,
                content: f.content,
            })
            .collect(),
        None => super::new_gear::files(product.gearbox.as_deref(), &target_repo, &gear)
            .await
            .map_err(scaffold_problem)?,
    };
    let written: Vec<ScaffoldFileDto> = files
        .iter()
        .map(|f| ScaffoldFileDto {
            path: f.path.clone(),
            content: f.content.clone(),
        })
        .collect();
    let repo = target.as_ref().map(|t| t.target.repo.clone());
    let into = target.as_ref().map(|t| t.origin.as_str().to_owned());
    if dry_run {
        return Ok(Json(ScaffoldResultDto {
            branch: format!("scaffold/{}", super::skeleton::gear_slug(&body.slug)),
            commit_sha: String::new(),
            pr_url: None,
            files: written,
            repo,
            target: into,
        }));
    }
    let Some(target) = target else {
        return Err(StudioProductError::invalid_argument()
            .with_constraint(format!(
                "scaffold failed: {}",
                super::service::no_repo_text()
            ))
            .create());
    };
    // The organization's repository is written as the organization, where
    // its connection is readable; the project's as before.
    let wctx = match (target.origin, &org_ctx) {
        (super::service::TargetOrigin::Organization, Some(octx)) => octx,
        _ => &ctx,
    };
    // Only through a connection the project's organization owns: a source
    // or gear repository connected through the platform's (inherited)
    // connection is refused, CONNECTION_NOT_OWNED.
    let w = product
        .service
        .scaffold_into_target(
            wctx,
            project_id,
            &target.target,
            &body.slug,
            &files,
            gear.open_pr,
        )
        .await
        .map_err(|e| write_problem("scaffold failed", &e))?;
    Ok(Json(ScaffoldResultDto {
        branch: w.branch,
        commit_sha: w.commit_sha,
        pr_url: w.pr_url,
        files: written,
        repo,
        target: into,
    }))
}

async fn get_project_product(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Path(project_id): Path<Uuid>,
) -> ApiResult<JsonBody<ProductRecordListDto>> {
    let node = product
        .service
        .get_project_product(&ctx, &project_id.to_string())
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(ProductRecordListDto {
        nodes: to_dtos(node.into_iter().collect()),
        truncated: false,
    }))
}

async fn save_project_product(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<SaveProjectProductRequest>,
) -> ApiResult<JsonBody<ProductRecordDto>> {
    let invalid = |msg: String| {
        StudioProductError::invalid_argument()
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
    let node = product
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
    Extension(product): Extension<Product>,
) -> ApiResult<JsonBody<ExtensionPointListDto>> {
    let points = product
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
    Extension(product): Extension<Product>,
    Json(body): Json<CompleteProductRequest>,
) -> ApiResult<JsonBody<CompleteProductDto>> {
    let config = super::gearbox::gear_config_from(body.config.as_ref()).map_err(|e| {
        StudioProductError::invalid_argument()
            .with_constraint(format!("{e:#}"))
            .create()
    })?;
    let completion = product
        .gearbox()?
        .complete(&body.gears, &config)
        .await
        .map_err(|e| {
            StudioProductError::invalid_argument()
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

async fn gear_config_schemas(
    Extension(product): Extension<Product>,
    Json(body): Json<GearConfigSchemaRequest>,
) -> ApiResult<JsonBody<GearConfigSchemaListDto>> {
    if body.gears.len() > MAX_SCHEMA_GEARS {
        return Err(StudioProductError::invalid_argument()
            .with_constraint(format!(
                "at most {MAX_SCHEMA_GEARS} gears per request, got {}",
                body.gears.len()
            ))
            .create());
    }
    let schemas = product
        .gearbox()?
        .config_schemas(&body.gears)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let items: Vec<GearConfigSchemaDto> = schemas
        .into_iter()
        .map(|s| GearConfigSchemaDto {
            gear: s.gear,
            id: s.id,
            fields: s
                .fields
                .into_iter()
                .map(|f| GearConfigFieldDto {
                    name: f.name,
                    required: f.required,
                    default: f.default,
                    derived: f.derived,
                })
                .collect(),
        })
        .collect();
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(GearConfigSchemaListDto { items, total }))
}

async fn gearbox_catalogue(
    Extension(product): Extension<Product>,
) -> ApiResult<JsonBody<GearboxCatalogueDto>> {
    let gearbox = product.gearbox()?;
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
const CORPUS_GIT_PATH: &str = "/studio-product/v1/gearbox/corpus";

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
    product: &Product,
    protocol_path: &str,
    service: crate::git_proxy::sdk::Service,
    request: Request,
) -> Response {
    use crate::git_proxy::sdk::{Service, upstream_url};
    use crate::git_proxy::sdk::{authenticate_member, refuse, send_upstream, stream_back};

    let Ok(authn) = product
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
    let Some(gearbox) = product.gearbox.as_ref() else {
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
    Extension(product): Extension<Product>,
    Query(query): Query<CorpusRefsQuery>,
    request: Request,
) -> Response {
    use crate::git_proxy::sdk::Service;
    let Some(service) = query.service.as_deref().and_then(Service::parse) else {
        return crate::git_proxy::sdk::refuse(
            StatusCode::BAD_REQUEST,
            "Only the smart HTTP protocol is served (service=git-upload-pack).",
        );
    };
    corpus_git(&product, "info/refs", service, request).await
}

/// POST …/gearbox/corpus/git-upload-pack — the pack a clone downloads.
async fn corpus_pack(Extension(product): Extension<Product>, request: Request) -> Response {
    corpus_git(
        &product,
        "git-upload-pack",
        crate::git_proxy::sdk::Service::UploadPack,
        request,
    )
    .await
}

async fn gearbox_status(
    Extension(product): Extension<Product>,
) -> ApiResult<JsonBody<GearboxStatusDto>> {
    let profiles = PROFILES.iter().map(|p| (*p).to_string()).collect();
    let Some(gearbox) = product.gearbox.as_ref() else {
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

/// Where a project's product description goes in its repository: where it was
/// last written, so a project keeps one description however its id changes
/// (projects created before `products/<id>/` keep theirs at the root), and
/// otherwise `products/<id>/product.gdl`, the layout the IDE's Gearbox finds
/// and New Product suggests. Recorded with every write, so a reader follows the
/// record.
fn product_path_for(record: Option<&Value>, product_id: &str) -> String {
    record
        .and_then(|r| r.pointer("/written/path"))
        .and_then(Value::as_str)
        .filter(|p| super::gearbox::is_product_path(p))
        .map_or_else(
            || super::gearbox::product_gdl_path(product_id),
            str::to_owned,
        )
}

async fn preview_product(
    OrgCtx(ctx): OrgCtx,
    Extension(product): Extension<Product>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<ProductPreviewRequest>,
) -> ApiResult<JsonBody<ProductPreviewDto>> {
    let gearbox = product.gearbox()?;
    let invalid = |e: anyhow::Error| {
        StudioProductError::invalid_argument()
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
    let record = product
        .service
        .get_project_product(&ctx, &project_id.to_string())
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let product_path = product_path_for(record.as_ref().map(|n| &n.value), &body.product_id);
    let preview = gearbox
        .preview(PreviewInput {
            product_id: body.product_id.clone(),
            product_path: product_path.clone(),
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
        let w = product
            .service
            .write_to_project_repo(
                &ctx,
                &project_id.to_string(),
                branch.as_deref(),
                &[super::scaffold::ScaffoldFile {
                    path: product_path.clone(),
                    content: preview.product_gdl.clone(),
                }],
                &format!("product: describe {} for Gearbox", body.product_id),
                pr_title.as_deref(),
            )
            .await
            .map_err(|e| write_problem("writing product.gdl failed", &e))?;
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
                "path": product_path,
            }),
        );
    }
    if let Err(e) = product
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
    Extension(product): Extension<Product>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<CreateRepoRequest>,
) -> ApiResult<(StatusCode, JsonBody<CreateRepoResultDto>)> {
    let created = product
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
        .map_err(|e| write_problem("create repo failed", &e))?;
    Ok((
        StatusCode::CREATED,
        Json(CreateRepoResultDto {
            full_name: created.full_name,
            html_url: created.html_url,
            default_branch: created.default_branch,
        }),
    ))
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<ProductService>,
    hub: Arc<ClientHub>,
    gearbox: Option<Arc<Gearbox>>,
) -> Router {
    let router = OperationBuilder::get("/studio-product/v1/projects/{project_id}/gear-repo")
        .operation_id("studio_product.get_project_repo")
        .summary("The gear repository connected to a project (0 or 1 node)")
        .description(
            "Returns the repository a project's gears are scaffolded into, as \
                 zero or one node — a project with none has simply not connected \
                 one yet.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("project_id", "Project tenant id")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_project_repo)
        .json_response_with_schema::<ProductRecordListDto>(
            openapi,
            StatusCode::OK,
            "Connected gear repo",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-product/v1/projects/{project_id}/gear-repo")
        .operation_id("studio_product.set_project_repo")
        .summary("Connect (or update) the gear repository for a project")
        .description(
            "Connects a project to the repository its gears are scaffolded \
                 into, or replaces that connection. The branch defaults to \
                 `main`. The repository is reached through a studio-connector \
                 connection, so its credential stays in credstore. The \
                 connection must be the organization's own -- held by it, a \
                 workspace or a project of it; one inherited from the platform \
                 or held by another organization is a 400 `CONNECTION_NOT_OWNED`.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("project_id", "Project tenant id")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(set_project_repo)
        .json_request::<SetProjectRepoRequest>(openapi, "Gear repository")
        .json_response_with_schema::<ProductRecordDto>(
            openapi,
            StatusCode::OK,
            "Connected gear repo",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-product/v1/projects/{project_id}/scaffold")
        .operation_id("studio_product.scaffold_gear")
        .summary("Write a scaffolded gear skeleton into the project's connected gear repo")
        .description(
            "Writes a gear skeleton on a branch named after the slug, and opens \
                 a pull request when asked to. The repository is the project's \
                 gear repository; without one, the organization's gear repository \
                 (ADR-0042); without that, the project's own repository from its \
                 sources. Returns what was written, the repository (`repo`) and \
                 which of the three it was (`target`: `project`, `organization` \
                 or `sources`); a dry run says the same of where it would go. \
                 Written only through a connection the organization owns: one \
                 inherited from the platform is a 400 `CONNECTION_NOT_OWNED`.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("project_id", "Project tenant id")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(scaffold_gear)
        .json_request::<ScaffoldRequest>(openapi, "Gear scaffold")
        .json_response_with_schema::<ScaffoldResultDto>(openapi, StatusCode::OK, "Scaffold written")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-product/v1/projects/{project_id}/create-repo")
        .operation_id("studio_product.create_repo")
        .summary("Create a new repository via the connector and set it as the project's gear repo")
        .description(
            "Creates a repository through the project's connector and records \
                 it as that project's gear repository in one step, so a new \
                 project does not need the repository to exist first. Answers 201; \
                 `GET …/projects/{project_id}/gear-repo` reads the record back. \
                 A connection the organization does not own (the platform's, \
                 inherited) is a 400 `CONNECTION_NOT_OWNED`; nothing is created.",
        )
        .tag("StudioProduct")
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

    let router = OperationBuilder::get("/studio-product/v1/projects/{project_id}/product")
        .operation_id("studio_product.get_project_product")
        .summary("The product a project is composing out of gears")
        .description(
            "The gears picked for the project's product, its deployment \
                 profile, and what the Gearbox engine said at the last preview. \
                 Empty until something is picked.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("project_id", "Project tenant id")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_project_product)
        .json_response_with_schema::<ProductRecordListDto>(
            openapi,
            StatusCode::OK,
            "Project product",
        )
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-product/v1/projects/{project_id}/product")
        .operation_id("studio_product.upsert_project_product")
        .summary("Save which gears a project's product is made of")
        .description(
            "Merges the given fields into the project's product record; \
                 fields left out keep their value.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("project_id", "Project tenant id")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(save_project_product)
        .json_request::<SaveProjectProductRequest>(openapi, "Product fields")
        .json_response_with_schema::<ProductRecordDto>(openapi, StatusCode::OK, "Saved product")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-product/v1/gearbox/extension-points")
        .operation_id("studio_product.list_extension_points")
        .summary("The hosts a new plugin gear can fill, from the Gearbox engine's catalogue")
        .description(
            "One entry per host extension point in the gear corpus: the host crate, \
             the SDK crate the point is declared in, and whether the host can run \
             in a product. A scaffold with `gear_kind: plugin` names one as \
             `plugin_host`.",
        )
        .tag("StudioProduct")
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

    let router = OperationBuilder::post("/studio-product/v1/gearbox/complete")
        .operation_id("studio_product.resolve_product")
        .summary("Complete picked gears into a set the Gearbox engine can resolve")
        .description(
            "Drops what the gear catalogue proves cannot run (a gear with required \
             configuration nobody set, a host no plugin fills, a plugin with no \
             host, a gear that must run with one of those), adds a plugin for a \
             host that has none and a REST host for REST gears, and says why for \
             each. Writes nothing.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .handler(complete_product)
        .json_request::<CompleteProductRequest>(openapi, "Picked gears")
        .json_response_with_schema::<CompleteProductDto>(openapi, StatusCode::OK, "Completed picks")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-product/v1/gearbox/config-schema")
        .operation_id("studio_product.query_gear_config_schemas")
        .summary("The configuration fields of named gears, as their gear.gdl declares them")
        .description(
            "For each named gear (crate name or engine id, at most 200): its config \
             fields with `required`, `default`, and `derived` for the addresses \
             generation writes. A required field with no default that the product \
             does not set is what makes the engine refuse it. A gear the corpus \
             does not describe answers with no `id` and no fields. Writes nothing.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .handler(gear_config_schemas)
        .json_request::<GearConfigSchemaRequest>(openapi, "Gears to describe")
        .json_response_with_schema::<GearConfigSchemaListDto>(
            openapi,
            StatusCode::OK,
            "Config schemas",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-product/v1/gearbox/catalogue")
        .operation_id("studio_product.get_gearbox_catalogue")
        .summary("The gear corpus's catalogue, as the Gearbox engine reads it")
        .description(
            "Every gear the corpus describes, read by the engine from the one              checkout this backend keeps. An IDE whose workspace holds no gear              corpus lists the gears from here instead of cloning it.",
        )
        .tag("StudioProduct")
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
    let router = OperationBuilder::get("/studio-product/v1/gearbox/corpus/info/refs")
        .operation_id("studio_product.get_corpus_refs")
        .summary("Git smart-HTTP ref advertisement for the gear corpus")
        .description(
            "The first request of a clone of the gear corpus through this backend. \
             Authenticated with the member's Studio token as the Basic password (or a \
             Bearer token); the corpus's own token is attached upstream and never \
             returned. Fetch only.",
        )
        .tag("StudioProduct")
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

    let router = OperationBuilder::post("/studio-product/v1/gearbox/corpus/git-upload-pack")
        .operation_id("studio_product.pull_corpus_pack")
        .summary("Git smart-HTTP upload-pack (clone and fetch) for the gear corpus")
        .description(
            "Streams the negotiation to the corpus's host with its token attached, \
                 and streams the pack back.",
        )
        .tag("StudioProduct")
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

    let router = OperationBuilder::get("/studio-product/v1/gearbox")
        .operation_id("studio_product.get_gearbox_status")
        .summary("Whether product previews can run, and against which gear corpus")
        .description(
            "Reports the Gearbox engine version and the gear corpus checkout \
             previews resolve against. A session opened for a product project \
             checks out the same corpus beside the project, under `source_id`.",
        )
        .tag("StudioProduct")
        .authenticated()
        .require_license_features::<License>([])
        .handler(gearbox_status)
        .json_response_with_schema::<GearboxStatusDto>(openapi, StatusCode::OK, "Engine status")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-product/v1/projects/{project_id}/product/preview")
        .operation_id("studio_product.materialize_product_preview")
        .summary("Compose a product.gdl from picked gears and resolve it")
        .description(
            "Writes a product.gdl naming the picked gears (a plugin under the host \
         whose extension point it fills), then asks the Gearbox engine to \
         validate and resolve it for one deployment profile. Returns the \
         description, the engine's diagnostics, and the applications and gears \
         the resolution arrived at. With `write`, also commits product.gdl to \
         the project's gear repo on a new branch. `write` with no gears commits \
         the description a new product project starts from, without resolving it. \
         A write through a connection the organization does not own is a 400 \
         `CONNECTION_NOT_OWNED`.",
        )
        .tag("StudioProduct")
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

    let router = register_legacy_routes(router, openapi);
    router.layer(Extension(Product::new(service, hub, gearbox)))
}

/// The paths these routes had under `studio-components-catalog` that a client
/// already in the field still calls: the IDE's remote catalogue
/// (`theia/studio`, `gearbox-remote-catalogue.ts`) and a desktop clone of the
/// corpus, whose `origin` is the path it was cloned from. Same handlers.
/// Remove once no supported desktop release reads them.
fn register_legacy_routes(router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    let router = OperationBuilder::get("/studio-components-catalog/v1/gearbox/catalogue")
        .operation_id("studio_components_catalog.get_gearbox_catalogue")
        .summary("Deprecated: the gear corpus's catalogue, now under studio-product")
        .description(
            "The same answer as `GET /studio-product/v1/gearbox/catalogue`, kept \
             for IDEs released before the product became its own gear.",
        )
        .tag("StudioComponentsCatalog")
        .authenticated()
        .require_license_features::<License>([])
        .handler(gearbox_catalogue)
        .json_response_with_schema::<GearboxCatalogueDto>(openapi, StatusCode::OK, "Catalogue")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-components-catalog/v1/gearbox/corpus/info/refs")
        .operation_id("studio_components_catalog.get_corpus_refs")
        .summary("Deprecated: Git ref advertisement for the gear corpus, now under studio-product")
        .description(
            "The same relay as `GET /studio-product/v1/gearbox/corpus/info/refs`, \
             kept because a desktop clone fetches from the URL it was cloned from.",
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

    OperationBuilder::post("/studio-components-catalog/v1/gearbox/corpus/git-upload-pack")
        .operation_id("studio_components_catalog.pull_corpus_pack")
        .summary("Deprecated: Git upload-pack for the gear corpus, now under studio-product")
        .description(
            "The same relay as `POST /studio-product/v1/gearbox/corpus/git-upload-pack`, \
             kept because a desktop clone fetches from the URL it was cloned from.",
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
        .register(router, openapi)
}

#[cfg(test)]
mod tests {
    use super::product_path_for;
    use serde_json::json;

    #[test]
    fn a_new_product_goes_under_products_and_a_written_one_stays_where_it_is() {
        assert_eq!(product_path_for(None, "shop"), "products/shop/product.gdl");
        let unwritten = json!({ "product_id": "shop" });
        assert_eq!(
            product_path_for(Some(&unwritten), "shop"),
            "products/shop/product.gdl"
        );
        // A project created before `products/<id>/` keeps its root file, and a
        // renamed product keeps the file it has.
        let at_root = json!({ "written": { "path": "product.gdl" } });
        assert_eq!(product_path_for(Some(&at_root), "shop"), "product.gdl");
        let renamed = json!({ "written": { "path": "products/old/product.gdl" } });
        assert_eq!(
            product_path_for(Some(&renamed), "new"),
            "products/old/product.gdl"
        );
        let outside = json!({ "written": { "path": "../product.gdl" } });
        assert_eq!(
            product_path_for(Some(&outside), "shop"),
            "products/shop/product.gdl"
        );
    }
}
