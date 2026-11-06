//! The routes of a project's images, an organization's registries, a
//! cluster's readiness, namespace assignments and a build's plan
//! (ADR-0062).

use axum::extract::{Path, Query};
use axum::http::HeaderMap;
use axum::{Extension, Router};
use serde::Deserialize;
use toolkit::api::canonical_prelude::*;
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{Environments, License, ProjectQuery, StudioBuildRequest, TAG, problem, total};
use crate::environments::images::{ImageKind, ImageRecord, ImageState, Retention};
use crate::environments::records::{Assignment, ImageFilter};
use crate::environments::service::{
    BuildAsked, BuildPlan, Refusal, RetentionOf, RetentionScope, RunsIn,
};
use crate::org_scope::OrgCtx;

/* ── DTOs ── */

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RunsInDto {
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    pub environment_name: String,
    #[schema(value_type = String)]
    pub deployment_id: Uuid,
    pub namespace: String,
    /// RFC 3339: when the release was decided, else asked for.
    pub deployed_at: String,
}

fn runs_dto(r: RunsIn) -> RunsInDto {
    RunsInDto {
        environment_id: r.environment_id,
        environment_name: r.environment_name,
        deployment_id: r.deployment_id,
        namespace: r.namespace,
        deployed_at: r.deployed_at,
    }
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ImageRecordDto {
    #[schema(value_type = String)]
    pub id: Uuid,
    #[schema(value_type = String)]
    pub project_id: Uuid,
    #[schema(value_type = Option<String>)]
    pub registry_connection_id: Option<Uuid>,
    pub registry_host: String,
    pub repository: String,
    /// `host/repository@digest`: how a deploy names it.
    pub reference: String,
    pub tags: Vec<String>,
    pub digest: String,
    pub media_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub platforms: Vec<String>,
    pub build_id: Option<String>,
    pub app: Option<String>,
    pub commit: Option<String>,
    pub description_revision: Option<i64>,
    pub lock_hash: Option<String>,
    pub pushed_by: Option<String>,
    /// RFC 3339.
    pub pushed_at: String,
    /// `image` | `chart`.
    pub kind: String,
    /// `present` | `missing` | `deleted` | `retained`.
    pub state: String,
    pub pinned: bool,
    #[schema(value_type = Option<String>)]
    pub promoted_from: Option<Uuid>,
    /// Where an imported external image came from.
    pub source_ref: Option<String>,
    /// The live releases that run it.
    pub running_in: Vec<RunsInDto>,
}

fn rfc3339_ms(ms: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()
        .and_then(|t| {
            t.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_default()
}

fn image_dto((r, runs): (ImageRecord, Vec<RunsIn>)) -> ImageRecordDto {
    ImageRecordDto {
        reference: match r.kind {
            ImageKind::Image => r.reference(),
            ImageKind::Chart => r.chart_ref(),
        },
        id: r.id,
        project_id: r.project_id,
        registry_connection_id: r.registry_connection_id,
        registry_host: r.registry_host,
        repository: r.repository,
        tags: r.tags,
        digest: r.digest,
        media_type: r.media_type,
        size_bytes: r.size_bytes,
        platforms: r.platforms,
        build_id: r.build_id,
        app: r.app,
        commit: r.commit,
        description_revision: r.description_revision,
        lock_hash: r.lock_hash,
        pushed_by: r.pushed_by,
        pushed_at: rfc3339_ms(r.pushed_at_ms),
        kind: r.kind.as_str().to_owned(),
        state: r.state.as_str().to_owned(),
        pinned: r.pinned,
        promoted_from: r.promoted_from,
        source_ref: r.source_ref,
        running_in: runs.into_iter().map(runs_dto).collect(),
    }
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ImageListDto {
    pub items: Vec<ImageRecordDto>,
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ImageRunDto {
    #[schema(value_type = String)]
    pub run_id: Uuid,
    /// The record the run acts on, or makes.
    #[schema(value_type = String)]
    pub image_id: Uuid,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ImageDeleteRunDto {
    #[schema(value_type = String)]
    pub run_id: Uuid,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PromotionRequest {
    /// The environment whose registry gets the copy, under the project's
    /// path there.
    #[schema(value_type = String)]
    pub environment_id: Uuid,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ImportRequest {
    /// The environment whose registry the image is copied into.
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    /// The external reference, with a tag or a digest:
    /// `docker.io/library/postgres:16`.
    pub source: String,
    /// The name under `<prefix>/<project>/mirror/`; default the source's
    /// last path segment.
    #[serde(default)]
    pub name: Option<String>,
    /// `image` (the default) or `chart`, an infra chart imported as OCI.
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct RetentionDto {
    /// `project` | `organization` (answer only).
    #[serde(default)]
    pub scope: Option<String>,
    /// Keep the newest n of each repository.
    #[serde(default)]
    pub keep_last: Option<u32>,
    /// Keep anything pushed in the last d days.
    #[serde(default)]
    pub keep_days: Option<u32>,
    /// The project has no policy of its own: the organization's applies
    /// (answer only).
    #[serde(default)]
    pub inherited: Option<bool>,
}

fn retention_dto(r: RetentionOf) -> RetentionDto {
    RetentionDto {
        scope: Some(r.scope.to_owned()),
        keep_last: r.policy.keep_last,
        keep_days: r.policy.keep_days,
        inherited: Some(r.inherited),
    }
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryEnvironmentDto {
    #[schema(value_type = String)]
    pub id: Uuid,
    pub name: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryDto {
    #[schema(value_type = String)]
    pub connection_id: Uuid,
    pub label: String,
    pub host: String,
    /// `ghcr` | `oci` (Harbor is told apart when it is read).
    pub kind: String,
    pub prefixes: Vec<String>,
    pub environments: Vec<RegistryEnvironmentDto>,
    /// `push` | `pull` | `push_pull`.
    pub role: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryListDto {
    pub items: Vec<RegistryDto>,
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RepositoryDto {
    pub name: String,
    #[schema(value_type = Option<String>)]
    pub project_id: Option<Uuid>,
    pub project_name: Option<String>,
    /// How many records Studio keeps of it.
    pub recorded: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RepositoryListDto {
    pub items: Vec<RepositoryDto>,
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RegistryVersionDto {
    pub digest: Option<String>,
    pub tags: Vec<String>,
    pub size_bytes: Option<i64>,
    /// RFC 3339, when the registry says.
    pub pushed_at: Option<String>,
    #[schema(value_type = Option<String>)]
    pub image_id: Option<Uuid>,
    #[schema(value_type = Option<String>)]
    pub project_id: Option<Uuid>,
    pub running_in: Vec<RunsInDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct VersionListDto {
    pub items: Vec<RegistryVersionDto>,
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct OrphanDto {
    pub repository: String,
    pub digest: Option<String>,
    pub tags: Vec<String>,
    /// `unowned` | `unrecorded` | `undeployed` | `missing`.
    pub reason: String,
    #[schema(value_type = Option<String>)]
    pub image_id: Option<Uuid>,
    #[schema(value_type = Option<String>)]
    pub project_id: Option<Uuid>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct OrphanListDto {
    pub items: Vec<OrphanDto>,
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReadinessDto {
    /// `bootstrapped` | `namespace_limited` | `partial`.
    pub level: String,
    /// What a partial cluster lacks, each said as what to do.
    pub missing: Vec<String>,
    /// The namespaces a namespace-limited cluster gives.
    pub namespaces: Vec<String>,
    pub bootstrap_version: Option<String>,
    /// Whether the admission policy refused an unlabelled namespace.
    pub policy_enforced: bool,
    /// What the environment's own setup should fix, a sentence each: the
    /// cluster is ready, and still e.g. pulls with the push login.
    #[serde(default)]
    pub warnings: Vec<String>,
    /// The code of each of `warnings`, in its order (`PULL_USES_PUSH_LOGIN`).
    #[serde(default)]
    pub warning_codes: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlanSourceDto {
    pub id: String,
    pub repository: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub commit: Option<String>,
    #[schema(value_type = Option<String>)]
    pub connection_id: Option<Uuid>,
    pub connection_label: Option<String>,
    pub connection_scope: Option<String>,
    #[schema(value_type = Option<String>)]
    pub connection_holder: Option<Uuid>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlanRefusalDto {
    pub code: String,
    pub message: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BuildPlanDto {
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    pub environment: String,
    pub profile: String,
    pub product_file: String,
    pub description_revision: Option<i64>,
    pub strictness: String,
    pub namespace: String,
    pub build_namespace: String,
    pub builder_image: String,
    pub builder_pinned: bool,
    pub gearbox_version: Option<String>,
    pub registry_prefix: String,
    pub image_repositories: Vec<String>,
    pub chart_repository: String,
    pub sources: Vec<PlanSourceDto>,
    pub warnings: Vec<String>,
    /// The codes of the environment's warnings among `warnings`, e.g.
    /// `PULL_USES_PUSH_LOGIN`: the cluster pulls with the push login.
    #[serde(default)]
    pub warning_codes: Vec<String>,
    /// What a build would be refused with now; absent: it would start.
    pub refusal: Option<PlanRefusalDto>,
}

fn plan_dto(p: BuildPlan) -> BuildPlanDto {
    BuildPlanDto {
        environment_id: p.environment_id,
        environment: p.environment,
        profile: p.profile,
        product_file: p.product_file,
        description_revision: p.description_revision,
        strictness: p.strictness,
        namespace: p.namespace,
        build_namespace: p.build_namespace,
        builder_image: p.builder_image,
        builder_pinned: p.builder_pinned,
        gearbox_version: p.gearbox_version,
        registry_prefix: p.registry_prefix,
        image_repositories: p.image_repositories,
        chart_repository: p.chart_repository,
        sources: p
            .sources
            .into_iter()
            .map(|s| PlanSourceDto {
                id: s.id,
                repository: s.repository,
                git_ref: s.git_ref,
                commit: s.commit,
                connection_id: s.connection_id,
                connection_label: s.connection_label,
                connection_scope: s.connection_scope,
                connection_holder: s.connection_holder,
            })
            .collect(),
        warnings: p.warnings,
        warning_codes: p.warning_codes,
        refusal: p
            .refusal
            .map(|(code, message)| PlanRefusalDto { code, message }),
    }
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct AssignmentDto {
    #[schema(value_type = String)]
    pub project_id: Uuid,
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    pub namespace: String,
    /// Default: the namespace itself.
    #[serde(default)]
    pub build_namespace: Option<String>,
    /// Answer only: who assigned it (`studio` for a namespace a run made).
    #[serde(default)]
    pub assigned_by: Option<String>,
    /// Answer only, RFC 3339.
    #[serde(default)]
    pub assigned_at: Option<String>,
}

fn assignment_dto(a: Assignment) -> AssignmentDto {
    AssignmentDto {
        project_id: a.project_id,
        environment_id: a.environment_id,
        namespace: a.namespace,
        build_namespace: Some(a.build_namespace),
        assigned_by: Some(a.assigned_by),
        assigned_at: Some(rfc3339_ms(a.assigned_at_ms)),
    }
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AssignmentListDto {
    pub items: Vec<AssignmentDto>,
    pub total: u32,
}

/* ── queries ── */

#[derive(Debug, Deserialize)]
pub struct ImageQuery {
    project_id: Uuid,
    #[serde(default)]
    environment_id: Option<Uuid>,
    #[serde(default)]
    app: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    build_id: Option<String>,
    #[serde(flatten)]
    page: crate::pagination::PageQuery,
}

#[derive(Debug, Deserialize)]
pub struct MaybeProject {
    #[serde(default)]
    project_id: Option<Uuid>,
}

/* ── handlers ── */

fn invalid(why: String) -> CanonicalError {
    problem(Refusal::Invalid(why))
}

async fn list_images(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ImageQuery>,
) -> ApiResult<JsonBody<ImageListDto>> {
    let filter = ImageFilter {
        app: q.app,
        kind: match q.kind.as_deref() {
            None | Some("") => None,
            Some(k) => Some(
                ImageKind::parse(k)
                    .ok_or_else(|| invalid(format!("kind is image or chart, not '{k}'")))?,
            ),
        },
        state: match q.state.as_deref() {
            None | Some("") => None,
            Some(s) => Some(ImageState::parse(s).ok_or_else(|| {
                invalid(format!(
                    "state is present, missing, deleted or retained, not '{s}'"
                ))
            })?),
        },
        build_id: q.build_id,
    };
    let offset = q.page.offset().to_string();
    let (items, n, _) = envs
        .0
        .images(
            &ctx,
            q.project_id,
            &filter,
            Some(&offset),
            q.page.limit() as u64,
        )
        .await
        .map_err(problem)?;
    let items: Vec<ImageRecordDto> = items
        .into_iter()
        .filter(|(_, runs)| {
            q.environment_id
                .is_none_or(|e| runs.iter().any(|r| r.environment_id == e))
        })
        .map(image_dto)
        .collect();
    Ok(Json(ImageListDto {
        total: u32::try_from(n).unwrap_or(u32::MAX),
        items,
    }))
}

async fn get_image(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Path(image_id): Path<Uuid>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<ImageRecordDto>> {
    let placed = envs
        .0
        .image(&ctx, q.project_id, image_id)
        .await
        .map_err(problem)?;
    Ok(Json(image_dto(placed)))
}

async fn pin_image(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Path(image_id): Path<Uuid>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<ImageRecordDto>> {
    let placed = envs
        .0
        .pin_image(&ctx, q.project_id, image_id, true)
        .await
        .map_err(problem)?;
    Ok(Json(image_dto(placed)))
}

async fn unpin_image(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Path(image_id): Path<Uuid>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<ImageRecordDto>> {
    let placed = envs
        .0
        .pin_image(&ctx, q.project_id, image_id, false)
        .await
        .map_err(problem)?;
    Ok(Json(image_dto(placed)))
}

async fn delete_image(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Path(image_id): Path<Uuid>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<(StatusCode, JsonBody<ImageRunDto>)> {
    let run_id = envs
        .0
        .delete_image(&ctx, q.project_id, image_id)
        .await
        .map_err(problem)?;
    Ok((StatusCode::ACCEPTED, Json(ImageRunDto { run_id, image_id })))
}

async fn promote_image(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Path(image_id): Path<Uuid>,
    Query(q): Query<ProjectQuery>,
    _headers: HeaderMap,
    Json(body): Json<PromotionRequest>,
) -> ApiResult<(StatusCode, JsonBody<ImageRunDto>)> {
    let (run_id, made) = envs
        .0
        .promote_image(&ctx, q.project_id, image_id, body.environment_id)
        .await
        .map_err(problem)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(ImageRunDto {
            run_id,
            image_id: made,
        }),
    ))
}

async fn import_image(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ProjectQuery>,
    _headers: HeaderMap,
    Json(body): Json<ImportRequest>,
) -> ApiResult<(StatusCode, JsonBody<ImageRunDto>)> {
    let kind = match body.kind.as_deref() {
        None | Some("") => ImageKind::Image,
        Some(k) => ImageKind::parse(k)
            .ok_or_else(|| invalid(format!("kind is image or chart, not '{k}'")))?,
    };
    let (run_id, image_id) = envs
        .0
        .import_image(
            &ctx,
            q.project_id,
            body.environment_id,
            &body.source,
            body.name.as_deref(),
            kind,
        )
        .await
        .map_err(problem)?;
    Ok((StatusCode::ACCEPTED, Json(ImageRunDto { run_id, image_id })))
}

fn scope_of(ctx: &SecurityContext, q: &MaybeProject) -> RetentionScope {
    match q.project_id {
        Some(p) => RetentionScope::Project(p),
        None => RetentionScope::Organization(ctx.subject_tenant_id()),
    }
}

async fn get_retention(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Query(q): Query<MaybeProject>,
) -> ApiResult<JsonBody<RetentionDto>> {
    let r = envs
        .0
        .retention(&ctx, scope_of(&ctx, &q))
        .await
        .map_err(problem)?;
    Ok(Json(retention_dto(r)))
}

async fn put_retention(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Query(q): Query<MaybeProject>,
    Json(body): Json<RetentionDto>,
) -> ApiResult<JsonBody<RetentionDto>> {
    let r = envs
        .0
        .put_retention(
            &ctx,
            scope_of(&ctx, &q),
            Retention {
                keep_last: body.keep_last,
                keep_days: body.keep_days,
            },
        )
        .await
        .map_err(problem)?;
    Ok(Json(retention_dto(r)))
}

async fn list_registries(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
) -> ApiResult<JsonBody<RegistryListDto>> {
    let list = envs
        .0
        .registries(&ctx, ctx.subject_tenant_id())
        .await
        .map_err(problem)?;
    Ok(Json(RegistryListDto {
        total: total(list.len()),
        items: list
            .into_iter()
            .map(|r| RegistryDto {
                connection_id: r.connection_id,
                label: r.label,
                host: r.host,
                kind: r.kind,
                prefixes: r.prefixes,
                environments: r
                    .environments
                    .into_iter()
                    .map(|(id, name)| RegistryEnvironmentDto { id, name })
                    .collect(),
                role: r.role,
            })
            .collect(),
    }))
}

async fn list_repositories(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(connection_id): Path<Uuid>,
) -> ApiResult<JsonBody<RepositoryListDto>> {
    let list = envs
        .0
        .registry_repositories(&ctx, ctx.subject_tenant_id(), connection_id)
        .await
        .map_err(problem)?;
    Ok(Json(RepositoryListDto {
        total: total(list.len()),
        items: list
            .into_iter()
            .map(|r| RepositoryDto {
                name: r.name,
                project_id: r.project_id,
                project_name: r.project_name,
                recorded: u32::try_from(r.recorded).unwrap_or(u32::MAX),
            })
            .collect(),
    }))
}

async fn list_versions(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path((connection_id, repository)): Path<(Uuid, String)>,
) -> ApiResult<JsonBody<VersionListDto>> {
    let list = envs
        .0
        .registry_tags(&ctx, ctx.subject_tenant_id(), connection_id, &repository)
        .await
        .map_err(problem)?;
    Ok(Json(VersionListDto {
        total: total(list.len()),
        items: list
            .into_iter()
            .map(|v| RegistryVersionDto {
                digest: v.version.digest,
                tags: v.version.tags,
                size_bytes: v.version.size_bytes,
                pushed_at: v.version.pushed_at,
                image_id: v.image_id,
                project_id: v.project_id,
                running_in: v.running_in.into_iter().map(runs_dto).collect(),
            })
            .collect(),
    }))
}

async fn delete_version(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path((connection_id, repository, digest)): Path<(Uuid, String, String)>,
) -> ApiResult<(StatusCode, JsonBody<ImageDeleteRunDto>)> {
    let run_id = envs
        .0
        .delete_registry_version(
            &ctx,
            ctx.subject_tenant_id(),
            connection_id,
            &repository,
            &digest,
        )
        .await
        .map_err(problem)?;
    Ok((StatusCode::ACCEPTED, Json(ImageDeleteRunDto { run_id })))
}

async fn list_orphans(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(connection_id): Path<Uuid>,
) -> ApiResult<JsonBody<OrphanListDto>> {
    let list = envs
        .0
        .registry_orphans(&ctx, ctx.subject_tenant_id(), connection_id)
        .await
        .map_err(problem)?;
    Ok(Json(OrphanListDto {
        total: total(list.len()),
        items: list
            .into_iter()
            .map(|o| OrphanDto {
                repository: o.repository,
                digest: o.digest,
                tags: o.tags,
                reason: o.reason.as_str().to_owned(),
                image_id: o.image_id,
                project_id: o.project_id,
            })
            .collect(),
    }))
}

async fn get_readiness(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(environment_id): Path<Uuid>,
    Query(q): Query<MaybeProject>,
) -> ApiResult<JsonBody<ReadinessDto>> {
    let org = match q.project_id {
        Some(p) => envs
            .0
            .organization_of_project(&ctx, p)
            .await
            .map_err(problem)?,
        None => ctx.subject_tenant_id(),
    };
    let (report, warnings, warning_codes) = envs
        .0
        .readiness(&ctx, org, q.project_id, environment_id)
        .await
        .map_err(problem)?;
    use crate::connectors::sdk::Readiness;
    let (missing, namespaces) = match &report.readiness {
        Readiness::Bootstrapped { .. } => (Vec::new(), Vec::new()),
        Readiness::NamespaceLimited { namespaces } => (Vec::new(), namespaces.clone()),
        Readiness::Partial { missing } => (missing.clone(), Vec::new()),
    };
    Ok(Json(ReadinessDto {
        level: report.readiness.level().to_owned(),
        missing,
        namespaces,
        bootstrap_version: report.version.map(|v| v.to_string()),
        policy_enforced: report.policy_enforced,
        warnings,
        warning_codes,
    }))
}

async fn plan_build(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ProjectQuery>,
    Json(body): Json<StudioBuildRequest>,
) -> ApiResult<JsonBody<BuildPlanDto>> {
    // The profile a build of the same request would take.
    let profile = match body.profile.filter(|p| !p.trim().is_empty()) {
        Some(p) => p,
        None => {
            envs.0
                .profile_for(&ctx, q.project_id, body.environment_id)
                .await
        }
    };
    let asked = envs
        .0
        .request_build(
            &ctx,
            q.project_id,
            body.environment_id,
            &profile,
            body.product_file.as_deref(),
            body.git_ref,
            true,
        )
        .await
        .map_err(problem)?;
    match asked {
        BuildAsked::Planned(p) => Ok(Json(plan_dto(*p))),
        BuildAsked::Started(_) => Err(problem(Refusal::Internal("a plan started a build".into()))),
    }
}

async fn list_assignments(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
) -> ApiResult<JsonBody<AssignmentListDto>> {
    let list = envs
        .0
        .namespace_assignments(&ctx, ctx.subject_tenant_id())
        .await
        .map_err(problem)?;
    Ok(Json(AssignmentListDto {
        total: total(list.len()),
        items: list.into_iter().map(assignment_dto).collect(),
    }))
}

async fn put_assignment(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Json(body): Json<AssignmentDto>,
) -> ApiResult<JsonBody<AssignmentDto>> {
    let a = envs
        .0
        .assign_namespace(
            &ctx,
            ctx.subject_tenant_id(),
            body.project_id,
            body.environment_id,
            &body.namespace,
            body.build_namespace.as_deref(),
        )
        .await
        .map_err(problem)?;
    Ok(Json(assignment_dto(a)))
}

/* ── routes ── */

pub fn register(mut router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    router = OperationBuilder::post("/studio-environments/v1/builds/plan")
        .operation_id("studio_environments.create_build_plan")
        .summary("Say what a build would do, without starting it")
        .description(
            "For `?project_id=`, the same body as `POST /builds` (ADR-0062 §8): the sources \
             with their refs and the connections they are read through, the description \
             revision, the registry paths, the namespace and build namespace, the builder \
             image and Gearbox version, the strictness -- and `refusal`, the code and reason a \
             build would be refused with now. Nothing is queued.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .json_request::<StudioBuildRequest>(openapi, "What to build, where")
        .handler(plan_build)
        .json_response_with_schema::<BuildPlanDto>(openapi, StatusCode::OK, "The plan")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router =
        OperationBuilder::get("/studio-environments/v1/environments/{environment_id}/readiness")
            .operation_id("studio_environments.get_environment_readiness")
            .summary("How far an environment's cluster is bootstrapped for Studio")
            .description(
                "Asks the cluster now, as the environment's connection (ADR-0062 §6): the \
             bootstrap manifest's rights, a dry-run create of a namespace without Studio's \
             label (which the admission policy must refuse), and the version label on the \
             manifest's ClusterRole. `bootstrapped`, `namespace_limited` (with the namespaces \
             the cluster gives) or `partial` (with what is missing). An organization's \
             environment with `?organization_id=`, a project's own with `?project_id=`.",
            )
            .tag(TAG)
            .authenticated()
            .require_license_features::<License>([])
            .path_param("environment_id", "Environment id")
            .query_param_typed("organization_id", false, "The organization", "string")
            .query_param_typed(
                "project_id",
                false,
                "The project, for its own environment",
                "string",
            )
            .handler(get_readiness)
            .json_response_with_schema::<ReadinessDto>(openapi, StatusCode::OK, "Readiness")
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/images")
        .operation_id("studio_environments.list_images")
        .summary("A project's images and charts, and where each runs")
        .description(
            "For `?project_id=`: what the project's builds and pipelines published, and what \
             it imported or promoted, newest first (ADR-0062 §4). Each with its digest, tags, \
             build, commit, description revision and state, and the live releases that run \
             it. Filters: `environment_id` (runs there), `app`, `kind`, `state`, `build_id`.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .query_param_typed(
            "environment_id",
            false,
            "Only what runs in this environment",
            "string",
        )
        .query_param_typed("app", false, "Only this application", "string")
        .query_param_typed("kind", false, "`image` or `chart`", "string")
        .query_param_typed(
            "state",
            false,
            "`present`, `missing`, `deleted` or `retained`",
            "string",
        )
        .query_param_typed(
            "build_id",
            false,
            "Only what this build published",
            "string",
        )
        .query_param_typed(
            "offset",
            false,
            "Zero-based index of the first image",
            "integer",
        )
        .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
        .handler(list_images)
        .json_response_with_schema::<ImageListDto>(openapi, StatusCode::OK, "Images")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/images/{image_id}")
        .operation_id("studio_environments.get_image")
        .summary("One of a project's images, and where it runs")
        .description("For `?project_id=`. 404 for another project's.")
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("image_id", "Image record id")
        .query_param_typed("project_id", true, "The project", "string")
        .handler(get_image)
        .json_response_with_schema::<ImageRecordDto>(openapi, StatusCode::OK, "The image")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-environments/v1/images/{image_id}/pin")
        .operation_id("studio_environments.upsert_image_pin")
        .summary("Keep an image past its retention policy")
        .description("For `?project_id=`: a pinned image is never swept nor deleted.")
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("image_id", "Image record id")
        .query_param_typed("project_id", true, "The project", "string")
        .handler(pin_image)
        .json_response_with_schema::<ImageRecordDto>(openapi, StatusCode::OK, "Pinned")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-environments/v1/images/{image_id}/pin")
        .operation_id("studio_environments.delete_image_pin")
        .summary("Let an image go by its retention policy again")
        .description("For `?project_id=`: the image is swept and may be deleted by its retention policy again.")
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("image_id", "Image record id")
        .query_param_typed("project_id", true, "The project", "string")
        .handler(unpin_image)
        .json_response_with_schema::<ImageRecordDto>(openapi, StatusCode::OK, "Unpinned")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-environments/v1/images/{image_id}")
        .operation_id("studio_environments.delete_image")
        .summary("Delete one of a project's images from its registry")
        .description(
            "For `?project_id=`: 409 `IMAGE_RUNNING` while a live release runs it, \
             `IMAGE_PINNED` while it is pinned. Else 202 with the run that deletes the \
             digest through the registry's own API; the record stays, `deleted`.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("image_id", "Image record id")
        .query_param_typed("project_id", true, "The project", "string")
        .handler(delete_image)
        .json_response_with_schema::<ImageRunDto>(openapi, StatusCode::ACCEPTED, "Deleting")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_409(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-environments/v1/images/{image_id}/promotions")
        .operation_id("studio_environments.create_image_promotion")
        .summary("Copy an image by digest into another environment's registry")
        .description(
            "For `?project_id=`: the digest is copied server-side, through the registries' \
             OCI API, under the project's path in the other environment's registry, with its \
             tags. 202 with the run and the id of the record the copy makes.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("image_id", "Image record id")
        .query_param_typed("project_id", true, "The project", "string")
        .param(crate::idempotency::param())
        .json_request::<PromotionRequest>(openapi, "Where to")
        .handler(promote_image)
        .json_response_with_schema::<ImageRunDto>(openapi, StatusCode::ACCEPTED, "Copying")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-environments/v1/images/imports")
        .operation_id("studio_environments.create_image_import")
        .summary("Import an external image or chart into the project's own path")
        .description(
            "For `?project_id=`: `source` (Docker Hub, quay, ghcr…, with a tag or a digest) \
             is copied by digest into `<prefix>/<project>/mirror/<name>` of the environment's \
             registry, and recorded with where it came from, who and when. A deploy takes only \
             images in the organization's registry, so an external one comes in this way. 202 \
             with the run and the record's id.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .param(crate::idempotency::param())
        .json_request::<ImportRequest>(openapi, "What to import")
        .handler(import_image)
        .json_response_with_schema::<ImageRunDto>(openapi, StatusCode::ACCEPTED, "Importing")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/image-retention")
        .operation_id("studio_environments.get_image_retention")
        .summary("How long a project's, or an organization's, images are kept")
        .description(
            "`?project_id=` for a project (its own policy, else the organization's, \
             `inherited`), `?organization_id=` for the organization's default.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .query_param_typed("project_id", false, "The project", "string")
        .handler(get_retention)
        .json_response_with_schema::<RetentionDto>(openapi, StatusCode::OK, "The policy")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-environments/v1/image-retention")
        .operation_id("studio_environments.upsert_image_retention")
        .summary("Set how long a project's, or an organization's, images are kept")
        .description(
            "`keep_last` (per repository) and `keep_days`; an image past both that runs \
             nowhere and is not pinned is deleted by the daily `environments.image_sweep`. \
             The organization's default needs `environment.manage`.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .query_param_typed("project_id", false, "The project", "string")
        .json_request::<RetentionDto>(openapi, "The policy")
        .handler(put_retention)
        .json_response_with_schema::<RetentionDto>(openapi, StatusCode::OK, "Set")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/registries")
        .operation_id("studio_environments.list_registries")
        .summary("The registries an organization's environments push to and pull from")
        .description("Organization administrators (`environment.manage`), `?organization_id=`.")
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(list_registries)
        .json_response_with_schema::<RegistryListDto>(openapi, StatusCode::OK, "Registries")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router =
        OperationBuilder::get("/studio-environments/v1/registries/{connection_id}/repositories")
            .operation_id("studio_environments.list_registry_repositories")
            .summary("The repositories a registry holds under the organization's prefixes")
            .description(
                "Organization administrators. Read through the registry's own API (GHCR's \
             packages API, Harbor's, or the distribution API), each with the project whose \
             path holds it and how many records Studio keeps of it.",
            )
            .tag(TAG)
            .authenticated()
            .require_license_features::<License>([])
            .path_param("connection_id", "The registry connection")
            .query_param_typed("organization_id", false, "The organization", "string")
            .handler(list_repositories)
            .json_response_with_schema::<RepositoryListDto>(openapi, StatusCode::OK, "Repositories")
            .error_401(openapi)
            .error_403(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi);

    router = OperationBuilder::get(
        "/studio-environments/v1/registries/{connection_id}/repositories/{repository}/tags",
    )
    .operation_id("studio_environments.list_registry_tags")
    .summary("The versions one repository holds, with their records")
    .description(
        "Organization administrators. `repository` is the path under the host, URL-encoded \
         (`acme%2Fshop%2Fapi`). Each digest with its tags, its record and project when Studio \
         has one, and where it runs.",
    )
    .tag(TAG)
    .authenticated()
    .require_license_features::<License>([])
    .path_param("connection_id", "The registry connection")
    .path_param("repository", "The repository, URL-encoded")
    .query_param_typed("organization_id", false, "The organization", "string")
    .handler(list_versions)
    .json_response_with_schema::<VersionListDto>(openapi, StatusCode::OK, "Versions")
    .error_401(openapi)
    .error_403(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .error_503(openapi)
    .register(router, openapi);

    router = OperationBuilder::delete(
        "/studio-environments/v1/registries/{connection_id}/repositories/{repository}/versions/{digest}",
    )
    .operation_id("studio_environments.delete_registry_version")
    .summary("Delete one digest from an organization's registry")
    .description(
        "Organization administrators. 409 `IMAGE_RUNNING` while a live release runs it; \
         else 202 with the run.",
    )
    .tag(TAG)
    .authenticated()
    .require_license_features::<License>([])
    .path_param("connection_id", "The registry connection")
    .path_param("repository", "The repository, URL-encoded")
    .path_param("digest", "sha256:…")
    .query_param_typed("organization_id", false, "The organization", "string")
    .handler(delete_version)
    .json_response_with_schema::<ImageDeleteRunDto>(openapi, StatusCode::ACCEPTED, "Deleting")
    .error_400(openapi)
    .error_401(openapi)
    .error_403(openapi)
    .error_404(openapi)
    .error_409(openapi)
    .error_500(openapi)
    .error_503(openapi)
    .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/registries/{connection_id}/orphans")
        .operation_id("studio_environments.list_registry_orphans")
        .summary("What a registry holds that nothing accounts for, and records it lost")
        .description(
            "Organization administrators. `unowned` (under no project's path), `unrecorded` \
             (under one, with no record), `undeployed` (recorded, unpinned, running \
             nowhere), `missing` (recorded as present, gone from the registry).",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("connection_id", "The registry connection")
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(list_orphans)
        .json_response_with_schema::<OrphanListDto>(openapi, StatusCode::OK, "Orphans")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/namespace-assignments")
        .operation_id("studio_environments.list_namespace_assignments")
        .summary("The namespace each project was given in each environment")
        .description(
            "Organization administrators (ADR-0062 §3): recorded at the first build or deploy \
             that made or found it, or assigned by an administrator.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(list_assignments)
        .json_response_with_schema::<AssignmentListDto>(openapi, StatusCode::OK, "Assignments")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-environments/v1/namespace-assignments")
        .operation_id("studio_environments.upsert_namespace_assignment")
        .summary("Give a project a namespace in an environment")
        .description(
            "Organization administrators. On a cluster that gives Studio its namespaces \
             (namespace-limited), one of the environment's `namespaces`; elsewhere, any the \
             connection may work in, such as one the cluster's administrator made. Replaces \
             what was recorded; 409 `NAMESPACE_TAKEN` when another project holds it.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .json_request::<AssignmentDto>(openapi, "The assignment")
        .handler(put_assignment)
        .json_response_with_schema::<AssignmentDto>(openapi, StatusCode::OK, "Assigned")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_409(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router
}
