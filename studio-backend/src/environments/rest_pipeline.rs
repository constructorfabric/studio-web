//! One build, one deployment and an environment's configuration-secret keys,
//! each by its own route: what an agent following a project's pipeline reads
//! (`docs/mcp.md`) instead of listing everything and filtering.

use axum::extract::{Path, Query};
use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{
    ConfigSecretQuery, DeploymentDto, DeploymentFilter, Environments, ImageDto, License,
    ProjectQuery, TAG, deployment_dto, problem,
};
use crate::environments::service::{BuildView, SecretKeys};
use crate::org_scope::OrgCtx;

/* ── DTOs ── */

/// One build of a project as Studio keeps it, whoever ran it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct EnvironmentBuildDto {
    pub build_id: String,
    /// Where it ran: `studio`, `research`, `ci` or `desktop`.
    #[serde(rename = "where")]
    pub ran_in: Option<String>,
    /// `running`, `passed`, `failed` or `cancelled`.
    pub status: String,
    pub product: Option<String>,
    pub profile: Option<String>,
    pub commit: Option<String>,
    /// The hash of the lock it was generated from.
    pub lock_hash: Option<String>,
    /// What it published, with registry and digest.
    pub images: Vec<ImageDto>,
    /// The chart it published, `oci://…`, and its version.
    pub chart_ref: Option<String>,
    pub chart_version: Option<String>,
    /// Why it failed, and the step: `start` when it never reached the
    /// cluster.
    pub failure: Option<String>,
    pub failure_step: Option<String>,
    /// For a build Studio ran: the environment, namespace, ref, connection,
    /// builder image and engine it ran with.
    pub environment_id: Option<String>,
    pub environment: Option<String>,
    pub namespace: Option<String>,
    pub git_ref: Option<String>,
    pub source_connection_id: Option<String>,
    pub source_connection: Option<String>,
    pub builder_image: Option<String>,
    pub gearbox_version: Option<String>,
    /// `id=commit` of each source it fetched, comma separated.
    pub source_commits: Option<String>,
    /// The infra services its lock resolved (ADR-0065 §3), which a deploy
    /// of it runs; absent when the project keeps none for it.
    #[schema(value_type = Option<Vec<Object>>)]
    pub built_infra: Option<Vec<serde_json::Value>>,
}

fn build_dto(v: BuildView) -> EnvironmentBuildDto {
    let r = v.record;
    let p = r.place;
    EnvironmentBuildDto {
        build_id: r.build_id,
        ran_in: r.r#where,
        status: r.status,
        product: r.product,
        profile: r.profile,
        commit: r.commit,
        lock_hash: r.lock_hash,
        images: r
            .images
            .into_iter()
            .map(|(app, image)| ImageDto { app, image })
            .collect(),
        chart_ref: r.chart_ref,
        chart_version: r.chart_version,
        failure: r.failure,
        failure_step: r.failure_step,
        environment_id: p.environment_id,
        environment: p.environment,
        namespace: p.namespace,
        git_ref: p.git_ref,
        source_connection_id: p.source_connection_id,
        source_connection: p.source_connection,
        builder_image: p.builder_image,
        gearbox_version: p.gearbox_version,
        source_commits: p.source_commits,
        built_infra: v.built_infra.map(|services| {
            services
                .iter()
                .filter_map(|s| serde_json::to_value(s).ok())
                .collect()
        }),
    }
}

/// One configuration secret the product needs in an environment.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ConfigSecretNeedDto {
    /// The variable: `SMTP_PASSWORD`.
    pub key: String,
    /// What needs it: `description` (outside every profile, a gear's
    /// configuration), `profile <id>`, `infra <service>`.
    pub needed_by: Vec<String>,
    /// What gives it without the project setting it: `database`,
    /// `infra <service>`; absent when only a set secret does.
    pub provided_by: Option<String>,
    /// Set for the environment.
    pub set: bool,
}

/// An environment's configuration-secret keys -- never a value -- against
/// what the product needs there.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ConfigSecretKeysDto {
    #[schema(value_type = String)]
    pub environment_id: Uuid,
    /// The profile the environment runs.
    pub profile: String,
    /// The description revision read; absent before one is saved.
    pub revision: Option<i64>,
    /// The keys set there.
    pub keys: Vec<String>,
    /// What the description and the infra services need there.
    pub needed: Vec<ConfigSecretNeedDto>,
    /// Needed, not set, and nothing else gives it.
    pub missing: Vec<String>,
}

