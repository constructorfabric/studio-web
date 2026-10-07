//! `/studio-reports/v1/reports` -- every report this deployment draws, its
//! source in the caller's organization, and the report itself.
//!
//! Every route takes `?organization_id=`: the organization on the caller's
//! screen, which need not be their home tenant (a platform administrator's
//! home is the platform root). Absent, the home tenant is meant. Handlers
//! take [`OrgCtx`], which checks the caller reaches it (`crate::org_scope`).

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::people_links::{self, PlanPeopleDto};
use super::plan_edit::{self, LanesDto, NeedDto, PersonDto, ProjectDto, Section, UnitDto};
use super::refresh_task::{RefreshPayload, TASK_TYPE};
use super::roadmap::summary::RoadmapReportDto;
use super::service::{PlanEditError, REPORTS, ReportKind, ReportsService, kind};
use super::source::{PlanSnapshot, Refresh, ReportSource};
use crate::components_catalog::port::unread_boards;
use crate::org_scope::{OrgAccess, OrgCtx};
use crate::studio_session::access::WorkspaceAccess;
use crate::tasks::{RunState, RunView};

#[resource_error(gts_id!("cf.studio._.reports.v1~"))]
pub struct StudioReportsError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

#[derive(Clone)]
pub struct Reports {
    pub service: Arc<ReportsService>,
    hub: Arc<ClientHub>,
}

impl Reports {
    /// Why the board the last refresh asked for was not read, once that sync
    /// has finished. The refresh only queues the sync, so it cannot know; the
    /// catalogue's run says so in its result.
    async fn board_error(&self, ctx: &SecurityContext, s: &ReportSource) -> Option<String> {
        let run = s.last_refresh.as_ref()?.sync_run?;
        let view = self
            .queue()
            .ok()?
            .run(ctx.subject_tenant_id(), run)
            .await
            .ok()??;
        board_error_of(&view)
    }

    async fn source_dto(&self, ctx: &SecurityContext, s: &ReportSource) -> ReportSourceDto {
        let mut dto = source_dto(s);
        dto.board_error = self.board_error(ctx, s).await;
        dto
    }

    fn queue(&self) -> ApiResult<Arc<dyn crate::tasks::TaskQueue>> {
        self.hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(crate::tasks::TASK_QUEUE_INSTANCE_ID))
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail("reports cannot be refreshed in this deployment (studio-tasks has no database configured)")
                    .create()
            })
    }
}

fn internal(e: impl std::fmt::Display) -> CanonicalError {
    CanonicalError::internal(e.to_string()).create()
}

fn report(id: &str) -> ApiResult<&'static ReportKind> {
    kind(id).ok_or_else(|| {
        StudioReportsError::not_found(format!("there is no report `{id}`"))
            .with_resource(id)
            .create()
    })
}

// ── DTOs ────────────────────────────────────────────────────────────────────

/// The plan as last read.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlanSnapshotDto {
    /// `owner/repo:path@ref`, or `upload`.
    pub from: String,
    pub sha: Option<String>,
    /// RFC 3339.
    pub read_at: String,
    /// The plan's size, in bytes: the text itself stays on the server.
    pub size: u32,
}

/// What the last refresh did.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RefreshDto {
    /// RFC 3339.
    pub at: String,
    /// The board sync it queued: a studio-tasks run.
    pub sync_run: Option<String>,
    /// Why it did not finish, when it did not.
    pub error: Option<String>,
}

/// A report's source in the caller's organization.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReportSourceDto {
    pub report: String,
    pub connection_id: Option<Uuid>,
    pub plan_file: Option<String>,
    /// Whether the plan was uploaded rather than read from a file.
    pub plan_uploaded: bool,
    pub board: Option<String>,
    pub roots: Vec<String>,
    pub consumers: std::collections::BTreeMap<String, String>,
    pub snapshot: Option<PlanSnapshotDto>,
    /// What the plan holds, so a screen can say what an empty one costs.
    /// Absent until a plan has been read.
    pub plan: Option<PlanSummaryDto>,
    pub last_refresh: Option<RefreshDto>,
    /// Why the board the last refresh synced was not read, once that sync
    /// finished. The refresh itself only queues the sync, so `last_refresh`
    /// can say nothing about it.
    pub board_error: Option<String>,
}

/// What a read plan holds: what the People sheet, the Gantt's lanes and the
/// project columns are drawn from.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlanSummaryDto {
    /// The board the plan names (`board:`), if it names one.
    pub board: Option<String>,
    pub people: u32,
    pub teams: u32,
    pub projects: u32,
}

/// The schedule that refreshes the report on its own.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReportScheduleDto {
    pub enabled: bool,
    /// A 5-field cron expression, in UTC.
    pub cron: Option<String>,
    /// RFC 3339.
    pub next_run_at: Option<String>,
    /// The run it produced last, a studio-tasks run.
    pub last_run: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ReportScheduleInputDto {
    pub enabled: bool,
    /// A 5-field cron expression in UTC; hourly when absent.
    pub cron: Option<String>,
}

/// What a person saves as a report's source. Every field optional: the plan
/// file can say the rest (`board`, `roots`, `consumers`, `report`).
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ReportSourceInputDto {
    /// The GitHub connection to read the board and the plan file through;
    /// the organization's first GitHub connection when absent.
    pub connection_id: Option<Uuid>,
    /// `owner/repo:path@ref`, or a GitHub link to the file.
    pub plan_file: Option<String>,
    /// The plan's text, for a file the connection cannot read. Absent keeps
    /// an uploaded plan; empty removes it.
    pub plan_yaml: Option<String>,
    /// `owner/number`; overrides the plan's `board`.
    pub board: Option<String>,
    pub roots: Option<Vec<String>>,
    pub consumers: Option<std::collections::BTreeMap<String, String>>,
}

