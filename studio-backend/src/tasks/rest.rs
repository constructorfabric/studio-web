//! REST surface for runs.
//!
//! Read, cancel, retry — and the list of task types this deployment can
//! actually run. There is deliberately **no** route that enqueues an arbitrary
//! task type with an arbitrary payload: that would be a way to make any handler
//! in the process do anything, with nothing validating what it is handed. Work
//! is enqueued by the gear that owns it, or by a schedule that already names
//! both the type and the payload.

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

use super::service::{RunQuery, TaskService};
use super::{RunState, entity, registry};

/// Errors attributable to a run as a resource.
#[resource_error(gts_id!("cf.studio.tasks.run.v1~"))]
pub struct StudioTasksError;

/// Service handle. `None` = the gear booted without a database: the routes stay
/// mounted and answer 503 with the reason.
#[derive(Clone)]
pub struct Tasks(pub Option<Arc<TaskService>>);

impl Tasks {
    fn get(&self) -> ApiResult<&Arc<TaskService>> {
        self.0.as_ref().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail(
                    "background tasks are not available in this deployment \
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

/* ── DTOs ── */

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RunDto {
    #[schema(value_type = String)]
    pub id: Uuid,
    #[schema(value_type = String)]
    pub tenant_id: Uuid,
    /// `<gear>.<verb>` — what kind of work this is.
    pub task_type: String,
    /// `queued` | `running` | `succeeded` | `failed` | `cancelled`.
    pub state: String,
    /// The handler's input, as it was enqueued.
    #[schema(value_type = Object)]
    pub payload: serde_json::Value,
    /// What the run was told not to overtake, when ordering was asked for.
    pub partition_key: Option<String>,
    pub attempts: i32,
    /// The phase the handler last reported. Kept after the run ends — the last
    /// phase before a failure is usually the diagnosis.
    pub progress: Option<String>,
    /// One line about what it did, once it succeeded — for a person.
    pub summary: Option<String>,
    /// The handler's structured result, where it has one. Its shape belongs to
    /// the task type; this gear stores it without reading it.
    #[schema(value_type = Option<Object>)]
    pub result: Option<serde_json::Value>,
    pub last_error: Option<String>,
    /// Whether somebody has asked it to stop.
    pub cancel_requested: bool,
    #[schema(value_type = String)]
    pub requested_by: Uuid,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RunListDto {
    pub items: Vec<RunDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TaskTypeListDto {
    /// Every task type with a handler in this deployment. A type absent from
    /// this list cannot be run here — the gear that owns it is not linked.
    pub items: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct RunFilter {
    #[serde(default)]
    tenant: Option<Uuid>,
    /// `queued` | `running` | `succeeded` | `failed` | `cancelled`.
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    task_type: Option<String>,
    /// Page size, default 50.
    #[serde(default)]
    limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct ScopeQuery {
    #[serde(default)]
    tenant: Option<Uuid>,
}

fn to_dto(row: entity::Model) -> RunDto {
    RunDto {
        id: row.id,
        tenant_id: row.tenant_id,
        task_type: row.task_type,
        state: row.state,
        payload: row.payload,
        partition_key: row.partition_key,
        attempts: i32::from(row.attempts),
        progress: row.progress,
        summary: row.summary,
        result: row.result,
        last_error: row.last_error,
        cancel_requested: row.cancel_requested,
        requested_by: row.requested_by,
        created_at: rfc3339(row.created_at),
        updated_at: rfc3339(row.updated_at),
        started_at: row.started_at.map(rfc3339),
        finished_at: row.finished_at.map(rfc3339),
    }
}

fn rfc3339(at: time::OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| at.unix_timestamp().to_string())
}

/* ── Handlers ── */

async fn list_runs(
    Extension(ctx): Extension<SecurityContext>,
    Extension(tasks): Extension<Tasks>,
    Query(q): Query<RunFilter>,
) -> ApiResult<JsonBody<RunListDto>> {
    let svc = tasks.get()?;
    let state = match q.state.as_deref() {
        Some(raw) => Some(RunState::parse(raw).map_err(|e| {
            StudioTasksError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?),
        None => None,
    };
    let items = svc
        .list(
            &ctx,
            q.tenant.unwrap_or_else(|| ctx.subject_tenant_id()),
            &RunQuery {
                state,
                task_type: q.task_type,
                limit: q.limit.unwrap_or(50).clamp(1, 500),
            },
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(RunListDto {
        items: items.into_iter().map(to_dto).collect(),
    }))
}

async fn get_run(
    Extension(ctx): Extension<SecurityContext>,
    Extension(tasks): Extension<Tasks>,
    Path(id): Path<Uuid>,
    Query(q): Query<ScopeQuery>,
) -> ApiResult<JsonBody<RunDto>> {
    let svc = tasks.get()?;
    let tenant = q.tenant.unwrap_or_else(|| ctx.subject_tenant_id());
    let row = svc
        .get(&ctx, tenant, id)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
        .ok_or_else(|| {
            StudioTasksError::not_found("Run not found")
                .with_resource(id.to_string())
                .create()
        })?;
    Ok(Json(to_dto(row)))
}

async fn cancel_run(
    Extension(ctx): Extension<SecurityContext>,
    Extension(tasks): Extension<Tasks>,
    Path(id): Path<Uuid>,
    Query(q): Query<ScopeQuery>,
) -> ApiResult<(StatusCode, JsonBody<RunDto>)> {
    let svc = tasks.get()?;
    let tenant = q.tenant.unwrap_or_else(|| ctx.subject_tenant_id());
    let row = svc.cancel(&ctx, tenant, id).await.map_err(|e| {
        StudioTasksError::failed_precondition()
            .with_precondition_violation(id.to_string(), format!("{e:#}"), "TASK_CANCEL_REFUSED")
            .create()
    })?;
    // 202, not 200: the flag is set, and whether a running handler honours it
    // is up to that handler.
    Ok((StatusCode::ACCEPTED, Json(to_dto(row))))
}

async fn retry_run(
    Extension(ctx): Extension<SecurityContext>,
    Extension(tasks): Extension<Tasks>,
    Path(id): Path<Uuid>,
    Query(q): Query<ScopeQuery>,
) -> ApiResult<(StatusCode, JsonBody<RunDto>)> {
    let svc = tasks.get()?;
    let tenant = q.tenant.unwrap_or_else(|| ctx.subject_tenant_id());
    let row = svc.retry(&ctx, tenant, id).await.map_err(|e| {
        StudioTasksError::failed_precondition()
            .with_precondition_violation(id.to_string(), format!("{e:#}"), "TASK_RETRY_REFUSED")
            .create()
    })?;
    Ok((StatusCode::ACCEPTED, Json(to_dto(row))))
}

async fn list_task_types(
    Extension(_ctx): Extension<SecurityContext>,
) -> ApiResult<JsonBody<TaskTypeListDto>> {
    // Reads the process-global registry, not the service: the answer is
    // "what is linked into this binary", which is true even without a database.
    Ok(Json(TaskTypeListDto {
        items: registry::known_task_types()
            .into_iter()
            .map(str::to_owned)
            .collect(),
    }))
}

/* ── Registration ── */

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<TaskService>>,
) -> Router {
    router = OperationBuilder::get("/studio-tasks/v1/runs")
        .operation_id("studio_tasks.list_runs")
        .summary("List background runs")
        .description(
            "Newest first, scoped to one tenant. Filter by `state` for the two \
             questions worth asking — `failed` for what needs attention, `running` \
             for what is in flight — or by `task_type` to see how one kind of work \
             has been behaving.",
        )
        .tag("StudioTasks")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_runs)
        .json_response_with_schema::<RunListDto>(openapi, StatusCode::OK, "Runs")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-tasks/v1/task-types")
        .operation_id("studio_tasks.list_task_types")
        .summary("What kinds of background work this deployment can run")
        .description(
            "One entry per registered handler. A task type absent from this list \
             cannot run here because the gear that owns it is not linked into the \
             assembly — the same shape as `GET /studio-connector/v1/providers`.",
        )
        .tag("StudioTasks")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_task_types)
        .json_response_with_schema::<TaskTypeListDto>(openapi, StatusCode::OK, "Task types")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-tasks/v1/runs/{id}")
        .operation_id("studio_tasks.get_run")
        .summary("What happened to one run")
        .description(
            "Includes the phase the handler last reported, which for a long import \
             is the difference between \"still working\" and \"stuck\".",
        )
        .tag("StudioTasks")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Run id")
        .handler(get_run)
        .json_response_with_schema::<RunDto>(openapi, StatusCode::OK, "The run")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-tasks/v1/runs/{id}/cancel")
        .operation_id("studio_tasks.cancel_run")
        .summary("Ask a run to stop")
        .description(
            "Cooperative: a queued run will not start, and a running one stops where \
             its handler checks for cancellation. A handler that never checks cannot \
             be stopped — the answer is 202 because the request has been recorded, \
             not because the work has ended. Refuses a run that already finished.",
        )
        .tag("StudioTasks")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Run id")
        .handler(cancel_run)
        .json_response_with_schema::<RunDto>(
            openapi,
            StatusCode::ACCEPTED,
            "Cancellation requested",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-tasks/v1/runs/{id}/retry")
        .operation_id("studio_tasks.retry_run")
        .summary("Put a failed or cancelled run back on the queue")
        .description(
            "For work that gave up on something since fixed. Refuses a run that \
             succeeded (doing it twice is not a retry) and one that is still queued \
             or running (it has not given up yet).",
        )
        .tag("StudioTasks")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Run id")
        .handler(retry_run)
        .json_response_with_schema::<RunDto>(openapi, StatusCode::ACCEPTED, "Queued again")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(Tasks(service)))
}