fn keys_dto(k: SecretKeys) -> ConfigSecretKeysDto {
    ConfigSecretKeysDto {
        environment_id: k.environment_id,
        profile: k.profile,
        revision: k.revision,
        keys: k.set,
        missing: k
            .needed
            .iter()
            .filter(|n| n.missing())
            .map(|n| n.key.clone())
            .collect(),
        needed: k
            .needed
            .into_iter()
            .map(|n| ConfigSecretNeedDto {
                key: n.key,
                needed_by: n.needed_by,
                provided_by: n.provided_by,
                set: n.set,
            })
            .collect(),
    }
}

/* ── Handlers ── */

async fn get_build(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Path(build_id): Path<String>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<EnvironmentBuildDto>> {
    let v = envs
        .0
        .build_view(&ctx, q.project_id, &build_id)
        .await
        .map_err(problem)?;
    Ok(Json(build_dto(v)))
}

async fn get_deployment(
    OrgCtx(ctx): OrgCtx,
    Extension(envs): Extension<Environments>,
    Path(deployment_id): Path<Uuid>,
    Query(f): Query<DeploymentFilter>,
) -> ApiResult<JsonBody<DeploymentDto>> {
    // As the list: a project's deployment is its organization's.
    let org = match f.project_id {
        Some(project) => envs
            .0
            .organization_of_project(&ctx, project)
            .await
            .map_err(problem)?,
        None => ctx.subject_tenant_id(),
    };
    let d = envs
        .0
        .deployment_view(&ctx, org, f.project_id, deployment_id)
        .await
        .map_err(problem)?;
    Ok(Json(deployment_dto(d)))
}

async fn get_config_secret_keys(
    Extension(ctx): Extension<SecurityContext>,
    Extension(envs): Extension<Environments>,
    Query(q): Query<ConfigSecretQuery>,
) -> ApiResult<JsonBody<ConfigSecretKeysDto>> {
    let k = envs
        .0
        .secret_keys(&ctx, q.project_id, q.environment_id)
        .await
        .map_err(problem)?;
    Ok(Json(keys_dto(k)))
}

/* ── Registration ── */

pub fn register(mut router: Router, openapi: &dyn OpenApiRegistry) -> Router {
    router = OperationBuilder::get("/studio-environments/v1/builds/{build_id}")
        .operation_id("studio_environments.get_build")
        .summary("One build of a project, as Studio keeps it")
        .description(
            "For `?project_id=`: the build's record, whoever ran it (Studio, Research, CI, a \
             desktop) -- status, failure and its step, product, profile, commit, lock hash, \
             the images and chart it published, where Studio ran it and with what -- and the \
             infra services its lock resolved (`built_infra`), which a deploy of it runs. \
             Kept after the build's pod is gone, unlike its log.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("build_id", "Build id")
        .query_param_typed("project_id", true, "The project", "string")
        .handler(get_build)
        .json_response_with_schema::<EnvironmentBuildDto>(openapi, StatusCode::OK, "The build")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-environments/v1/deployments/{deployment_id}")
        .operation_id("studio_environments.get_deployment")
        .summary("One deployment, as Studio records it")
        .description(
            "Its state, with where its run has got to, its `outcome`, the build and images it \
             installs, and the decision on it. Name the project with `?project_id=`, or the \
             organization with `?organization_id=`. What the cluster reports now is \
             `…/status`.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .path_param("deployment_id", "Deployment id")
        .query_param_typed("organization_id", false, "The organization", "string")
        .query_param_typed("project_id", false, "The project it is of", "string")
        .handler(get_deployment)
        .json_response_with_schema::<DeploymentDto>(openapi, StatusCode::OK, "The deployment")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    OperationBuilder::get("/studio-environments/v1/config-secrets")
        .operation_id("studio_environments.get_config_secret_keys")
        .summary("An environment's configuration-secret keys against what the product needs")
        .description(
            "For `?project_id=` and `?environment_id=`: the keys set there -- never a value -- \
             and what the product needs there: each `${NAME}` of the latest description \
             revision outside every profile or in the profile the environment runs, and each \
             capability an infra service leaves to the project. Each says what needs it, what \
             gives it otherwise (the database step, an infra service), and whether it is set; \
             `missing` lists those a deploy would run without.",
        )
        .tag(TAG)
        .authenticated()
        .require_license_features::<License>([])
        .query_param_typed("project_id", true, "The project", "string")
        .query_param_typed("environment_id", true, "The environment", "string")
        .handler(get_config_secret_keys)
        .json_response_with_schema::<ConfigSecretKeysDto>(openapi, StatusCode::OK, "The keys")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi)
}
