use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, RawQuery};
use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// Shared proxy state: one upstream, one server-held key.
pub struct ProxyState {
    pub client: reqwest::Client,
    pub base_url: String,
    /// None = key not configured; requests fail with a clear message instead
    /// of failing the whole backend boot.
    pub api_key: Option<String>,
}

/// Wiring status for the wrapper — deliberately excludes anything secret, so
/// the portal can show "analysis is available" without ever seeing the key.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecQualityStatusDto {
    /// True iff both the base URL and the key are configured.
    pub configured: bool,
    /// Whether an upstream base URL is set.
    pub base_url_set: bool,
    /// Whether the upstream key is set (its value is never exposed).
    pub key_set: bool,
}

impl ProxyState {
    /// Forward a request to `{base_url}{path}[?{query}]` verbatim and stream
    /// the upstream response back (JSON body, upstream status and
    /// content-type preserved). The upstream key is attached here, server-side.
    async fn forward(
        &self,
        method: reqwest::Method,
        path: &str,
        query: Option<&str>,
        body: Option<Bytes>,
    ) -> ApiResult<axum::response::Response> {
        if self.base_url.is_empty() {
            return Err(CanonicalError::internal(
                "spec-quality upstream not configured (set STUDIO_SPEC_QUALITY_BASE_URL / STUDIO_SPEC_QUALITY_API_KEY and restart)",
            )
            .create());
        }
        let Some(key) = self.api_key.as_deref() else {
            return Err(CanonicalError::internal(
                "spec-quality upstream key is not configured (set STUDIO_SPEC_QUALITY_API_KEY and restart)",
            )
            .create());
        };

        let url = match query {
            Some(q) if !q.is_empty() => format!("{}{}?{}", self.base_url, path, q),
            _ => format!("{}{}", self.base_url, path),
        };
        let mut req = self
            .client
            .request(method, url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"));
        if let Some(bytes) = body {
            req = req
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(bytes);
        }
        let upstream = req.send().await.map_err(|e| {
            CanonicalError::internal(format!("spec-quality upstream request failed: {e}")).create()
        })?;

        let mut builder = axum::response::Response::builder().status(upstream.status().as_u16());
        if let Some(ct) = upstream.headers().get(reqwest::header::CONTENT_TYPE) {
            builder = builder.header(axum::http::header::CONTENT_TYPE, ct.as_bytes());
        }
        builder
            .body(Body::from_stream(upstream.bytes_stream()))
            .map_err(|e| {
                CanonicalError::internal(format!("proxy response build failed: {e}")).create()
            })
    }
}

/* ── Handlers ── */

// Each detector is a verbatim POST passthrough. Splitting them into four named
// routes (rather than one `{detector}` path param) keeps the OpenAPI browser
// honest about exactly which detectors the wrapper offers.

async fn analyze_bloat(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    state
        .forward(reqwest::Method::POST, "/v1/analyze/bloat", None, Some(body))
        .await
}

async fn analyze_purpose(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    state
        .forward(
            reqwest::Method::POST,
            "/v1/analyze/purpose",
            None,
            Some(body),
        )
        .await
}

async fn analyze_leak(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    state
        .forward(reqwest::Method::POST, "/v1/analyze/leak", None, Some(body))
        .await
}

async fn analyze_traceability(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    state
        .forward(
            reqwest::Method::POST,
            "/v1/analyze/traceability",
            None,
            Some(body),
        )
        .await
}

/// GET /spec-quality/v1/tasks/{task_id} — poll a submitted task.
async fn get_task(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    Path(task_id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    // task_id is opaque upstream; percent-encode nothing fancy — the upstream
    // ids are url-safe. Building the path directly keeps the forward verbatim.
    state
        .forward(
            reqwest::Method::GET,
            &format!("/v1/tasks/{task_id}"),
            None,
            None,
        )
        .await
}

/// GET /spec-quality/v1/tasks — list recent tasks (optional `?limit=`).
async fn list_tasks(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    RawQuery(query): RawQuery,
) -> ApiResult<impl IntoResponse> {
    state
        .forward(reqwest::Method::GET, "/v1/tasks", query.as_deref(), None)
        .await
}

/// GET /spec-quality/v1/health — upstream liveness (maps to `/healthz`).
/// Handy to confirm base URL + reachability without submitting work.
async fn health(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
) -> ApiResult<impl IntoResponse> {
    state
        .forward(reqwest::Method::GET, "/healthz", None, None)
        .await
}

/// GET /spec-quality/v1/status — is the wrapper wired? No secrets exposed.
async fn status(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
) -> ApiResult<JsonBody<SpecQualityStatusDto>> {
    let base_url_set = !state.base_url.is_empty();
    let key_set = state.api_key.is_some();
    Ok(Json(SpecQualityStatusDto {
        configured: base_url_set && key_set,
        base_url_set,
        key_set,
    }))
}

/* ── Routes ── */

/// Body-size ceiling for the submit endpoints. A bloat/traceability call ships
/// the WHOLE doc-set as one JSON body, which blows past axum's 2 MiB default
/// `Bytes` limit on any real set — lift it to a generous 64 MiB (the upstream
/// enforces its own limit; this just stops OUR gateway from 413-ing first).
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Shared prose for the four submit endpoints (they differ only in detector).
const SUBMIT_DESC: &str = "Verbatim passthrough to the external spec-quality service. The \
     service key is attached server-side; callers authenticate with their \
     Studio token. Returns the upstream 202 TaskCreated (task_id + poll URL); \
     poll GET /spec-quality/v1/tasks/{task_id}.";

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    state: Arc<ProxyState>,
) -> Router {
    // Four detector submit endpoints (POST → upstream 202 TaskCreated). Kept
    // as explicit chains (rather than a loop) because each `.handler()` yields
    // a distinct builder type — the same shape llm_proxy uses.
    router = OperationBuilder::post("/spec-quality/v1/analyze/bloat")
        .operation_id("spec_quality.analyze_bloat")
        .summary("Submit a bloat (cross-document duplication) analysis")
        .description(SUBMIT_DESC)
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .handler(analyze_bloat)
        .json_response(
            StatusCode::ACCEPTED,
            "Upstream TaskCreated (task_id, poll URL)",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/spec-quality/v1/analyze/purpose")
        .operation_id("spec_quality.analyze_purpose")
        .summary("Submit a purpose (section roles + purpose gate) analysis")
        .description(SUBMIT_DESC)
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .handler(analyze_purpose)
        .json_response(
            StatusCode::ACCEPTED,
            "Upstream TaskCreated (task_id, poll URL)",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/spec-quality/v1/analyze/leak")
        .operation_id("spec_quality.analyze_leak")
        .summary("Submit a leak (foreign-content verdict) analysis")
        .description(SUBMIT_DESC)
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .handler(analyze_leak)
        .json_response(
            StatusCode::ACCEPTED,
            "Upstream TaskCreated (task_id, poll URL)",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/spec-quality/v1/analyze/traceability")
        .operation_id("spec_quality.analyze_traceability")
        .summary("Submit a traceability (ID graph / drift) analysis")
        .description(SUBMIT_DESC)
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .handler(analyze_traceability)
        .json_response(
            StatusCode::ACCEPTED,
            "Upstream TaskCreated (task_id, poll URL)",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/spec-quality/v1/tasks/{task_id}")
        .operation_id("spec_quality.get_task")
        .summary("Poll a submitted spec-quality task")
        .description(
            "Verbatim passthrough of the upstream task view: status, timestamps, \
             the detector-specific result object, warnings and errors.",
        )
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("task_id", "Upstream task id (from the submit response)")
        .handler(get_task)
        .json_response(StatusCode::OK, "Upstream TaskView, passed through verbatim")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/spec-quality/v1/tasks")
        .operation_id("spec_quality.list_tasks")
        .summary("List recent spec-quality tasks")
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_tasks)
        .json_response(
            StatusCode::OK,
            "Upstream task list, passed through verbatim",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/spec-quality/v1/health")
        .operation_id("spec_quality.health")
        .summary("Upstream liveness (maps to the service's /healthz)")
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .handler(health)
        .json_response(StatusCode::OK, "Upstream health, passed through verbatim")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/spec-quality/v1/status")
        .operation_id("spec_quality.status")
        .summary("Whether the spec-quality wrapper is configured (no secrets)")
        .description(
            "Lets the portal decide whether to offer analysis without ever \
             seeing the upstream key.",
        )
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .handler(status)
        .json_response_with_schema::<SpecQualityStatusDto>(openapi, StatusCode::OK, "Wiring status")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    // Lift the body limit for this gear's routes (submit endpoints carry the
    // whole doc-set). Applied here, closest to the handlers, so it overrides
    // the gateway's smaller global default for spec-quality only.
    router
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(Extension(state))
}
