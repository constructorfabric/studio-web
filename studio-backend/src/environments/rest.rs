//! REST surface of `studio-environments` (ADR-0043).
//!
//! An organization's environments are addressed through `?organization_id=`
//! (the `OrgCtx` extractor), a project's bindings and deploys through
//! `?project_id=`: a scope never goes in the path (`api_contract`, rule C).

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::{Extension, Router};
use serde::Deserialize;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::deploy::Rollout;
use super::model::{
    Binding, DatabaseMode, DeployImage, Deployment, DeploymentAction, Environment,
    EnvironmentInput, EnvironmentKind, ResearchTarget,
};
use super::service::{DeployRequest, EnvironmentService, Refusal};
use crate::org_scope::OrgCtx;

/// Errors attributable to an environment or a deployment as a resource.
#[resource_error(gts_id!("cf.studio.environments.environment.v1~"))]
pub struct StudioEnvironmentsError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

#[derive(Clone)]
pub struct Environments(pub Arc<EnvironmentService>);

fn problem(r: Refusal) -> CanonicalError {
    match r {
        Refusal::Forbidden(reason) => StudioEnvironmentsError::permission_denied()
            .with_reason(reason)
            .create(),
        Refusal::NotFound(id, detail) => StudioEnvironmentsError::not_found(detail)
            .with_resource(id)
            .create(),
        Refusal::Invalid(detail) => StudioEnvironmentsError::invalid_argument()
            .with_constraint(detail)
            .create(),
        Refusal::Precondition(kind, detail) => StudioEnvironmentsError::failed_precondition()
            .with_precondition_violation("environment", detail, kind)
            .create(),
        Refusal::Unavailable(detail) => CanonicalError::service_unavailable()
            .with_detail(detail)
            .create(),
        Refusal::Internal(detail) => CanonicalError::internal(detail).create(),
    }
}

/* ── DTOs ── */

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct EnvironmentDto {
    #[schema(value_type = String)]
    pub id: Uuid,
    pub name: String,
    pub description: String,
    /// `kubernetes` | `research` (ADR-0049).
    pub kind: String,
    /// The `kubernetes` connection the cluster is reached through, or the
    /// `research` connection Constructor Research is signed in with.
    #[schema(value_type = String)]
    pub connection_id: Uuid,
    /// The Research project a `research` environment runs products in.
    pub research_project: Option<String>,
    /// The Research hardware configuration its services run on.
    pub research_hardware: Option<String>,
    /// Image registry prefix (`ghcr.io/acme`); empty for images as generated.
    pub registry: String,
    /// The `registry` connection the cluster pulls with and a published
    /// chart is fetched with (ADR-0048); absent for none.
    #[schema(value_type = Option<String>)]
    pub registry_connection_id: Option<Uuid>,
    pub namespace_pattern: String,
    /// `none` | `shared` | `namespace`.
    pub database: String,
    /// The image of a `namespace` database; absent for the default.
    pub database_image: Option<String>,
    /// Whether a deploy waits for an organization administrator's approval.
    pub protected: bool,
    /// The environment a release must have succeeded in first; absent for
    /// none (ADR-0048 §5).
    #[schema(value_type = Option<String>)]
    pub promote_from: Option<Uuid>,
    /// The projects that may deploy here; absent for all of them.
    #[schema(value_type = Option<Vec<String>>)]
    pub projects: Option<Vec<Uuid>>,
    pub updated_by: String,
    pub updated_at: String,
}

fn database_str(d: DatabaseMode) -> &'static str {
    match d {
        DatabaseMode::None => "none",
        DatabaseMode::Shared => "shared",
        DatabaseMode::Namespace => "namespace",
    }
}

fn kind_str(k: EnvironmentKind) -> &'static str {
    match k {
        EnvironmentKind::Kubernetes => "kubernetes",
        EnvironmentKind::Research => "research",
    }
}

