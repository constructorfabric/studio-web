//! REST surface for schedules.
//!
//! CRUD, plus `run-now` — which is the only way a human triggers background
//! work through the API. That is deliberate: the schedule has already named a
//! task type and a payload, both validated when it was written, so there is no
//! endpoint that runs an arbitrary handler with arbitrary input.

use std::sync::Arc;

use axum::extract::Path;
use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::entity;
use super::service::{NewSchedule, ScheduleUpdate, SchedulerService};

/// Errors attributable to a schedule as a resource.
#[resource_error(gts_id!("cf.studio.scheduler.schedule.v1~"))]
pub struct StudioSchedulerError;

/// Service handle. `None` = the gear booted without a database.
#[derive(Clone)]
pub struct Scheduler(pub Option<Arc<SchedulerService>>);

impl Scheduler {
    fn get(&self) -> ApiResult<&Arc<SchedulerService>> {
        self.0.as_ref().ok_or_else(|| {
            CanonicalError::service_unavailable()
                .with_detail(
                    "schedules are not available in this deployment \
                     (studio-scheduler has no database configured)",
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
#[toolkit_macros::api_dto(request)]
pub struct CreateScheduleRequest {
    /// Unique within the deployment; what an operator refers to it by.
    pub name: String,
    /// Task type to run, from `GET /studio-tasks/v1/task-types`.
    pub task_type: String,
    /// Input for the handler. Omitted = `{}`.
    #[schema(value_type = Object)]
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
    /// `cron` | `interval`.
    pub expression_kind: String,
    /// A 5-field cron expression (`17 3 * * *`) or an ISO-8601 duration
    /// (`PT15M`).
    pub expression: String,
    /// IANA timezone. Only `UTC` is accepted today, and anything else is
    /// refused rather than quietly treated as UTC.
    #[serde(default)]
    pub timezone: Option<String>,
    /// `allow` (default) | `forbid` | `replace` — what to do when the previous
    /// run has not finished.
    #[serde(default)]
    pub concurrency: Option<String>,
    /// `skip` (default) | `catch_up` | `backfill` — what to do about firings
    /// missed while nothing was running.
    #[serde(default)]
    pub missed_policy: Option<String>,
    /// Cap on `backfill`. Default 3.
    #[serde(default)]
    pub max_catch_up_runs: Option<i32>,
    /// Default true. A disabled schedule keeps its row and fires nothing.
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PatchScheduleRequest {
    #[serde(default)]
    pub expression_kind: Option<String>,
    #[serde(default)]
    pub expression: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub concurrency: Option<String>,
    #[serde(default)]
    pub missed_policy: Option<String>,
    #[serde(default)]
    pub max_catch_up_runs: Option<i32>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[schema(value_type = Object)]
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ScheduleDto {
    #[schema(value_type = String)]
    pub id: Uuid,
    pub name: String,
    pub task_type: String,
    #[schema(value_type = Object)]
    pub payload: serde_json::Value,
    pub expression_kind: String,
    pub expression: String,
    pub timezone: String,
    pub concurrency: String,
    pub missed_policy: String,
    pub max_catch_up_runs: i32,
    pub enabled: bool,
    /// When it is next due. The ticker's accuracy is one tick, so a firing
    /// lands within a minute of this rather than exactly on it.
    pub next_run_at: String,
    pub last_fired_at: Option<String>,
    /// The run the last firing produced — poll it at
    /// `GET /studio-tasks/v1/runs/{id}`.
    #[schema(value_type = Option<String>)]
    pub last_run_id: Option<Uuid>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ScheduleListDto {
    pub items: Vec<ScheduleDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct FiredDto {
    /// The run this created. Poll it under `studio-tasks`.
    #[schema(value_type = String)]
    pub run_id: Uuid,
}

fn to_dto(row: entity::Model) -> ScheduleDto {
    ScheduleDto {
        id: row.id,
        name: row.name,
        task_type: row.task_type,
        payload: row.payload,
        expression_kind: row.expression_kind,
        expression: row.expression,
        timezone: row.timezone,
        concurrency: row.concurrency,
        missed_policy: row.missed_policy,
        max_catch_up_runs: i32::from(row.max_catch_up_runs),
        enabled: row.enabled,
        next_run_at: rfc3339(row.next_run_at),
        last_fired_at: row.last_fired_at.map(rfc3339),
        last_run_id: row.last_run_id,
        created_at: rfc3339(row.created_at),
        updated_at: rfc3339(row.updated_at),
    }
}

fn rfc3339(at: time::OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| at.unix_timestamp().to_string())
}

/// Every write refuses in the caller's terms: a cron field that does not
/// parse, a task type nothing can run, a timezone that is not UTC.
fn bad_request(e: &anyhow::Error) -> CanonicalError {
    StudioSchedulerError::invalid_argument()
        .with_constraint(format!("{e:#}"))
        .create()
}

/* ── Handlers ── */

async fn list_schedules(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(scheduler): Extension<Scheduler>,
) -> ApiResult<JsonBody<ScheduleListDto>> {
    let svc = scheduler.get()?;
    let items = svc
        .list()
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(ScheduleListDto {
        items: items.into_iter().map(to_dto).collect(),
    }))
}

async fn get_schedule(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(scheduler): Extension<Scheduler>,
    Path(id): Path<Uuid>,
) -> ApiResult<JsonBody<ScheduleDto>> {
    let svc = scheduler.get()?;
    let row = svc
        .get(id)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?
        .ok_or_else(|| {
            StudioSchedulerError::not_found("Schedule not found")
                .with_resource(id.to_string())
                .create()
        })?;
    Ok(Json(to_dto(row)))
}

async fn create_schedule(
    Extension(ctx): Extension<SecurityContext>,
    Extension(scheduler): Extension<Scheduler>,
    Json(req): Json<CreateScheduleRequest>,
) -> ApiResult<(StatusCode, JsonBody<ScheduleDto>)> {
    let svc = scheduler.get()?;
    let row = svc
        .create(
            &ctx,
            NewSchedule {
                name: &req.name,
                task_type: &req.task_type,
                payload: req.payload.unwrap_or_else(|| serde_json::json!({})),
                expression_kind: &req.expression_kind,
                expression: &req.expression,
                timezone: req.timezone.as_deref(),
                concurrency: req.concurrency.as_deref(),
                missed_policy: req.missed_policy.as_deref(),
                max_catch_up_runs: req.max_catch_up_runs.map(|n| n.clamp(1, 100) as i16),
                enabled: req.enabled.unwrap_or(true),
            },
        )
        .await
        .map_err(|e| bad_request(&e))?;
    Ok((StatusCode::CREATED, Json(to_dto(row))))
}

async fn patch_schedule(
    Extension(ctx): Extension<SecurityContext>,
    Extension(scheduler): Extension<Scheduler>,
    Path(id): Path<Uuid>,
    Json(req): Json<PatchScheduleRequest>,
) -> ApiResult<JsonBody<ScheduleDto>> {
    let svc = scheduler.get()?;
    let row = svc
        .patch(
            &ctx,
            id,
            ScheduleUpdate {
                expression_kind: req.expression_kind.as_deref(),
                expression: req.expression.as_deref(),
                timezone: req.timezone.as_deref(),
                concurrency: req.concurrency.as_deref(),
                missed_policy: req.missed_policy.as_deref(),
                max_catch_up_runs: req.max_catch_up_runs.map(|n| n.clamp(1, 100) as i16),
                enabled: req.enabled,
                payload: req.payload,
            },
        )
        .await
        .map_err(|e| bad_request(&e))?;
    Ok(Json(to_dto(row)))
}

async fn delete_schedule(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(scheduler): Extension<Scheduler>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let svc = scheduler.get()?;
    let removed = svc
        .delete(id)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    if !removed {
        return Err(StudioSchedulerError::not_found("Schedule not found")
            .with_resource(id.to_string())
            .create());
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn run_now(
    Extension(ctx): Extension<SecurityContext>,
    Extension(scheduler): Extension<Scheduler>,
    Path(id): Path<Uuid>,
) -> ApiResult<(StatusCode, JsonBody<FiredDto>)> {
    let svc = scheduler.get()?;
    let run_id = svc.run_now(&ctx, id).await.map_err(|e| {
        StudioSchedulerError::failed_precondition()
            .with_precondition_violation(id.to_string(), format!("{e:#}"), "SCHEDULE_RUN_REFUSED")
            .create()
    })?;
    Ok((StatusCode::ACCEPTED, Json(FiredDto { run_id })))
}

/* ── Registration ── */

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Option<Arc<SchedulerService>>,
) -> Router {
    router = OperationBuilder::get("/studio-scheduler/v1/schedules")
        .operation_id("studio_scheduler.list")
        .summary("List schedules")
        .description(
            "Schedules are platform-level: one list for the deployment, owned by the \
             platform tenant. A schedule that acts on a workspace's data names that \
             workspace in its payload.",
        )
        .tag("StudioScheduler")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_schedules)
        .json_response_with_schema::<ScheduleListDto>(openapi, StatusCode::OK, "Schedules")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-scheduler/v1/schedules")
        .operation_id("studio_scheduler.create")
        .summary("Create a schedule")
        .description(
            "The expression, the timezone, the two policies and the task type are all \
             validated before anything is stored, so a mistyped cron field is a 400 \
             here rather than a job that silently never fires. The first firing is \
             computed from the expression — creating a schedule does not run it; use \
             `POST …/run-now` for that.",
        )
        .tag("StudioScheduler")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<CreateScheduleRequest>(openapi, "The schedule")
        .handler(create_schedule)
        .json_response_with_schema::<ScheduleDto>(openapi, StatusCode::CREATED, "Created")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-scheduler/v1/schedules/{id}")
        .operation_id("studio_scheduler.get")
        .summary("One schedule, and when it is next due")
        .tag("StudioScheduler")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Schedule id")
        .handler(get_schedule)
        .json_response_with_schema::<ScheduleDto>(openapi, StatusCode::OK, "The schedule")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::patch("/studio-scheduler/v1/schedules/{id}")
        .operation_id("studio_scheduler.patch")
        .summary("Change a schedule's cadence, policies or payload")
        .description(
            "Every field is optional. Changing the expression recomputes the next \
             firing immediately — otherwise the old cadence would survive one more \
             tick. The task type is not editable: that is a different schedule.",
        )
        .tag("StudioScheduler")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Schedule id")
        .json_request::<PatchScheduleRequest>(openapi, "Fields to change")
        .handler(patch_schedule)
        .json_response_with_schema::<ScheduleDto>(openapi, StatusCode::OK, "Updated")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-scheduler/v1/schedules/{id}")
        .operation_id("studio_scheduler.delete")
        .summary("Remove a schedule")
        .description(
            "Runs it already created are untouched — they are `studio-tasks`' rows and \
             carry their own history. A platform schedule deleted here is recreated on \
             the next restart; disable it instead if that is not what you want.",
        )
        .tag("StudioScheduler")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Schedule id")
        .handler(delete_schedule)
        .no_content_response(StatusCode::NO_CONTENT, "Removed")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-scheduler/v1/schedules/{id}/run-now")
        .operation_id("studio_scheduler.run_now")
        .summary("Fire a schedule immediately")
        .description(
            "Enqueues the schedule's task once, without touching its cadence. This is \
             the human entry point for background work — and the reason no endpoint \
             accepts an arbitrary task type and payload: this one runs something a \
             schedule already described and validated.",
        )
        .tag("StudioScheduler")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Schedule id")
        .handler(run_now)
        .json_response_with_schema::<FiredDto>(openapi, StatusCode::ACCEPTED, "Queued")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(Scheduler(service)))
}