/// One report this deployment draws.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReportDto {
    pub id: String,
    pub title: String,
    pub description: String,
    /// The definition it is drawn with: the plan's, else its built-in.
    pub definition: String,
    /// The definition's sheets, in order (`Summary`, `Roadmap`, …).
    pub sheets: Vec<String>,
    /// Why the plan's definition does not read, when it does not.
    pub definition_error: Option<String>,
    pub source: ReportSourceDto,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReportListDto {
    pub items: Vec<ReportDto>,
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReportSyncEnqueued {
    /// The studio-tasks run doing the refresh: poll `GET /studio-tasks/v1/runs/{run_id}`.
    pub run_id: String,
    pub status: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct WorkbookQuery {
    /// The day the workbook is drawn as of (`YYYY-MM-DD`); today when absent.
    #[serde(default)]
    pub date: Option<String>,
}

fn snapshot_dto(s: &PlanSnapshot) -> PlanSnapshotDto {
    PlanSnapshotDto {
        from: s.from.clone(),
        sha: s.sha.clone(),
        read_at: s.read_at.clone(),
        size: u32::try_from(s.text.len()).unwrap_or(u32::MAX),
    }
}

fn refresh_dto(r: &Refresh) -> RefreshDto {
    RefreshDto {
        at: r.at.clone(),
        sync_run: r.sync_run.map(|u| u.to_string()),
        error: r.error.clone(),
    }
}

fn plan_summary(s: &ReportSource) -> Option<PlanSummaryDto> {
    s.snapshot.as_ref()?;
    let (value, plan) = ReportsService::plan_of(s);
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Some(PlanSummaryDto {
        board: value
            .as_ref()
            .and_then(|v| s.effective(Some(v)).ok())
            .filter(|_| value.as_ref().is_some_and(|v| v.get("board").is_some()))
            .map(|e| format!("{}/{}", e.board.owner, e.board.number)),
        people: count(plan.users.len()),
        teams: count(plan.units.iter().map(|u| u.teams.len()).sum()),
        projects: count(plan.projects.len()),
    })
}

pub fn source_dto(s: &ReportSource) -> ReportSourceDto {
    ReportSourceDto {
        report: s.report.clone(),
        connection_id: s.connection_id,
        plan_file: s.plan_file.clone(),
        plan_uploaded: s.snapshot.as_ref().is_some_and(|x| x.from == "upload"),
        board: s.board.clone(),
        roots: s.roots.clone(),
        consumers: s.consumers.clone(),
        snapshot: s.snapshot.as_ref().map(snapshot_dto),
        plan: plan_summary(s),
        last_refresh: s.last_refresh.as_ref().map(refresh_dto),
        board_error: None,
    }
}

/// What a finished board sync says about the board: why it was not read, or
/// nothing when it was (or when the sync has not finished yet).
pub fn board_error_of(view: &RunView) -> Option<String> {
    match view.state {
        RunState::Failed => Some(format!(
            "the board sync failed: {}",
            view.last_error.as_deref().unwrap_or("no reason recorded")
        )),
        RunState::Succeeded => {
            let unread = view.result.as_ref().map(unread_boards).unwrap_or_default();
            (!unread.is_empty()).then(|| {
                unread
                    .iter()
                    .map(|u| format!("board {} was not read: {}", u.board, u.error))
                    .collect::<Vec<_>>()
                    .join("; ")
            })
        }
        RunState::Queued | RunState::Running | RunState::Cancelled => None,
    }
}

/// The input applied over what is saved: an absent field keeps its value.
pub fn apply(prev: &ReportSource, input: ReportSourceInputDto) -> ReportSource {
    let trimmed = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    ReportSource {
        report: prev.report.clone(),
        connection_id: input.connection_id.or(prev.connection_id),
        plan_file: match input.plan_file {
            Some(f) => trimmed(Some(f)),
            None => prev.plan_file.clone(),
        },
        // An upload is an act, not a setting: it travels to the save once.
        plan_yaml: input.plan_yaml,
        board: match input.board {
            Some(b) => trimmed(Some(b)),
            None => prev.board.clone(),
        },
        roots: input.roots.unwrap_or_else(|| prev.roots.clone()),
        consumers: input.consumers.unwrap_or_else(|| prev.consumers.clone()),
        snapshot: prev.snapshot.clone(),
        last_refresh: prev.last_refresh.clone(),
    }
}

fn report_dto(k: &ReportKind, source: &ReportSource, source_dto: ReportSourceDto) -> ReportDto {
    let (plan, _) = ReportsService::plan_of(source);
    let (definition, sheets, definition_error) =
        match ReportsService::definition_of(k, plan.as_ref()) {
            Ok(d) => {
                let names = d
                    .sheets
                    .iter()
                    .map(|s| match s {
                        super::definition::SheetDef::Summary { name }
                        | super::definition::SheetDef::Timeline { name, .. }
                        | super::definition::SheetDef::Gantt { name, .. }
                        | super::definition::SheetDef::People { name } => name.clone(),
                        super::definition::SheetDef::Table(t) => match (&t.all, t.per_group) {
                            (Some(a), true) => format!("a sheet per group, {a}"),
                            (Some(a), false) => a.clone(),
                            (None, _) => "a sheet per group".into(),
                        },
                    })
                    .collect();
                (d.id, names, None)
            }
            Err(e) => (k.default_definition.to_string(), Vec::new(), Some(e)),
        };
    ReportDto {
        id: k.id.to_string(),
        title: k.title.to_string(),
        description: k.description.to_string(),
        definition,
        sheets,
        definition_error,
        source: source_dto,
    }
}

// ── handlers ────────────────────────────────────────────────────────────────

async fn list_reports(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
) -> ApiResult<JsonBody<ReportListDto>> {
    let mut items = Vec::new();
    for k in &REPORTS {
        let source = reports.service.source(&ctx, k.id).await.map_err(internal)?;
        let dto = reports.source_dto(&ctx, &source).await;
        items.push(report_dto(k, &source, dto));
    }
    Ok(Json(ReportListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

async fn get_report(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
) -> ApiResult<JsonBody<ReportDto>> {
    let k = report(&id)?;
    let source = reports.service.source(&ctx, k.id).await.map_err(internal)?;
    let dto = reports.source_dto(&ctx, &source).await;
    Ok(Json(report_dto(k, &source, dto)))
}

async fn get_report_summary(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
) -> ApiResult<JsonBody<RoadmapReportDto>> {
    report(&id)?;
    Ok(Json(
        reports
            .service
            .summary(&ctx)
            .await
            .map_err(|e| internal(format!("{e:#}")))?,
    ))
}

async fn export_report(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
    Query(query): Query<WorkbookQuery>,
) -> ApiResult<Response> {
    let k = report(&id)?;
    let today = match query
        .date
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        None => time::OffsetDateTime::now_utc().date(),
        Some(d) => time::Date::parse(d, &time::format_description::well_known::Iso8601::DATE)
            .map_err(|e| {
                StudioReportsError::invalid_argument()
                    .with_field_violation("date", format!("not a YYYY-MM-DD date: {e}"), "INVALID")
                    .create()
            })?,
    };
    let bytes = reports
        .service
        .workbook(&ctx, k, today)
        .await
        .map_err(|e| internal(format!("{e:#}")))?;
    let name = format!("back_{}_{today}.xlsx", k.id);
    Response::builder()
        .status(StatusCode::OK)
        .header(
            axum::http::header::CONTENT_TYPE,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{name}\""),
        )
        .body(axum::body::Body::from(bytes))
        .map_err(internal)
}

async fn get_report_source(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
) -> ApiResult<JsonBody<ReportSourceDto>> {
    let k = report(&id)?;
    let source = reports.service.source(&ctx, k.id).await.map_err(internal)?;
    Ok(Json(reports.source_dto(&ctx, &source).await))
}

async fn update_report_source(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
    Json(input): Json<ReportSourceInputDto>,
) -> ApiResult<JsonBody<ReportSourceDto>> {
    let k = report(&id)?;
    let prev = reports.service.source(&ctx, k.id).await.map_err(internal)?;
    let saved = reports
        .service
        .save_source(&ctx, apply(&prev, input))
        .await
        .map_err(|e| {
            StudioReportsError::invalid_argument()
                .with_constraint(e)
                .create()
        })?;
    Ok(Json(reports.source_dto(&ctx, &saved).await))
}

async fn sync_report(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<(StatusCode, JsonBody<ReportSyncEnqueued>)> {
    let idempotency_key = crate::idempotency::key(&headers)?;
    let k = report(&id)?;
    // Queued in the organization's own tenant: nothing to hand it on to.
    let payload = serde_json::to_value(RefreshPayload {
        report: k.id.to_string(),
        organization_id: None,
    })
    .map_err(internal)?;
    let run = reports
        .queue()?
        .enqueue(
            &ctx,
            crate::tasks::service::NewRun {
                tenant: ctx.subject_tenant_id(),
                task_type: TASK_TYPE,
                payload,
                partition_key: Some("reports"),
                idempotency_key: idempotency_key.as_deref(),
                coalesce_queued: true,
                notify_workspace_id: None,
            },
        )
        .await
        .map_err(|e| internal(format!("{e:#}")))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(ReportSyncEnqueued {
            run_id: run.to_string(),
            status: "queued".into(),
        }),
    ))
}

fn schedule_dto(v: Option<crate::scheduler::port::ScheduleView>) -> ReportScheduleDto {
    match v {
        Some(v) => ReportScheduleDto {
            enabled: v.enabled,
            cron: Some(v.expression),
            next_run_at: Some(v.next_run_at),
            last_run: v.last_run_id.map(|u| u.to_string()),
        },
        None => ReportScheduleDto {
            enabled: false,
            cron: None,
            next_run_at: None,
            last_run: None,
        },
    }
}

async fn get_report_schedule(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
) -> ApiResult<JsonBody<ReportScheduleDto>> {
    let k = report(&id)?;
    let v = reports
        .service
        .schedule(&ctx, k.id)
        .await
        .map_err(|e| internal(format!("{e:#}")))?;
    Ok(Json(schedule_dto(v)))
}

async fn update_report_schedule(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
    Json(input): Json<ReportScheduleInputDto>,
) -> ApiResult<JsonBody<ReportScheduleDto>> {
    let k = report(&id)?;
    let cron = input
        .cron
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty());
    let v = reports
        .service
        .set_schedule(&ctx, k.id, input.enabled, cron)
        .await
        .map_err(|e| {
            StudioReportsError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok(Json(schedule_dto(Some(v))))
}

// ── the plan, edited here ───────────────────────────────────────────────────

/// The report's plan, in the sections the screen edits.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlanDto {
    /// What a save is made against: a save at another revision is a 409.
    /// 0 for a source with no plan yet.
    pub revision: u64,
    /// Where it came from: `studio` once edited here, `upload`, or the file.
    pub from: Option<String>,
    /// RFC 3339: read, uploaded or last edited.
    pub changed_at: Option<String>,
    /// The subject id of whoever changed it last here.
    pub changed_by: Option<String>,
    /// The file it is read from, while it is; the first save here lets it go.
    pub file: Option<String>,
    pub lanes: LanesDto,
    pub units: Vec<UnitDto>,
    /// The colour of a person in no unit.
    pub no_unit_color: Option<String>,
    pub people: Vec<PersonDto>,
    pub projects: Vec<ProjectDto>,
    pub needs: Vec<NeedDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PlanLanesInputDto {
    pub revision: u64,
    pub lanes: LanesDto,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PlanUnitsInputDto {
    pub revision: u64,
    pub units: Vec<UnitDto>,
    pub no_unit_color: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PlanPeopleInputDto {
    pub revision: u64,
    pub people: Vec<PersonDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PlanProjectsInputDto {
    pub revision: u64,
    pub projects: Vec<ProjectDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PlanNeedsInputDto {
    pub revision: u64,
    pub needs: Vec<NeedDto>,
}

pub fn plan_dto(source: &ReportSource, doc: &serde_yaml::Value) -> PlanDto {
    let s = plan_edit::read(doc);
    let snap = source.snapshot.as_ref();
    PlanDto {
        revision: snap.map_or(0, |s| s.revision),
        from: snap.map(|s| s.from.clone()),
        changed_at: snap.map(|s| s.read_at.clone()),
        changed_by: snap.and_then(|s| s.edited_by.clone()),
        file: source.plan_file.clone().filter(|f| !f.trim().is_empty()),
        lanes: s.lanes,
        units: s.units,
        no_unit_color: s.no_unit_color,
        people: s.people,
        projects: s.projects,
        needs: s.needs,
    }
}

async fn get_report_plan(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
) -> ApiResult<JsonBody<PlanDto>> {
    let k = report(&id)?;
    let (source, doc) = reports
        .service
        .plan_document(&ctx, k.id)
        .await
        .map_err(|e| internal(format!("{e:#}")))?;
    Ok(Json(plan_dto(&source, &doc)))
}

async fn save_section(
    ctx: &SecurityContext,
    reports: &Reports,
    id: &str,
    revision: u64,
    section: Section,
) -> ApiResult<JsonBody<PlanDto>> {
    let k = report(id)?;
    let saved = reports
        .service
        .edit_plan(ctx, k.id, revision, section)
        .await
        .map_err(|e| match e {
            PlanEditError::Stale { current } => StudioReportsError::aborted(format!(
                "the plan changed since revision {revision}; it is at {current} -- read it again"
            ))
            .with_reason("PLAN_REVISION_STALE")
            .create(),
            PlanEditError::Invalid(m) => StudioReportsError::invalid_argument()
                .with_constraint(m)
                .create(),
            PlanEditError::Other(e) => internal(format!("{e:#}")),
        })?;
    let (_, doc) = reports
        .service
        .plan_document(ctx, k.id)
        .await
        .map_err(|e| internal(format!("{e:#}")))?;
    Ok(Json(plan_dto(&saved, &doc)))
}

async fn update_report_plan_lanes(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
    Json(input): Json<PlanLanesInputDto>,
) -> ApiResult<JsonBody<PlanDto>> {
    save_section(
        &ctx,
        &reports,
        &id,
        input.revision,
        Section::Lanes(input.lanes),
    )
    .await
}

async fn update_report_plan_units(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
    Json(input): Json<PlanUnitsInputDto>,
) -> ApiResult<JsonBody<PlanDto>> {
    let section = Section::Units {
        units: input.units,
        no_unit_color: input.no_unit_color,
    };
    save_section(&ctx, &reports, &id, input.revision, section).await
}

async fn update_report_plan_people(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
    Json(input): Json<PlanPeopleInputDto>,
) -> ApiResult<JsonBody<PlanDto>> {
    save_section(
        &ctx,
        &reports,
        &id,
        input.revision,
        Section::People(input.people),
    )
    .await
}

async fn update_report_plan_projects(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
    Json(input): Json<PlanProjectsInputDto>,
) -> ApiResult<JsonBody<PlanDto>> {
    save_section(
        &ctx,
        &reports,
        &id,
        input.revision,
        Section::Projects(input.projects),
    )
    .await
}

async fn update_report_plan_needs(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
    Json(input): Json<PlanNeedsInputDto>,
) -> ApiResult<JsonBody<PlanDto>> {
    save_section(
        &ctx,
        &reports,
        &id,
        input.revision,
        Section::Needs(input.needs),
    )
    .await
}

/// The plan's people matched to Studio's, and the members the plan misses.
async fn get_report_plan_people(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
) -> ApiResult<JsonBody<PlanPeopleDto>> {
    let k = report(&id)?;
    let (_, doc) = reports
        .service
        .plan_document(&ctx, k.id)
        .await
        .map_err(|e| internal(format!("{e:#}")))?;
    let people = plan_edit::read(&doc).people;
    let scope = ClientScope::gts_id(crate::user_profile::IDENTITY_INSTANCE_ID);
    let resolver = reports
        .hub
        .get_scoped::<dyn crate::user_profile::AliasResolver>(&scope);
    let roster = reports
        .hub
        .get_scoped::<dyn crate::user_profile::OrganizationRoster>(&scope);
    let (Ok(resolver), Ok(roster)) = (resolver, roster) else {
        // Without studio-user nobody can be matched; say so rather than
        // answer every person as unknown.
        let mut out = people_links::link(
            &people,
            &Default::default(),
            &Default::default(),
            &Default::default(),
        );
        out.identities_available = false;
        return Ok(Json(out));
    };
    let logins: Vec<String> = people.iter().map(|p| people_links::key(&p.login)).collect();
    let owners = resolver
        .confirmed_owners("github", &logins)
        .await
        .map_err(|e| internal(format!("{e:#}")))?;
    let members: std::collections::BTreeSet<String> = roster
        .active_members(ctx.subject_tenant_id())
        .await
        .map_err(|e| internal(format!("{e:#}")))?
        .into_iter()
        .map(|m| m.person)
        .collect();
    let member_ids: Vec<String> = members.iter().cloned().collect();
    let held = resolver
        .confirmed_identities("github", &member_ids)
        .await
        .map_err(|e| internal(format!("{e:#}")))?;
    Ok(Json(people_links::link(&people, &owners, &members, &held)))
}

/// The plan as `gears.yaml`, for the planning script or a backup.
async fn export_report_plan(
    OrgCtx(ctx): OrgCtx,
    Extension(reports): Extension<Reports>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let k = report(&id)?;
    let source = reports.service.source(&ctx, k.id).await.map_err(internal)?;
    let snap = source.snapshot.ok_or_else(|| {
        StudioReportsError::not_found(format!("the {} report has no plan yet", k.id))
            .with_resource(k.id)
            .create()
    })?;
    Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "application/yaml")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            "attachment; filename=\"gears.yaml\"",
        )
        .body(axum::body::Body::from(snap.text))
        .map_err(internal)
}

// ── routes ──────────────────────────────────────────────────────────────────

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<ReportsService>,
    hub: Arc<ClientHub>,
    access: Arc<dyn WorkspaceAccess>,
) -> Router {
    let router = OperationBuilder::get("/studio-reports/v1/reports")
        .operation_id("studio_reports.list_reports")
        .summary("Every report this deployment draws, with its source here")
        .description(
            "One entry per report: what it is, the definition it is drawn with (the plan's own, \
             or the report's built-in), the sheets that gives, and the caller's organization's \
             source for it -- the connection, the plan file, the board, and what the last refresh \
             read and did. A report nobody configured is listed with an empty source.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(list_reports)
        .json_response_with_schema::<ReportListDto>(openapi, StatusCode::OK, "The reports")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-reports/v1/reports/{report_id}")
        .operation_id("studio_reports.get_report")
        .summary("One report, its definition and its source here")
        .description(
            "What one entry of the report list says: the report, the definition it is drawn with \
             and its sheets, and the organization's source. `definition_error` says why a plan's \
             own definition does not read; the report is then drawn with its built-in.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(get_report)
        .json_response_with_schema::<ReportDto>(openapi, StatusCode::OK, "The report")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-reports/v1/reports/{report_id}/summary")
        .operation_id("studio_reports.get_report_summary")
        .summary("The report's data, as typed JSON: one row per planned gear and the summary")
        .description(
            "Every gear the roadmap board plans, one row each -- stage, milestone and due date, \
             commitment, progress per axis, who needs it and how badly, whether the plan holds \
             and why not, assignees, effort, and the repository's side (lifecycle, last release, \
             grade) where a catalogued component implements it -- soonest due first, with what \
             a planning meeting reads first: per group, per stage, per milestone, per consumer, \
             per plan state, and the overdue ones. What a screen draws; the workbook is the \
             export.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(get_report_summary)
        .json_response_with_schema::<RoadmapReportDto>(openapi, StatusCode::OK, "The report's data")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-reports/v1/reports/{report_id}/workbook")
        .operation_id("studio_reports.export_report")
        .summary("The report as a workbook: the planning team's back_roadmap spreadsheet")
        .description(
            "The report drawn by its definition as an .xlsx: for the built-in back_roadmap, \
             Summary (per group, formulas over the group sheets), Roadmap (groups as swimlanes \
             over the coming nine months, a box per gear at its milestone), Gantt (each team's \
             remaining work scheduled against its people and power, blockers first), People, a \
             sheet per group and ALL, with every forecast and every cell the planning sheet \
             colours. Drawn from the gears the last board sync stored and the plan the last \
             refresh read; `date` sets the day it is drawn as of.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(export_report)
        .text_response(
            StatusCode::OK,
            "The workbook",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-reports/v1/reports/{report_id}/source")
        .operation_id("studio_reports.get_report_source")
        .summary("Where the report's board and plan come from in this organization")
        .description(
            "The organization's source for the report: the GitHub connection, the plan file \
             (`owner/repo:path@ref`) or an uploaded plan, the board, roots and consumers when the \
             source overrides the plan's, the plan as the last refresh read it (where from, which \
             blob, when) and what that refresh did. Empty until someone saves one.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(get_report_source)
        .json_response_with_schema::<ReportSourceDto>(openapi, StatusCode::OK, "The source")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-reports/v1/reports/{report_id}/source")
        .operation_id("studio_reports.update_report_source")
        .summary("Set where the report's board and plan come from in this organization")
        .description(
            "Saves the organization's source for the report. A field left out keeps what is \
             saved; an empty string clears it. The plan file is written `owner/repo:path@ref` or \
             as a GitHub link, and the plan can carry the rest itself -- `board`, `roots`, \
             `consumers` and `report` (a built-in definition's id, or a definition). A plan file \
             that does not parse, a plan that is not YAML or a board that is not owner/number is \
             refused. Uploading a plan makes it the plan at once; a file is read on the next \
             refresh.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(update_report_source)
        .json_request::<ReportSourceInputDto>(openapi, "The source")
        .json_response_with_schema::<ReportSourceDto>(openapi, StatusCode::OK, "The saved source")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-reports/v1/reports/{report_id}/sync")
        .operation_id("studio_reports.sync_report")
        .summary("Refresh the report: read its plan again and sync its board")
        .description(
            "Queues a `reports.refresh` run: it reads the plan file again through the source's \
             connection, keeps what it read, and queues a sync of the board the plan names (a \
             `catalog.sync` run). What it did -- and why not, when it failed -- is on the source \
             afterwards. To keep a report current on its own, switch on its schedule with \
             `PUT .../{report_id}/schedule`: the schedule fires in the platform tenant, so its \
             payload names the organization (`{\"report\": \"roadmap\", \"organization_id\": \
             \"...\"}`), and the run hands itself on to that organization's tenant. A schedule \
             without `organization_id` would refresh the platform tenant's empty source. Answers \
             202 with the `run_id`; send an `Idempotency-Key` header to make a retry of this \
             request safe, since a repeat with the same key answers the same run.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .param(crate::idempotency::param())
        .handler(sync_report)
        .json_response_with_schema::<ReportSyncEnqueued>(
            openapi,
            StatusCode::ACCEPTED,
            "The queued run",
        )
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-reports/v1/reports/{report_id}/schedule")
        .operation_id("studio_reports.get_report_schedule")
        .summary("Whether the report refreshes on its own, and when next")
        .description(
            "The schedule that keeps this organization's report current: a `reports.refresh` \
             schedule on studio-scheduler whose payload names the report and the organization. \
             `enabled: false` with no `cron` when there is none yet.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(get_report_schedule)
        .json_response_with_schema::<ReportScheduleDto>(openapi, StatusCode::OK, "The schedule")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-reports/v1/reports/{report_id}/schedule")
        .operation_id("studio_reports.update_report_schedule")
        .summary("Switch the report's own refresh on or off")
        .description(
            "Creates the schedule the first time, then switches it and sets its expression (hourly \
             unless `cron` says otherwise, in UTC). Schedules are platform-level and fire in the \
             platform tenant, so this gear writes the organization (`organization_id`, checked \
             against the caller's reach) into the schedule's payload, and the run it fires hands \
             itself to that organization -- a client never writes the payload itself.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(update_report_schedule)
        .json_request::<ReportScheduleInputDto>(openapi, "On or off, and how often")
        .json_response_with_schema::<ReportScheduleDto>(openapi, StatusCode::OK, "The schedule")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-reports/v1/reports/{report_id}/plan")
        .operation_id("studio_reports.get_report_plan")
        .summary("The report's plan, in the sections the Reports screen edits")
        .description(
            "The planning team's `gears.yaml` as this organization keeps it: the group lanes, \
             the units and their teams, the people (GitHub login, alias, team, power, email), \
             the consumer projects and, per gear, when each project needs it -- each in the \
             document's order, which is the order the workbook draws. `revision` is what a save \
             is made against; a source with no plan yet answers an empty one at revision 0.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(get_report_plan)
        .json_response_with_schema::<PlanDto>(openapi, StatusCode::OK, "The plan")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-reports/v1/reports/{report_id}/plan/lanes")
        .operation_id("studio_reports.update_report_plan_lanes")
        .summary("Save the plan's group lanes: their order and names")
        .description(
            "When the order or the names of the Roadmap sheet's group lanes change. Replaces this one section of the plan and keeps every other key of \
             the document, in its place, and the fields of an entry this section does not name. \
             The whole plan has to hold together afterwards -- a person's team is a team, a \
             need's project is a project, a team tag is in one unit -- or nothing is saved and \
             the 400 lists every reason. Made against `revision`: a plan saved since is a 409 \
             (`aborted`). The first save here makes Studio the plan's home: the file it was \
             read from is let go, and a refresh no longer reads it.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(update_report_plan_lanes)
        .json_request::<PlanLanesInputDto>(openapi, "The lanes, and the revision they were read at")
        .json_response_with_schema::<PlanDto>(openapi, StatusCode::OK, "The saved plan")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_409(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-reports/v1/reports/{report_id}/plan/units")
        .operation_id("studio_reports.update_report_plan_units")
        .summary("Save the plan's units and their teams")
        .description(
            "When a unit or a team is added, renamed, recoloured or resized. Replaces this one section of the plan and keeps every other key of \
             the document, in its place, and the fields of an entry this section does not name. \
             The whole plan has to hold together afterwards -- a person's team is a team, a \
             need's project is a project, a team tag is in one unit -- or nothing is saved and \
             the 400 lists every reason. Made against `revision`: a plan saved since is a 409 \
             (`aborted`). The first save here makes Studio the plan's home: the file it was \
             read from is let go, and a refresh no longer reads it.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(update_report_plan_units)
        .json_request::<PlanUnitsInputDto>(openapi, "The units, and the revision they were read at")
        .json_response_with_schema::<PlanDto>(openapi, StatusCode::OK, "The saved plan")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_409(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-reports/v1/reports/{report_id}/plan/people")
        .operation_id("studio_reports.update_report_plan_people")
        .summary("Save the plan's people: login, alias, team, power and email")
        .description(
            "When someone joins, leaves, moves team or changes how much of their time the plan counts on. Replaces this one section of the plan and keeps every other key of \
             the document, in its place, and the fields of an entry this section does not name. \
             The whole plan has to hold together afterwards -- a person's team is a team, a \
             need's project is a project, a team tag is in one unit -- or nothing is saved and \
             the 400 lists every reason. Made against `revision`: a plan saved since is a 409 \
             (`aborted`). The first save here makes Studio the plan's home: the file it was \
             read from is let go, and a refresh no longer reads it.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(update_report_plan_people)
        .json_request::<PlanPeopleInputDto>(
            openapi,
            "The people, and the revision they were read at",
        )
        .json_response_with_schema::<PlanDto>(openapi, StatusCode::OK, "The saved plan")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_409(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-reports/v1/reports/{report_id}/plan/projects")
        .operation_id("studio_reports.update_report_plan_projects")
        .summary("Save the plan's consumer projects: the needs' columns")
        .description(
            "When a consumer project is added, renamed or reordered: the needs' columns. Replaces this one section of the plan and keeps every other key of \
             the document, in its place, and the fields of an entry this section does not name. \
             The whole plan has to hold together afterwards -- a person's team is a team, a \
             need's project is a project, a team tag is in one unit -- or nothing is saved and \
             the 400 lists every reason. Made against `revision`: a plan saved since is a 409 \
             (`aborted`). The first save here makes Studio the plan's home: the file it was \
             read from is let go, and a refresh no longer reads it.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(update_report_plan_projects)
        .json_request::<PlanProjectsInputDto>(
            openapi,
            "The projects, and the revision they were read at",
        )
        .json_response_with_schema::<PlanDto>(openapi, StatusCode::OK, "The saved plan")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_409(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-reports/v1/reports/{report_id}/plan/needs")
        .operation_id("studio_reports.update_report_plan_needs")
        .summary("Save the plan's needs: per gear, when each project needs it")
        .description(
            "When a project's date for a gear changes, or a gear is added to the needs. Replaces this one section of the plan and keeps every other key of \
             the document, in its place, and the fields of an entry this section does not name. \
             The whole plan has to hold together afterwards -- a person's team is a team, a \
             need's project is a project, a team tag is in one unit -- or nothing is saved and \
             the 400 lists every reason. Made against `revision`: a plan saved since is a 409 \
             (`aborted`). The first save here makes Studio the plan's home: the file it was \
             read from is let go, and a refresh no longer reads it.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(update_report_plan_needs)
        .json_request::<PlanNeedsInputDto>(openapi, "The needs, and the revision they were read at")
        .json_response_with_schema::<PlanDto>(openapi, StatusCode::OK, "The saved plan")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_409(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-reports/v1/reports/{report_id}/plan/people")
        .operation_id("studio_reports.get_report_plan_people")
        .summary("The plan's people matched to Studio's, and the members it misses")
        .description(
            "When planning who works on what: each person in the plan with the Studio person \
             whose confirmed GitHub account their login is, and whether that person is an \
             active member of this organization; then the members with a confirmed GitHub \
             account the plan does not list, and how many members have none. Only confirmed \
             accounts link anybody (ADR-0012), and nothing is stored: a person who confirms \
             their account is linked from then on. `identities_available` is false when \
             studio-user is not running, and nobody can be matched.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(get_report_plan_people)
        .json_response_with_schema::<PlanPeopleDto>(openapi, StatusCode::OK, "The plan's people")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-reports/v1/reports/{report_id}/plan/yaml")
        .operation_id("studio_reports.export_report_plan")
        .summary("The plan as gears.yaml")
        .description(
            "The plan's text as the source keeps it: what the planning script reads, and the \
             backup of what is edited here. Uploading it as the source's plan brings it back. \
             404 when the report has no plan yet.",
        )
        .tag("StudioReports")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .path_param("report_id", "The report (`roadmap`)")
        .handler(export_report_plan)
        .text_response(StatusCode::OK, "The plan", "application/yaml")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router
        .layer(Extension(Reports { service, hub }))
        .layer(Extension(OrgAccess(access)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> ReportSourceInputDto {
        ReportSourceInputDto {
            connection_id: None,
            plan_file: None,
            plan_yaml: None,
            board: None,
            roots: None,
            consumers: None,
        }
    }

    fn saved() -> ReportSource {
        ReportSource {
            report: "roadmap".into(),
            connection_id: Some(Uuid::from_u128(1)),
            plan_file: Some("o/r:p.yaml".into()),
            board: Some("o/48".into()),
            roots: vec!["1".into()],
            ..ReportSource::default()
        }
    }

    #[test]
    fn a_field_left_out_keeps_what_is_saved() {
        assert_eq!(apply(&saved(), input()), saved());
    }

    #[test]
    fn an_empty_field_clears_it() {
        let cleared = apply(
            &saved(),
            ReportSourceInputDto {
                plan_file: Some("  ".into()),
                plan_yaml: Some("".into()),
                board: Some("".into()),
                roots: Some(Vec::new()),
                ..input()
            },
        );
        assert_eq!(cleared.plan_yaml.as_deref(), Some(""));
        assert!(cleared.plan_file.is_none() && cleared.board.is_none());
        assert!(cleared.roots.is_empty());
        assert_eq!(cleared.connection_id, Some(Uuid::from_u128(1)));
    }

    #[test]
    fn the_dto_says_whether_the_plan_was_uploaded_but_not_its_text() {
        let mut s = saved();
        s.snapshot = Some(PlanSnapshot {
            text: "board: o/48\n".into(),
            from: "upload".into(),
            sha: None,
            read_at: "t".into(),
            ..PlanSnapshot::default()
        });
        let dto = source_dto(&s);
        assert!(dto.plan_uploaded);
        assert_eq!(dto.snapshot.as_ref().map(|x| x.size), Some(12));
        s.snapshot = Some(PlanSnapshot {
            from: "o/r:p.yaml".into(),
            ..s.snapshot.clone().unwrap()
        });
        assert!(!source_dto(&s).plan_uploaded);
    }

    #[test]
    fn a_report_lists_its_sheets_and_says_when_the_plans_definition_does_not_read() {
        let k = kind("roadmap").unwrap();
        let empty = ReportSource {
            report: "roadmap".into(),
            ..ReportSource::default()
        };
        let dto = report_dto(k, &empty, source_dto(&empty));
        assert_eq!(dto.definition, "back_roadmap");
        assert_eq!(
            dto.sheets,
            vec![
                "Summary",
                "Roadmap",
                "Gantt",
                "People",
                "a sheet per group, ALL"
            ]
        );
        assert!(dto.definition_error.is_none());
        let bad = ReportSource {
            report: "roadmap".into(),
            snapshot: Some(PlanSnapshot {
                text: "report: weekly\n".into(),
                from: "upload".into(),
                sha: None,
                read_at: "t".into(),
                ..PlanSnapshot::default()
            }),
            ..ReportSource::default()
        };
        let dto = report_dto(k, &bad, source_dto(&bad));
        assert!(dto.definition_error.is_some_and(|e| e.contains("weekly")));
    }

    #[test]
    fn the_source_says_what_its_plan_holds() {
        let none = source_dto(&ReportSource {
            report: "roadmap".into(),
            ..ReportSource::default()
        });
        assert!(none.plan.is_none(), "no plan read: nothing to summarise");
        let read = ReportSource {
            report: "roadmap".into(),
            snapshot: Some(PlanSnapshot {
                text: "board: o/48\nunits:\n  U: { teams: [ { tag: a, name: A }, { tag: b, name: B } ] }\nusers:\n  x: { team: a }\n  y: { team: b }\ngear_projects:\n  web: { name: Web }\n".into(),
                from: "upload".into(),
                sha: None,
                read_at: "t".into(),
                ..PlanSnapshot::default()
            }),
            ..ReportSource::default()
        };
        let p = source_dto(&read).plan.expect("summary");
        assert_eq!(p.board.as_deref(), Some("o/48"));
        assert_eq!((p.people, p.teams, p.projects), (2, 2, 1));
        // A plan that names no board says so, even when the source does.
        let mut boardless = read.clone();
        boardless.board = Some("o/7".into());
        boardless.snapshot.as_mut().unwrap().text = "users:\n  x: {}\n".into();
        let p = source_dto(&boardless).plan.expect("summary");
        assert!(p.board.is_none());
        assert_eq!(p.people, 1);
    }

    #[test]
    fn no_schedule_reads_as_off() {
        let off = schedule_dto(None);
        assert!(!off.enabled && off.cron.is_none());
        let on = schedule_dto(Some(crate::scheduler::port::ScheduleView {
            id: Uuid::from_u128(1),
            expression: "0 * * * *".into(),
            enabled: true,
            next_run_at: "2026-10-02T09:00:00Z".into(),
            last_run_id: Some(Uuid::from_u128(2)),
        }));
        assert!(on.enabled);
        assert_eq!(on.cron.as_deref(), Some("0 * * * *"));
        assert_eq!(on.last_run, Some(Uuid::from_u128(2).to_string()));
    }

    #[test]
    fn an_unknown_report_is_not_found() {
        assert!(report("roadmap").is_ok());
        assert!(report("weekly").is_err());
    }

    fn view(state: RunState, result: Option<serde_json::Value>, err: Option<&str>) -> RunView {
        RunView {
            state,
            result,
            last_error: err.map(str::to_string),
        }
    }

    #[test]
    fn a_finished_sync_says_which_board_it_did_not_read() {
        let unread = serde_json::json!({
            "gears": 0, "versions": 0, "stored": 54,
            "boards_unread": [{ "board": "constructorfabric/48", "error": "connection ddff5557 not found" }],
        });
        let e = board_error_of(&view(RunState::Succeeded, Some(unread), None)).expect("said");
        assert!(
            e.contains("constructorfabric/48") && e.contains("not found"),
            "{e}"
        );
        // Read, or not finished: nothing to say.
        let read = serde_json::json!({ "gears": 0, "versions": 0, "stored": 54 });
        assert!(board_error_of(&view(RunState::Succeeded, Some(read), None)).is_none());
        assert!(board_error_of(&view(RunState::Running, None, None)).is_none());
        assert!(board_error_of(&view(RunState::Queued, None, None)).is_none());
        let failed = board_error_of(&view(RunState::Failed, None, Some("graph-storage down")));
        assert!(failed.is_some_and(|e| e.contains("graph-storage down")));
    }
}