fn env_dto(e: Environment) -> EnvironmentDto {
    EnvironmentDto {
        id: e.id,
        name: e.name,
        description: e.description,
        kind: kind_str(e.kind).to_owned(),
        connection_id: e.connection_id,
        research_project: e.research.as_ref().map(|r| r.project.clone()),
        research_hardware: e.research.and_then(|r| r.hardware),
        registry: e.registry,
        registry_connection_id: e.registry_connection_id,
        namespace_pattern: e.namespace_pattern,
        database: database_str(e.database).to_owned(),
        database_image: e.database_image,
        protected: e.protected,
        promote_from: e.promote_from,
        projects: e.projects,
        updated_by: e.updated_by,
        updated_at: e.updated_at,
    }
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct EnvironmentListDto {
    pub items: Vec<EnvironmentDto>,
    pub total: u32,
    /// Whether the caller may change them and decide about deploys.
    pub may_manage: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct EnvironmentRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// `kubernetes` (default) | `research`.
    #[serde(default)]
    pub kind: Option<String>,
    #[schema(value_type = String)]
    pub connection_id: Uuid,
    /// For `research`: the Research project products run in.
    #[serde(default)]
    pub research_project: Option<String>,
    /// For `research`: the hardware configuration; default Research's.
    #[serde(default)]
    pub research_hardware: Option<String>,
    #[serde(default)]
    pub registry: String,
    /// A `registry` connection the organization holds, on the prefix's host.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub registry_connection_id: Option<Uuid>,
    /// Default `{project}-{environment}`.
    #[serde(default)]
    pub namespace_pattern: Option<String>,
    /// `none` (default) | `shared` | `namespace`: a Postgres of the
    /// product's own in the project's namespace (ADR-0048 §7).
    #[serde(default)]
    pub database: Option<String>,
    /// The image of a `namespace` database; default `pgvector/pgvector:pg18`.
    #[serde(default)]
    pub database_image: Option<String>,
    #[serde(default)]
    pub protected: bool,
    /// Another environment of the organization a release must have
    /// succeeded in first.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub promote_from: Option<Uuid>,
    /// Absent: every project of the organization.
    #[schema(value_type = Option<Vec<String>>)]
    #[serde(default)]
    pub projects: Option<Vec<Uuid>>,
}

fn env_input(r: EnvironmentRequest) -> Result<EnvironmentInput, CanonicalError> {
    let database = match r.database.as_deref().map(str::trim) {
        None | Some("" | "none") => DatabaseMode::None,
        Some("shared") => DatabaseMode::Shared,
        Some("namespace") => DatabaseMode::Namespace,
        Some(other) => {
            return Err(StudioEnvironmentsError::invalid_argument()
                .with_constraint(format!(
                    "database is none, shared or namespace, not '{other}'"
                ))
                .create());
        }
    };
    let kind = match r.kind.as_deref().map(str::trim) {
        None | Some("" | "kubernetes") => EnvironmentKind::Kubernetes,
        Some("research") => EnvironmentKind::Research,
        Some(other) => {
            return Err(StudioEnvironmentsError::invalid_argument()
                .with_constraint(format!("kind is kubernetes or research, not '{other}'"))
                .create());
        }
    };
    let research = r.research_project.map(|project| ResearchTarget {
        project,
        hardware: r.research_hardware,
    });
    Ok(EnvironmentInput {
        name: r.name,
        description: r.description,
        kind,
        connection_id: r.connection_id,
        research,
        registry: r.registry,
        registry_connection_id: r.registry_connection_id,
        namespace_pattern: r.namespace_pattern,
        database,
        database_image: r.database_image,
        protected: r.protected,
        promote_from: r.promote_from,
        projects: r.projects,
    })
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct EnvironmentTestDto {
    /// What answered, e.g. "https://k8s.acme:6443 answers: Kubernetes v1.32.1".
    pub message: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BindingDto {
    pub profile: String,
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    /// Chart values the release gets in that environment (ADR-0048 §7).
    #[schema(value_type = Option<Object>)]
    pub values: Option<serde_json::Value>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ConfigSecretDto {
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    /// The variable it is read as; the value never comes back.
    pub key: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ConfigSecretRequest {
    /// Kept in credstore; never returned.
    pub value: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct StudioBuildRequest {
    /// The environment whose cluster builds it and whose registry gets it.
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    /// The `kubernetes` profile it builds; default `prod`.
    #[serde(default)]
    pub profile: Option<String>,
    /// The product's description in the repository; default `product.gdl`.
    #[serde(default)]
    pub product_file: Option<String>,
    /// A branch, tag or commit; the repository's branch when absent.
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct StudioBuildDto {
    /// The build's id, as the project's Builds list names it.
    pub build_id: String,
    #[schema(value_type = String)]
    pub run_id: Uuid,
    /// Where it runs.
    pub namespace: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BuildStepLogDto {
    /// `prepare`, `build` or `publish`.
    pub step: String,
    /// `waiting`, `running`, `passed` or `failed`.
    pub state: String,
    /// The end of what the step wrote; empty while it has not started.
    pub log: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BuildLogDto {
    pub build_id: String,
    /// The environment the build runs in.
    pub environment: String,
    pub namespace: String,
    /// In the order they run.
    pub steps: Vec<BuildStepLogDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct BuildWorkflowRequest {
    /// The environment whose registry the workflow publishes to.
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    /// The `kubernetes` profile it builds; default `prod`.
    #[serde(default)]
    pub profile: Option<String>,
    /// The product's description in the repository; default `product.gdl`.
    #[serde(default)]
    pub product_file: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BuildWorkflowDto {
    /// `.github/workflows/studio-build-<product>.yml`.
    pub path: String,
    pub branch: String,
    pub pr_url: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PushTokenRequest {
    /// Repositories under the environment's registry prefix: `gbx-api`,
    /// `charts/shop`.
    pub repositories: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PushTokenDto {
    /// The registry host the token is for: `ghcr.io`.
    pub registry: String,
    /// Where under it the images go: `ghcr.io/acme`.
    pub prefix: String,
    /// A bearer token that may pull and push the named repositories only.
    pub token: String,
    /// Seconds, when the registry says.
    pub expires_in: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct ConfigSecretQuery {
    pub project_id: Uuid,
    pub environment_id: Uuid,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BindingListDto {
    pub items: Vec<BindingDto>,
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct BindingItem {
    pub profile: String,
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    /// Chart values for the release there, under what a deploy sets.
    #[schema(value_type = Option<Object>)]
    #[serde(default)]
    pub values: Option<serde_json::Value>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct BindingsRequest {
    pub items: Vec<BindingItem>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TargetDto {
    pub environment: EnvironmentDto,
    /// The namespace this project's release gets in this environment.
    pub namespace: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectTargetsDto {
    #[schema(value_type = String)]
    pub organization_id: Uuid,
    pub project_name: String,
    /// The environments this project may deploy to.
    pub environments: Vec<TargetDto>,
    /// Its product's profiles bound to them.
    pub bindings: Vec<BindingDto>,
    /// The secret keys of its configuration, per environment.
    pub secrets: Vec<ConfigSecretDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ImageDto {
    pub app: String,
    pub image: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeploymentDto {
    #[schema(value_type = String)]
    pub id: Uuid,
    #[schema(value_type = String)]
    pub project_id: Uuid,
    pub project_name: String,
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    pub environment_name: String,
    pub profile: String,
    pub product: String,
    /// `install` | `uninstall`.
    pub action: String,
    /// The earlier deployment this one installs again (a rollback or a
    /// promotion).
    #[schema(value_type = Option<String>)]
    pub redeploy_of: Option<Uuid>,
    pub commit: Option<String>,
    pub lock_hash: Option<String>,
    /// The build it came from (ADR-0045 §4), when the IDE deployed one.
    pub build: Option<String>,
    pub images: Vec<ImageDto>,
    pub namespace: String,
    /// The uploaded chart's sha256; empty for a published one.
    pub chart_sha256: String,
    /// The published chart it installs, `oci://…` (ADR-0048 §3).
    pub chart_ref: Option<String>,
    pub chart_version: Option<String>,
    /// `awaiting_approval` | `declined` | `queued` | `running` | `succeeded` |
    /// `failed` | `cancelled`.
    pub state: String,
    #[schema(value_type = Option<String>)]
    pub run_id: Option<Uuid>,
    pub requested_by: String,
    pub requested_by_name: String,
    pub requested_at: String,
    pub decided_by: Option<String>,
    pub decided_by_name: Option<String>,
    pub decided_at: Option<String>,
    pub reason: Option<String>,
    pub outcome: Option<String>,
}

fn deployment_dto(d: Deployment) -> DeploymentDto {
    DeploymentDto {
        id: d.id,
        project_id: d.project_id,
        project_name: d.project_name,
        environment_id: d.environment_id,
        environment_name: d.environment_name,
        profile: d.profile,
        product: d.product,
        action: d.action.as_str().to_owned(),
        redeploy_of: d.redeploy_of,
        commit: d.commit,
        lock_hash: d.lock_hash,
        build: d.build,
        images: d
            .images
            .into_iter()
            .map(|i| ImageDto {
                app: i.app,
                image: i.image,
            })
            .collect(),
        namespace: d.namespace,
        chart_sha256: d.chart_sha256,
        chart_ref: d.chart_ref.as_ref().map(|r| r.reference.clone()),
        chart_version: d.chart_ref.map(|r| r.version),
        state: d.state.as_str().to_owned(),
        run_id: d.run_id,
        requested_by: d.requested_by,
        requested_by_name: d.requested_by_name,
        requested_at: d.requested_at,
        decided_by: d.decided_by,
        decided_by_name: d.decided_by_name,
        decided_at: d.decided_at,
        reason: d.reason,
        outcome: d.outcome,
    }
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeploymentListDto {
    pub items: Vec<DeploymentDto>,
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct DeployImageItem {
    pub app: String,
    /// `repository:tag` as Generate built it, without a registry.
    pub image: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateDeploymentRequest {
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    /// The `kubernetes` profile the chart was generated for.
    pub profile: String,
    /// The product id: the Helm release.
    pub product: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub lock_hash: Option<String>,
    /// The build it came from: the IDE's build id (ADR-0045 §4).
    #[serde(default)]
    pub build: Option<String>,
    #[serde(default)]
    pub images: Vec<DeployImageItem>,
    /// The generated chart, packaged (`.tgz`), base64; at most 512 KiB. Or
    /// name a published one with `chart_ref`, never both.
    #[serde(default)]
    pub chart: Option<String>,
    /// A chart published to the environment's registry:
    /// `oci://<registry prefix>/…` (ADR-0048 §3). Needs `chart_version`, and
    /// an environment with a registry connection.
    #[serde(default)]
    pub chart_ref: Option<String>,
    #[serde(default)]
    pub chart_version: Option<String>,
    /// `install` (default) or `uninstall`: take the release (`product`) out
    /// of the environment. An uninstall takes no chart and no images.
    #[serde(default)]
    pub action: Option<String>,
    /// Install again what this earlier deployment of the project installed,
    /// in place of the chart, images and build: a rollback, or the same
    /// release promoted to the next environment.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub redeploy_of: Option<Uuid>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct DeploymentDecisionRequest {
    /// `approve` | `decline`.
    pub action: String,
    /// Required to decline.
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct WorkloadDto {
    pub name: String,
    pub ready: i32,
    pub desired: i32,
    pub images: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeploymentStatusDto {
    pub deployment: DeploymentDto,
    pub workloads: Vec<WorkloadDto>,
    /// Hosts the release's ingresses answer on.
    pub hosts: Vec<String>,
}

fn status_dto(d: Deployment, r: Rollout) -> DeploymentStatusDto {
    DeploymentStatusDto {
        deployment: deployment_dto(d),
        workloads: r
            .workloads
            .into_iter()
            .map(|w| WorkloadDto {
                name: w.name,
                ready: w.ready,
                desired: w.desired,
                images: w.images,
            })
            .collect(),
        hosts: r.hosts,
    }
}

#[derive(Debug, Deserialize)]
pub struct ProjectQuery {
    project_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct DeploymentFilter {
    #[serde(default)]
    project_id: Option<Uuid>,
    #[serde(default)]
    environment_id: Option<Uuid>,
}

fn total(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/* ── Handlers ── */

async fn list_environments(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
) -> ApiResult<JsonBody<EnvironmentListDto>> {
    let org = ctx.subject_tenant_id();
    let list = envs.0.environments(&ctx, org).await.map_err(problem)?;
    let may_manage = envs.0.may_manage(&ctx, org).await;
    Ok(Json(EnvironmentListDto {
        total: total(list.items.len()),
        items: list.items.into_iter().map(env_dto).collect(),
        may_manage,
    }))
}

async fn create_environment(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Json(body): Json<EnvironmentRequest>,
) -> ApiResult<(StatusCode, JsonBody<EnvironmentDto>)> {
    let input = env_input(body)?;
    let env = envs
        .0
        .put_environment(&ctx, ctx.subject_tenant_id(), None, input)
        .await
        .map_err(problem)?;
    Ok((StatusCode::CREATED, Json(env_dto(env))))
}

async fn update_environment(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(environment_id): Path<Uuid>,
    Json(body): Json<EnvironmentRequest>,
) -> ApiResult<JsonBody<EnvironmentDto>> {
    let input = env_input(body)?;
    let env = envs
        .0
        .put_environment(&ctx, ctx.subject_tenant_id(), Some(environment_id), input)
        .await
        .map_err(problem)?;
    Ok(Json(env_dto(env)))
}

async fn delete_environment(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(environment_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    envs.0
        .delete_environment(&ctx, ctx.subject_tenant_id(), environment_id)
        .await
        .map_err(problem)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn test_environment(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(environment_id): Path<Uuid>,
) -> ApiResult<JsonBody<EnvironmentTestDto>> {
    let message = envs
        .0
        .test_environment(&ctx, ctx.subject_tenant_id(), environment_id)
        .await
        .map_err(problem)?;
    Ok(Json(EnvironmentTestDto { message }))
}

fn binding_dto(b: Binding) -> BindingDto {
    BindingDto {
        profile: b.profile,
        environment_id: b.environment_id,
        values: b.values,
    }
}

async fn get_project_targets(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<ProjectTargetsDto>> {
    let t = envs.0.targets(&ctx, q.project_id).await.map_err(problem)?;
    Ok(Json(ProjectTargetsDto {
        organization_id: t.organization_id,
        project_name: t.project_name,
        environments: t
            .environments
            .into_iter()
            .map(|(e, namespace)| TargetDto {
                environment: env_dto(e),
                namespace,
            })
            .collect(),
        bindings: t.bindings.into_iter().map(binding_dto).collect(),
        secrets: t
            .secrets
            .into_iter()
            .map(|s| ConfigSecretDto {
                environment_id: s.environment_id,
                key: s.key,
            })
            .collect(),
    }))
}

async fn start_build(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ProjectQuery>,
    Json(body): Json<StudioBuildRequest>,
) -> ApiResult<(StatusCode, JsonBody<StudioBuildDto>)> {
    let started = envs
        .0
        .request_build(
            &ctx,
            q.project_id,
            body.environment_id,
            body.profile.as_deref().unwrap_or("prod"),
            body.product_file.as_deref(),
            body.git_ref,
        )
        .await
        .map_err(problem)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(StudioBuildDto {
            build_id: started.build_id,
            run_id: started.run_id,
            namespace: started.namespace,
        }),
    ))
}

async fn get_build_log(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Path(build_id): Path<String>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<BuildLogDto>> {
    let log = envs
        .0
        .build_log(&ctx, q.project_id, &build_id)
        .await
        .map_err(problem)?;
    Ok(Json(BuildLogDto {
        build_id,
        environment: log.environment,
        namespace: log.namespace,
        steps: log
            .steps
            .into_iter()
            .map(|s| BuildStepLogDto {
                step: s.step,
                state: s.state,
                log: s.log,
            })
            .collect(),
    }))
}

async fn scaffold_build_workflow(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ProjectQuery>,
    Json(body): Json<BuildWorkflowRequest>,
) -> ApiResult<JsonBody<BuildWorkflowDto>> {
    let profile = body.profile.unwrap_or_else(|| "prod".to_owned());
    let product_file = body
        .product_file
        .unwrap_or_else(|| "product.gdl".to_owned());
    let w = envs
        .0
        .propose_workflow(
            &ctx,
            q.project_id,
            body.environment_id,
            &profile,
            &product_file,
        )
        .await
        .map_err(problem)?;
    Ok(Json(BuildWorkflowDto {
        path: w.path,
        branch: w.branch,
        pr_url: w.pr_url,
    }))
}

async fn create_push_token(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Path(environment_id): Path<Uuid>,
    Query(q): Query<ProjectQuery>,
    Json(body): Json<PushTokenRequest>,
) -> ApiResult<(StatusCode, JsonBody<PushTokenDto>)> {
    let t = envs
        .0
        .push_token(&ctx, q.project_id, environment_id, body.repositories)
        .await
        .map_err(problem)?;
    Ok((
        StatusCode::CREATED,
        Json(PushTokenDto {
            registry: t.registry,
            prefix: t.prefix,
            token: t.token,
            expires_in: t.expires_in,
        }),
    ))
}

async fn put_config_secret(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Path(key): Path<String>,
    Query(q): Query<ConfigSecretQuery>,
    Json(body): Json<ConfigSecretRequest>,
) -> ApiResult<JsonBody<ConfigSecretDto>> {
    let s = envs
        .0
        .put_config_secret(&ctx, q.project_id, q.environment_id, &key, Some(body.value))
        .await
        .map_err(problem)?;
    Ok(Json(ConfigSecretDto {
        environment_id: s.environment_id,
        key: s.key,
    }))
}

async fn delete_config_secret(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Path(key): Path<String>,
    Query(q): Query<ConfigSecretQuery>,
) -> ApiResult<StatusCode> {
    envs.0
        .put_config_secret(&ctx, q.project_id, q.environment_id, &key, None)
        .await
        .map_err(problem)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn update_bindings(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ProjectQuery>,
    Json(body): Json<BindingsRequest>,
) -> ApiResult<JsonBody<BindingListDto>> {
    let items = body
        .items
        .into_iter()
        .map(|b| Binding {
            profile: b.profile.trim().to_owned(),
            environment_id: b.environment_id,
            values: b.values,
        })
        .collect();
    let saved = envs
        .0
        .put_bindings(&ctx, q.project_id, items)
        .await
        .map_err(problem)?;
    Ok(Json(BindingListDto {
        total: total(saved.len()),
        items: saved.into_iter().map(binding_dto).collect(),
    }))
}

async fn create_deployment(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ProjectQuery>,
    Json(body): Json<CreateDeploymentRequest>,
) -> ApiResult<(StatusCode, JsonBody<DeploymentDto>)> {
    let req = DeployRequest {
        environment_id: body.environment_id,
        profile: body.profile,
        product: body.product,
        commit: body.commit,
        lock_hash: body.lock_hash,
        build: body.build,
        images: body
            .images
            .into_iter()
            .map(|i| DeployImage {
                app: i.app.trim().to_owned(),
                image: i.image.trim().to_owned(),
            })
            .collect(),
        chart: body.chart,
        chart_ref: body.chart_ref,
        chart_version: body.chart_version,
        action: match body.action.as_deref().map(str::trim) {
            None | Some("" | "install") => DeploymentAction::Install,
            Some("uninstall") => DeploymentAction::Uninstall,
            Some(other) => {
                return Err(StudioEnvironmentsError::invalid_argument()
                    .with_constraint(format!("action is install or uninstall, not '{other}'"))
                    .create());
            }
        },
        redeploy_of: body.redeploy_of,
    };
    let d = envs
        .0
        .request_deploy(&ctx, q.project_id, req)
        .await
        .map_err(problem)?;
    // 202: queued, or waiting for an approval; the record says which.
    Ok((StatusCode::ACCEPTED, Json(deployment_dto(d))))
}

async fn list_deployments(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Query(f): Query<DeploymentFilter>,
) -> ApiResult<JsonBody<DeploymentListDto>> {
    // A project's history is its organization's, filtered: the organization is
    // found from the project when the request names one.
    let org = match f.project_id {
        Some(project) => envs
            .0
            .organization_of_project(&ctx, project)
            .await
            .map_err(problem)?,
        None => ctx.subject_tenant_id(),
    };
    let items = envs
        .0
        .deployments(&ctx, org, f.project_id, f.environment_id)
        .await
        .map_err(problem)?;
    Ok(Json(DeploymentListDto {
        total: total(items.len()),
        items: items.into_iter().map(deployment_dto).collect(),
    }))
}

async fn decide_deployment(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(deployment_id): Path<Uuid>,
    Json(body): Json<DeploymentDecisionRequest>,
) -> ApiResult<JsonBody<DeploymentDto>> {
    let approve = match body.action.trim() {
        "approve" => true,
        "decline" => false,
        other => {
            return Err(StudioEnvironmentsError::invalid_argument()
                .with_constraint(format!("action is approve or decline, not '{other}'"))
                .create());
        }
    };
    let d = envs
        .0
        .decide(
            &ctx,
            ctx.subject_tenant_id(),
            deployment_id,
            approve,
            body.reason,
        )
        .await
        .map_err(problem)?;
    Ok(Json(deployment_dto(d)))
}

async fn get_deployment_status(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(deployment_id): Path<Uuid>,
) -> ApiResult<JsonBody<DeploymentStatusDto>> {
    let (d, r) = envs
        .0
        .status(&ctx, ctx.subject_tenant_id(), deployment_id)
        .await
        .map_err(problem)?;
    Ok(Json(status_dto(d, r)))
}

/* ── Registration ── */

const TAG: &str = "StudioEnvironments";

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<EnvironmentService>,
) -> Router {
    router = OperationBuilder::get("/studio-environments/v1/environments")
        .operation_id("studio_environments.list_environments")
        .summary("List an organization's deployment environments")
        .description(
            "The places the organization's products run (ADR-0043): each with its cluster \
             connection, registry, namespace pattern and whether a deploy needs approval. \
             Name the organization with `?organization_id=`. `may_manage` says whether \
             the caller may change them.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(list_environments)
        .json_response_with_schema::<EnvironmentListDto>(openapi, StatusCode::OK, "Environments")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-environments/v1/environments")
        .operation_id("studio_environments.create_environment")
        .summary("Add a deployment environment")
        .description(
            "Organization administrators only. The cluster is a `kubernetes` connection the \
             organization holds and shares (not a personal one): deploys run on the server, \
             as the service, and read it from there.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .json_request::<EnvironmentRequest>(openapi, "The environment")
        .handler(create_environment)
        .json_response_with_schema::<EnvironmentDto>(openapi, StatusCode::CREATED, "Added")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-environments/v1/environments/{environment_id}")
        .operation_id("studio_environments.update_environment")
        .summary("Change a deployment environment")
        .description(
            "Organization administrators only. The whole environment is sent. A deploy \
             already queued keeps what it was given; the next one uses the change.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("environment_id", "Environment id")
        .query_param_typed("organization_id", false, "The organization", "string")
        .json_request::<EnvironmentRequest>(openapi, "The environment")
        .handler(update_environment)
        .json_response_with_schema::<EnvironmentDto>(openapi, StatusCode::OK, "Changed")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-environments/v1/environments/{environment_id}")
        .operation_id("studio_environments.delete_environment")
        .summary("Remove a deployment environment")
        .description(
            "Organization administrators only. What already runs in the cluster stays \
             there, and its deployment records stay in the history.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("environment_id", "Environment id")
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(delete_environment)
        .no_content_response(StatusCode::NO_CONTENT, "Removed")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-environments/v1/environments/{environment_id}/test")
        .operation_id("studio_environments.test_environment")
        .summary("Reach an environment's cluster")
        .description(
            "Asks the cluster's API server for its version with the environment's \
             connection, as a deploy would reach it. Nothing is changed in the cluster.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("environment_id", "Environment id")
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(test_environment)
        .json_response_with_schema::<EnvironmentTestDto>(
            openapi,
            StatusCode::OK,
            "The cluster answered",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/targets")
        .operation_id("studio_environments.get_project_targets")
        .summary("Where a project's product can be deployed")
        .description(
            "For `?project_id=`: the organization's environments that take the project's \
             deploys, the namespace its release gets in each, and how its product's \
             kubernetes profiles are bound to them. What the portal's product card and the \
             desktop's Deploy read.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .handler(get_project_targets)
        .json_response_with_schema::<ProjectTargetsDto>(openapi, StatusCode::OK, "Targets")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-environments/v1/bindings")
        .operation_id("studio_environments.update_bindings")
        .summary("Bind a project's product profiles to environments")
        .description(
            "For `?project_id=`: the whole list, each kubernetes profile at most once, each \
             to an environment that takes the project's deploys. A binding grants nothing: \
             every deploy is still checked against its environment.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .json_request::<BindingsRequest>(openapi, "The bindings")
        .handler(update_bindings)
        .json_response_with_schema::<BindingListDto>(openapi, StatusCode::OK, "Saved")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-environments/v1/builds")
        .operation_id("studio_environments.start_build")
        .summary("Build a project's product in an environment's cluster")
        .description(
            "For `?project_id=` (ADR-0048 §9). Studio starts a Job in the project's namespace \
             of the environment's cluster: it clones the product's repository and gear \
             sources, generates the profile with the Gearbox engine this Studio runs, builds \
             the images with rootless BuildKit, and pushes them and the chart under the \
             environment's registry. Answers 202 with the build's id, recorded as running in \
             the project's builds and as passed or failed when the Job ends; a passed build \
             can then be deployed by id.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .json_request::<StudioBuildRequest>(openapi, "What to build, where")
        .handler(start_build)
        .json_response_with_schema::<StudioBuildDto>(openapi, StatusCode::ACCEPTED, "Started")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/builds/{build_id}/log")
        .operation_id("studio_environments.get_build_log")
        .summary("A build Studio runs, step by step with the end of each step's log")
        .description(
            "For `?project_id=`: one of the project's builds the caller can see. Reads the \
             build's pod in the environment's cluster, through the environment's connection: \
             each step (prepare, build, publish), whether it waits, runs, passed or failed, \
             and the last lines it wrote. Asked on demand: the cluster is not polled. 404 \
             once the pod is gone, a day after the build ended.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("build_id", "Build id")
        .query_param_typed("project_id", true, "The project", "string")
        .handler(get_build_log)
        .json_response_with_schema::<BuildLogDto>(openapi, StatusCode::OK, "The build's steps")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-environments/v1/build-workflows")
        .operation_id("studio_environments.scaffold_build_workflow")
        .summary("Propose the workflow that builds a project's product for an environment")
        .description(
            "For `?project_id=`: a pull request to the project's repository adding \
             `.github/workflows/studio-build-<product>.yml` for `product_file` (default \
             `product.gdl`; ADR-0048 §5). It generates the profile with \
             the Gearbox engine this Studio runs, pushes the images and the chart under the \
             environment's registry prefix, and uploads `studio-build.json`, which the sync \
             records as the run's build. Answers with the pull request.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .json_request::<BuildWorkflowRequest>(openapi, "Which environment and profile")
        .handler(scaffold_build_workflow)
        .json_response_with_schema::<BuildWorkflowDto>(openapi, StatusCode::OK, "Proposed")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-environments/v1/environments/{environment_id}/push-tokens")
        .operation_id("studio_environments.create_push_token")
        .summary("Get a token that pushes a build's images and chart to an environment's registry")
        .description(
            "For `?project_id=`, a member of a project the environment takes. The registry's              own token service issues a short-lived bearer token scoped to pull and push the              named repositories under the environment's prefix (ADR-0048 §1); the stored              login never leaves the server. Refused for a registry without a token service.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("environment_id", "Environment id")
        .query_param_typed("project_id", true, "The project", "string")
        .json_request::<PushTokenRequest>(openapi, "What to push")
        .handler(create_push_token)
        .json_response_with_schema::<PushTokenDto>(openapi, StatusCode::CREATED, "Issued")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-environments/v1/config-secrets/{key}")
        .operation_id("studio_environments.upsert_config_secret")
        .summary("Set a secret of a project's configuration in an environment")
        .description(
            "For `?project_id=` and `?environment_id=`: the value of `key`, an environment              variable name, kept in credstore and never returned (ADR-0048 §7). Each deploy              there writes the project's secrets into the release's `<release>-config`              secret, which every application of the chart reads.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("key", "The variable name, SMTP_PASSWORD")
        .query_param_typed("project_id", true, "The project", "string")
        .query_param_typed("environment_id", true, "The environment", "string")
        .json_request::<ConfigSecretRequest>(openapi, "The value")
        .handler(put_config_secret)
        .json_response_with_schema::<ConfigSecretDto>(openapi, StatusCode::OK, "Set")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-environments/v1/config-secrets/{key}")
        .operation_id("studio_environments.delete_config_secret")
        .summary("Remove a secret of a project's configuration in an environment")
        .description(
            "For `?project_id=` and `?environment_id=`. The next deploy there writes the              release's configuration secret without it.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("key", "The variable name")
        .query_param_typed("project_id", true, "The project", "string")
        .query_param_typed("environment_id", true, "The environment", "string")
        .handler(delete_config_secret)
        .no_content_response(StatusCode::NO_CONTENT, "Removed")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-environments/v1/deployments")
        .operation_id("studio_environments.create_deployment")
        .summary("Ask to deploy a project's product into an environment")
        .description(
            "For `?project_id=`, with the generated chart packaged, or a chart published to \
             the environment's registry (`chart_ref`, `chart_version`), and the images \
             (pushed to the environment's registry beforehand). The server installs \
             it as a background run with the environment's connection; a protected \
             environment holds it until an organization administrator approves. Answers \
             202 with the record: `queued` or `awaiting_approval`.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .json_request::<CreateDeploymentRequest>(openapi, "The deploy")
        .handler(create_deployment)
        .json_response_with_schema::<DeploymentDto>(openapi, StatusCode::ACCEPTED, "Accepted")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/deployments")
        .operation_id("studio_environments.list_deployments")
        .summary("What runs where: an organization's deployments")
        .description(
            "Newest first, each with where its run has got to. Filter by `?project_id=` or \
             `?environment_id=`; name the organization with `?organization_id=` when no \
             project is named. The latest deployment of every project and environment is \
             always kept.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("organization_id", false, "The organization", "string")
        .query_param_typed("project_id", false, "Only this project's", "string")
        .query_param_typed("environment_id", false, "Only this environment's", "string")
        .handler(list_deployments)
        .json_response_with_schema::<DeploymentListDto>(openapi, StatusCode::OK, "Deployments")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router =
        OperationBuilder::post("/studio-environments/v1/deployments/{deployment_id}/decisions")
            .operation_id("studio_environments.decide_deployment")
            .summary("Approve or decline a deploy to a protected environment")
            .description(
                "Organization administrators only, for a deploy `awaiting_approval`. Approving \
             queues it; declining needs a reason. Who decided, when and why is kept on the \
             record.",
            )
            .tag(TAG)
            .authenticated()
            .require_license_features::<License>([])
            .path_param("deployment_id", "Deployment id")
            .query_param_typed("organization_id", false, "The organization", "string")
            .json_request::<DeploymentDecisionRequest>(openapi, "The decision")
            .handler(decide_deployment)
            .json_response_with_schema::<DeploymentDto>(openapi, StatusCode::OK, "Decided")
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .error_503(openapi)
            .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/deployments/{deployment_id}/status")
        .operation_id("studio_environments.get_deployment_status")
        .summary("A deployed release as its cluster reports it now")
        .description(
            "Reads the release's workloads (ready of desired, images) and the hosts its \
             ingresses answer on from the environment's cluster, through the environment's \
             connection. Asked on demand: the cluster is not polled.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("deployment_id", "Deployment id")
        .query_param_typed("organization_id", false, "The organization", "string")
        .handler(get_deployment_status)
        .json_response_with_schema::<DeploymentStatusDto>(openapi, StatusCode::OK, "Status")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(Environments(service)))
}
