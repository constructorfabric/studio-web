//! REST surface for the Insight integration.
//!
//! * `POST /query` runs one read-only SQL statement against Insight's
//!   warehouse — the operation Insight actually exposes, typed end to end.
//! * `POST /pull` / `POST /push` stay as the generic escape hatch: the body's
//!   `resource` names the Insight endpoint (appended to `{base_url}{api_path}`),
//!   so this surface does not hard-code routes Insight has yet to publish.
//! * `GET /health` reports whether the upstream is configured and, when it is,
//!   whether it actually answers.
//!
//! Error mapping follows fault, not convenience: a statement Insight rejects is
//! the caller's 400, an unreachable or misconfigured upstream is our 503, and
//! anything else is a 500.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use axum::{Extension, Router};
use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;

use super::INSIGHT_INSTANCE_ID;
use super::client::{InsightClient, InsightError, SqlPage};
use super::components::{
    Bucket, ComponentMatch, ComponentPoint, ComponentQuery, ComponentQueryInput, ComponentRow,
    ComponentSpec,
};

#[resource_error(gts_id!("cf.studio._.insight.v1~"))]
pub struct InsightApiError;

/// Service handle carried in the router.
#[derive(Clone)]
pub struct Handle(pub Arc<dyn InsightClient>);

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// Turn a seam failure into the canonical error that names the right culprit.
///
/// Insight's own 400 means the SQL was bad — that is the caller's fault and has
/// to reach them as a 400, otherwise every typo in a statement reads as "the
/// platform is broken". A missing key or an unreachable host is ours, and the
/// portal can only react usefully if it is told the upstream is unavailable.
fn to_canonical(e: InsightError) -> CanonicalError {
    if e.is_caller_error() {
        return InsightApiError::invalid_argument()
            .with_field_violation("sql", e.to_string(), "INVALID")
            .create();
    }
    match &e {
        InsightError::NotConfigured(_) | InsightError::Transport(_) => {
            CanonicalError::service_unavailable()
                .with_detail(e.to_string())
                .create()
        }
        InsightError::Upstream { .. } => CanonicalError::internal(e.to_string()).create(),
    }
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct QueryRequest {
    /// A single read-only statement — `SELECT …` or `WITH … SELECT …`. Insight
    /// refuses anything else (multiple statements, DDL, writes) with a 400.
    pub sql: String,
}

/// One column of a [`QueryResponse`], carrying Insight's ClickHouse type name.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ColumnDto {
    pub name: String,
    /// ClickHouse type name, e.g. `String`, `UInt64`, `Nullable(DateTime)`.
    #[serde(rename = "type")]
    pub data_type: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct QueryResponse {
    pub columns: Vec<ColumnDto>,
    /// Result rows as JSON objects keyed by column name, exactly as Insight
    /// returned them.
    #[schema(value_type = Vec<Object>)]
    pub rows: Vec<Value>,
    pub row_count: u64,
    /// True when Insight capped the result — the rows are a prefix, so an
    /// aggregate computed over them is not the aggregate over the warehouse.
    pub truncated: bool,
}

impl From<SqlPage> for QueryResponse {
    fn from(p: SqlPage) -> Self {
        Self {
            columns: p
                .columns
                .into_iter()
                .map(|c| ColumnDto {
                    name: c.name,
                    data_type: c.data_type,
                })
                .collect(),
            rows: p.rows,
            row_count: p.row_count,
            truncated: p.truncated,
        }
    }
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ComponentSpecDto {
    /// The name to report this component under.
    pub key: String,
    /// Everything under this path prefix belongs to the component, e.g.
    /// `studio-backend/src/insight/`.
    #[serde(default)]
    pub path_prefix: Option<String>,
    /// Or: one directory name to look for anywhere in a file's path, e.g.
    /// `api-gateway` for `gears/system/api-gateway/src/...`. Defaults to `key`,
    /// so a caller that knows component names and not paths can send names
    /// alone. Whole segments only — `credstore` will not swallow
    /// `credstore-sdk`.
    #[serde(default)]
    pub path_segment: Option<String>,
}

impl ComponentSpecDto {
    /// Exactly one matcher. Both set is a contradiction worth refusing rather
    /// than silently preferring one; neither means "the key is the directory".
    fn into_spec(self) -> Result<ComponentSpec, String> {
        let matcher = match (self.path_prefix, self.path_segment) {
            (Some(p), None) => ComponentMatch::Prefix(p),
            (None, Some(s)) => ComponentMatch::Segment(s),
            (None, None) => ComponentMatch::Segment(self.key.clone()),
            (Some(_), Some(_)) => {
                return Err(format!(
                    "component `{}` sets both `path_prefix` and `path_segment` — pick one",
                    self.key
                ));
            }
        };
        Ok(ComponentSpec {
            key: self.key,
            matcher,
        })
    }
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ComponentMetricsRequest {
    /// `owner/name` (or a bare `name`, which then matches in any org), e.g.
    /// `constructorfabric/gears-rust`.
    pub repository: String,
    /// Inclusive `YYYY-MM-DD` window. Both default to the last 30 days, as the
    /// warehouse counts them.
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    /// Path segments to group by when `components` is empty: `2` gives
    /// `gears/bss`, `3` walks down to the individual gear. Default 2, max 6.
    #[serde(default)]
    pub depth: Option<u8>,
    /// An explicit component map. When empty, components are derived from
    /// `depth`; when given, files matching none of them are reported as `other`
    /// rather than dropped.
    #[serde(default)]
    pub components: Vec<ComponentSpecDto>,
    /// Whether the `other` remainder row is returned. Default true; set false
    /// when only the declared components matter. Ignored when `components` is
    /// empty, since then every file already belongs to one.
    #[serde(default)]
    pub include_other: Option<bool>,
    /// Ask for a trend as well: `day`, `week` or `month`. The `series` in the
    /// answer then carries one point per component per bucket, for the
    /// components the totals ranked — omit it when a chart is not needed, since
    /// it costs a second query upstream.
    #[serde(default)]
    pub bucket: Option<String>,
    /// Rows to return, ordered by churn. Default 50, max 500.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentMetricsRow {
    /// The component key: a declared one, or the path prefix it was grouped by.
    pub component: String,
    pub commits: u64,
    pub files_changed: u64,
    pub lines_added: i64,
    pub lines_removed: i64,
    /// Distinct commit authors that touched it in the window.
    pub authors: u64,
}

/// One point of the trend: what a component did inside one bucket.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentTrendPoint {
    pub component: String,
    /// The bucket's first day, `YYYY-MM-DD`.
    pub date: String,
    pub commits: u64,
    pub lines_added: i64,
    pub lines_removed: i64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentMetricsResponse {
    /// The repository as the warehouse spells it.
    pub repository: String,
    /// The window actually used — resolved here when the request defaulted it,
    /// so a caller can label a chart without guessing what "last 30 days" meant.
    pub from: String,
    pub to: String,
    pub components: Vec<ComponentMetricsRow>,
    /// The bucket the series is grouped by, echoed back; absent when no trend
    /// was asked for.
    pub bucket: Option<String>,
    /// Sparse by design: a bucket in which a component saw no commits has no
    /// point, rather than a zero. A chart has to fill those gaps itself, which
    /// is the only way it can tell "quiet" from "outside the window".
    pub series: Vec<ComponentTrendPoint>,
    /// True when Insight capped the page: more components exist than are shown.
    pub truncated: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PullRequest {
    /// The Insight resource to read (appended to `{base_url}{api_path}`).
    pub resource: String,
    /// Optional query parameters.
    #[serde(default)]
    pub params: HashMap<String, String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PushRequest {
    /// The Insight resource to write (appended to `{base_url}{api_path}`).
    pub resource: String,
    /// The JSON body to send.
    #[schema(value_type = Object)]
    pub payload: Value,
}

/// Insight's response, passed through.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct InsightData {
    #[schema(value_type = Object)]
    pub data: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct InsightHealth {
    /// True when a base URL and API key are configured.
    pub configured: bool,
    /// The resolved Insight base URL (empty when unconfigured).
    pub base_url: String,
    /// The GTS instance id this gear publishes to the ClientHub, so a caller
    /// can see which seam answered.
    pub instance_id: String,
    /// True when a `SELECT 1` round trip succeeded just now. `false` with a
    /// `detail` when it failed; `false` with no detail when unconfigured, since
    /// no probe was attempted.
    pub reachable: bool,
    /// Why the probe failed, when it did.
    pub detail: Option<String>,
    /// Round-trip time of the probe in milliseconds, when one was attempted.
    pub probe_ms: Option<u64>,
}

async fn query(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Json(req): Json<QueryRequest>,
) -> ApiResult<JsonBody<QueryResponse>> {
    let page = handle.0.query(&req.sql).await.map_err(to_canonical)?;
    Ok(Json(page.into()))
}

/// A bad argument here is the caller's, so it is a 400 with the offending
/// field named — `invalid_argument` refuses to be built without one, which is
/// exactly the discipline this endpoint needs.
fn bad_argument(field: &'static str, detail: String) -> CanonicalError {
    InsightApiError::invalid_argument()
        .with_field_violation(field, detail, "INVALID")
        .create()
}

fn unreadable(kind: &str, e: serde_json::Error) -> CanonicalError {
    CanonicalError::internal(format!(
        "insight returned a {kind} this gear cannot read: {e}"
    ))
    .create()
}

async fn component_metrics(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Json(req): Json<ComponentMetricsRequest>,
) -> ApiResult<JsonBody<ComponentMetricsResponse>> {
    let repository = req.repository.trim().to_string();
    let bucket = req
        .bucket
        .as_deref()
        .map(Bucket::parse)
        .transpose()
        .map_err(|detail| bad_argument("bucket", detail))?;

    let query = ComponentQuery::new(ComponentQueryInput {
        repository: repository.clone(),
        from: req.from.clone(),
        to: req.to.clone(),
        depth: req.depth,
        components: req
            .components
            .into_iter()
            .map(ComponentSpecDto::into_spec)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|detail| bad_argument("components", detail))?,
        include_other: req.include_other.unwrap_or(true),
        limit: req.limit,
    })
    .map_err(|detail| bad_argument("repository", detail))?;

    let page = handle
        .0
        .query(&query.to_sql())
        .await
        .map_err(to_canonical)?;

    // The window is carried on every row (it is a constant of the query), so an
    // empty result still has to answer "over what period?" — fall back to the
    // request's own bounds, which are then the only ones anybody asked for.
    let mut from = req.from.unwrap_or_default();
    let mut to = req.to.unwrap_or_default();
    let mut components = Vec::with_capacity(page.rows.len());
    for row in page.rows {
        let row: ComponentRow =
            serde_json::from_value(row).map_err(|e| unreadable("component row", e))?;
        from = row.range_from;
        to = row.range_to;
        components.push(ComponentMetricsRow {
            component: row.component,
            commits: row.commits,
            files_changed: row.files_changed,
            lines_added: row.lines_added,
            lines_removed: row.lines_removed,
            authors: row.authors,
        });
    }

    // The trend follows the totals rather than running beside them: it is
    // restricted to the components the ranking kept, so asking for a chart over
    // a big repository cannot quietly become a query over all of it.
    let mut series = Vec::new();
    let mut truncated = page.truncated;
    if let Some(bucket) = bucket
        && !components.is_empty()
    {
        let keys: Vec<String> = components.iter().map(|c| c.component.clone()).collect();
        let trend = handle
            .0
            .query(&query.to_trend_sql(bucket, &keys))
            .await
            .map_err(to_canonical)?;
        truncated = truncated || trend.truncated;
        series.reserve(trend.rows.len());
        for row in trend.rows {
            let p: ComponentPoint =
                serde_json::from_value(row).map_err(|e| unreadable("trend point", e))?;
            series.push(ComponentTrendPoint {
                component: p.component,
                date: p.bucket_date,
                commits: p.commits,
                lines_added: p.lines_added,
                lines_removed: p.lines_removed,
            });
        }
    }

    Ok(Json(ComponentMetricsResponse {
        repository,
        from,
        to,
        components,
        bucket: bucket.map(|b| b.as_str().to_string()),
        series,
        truncated,
    }))
}

async fn pull(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Json(req): Json<PullRequest>,
) -> ApiResult<JsonBody<InsightData>> {
    let params: Vec<(String, String)> = req.params.into_iter().collect();
    let data = handle
        .0
        .pull(req.resource.trim(), &params)
        .await
        .map_err(to_canonical)?;
    Ok(Json(InsightData { data }))
}

async fn push(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Json(req): Json<PushRequest>,
) -> ApiResult<JsonBody<InsightData>> {
    let data = handle
        .0
        .push(req.resource.trim(), req.payload)
        .await
        .map_err(to_canonical)?;
    Ok(Json(InsightData { data }))
}

/// Configuration *and* liveness: "the key is set" is the question people think
/// they are asking, but the one that matters before a dashboard goes up is
/// whether the token is still accepted. One `SELECT 1` answers both.
async fn health(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
) -> ApiResult<JsonBody<InsightHealth>> {
    let configured = handle.0.is_configured();
    let mut health = InsightHealth {
        configured,
        base_url: handle.0.base_url().to_string(),
        instance_id: INSIGHT_INSTANCE_ID.to_string(),
        reachable: false,
        detail: None,
        probe_ms: None,
    };
    if configured {
        let started = Instant::now();
        match handle.0.query("SELECT 1").await {
            Ok(_) => health.reachable = true,
            Err(e) => health.detail = Some(e.to_string()),
        }
        health.probe_ms = Some(started.elapsed().as_millis() as u64);
    }
    Ok(Json(health))
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    client: Arc<dyn InsightClient>,
) -> Router {
    let router = OperationBuilder::post("/studio-insight/v1/query")
        .operation_id("studio_insight.query")
        .summary("Run a read-only SQL query against Constructor Insight")
        .description(
            "Forwards one statement to Insight's analytics endpoint with the \
             server-held instance token and returns its columns and rows. \
             Insight accepts a single `SELECT` or `WITH` over its ClickHouse \
             warehouse (`insight` holds the gold views — `exec_summary`, \
             `people`, `ic_kpis`, `commits_daily`; `system.tables` and \
             `system.columns` describe the schema). Anything else — several \
             statements, DDL, a write — comes back as a 400.",
        )
        .tag("StudioInsight")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<QueryRequest>(openapi, "The SQL statement to run")
        .handler(query)
        .json_response_with_schema::<QueryResponse>(openapi, StatusCode::OK, "Query result")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-insight/v1/components/metrics")
        .operation_id("studio_insight.component_metrics")
        .summary("Delivery metrics for one repository, sliced by component")
        .description(
            "Commits, files touched, lines added/removed and distinct authors \
             per component over a date window. Insight's own observations carry \
             a `repository` dimension and nothing finer, but a repository here \
             is not a component — `gears-rust` alone holds ~90 gear crates — so \
             this operation groups the per-file commit records underneath it. \
             Name the components explicitly with `components` (key + path \
             prefix, longest match wins, the remainder reported as `other`), or \
             leave it empty and group by the first `depth` path segments. \
             Pass `bucket` (`day`/`week`/`month`) to get a `series` alongside \
             the totals, for the components the ranking kept — that is what a \
             chart needs, and it costs a second query upstream.",
        )
        .tag("StudioInsight")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ComponentMetricsRequest>(openapi, "Repository, window and component map")
        .handler(component_metrics)
        .json_response_with_schema::<ComponentMetricsResponse>(
            openapi,
            StatusCode::OK,
            "Per-component metrics, ordered by churn",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-insight/v1/pull")
        .operation_id("studio_insight.pull")
        .summary("Read a resource from Constructor Insight")
        .description(
            "Forwards a GET to `{insight_base}{api_path}/{resource}` with the \
             server-held key and returns Insight's response verbatim. The \
             escape hatch for endpoints this gear does not type yet — for \
             analytics use `/studio-insight/v1/query`.",
        )
        .tag("StudioInsight")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<PullRequest>(openapi, "Resource and query params")
        .handler(pull)
        .json_response_with_schema::<InsightData>(openapi, StatusCode::OK, "Insight response")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-insight/v1/push")
        .operation_id("studio_insight.push")
        .summary("Save a resource to Constructor Insight")
        .description(
            "Forwards a POST to `{insight_base}{api_path}/{resource}` with the \
             given JSON body and the server-held key — the platform contributes \
             events/records to Insight.",
        )
        .tag("StudioInsight")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<PushRequest>(openapi, "Resource and payload")
        .handler(push)
        .json_response_with_schema::<InsightData>(openapi, StatusCode::OK, "Insight response")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-insight/v1/health")
        .operation_id("studio_insight.health")
        .summary("Whether the Insight upstream is configured and answering")
        .description(
            "Reports whether a base URL and API key are set and, when they are, \
             runs a `SELECT 1` so an expired or revoked instance token shows up \
             here rather than in the first dashboard that needs it.",
        )
        .tag("StudioInsight")
        .authenticated()
        .require_license_features::<License>([])
        .handler(health)
        .json_response_with_schema::<InsightHealth>(openapi, StatusCode::OK, "Configuration status")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(Handle(client)))
}
