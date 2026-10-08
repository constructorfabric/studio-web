use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::DefaultBodyLimit;
use axum::http::HeaderMap;
use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;

use super::analyze_task::{ANALYZE_TASK_TYPE, AnalyzePayload};
use super::batch_task::{BATCH_TASK_TYPE, BatchItem, BatchPayload, MAX_ITEMS};

#[resource_error(gts_id!("cf.studio._.spec_quality.v1~"))]
pub struct SpecQualityError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// Where a forwarded request goes: `{base_url}{path}` plus the caller's query
/// string when there is one.
///
/// The caller's query is passed through as the caller wrote it, not re-encoded
/// — the upstream's `?limit=` and any filter it grows are its own vocabulary,
/// and a wrapper that parsed them would have to be taught each one. An empty
/// query string is the same as none: `GET /tasks?` and `GET /tasks` ask the
/// upstream the same question, and the trailing `?` only ever came from a
/// client that built the URL by concatenation.
fn upstream_url(base_url: &str, path: &str, query: Option<&str>) -> String {
    match query {
        Some(q) if !q.is_empty() => format!("{base_url}{path}?{q}"),
        _ => format!("{base_url}{path}"),
    }
}

/// Shared proxy state: one upstream, one server-held key.
pub struct ProxyState {
    pub client: reqwest::Client,
    pub base_url: String,
    /// None = key not configured; requests fail with a clear message instead
    /// of failing the whole backend boot.
    pub api_key: Option<String>,
    /// Resolved lazily for the task queue, so this gear keeps no opinion about
    /// gear init order (see [`ProxyState::queue`]).
    pub hub: Arc<ClientHub>,
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

/// What the upstream service can actually do, read from the service rather
/// than restated here.
///
/// The portal used to carry its own copy of the document-type list, as a
/// constant in the Spec Quality screen. It had drifted: the workspace offered
/// seven built-in types and the service accepts five, so `app_spec` and
/// `upstream_reqs` reached the upstream only to come back as
/// `422 Unprocessable Entity` — *"Input should be 'prd', 'design', 'adr',
/// 'feature' or 'decomposition'"*. A list that has to be kept equal to
/// somebody else's list by hand is a list that will disagree with it.
///
/// The built-in catalogue has since been narrowed to the five, so the drift
/// that prompted this is gone. Asking is still how it is known: a workspace
/// may define types of its own, and the service may learn or forget one
/// without telling us.
///
/// So it is asked for. The service is FastAPI and publishes `/openapi.json`;
/// both facts below are read out of that document, which is the same source
/// the 422 comes from.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecQualityCapabilitiesDto {
    /// Detector names the service exposes, from its `/v1/analyze/{name}` paths.
    pub detectors: Vec<String>,
    /// What `doc_type` accepts. Empty when the schema no longer declares it —
    /// an empty list means "unknown", and a caller should offer no constraint
    /// rather than invent one.
    pub doc_types: Vec<String>,
}

/// What a submit answers with now: the run that is watching the analysis.
///
/// `task_id` is the upstream service's own id, kept because it is what appears
/// in that service's logs and its own task list. Nothing in the portal needs
/// it: the run is the thing to follow.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AnalyzeEnqueuedDto {
    /// The `studio-tasks` run watching this analysis.
    pub run_id: String,
    /// The upstream detector service's task id.
    pub task_id: String,
    /// Which detector was submitted.
    pub detector: String,
    /// Always `queued` — the run has been recorded, not yet picked up.
    pub status: String,
    /// Where the run can be read, for a caller that cannot subscribe.
    pub poll: String,
}

impl ProxyState {
    /// The task queue, or a 503 that says why analyses cannot be accepted.
    fn queue(&self) -> ApiResult<Arc<dyn crate::tasks::TaskQueue>> {
        self.hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "spec-quality analyses are not available in this deployment                          (studio-tasks has no database configured)",
                    )
                    .create()
            })
    }

    /// One upstream call whose body we read rather than stream back.
    ///
    /// The passthrough [`Self::forward`] exists for the caller's own requests;
    /// this is for the two places the backend has to understand the answer —
    /// the submit, which yields the task id to watch, and the watcher's reads.
    pub(super) async fn upstream_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Bytes>,
    ) -> anyhow::Result<serde_json::Value> {
        if self.base_url.is_empty() {
            anyhow::bail!("spec-quality upstream not configured");
        }
        let key = self
            .api_key
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("spec-quality upstream key is not configured"))?;

        let mut req = self
            .client
            .request(method, upstream_url(&self.base_url, path, None))
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"));
        if let Some(bytes) = body {
            // The caller's bytes, unread: what a detector accepts is between
            // the caller and the upstream, and a wrapper that parsed the
            // payload would have to be taught each detector's schema.
            req = req
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(bytes);
        }
        let res = req.send().await?;
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("upstream answered {status}: {}", body.trim());
        }
        Ok(serde_json::from_str(&body).unwrap_or(serde_json::Value::Null))
    }

    /// Read one upstream analysis task.
    pub(super) async fn upstream_task(&self, task_id: &str) -> anyhow::Result<serde_json::Value> {
        self.upstream_json(reqwest::Method::GET, &format!("/v1/tasks/{task_id}"), None)
            .await
    }

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

        let mut req = self
            .client
            .request(method, upstream_url(&self.base_url, path, query))
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

    /// The same request as [`Self::forward`], read rather than streamed.
    ///
    /// Everything else in this gear hands the upstream's bytes through
    /// untouched, and that is the right default: the wrapper's job is the key,
    /// not the schema. This exists for the one route that has to UNDERSTAND the
    /// answer — a verdict is a judgement about the result, and a judgement
    /// cannot be made on a stream nobody parsed.
    async fn fetch_json(&self, path: &str) -> ApiResult<serde_json::Value> {
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
        let upstream = self
            .client
            .get(upstream_url(&self.base_url, path, None))
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
            .send()
            .await
            .map_err(|e| {
                CanonicalError::internal(format!("spec-quality upstream request failed: {e}"))
                    .create()
            })?;
        if !upstream.status().is_success() {
            return Err(CanonicalError::internal(format!(
                "spec-quality upstream answered {} for {path}",
                upstream.status()
            ))
            .create());
        }
        upstream.json::<serde_json::Value>().await.map_err(|e| {
            CanonicalError::internal(format!("spec-quality upstream sent unreadable JSON: {e}"))
                .create()
        })
    }
}

/* ── Handlers ── */

// Each detector submits to the upstream and then hands the wait to
// `studio-tasks`. Splitting them into four named routes (rather than one
// `{detector}` path param) keeps the OpenAPI browser honest about exactly which
// detectors the wrapper offers.

/// Submit one analysis upstream and record a run to watch it.
///
/// The submit happens here, synchronously, because its failures are the
/// caller's to see now: an unconfigured upstream, a payload the detector
/// refuses. What takes minutes — waiting for the verdict — is the run's, and
/// the caller learns about it on `studio-events` like every other background
/// run in the assembly.
async fn enqueue_analysis(
    ctx: &SecurityContext,
    state: &Arc<ProxyState>,
    detector: &str,
    headers: &HeaderMap,
    body: Bytes,
) -> ApiResult<(StatusCode, JsonBody<AnalyzeEnqueuedDto>)> {
    let request_key = crate::idempotency::key(headers)?;
    // Resolved before the submit: accepting an analysis we then cannot watch
    // would leave the caller holding an id nothing in the portal can follow.
    let queue = state.queue()?;

    let created = state
        .upstream_json(
            reqwest::Method::POST,
            &format!("/v1/analyze/{detector}"),
            Some(body),
        )
        .await
        .map_err(|e| {
            CanonicalError::internal(format!("spec-quality submit failed: {e:#}")).create()
        })?;

    let upstream_task_id = created
        .get("task_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            CanonicalError::internal(format!(
                "spec-quality upstream accepted the analysis without a task_id: {created}"
            ))
            .create()
        })?
        .to_owned();

    let run_payload = serde_json::to_value(AnalyzePayload {
        detector: detector.to_owned(),
        upstream_task_id: upstream_task_id.clone(),
    })
    .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    let tenant = ctx.subject_tenant_id();
    let run_id = queue
        .enqueue(
            ctx,
            crate::tasks::sdk::NewRun {
                tenant,
                task_type: ANALYZE_TASK_TYPE,
                payload: run_payload,
                // No partition: analyses are independent of each other, and
                // serialising them would turn a document fan-out into a queue.
                partition_key: None,
                // The caller's `Idempotency-Key` when it sent one, so a retry
                // answers the run it already started. Otherwise the upstream
                // task id is the natural key — a resubmit that somehow
                // produced the same one is the same analysis.
                idempotency_key: Some(request_key.as_deref().unwrap_or(&upstream_task_id)),
                coalesce_queued: false,
                notify_workspace_id: None,
            },
        )
        .await
        .map_err(|e| {
            CanonicalError::internal(format!("analysis accepted upstream but not queued: {e:#}"))
                .create()
        })?;

    Ok((
        StatusCode::ACCEPTED,
        Json(AnalyzeEnqueuedDto {
            run_id: run_id.to_string(),
            task_id: upstream_task_id,
            detector: detector.to_owned(),
            status: "queued".to_owned(),
            poll: format!("/studio-tasks/v1/runs/{run_id}"),
        }),
    ))
}

/// One document in a sweep, as the caller sends it.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct BatchItemDto {
    /// The caller's own id for this document — a graph node id, a path.
    /// Echoed back in the result untouched, so results can be joined up.
    pub id: String,
    /// The body the detector expects for this document.
    pub payload: serde_json::Value,
}

/// Run one detector over a set of documents.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct AnalyzeBatchRequest {
    /// `bloat` | `purpose` | `leak` | `traceability`.
    pub detector: String,
    pub items: Vec<BatchItemDto>,
}

/// Acknowledgement of a sweep.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AnalyzeBatchEnqueuedDto {
    /// The `studio-tasks` run doing the sweep.
    pub run_id: String,
    /// How many documents it will analyse.
    pub count: usize,
    pub detector: String,
    pub status: String,
    /// Where the run can be read, for a caller that cannot subscribe.
    pub poll: String,
}

/// POST /studio-spec-quality/v1/analyze-batch — one detector over many documents.
///
/// The sweep used to be a loop in the caller: submit, wait, submit the next.
/// It is one run now. What a verdict MEANS is still the caller's — the run
/// reports which analyses finished and names the upstream task holding each
/// verdict, and the caller reads the ones it cares about.
async fn analyze_batch(
    Extension(ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    headers: HeaderMap,
    Json(req): Json<AnalyzeBatchRequest>,
) -> ApiResult<(StatusCode, JsonBody<AnalyzeBatchEnqueuedDto>)> {
    let request_key = crate::idempotency::key(&headers)?;
    let queue = state.queue()?;

    let detector = req.detector.trim().to_owned();
    if !matches!(
        detector.as_str(),
        "bloat" | "purpose" | "leak" | "traceability"
    ) {
        return Err(CanonicalError::internal(format!(
            "unknown detector '{detector}' (expected bloat|purpose|leak|traceability)"
        ))
        .create());
    }
    if req.items.len() > MAX_ITEMS {
        return Err(CanonicalError::internal(format!(
            "a sweep takes at most {MAX_ITEMS} documents, and this one has {} —              split it, or the run is one nobody will wait for",
            req.items.len()
        ))
        .create());
    }

    let count = req.items.len();
    let run_payload = serde_json::to_value(BatchPayload {
        detector: detector.clone(),
        items: req
            .items
            .into_iter()
            .map(|i| BatchItem {
                id: i.id,
                payload: i.payload,
            })
            .collect(),
        // A caller of this route names its own items and reads its own verdicts.
        record: None,
    })
    .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    let run_id = queue
        .enqueue(
            &ctx,
            crate::tasks::sdk::NewRun {
                tenant: ctx.subject_tenant_id(),
                task_type: BATCH_TASK_TYPE,
                payload: run_payload,
                // One sweep at a time per detector: they compete for the same
                // upstream, and two at once only makes both slower.
                partition_key: Some(&detector),
                idempotency_key: request_key.as_deref(),
                coalesce_queued: false,
                notify_workspace_id: None,
            },
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("sweep not queued: {e:#}")).create())?;

    Ok((
        StatusCode::ACCEPTED,
        Json(AnalyzeBatchEnqueuedDto {
            run_id: run_id.to_string(),
            count,
            detector,
            status: "queued".to_owned(),
            poll: format!("/studio-tasks/v1/runs/{run_id}"),
        }),
    ))
}

async fn analyze_bloat(
    Extension(ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<(StatusCode, JsonBody<AnalyzeEnqueuedDto>)> {
    enqueue_analysis(&ctx, &state, "bloat", &headers, body).await
}

async fn analyze_purpose(
    Extension(ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<(StatusCode, JsonBody<AnalyzeEnqueuedDto>)> {
    enqueue_analysis(&ctx, &state, "purpose", &headers, body).await
}

async fn analyze_leak(
    Extension(ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<(StatusCode, JsonBody<AnalyzeEnqueuedDto>)> {
    enqueue_analysis(&ctx, &state, "leak", &headers, body).await
}

async fn analyze_traceability(
    Extension(ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<(StatusCode, JsonBody<AnalyzeEnqueuedDto>)> {
    enqueue_analysis(&ctx, &state, "traceability", &headers, body).await
}

/// One analysis, read rather than relayed.
///
/// Every field is optional because a verdict's shape follows its detector, and
/// one response type keeps the portal from learning four. What is NOT optional
/// is the reading: the fields below are the judgements in
/// [`super::verdict`], made here so that two portals cannot make them
/// differently.
#[derive(Debug, Default)]
#[toolkit_macros::api_dto(response)]
pub struct VerdictDto {
    /// The detector this verdict came from.
    pub detector: String,
    /// The upstream task it was read from.
    pub task_id: String,
    /// `purpose`: the document type the detector named, if it named one.
    pub doc_type: Option<String>,
    /// `purpose`: how much of the document read as specification content,
    /// 0.0–1.0. The evidence for `doc_type`, and the reason it is reported
    /// beside it rather than alone.
    pub spec_share: Option<f64>,
    /// `purpose`: whether the gate passed. Null when the service answered
    /// without one — which keeps a gate shut rather than guessing.
    pub gate_passed: Option<bool>,
    /// `purpose`: what the document is made of, role to share. Reported
    /// because `spec_share` is one number out of it and a reader comparing
    /// documents wants the rest — and because a SET's mixture is these,
    /// weighted, which nobody can work out from the single number.
    pub mixture: Option<std::collections::BTreeMap<String, f64>>,
    /// `purpose`: how long the document was, in the detector's own tokens.
    /// The weight a set-wide mixture uses, so it travels with the mixture.
    pub n_tokens: Option<f64>,
    /// `purpose`: how many sections the detector split it into.
    pub n_sections: Option<u32>,
    /// `leak`: whether the foreign share stayed under the threshold.
    pub passed: Option<bool>,
    /// `leak`: how much of the document read as belonging to another kind.
    pub leak_share: Option<f64>,
    /// `leak`: the kinds it read as.
    pub foreign_roles: Option<Vec<String>>,
    /// `bloat` and `traceability`: each document asked about, mapped to the
    /// documents it shares text with, or references.
    pub by_path: Option<std::collections::BTreeMap<String, Vec<String>>>,
    /// The same relation as pairs, for a graph.
    pub pairs: Option<Vec<Vec<String>>>,
    /// `traceability`: false when the result carried no edge key this reader
    /// knows. An empty answer then means unreadable, not "nothing found".
    pub recognised: Option<bool>,
    /// What the detector found, each placed in the text it analysed. Empty
    /// for `traceability`, which places nothing, and for a clean document.
    /// See [`super::findings`].
    pub findings: Vec<FindingDto>,
}

/// Where in the analysed text a finding is. Each field is present only when
/// the detector gave it: `purpose` and `leak` place by section and lines,
/// `bloat` by lines and the passage itself. No character offsets: the ones
/// `bloat` reports do not match the text it analysed (see
/// [`super::findings::Anchor`]), while its lines do.
#[derive(Debug, Default)]
#[toolkit_macros::api_dto(response)]
pub struct FindingAnchorDto {
    /// The section as the detector named it.
    pub section: Option<String>,
    /// 1-based, inclusive. For a `purpose` or `leak` section, its body; the
    /// heading is just above.
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
    /// The passage, reflowed onto one line by the service. Find it in the
    /// lines above with whitespace collapsed; it is also what to look for when
    /// the document has changed since the analysis.
    pub quote: Option<String>,
}

/// Another place a finding is about: the other copy of a duplicated passage.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct FindingRelatedDto {
    pub path: String,
    pub anchor: FindingAnchorDto,
}

/// One thing a detector found.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct FindingDto {
    /// Stable across re-runs: a hash of the rule, the document, the section
    /// and the passage, never of line numbers, so a finding keeps its id when
    /// text is added above it.
    pub id: String,
    /// `purpose.foreign_section` | `purpose.not_a_spec` |
    /// `leak.foreign_content` | `bloat.cross_document` | `bloat.self_repeat`.
    pub rule: String,
    /// The document, as the run named it. Absent when the detector did not
    /// echo one; it is then the document the analysis was of.
    pub path: Option<String>,
    /// `high` | `medium` | `low`.
    pub severity: String,
    /// The detector's own reason where it gave one.
    pub message: String,
    /// Absent when the finding is about the document as a whole.
    pub anchor: Option<FindingAnchorDto>,
    pub related: Vec<FindingRelatedDto>,
    /// The detector's evidence, verbatim.
    pub evidence: Vec<String>,
    /// 0.0–1.0, when the detector reported one.
    pub confidence: Option<f64>,
}

fn anchor_dto(a: super::findings::Anchor) -> FindingAnchorDto {
    FindingAnchorDto {
        section: a.section,
        line_start: a.line_start,
        line_end: a.line_end,
        quote: a.quote,
    }
}

pub(super) fn finding_dto(f: super::findings::Finding) -> FindingDto {
    FindingDto {
        id: f.id,
        rule: f.rule.to_owned(),
        path: f.path,
        severity: f.severity.as_str().to_owned(),
        message: f.message,
        anchor: f.anchor.map(anchor_dto),
        related: f
            .related
            .into_iter()
            .map(|r| FindingRelatedDto {
                path: r.path,
                anchor: anchor_dto(r.anchor),
            })
            .collect(),
        evidence: f.evidence,
        confidence: f.confidence,
    }
}

/// Which detector's answer is being read.
///
/// An enum rather than a string so an unknown name is refused where the
/// request is parsed, with the four that exist named in the message — rather
/// than reaching a match arm that has to invent an error for it.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Detector {
    Purpose,
    Leak,
    Bloat,
    Traceability,
}

impl Detector {
    fn as_str(self) -> &'static str {
        match self {
            Detector::Purpose => "purpose",
            Detector::Leak => "leak",
            Detector::Bloat => "bloat",
            Detector::Traceability => "traceability",
        }
    }
}

/// `?task_id=` names the analysis; `?path=` repeats for the set detectors.
#[derive(Debug)]
pub struct VerdictQuery {
    pub task_id: String,
    pub detector: Detector,
    /// The documents the run was given. Required by `bloat` and
    /// `traceability`, which answer about a set: a document absent from this
    /// list is absent from the answer, and absent reads as "not analysed"
    /// where an empty list reads as "analysed, nothing found".
    pub path: Vec<String>,
}

impl VerdictQuery {
    /// Read from the query's pairs, in order.
    ///
    /// Not `#[derive(Deserialize)]` behind `Query<VerdictQuery>`: axum's
    /// `Query` is `serde_urlencoded`, which cannot read a repeated key into a
    /// `Vec`. It refused `?path=` with a bare 400 even with ONE path, so every
    /// `bloat` and `traceability` verdict failed for both portals, which send
    /// exactly that. A list of pairs is something it can read.
    fn from_pairs(pairs: Vec<(String, String)>) -> Result<Self, String> {
        let mut task_id = None;
        let mut detector = None;
        let mut path = Vec::new();
        for (key, value) in pairs {
            match key.as_str() {
                "task_id" => task_id = Some(value),
                "detector" => {
                    detector = Some(
                        serde_json::from_value::<Detector>(serde_json::Value::String(value))
                            .map_err(|_| {
                                "detector must be one of purpose, leak, bloat, traceability"
                                    .to_owned()
                            })?,
                    );
                }
                "path" => path.push(value),
                _ => {}
            }
        }
        Ok(Self {
            task_id: task_id
                .filter(|t| !t.trim().is_empty())
                .ok_or("task_id is required")?,
            detector: detector.ok_or("detector is required")?,
            path,
        })
    }
}

fn pairs_of(pairs: Vec<(String, String)>) -> Vec<Vec<String>> {
    pairs.into_iter().map(|(a, b)| vec![a, b]).collect()
}

/// GET /studio-spec-quality/v1/verdicts — one analysis, interpreted.
async fn get_verdict(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
    axum::extract::Query(pairs): axum::extract::Query<Vec<(String, String)>>,
) -> ApiResult<JsonBody<VerdictDto>> {
    let query = VerdictQuery::from_pairs(pairs).map_err(|why| {
        SpecQualityError::invalid_argument()
            .with_constraint(why)
            .create()
    })?;
    let view = state
        .fetch_json(&format!("/v1/tasks/{}", query.task_id))
        .await?;
    let result = view.get("result");
    let mut dto = VerdictDto {
        detector: query.detector.as_str().to_owned(),
        task_id: query.task_id.clone(),
        ..VerdictDto::default()
    };
    match query.detector {
        Detector::Purpose => {
            let v = super::verdict::doc_type(result);
            dto.doc_type = v.doc_type;
            dto.spec_share = Some(v.spec_share);
            dto.gate_passed = v.gate_passed;
            dto.mixture = result
                .and_then(|r| r.get("mixture"))
                .and_then(serde_json::Value::as_object)
                .map(|m| {
                    m.iter()
                        .filter_map(|(role, share)| {
                            Some((role.clone(), share.as_f64().filter(|s| s.is_finite())?))
                        })
                        .collect()
                });
            dto.n_tokens = result
                .and_then(|r| r.get("n_tokens"))
                .and_then(serde_json::Value::as_f64);
            dto.n_sections = result
                .and_then(|r| r.get("n_sections"))
                .and_then(serde_json::Value::as_u64)
                .and_then(|n| u32::try_from(n).ok());
            dto.findings = super::findings::purpose(result)
                .into_iter()
                .map(finding_dto)
                .collect();
        }
        Detector::Leak => {
            let v = super::verdict::leak(result);
            dto.passed = v.passed;
            dto.leak_share = v.leak_share;
            dto.foreign_roles = Some(v.foreign_roles);
            dto.findings = super::findings::leak(result)
                .into_iter()
                .map(finding_dto)
                .collect();
        }
        Detector::Bloat => {
            let v = super::verdict::bloat(result, &query.path);
            dto.by_path = Some(v.by_path);
            dto.pairs = Some(pairs_of(v.pairs));
            dto.findings = super::findings::bloat(result, &query.path)
                .into_iter()
                .map(finding_dto)
                .collect();
        }
        Detector::Traceability => {
            let v = super::verdict::trace(result, &query.path);
            dto.by_path = Some(v.by_path);
            dto.pairs = Some(pairs_of(v.pairs));
            dto.recognised = Some(v.recognised);
        }
    }
    Ok(Json(dto))
}

/// GET /studio-spec-quality/v1/health — upstream liveness (maps to `/healthz`).
/// Handy to confirm base URL + reachability without submitting work.
async fn health(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
) -> ApiResult<impl IntoResponse> {
    state
        .forward(reqwest::Method::GET, "/healthz", None, None)
        .await
}

/// GET /studio-spec-quality/v1/status — is the wrapper wired? No secrets exposed.
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

/// GET /studio-spec-quality/v1/capabilities — what the upstream declares about itself.
///
/// Deliberately not cached. The document is ~11 KB, it is fetched when a screen
/// opens, and a cache would have to answer "for how long is a stale vocabulary
/// better than a request?" — the answer being "never", since serving a doc type
/// the service has dropped produces a 422 the user cannot act on.
async fn capabilities(
    Extension(_ctx): Extension<SecurityContext>,
    Extension(state): Extension<Arc<ProxyState>>,
) -> ApiResult<JsonBody<SpecQualityCapabilitiesDto>> {
    let schema = state
        .upstream_json(reqwest::Method::GET, "/openapi.json", None)
        .await
        .map_err(|e| {
            CanonicalError::internal(format!("spec-quality capabilities unavailable: {e}")).create()
        })?;

    Ok(Json(read_capabilities(&schema)))
}

/// What the upstream will accept as a `doc_type`, or `None` when it does not
/// say.
///
/// `None` and "an empty list" mean the same thing here and both mean *unknown*:
/// a service that stopped declaring the enum has not stopped having one, so a
/// caller must offer no constraint rather than conclude it accepts nothing.
/// A failure to reach the service is the same answer — the submit itself will
/// fail in a moment and say so properly.
pub(super) async fn accepted_doc_types(state: &ProxyState) -> Option<Vec<String>> {
    let schema = state
        .upstream_json(reqwest::Method::GET, "/openapi.json", None)
        .await
        .ok()?;
    let types = read_capabilities(&schema).doc_types;
    (!types.is_empty()).then_some(types)
}

/// Pull the two vocabularies out of an OpenAPI document.
///
/// Separate from the handler so it can be tested against the real schema
/// rather than against a live service: what breaks here is a shape change
/// upstream, and a shape change is exactly what a fixture catches and a
/// smoke test does not.
fn read_capabilities(schema: &serde_json::Value) -> SpecQualityCapabilitiesDto {
    // Detectors are the `/v1/analyze/<name>` paths. Read from the paths rather
    // than from a list of our own, for the same reason as the types below.
    let mut detectors: Vec<String> = schema
        .get("paths")
        .and_then(|p| p.as_object())
        .map(|paths| {
            paths
                .keys()
                .filter_map(|p| p.strip_prefix("/v1/analyze/"))
                .filter(|name| !name.is_empty() && !name.contains('/'))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    detectors.sort();

    // `doc_type` is declared on the request schemas as an `anyOf` of a string
    // enum and null — it is optional. Walk every schema and take the first
    // enum found: the service declares the same set on each request type that
    // has one, and copies that disagreed would be its bug to fix rather than
    // ours to reconcile.
    let doc_types = schema
        .get("components")
        .and_then(|c| c.get("schemas"))
        .and_then(|s| s.as_object())
        .and_then(|schemas| {
            schemas.values().find_map(|s| {
                let any_of = s
                    .get("properties")?
                    .get("doc_type")?
                    .get("anyOf")?
                    .as_array()?;
                any_of.iter().find_map(|variant| {
                    let values = variant.get("enum")?.as_array()?;
                    let list: Vec<String> = values
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect();
                    (!list.is_empty()).then_some(list)
                })
            })
        })
        .unwrap_or_default();

    SpecQualityCapabilitiesDto {
        detectors,
        doc_types,
    }
}

#[cfg(test)]
mod capability_tests {
    use super::read_capabilities;

    /// The real document, fetched from the running service on 2026-09-17.
    /// Trimmed to the parts this reads, and kept verbatim otherwise — a
    /// hand-written approximation would pass while the real shape drifted.
    const SCHEMA: &str = r#"{
      "paths": {
        "/healthz": {"get": {}},
        "/v1/analyze/bloat": {"post": {}},
        "/v1/analyze/leak": {"post": {}},
        "/v1/analyze/purpose": {"post": {}},
        "/v1/analyze/traceability": {"post": {}},
        "/v1/tasks": {"get": {}},
        "/v1/tasks/{task_id}": {"get": {}}
      },
      "components": {"schemas": {
        "BloatRequest": {"properties": {"docs": {"type": "array"}}},
        "PurposeRequest": {"properties": {"doc_type": {"anyOf": [
          {"type": "string", "enum": ["prd","design","adr","feature","decomposition"]},
          {"type": "null"}
        ], "title": "Doc Type"}}}
      }}
    }"#;

    #[test]
    fn detectors_come_from_the_analyze_paths_and_nothing_else() {
        let caps = read_capabilities(&serde_json::from_str(SCHEMA).unwrap());
        // /healthz and /v1/tasks are paths too, and are not detectors.
        assert_eq!(
            caps.detectors,
            vec!["bloat", "leak", "purpose", "traceability"]
        );
    }

    #[test]
    fn doc_types_come_from_the_enum_beside_the_null_variant() {
        let caps = read_capabilities(&serde_json::from_str(SCHEMA).unwrap());
        assert_eq!(
            caps.doc_types,
            vec!["prd", "design", "adr", "feature", "decomposition"]
        );
    }

    #[test]
    fn a_schema_without_the_vocabulary_reports_nothing_rather_than_guessing() {
        // Upstream drops or renames `doc_type`: the portal must offer no
        // constraint, not a stale list it invented. Empty means "unknown".
        let caps = read_capabilities(&serde_json::json!({"paths": {}, "components": {}}));
        assert!(caps.doc_types.is_empty());
        assert!(caps.detectors.is_empty());
    }

    #[test]
    fn a_doc_type_that_is_a_bare_enum_is_still_read() {
        // The optionality is the service's choice, not ours to depend on.
        let caps = read_capabilities(&serde_json::json!({
            "components": {"schemas": {"R": {"properties": {"doc_type": {
                "anyOf": [{"enum": ["prd"]}]
            }}}}}
        }));
        assert_eq!(caps.doc_types, vec!["prd"]);
    }
}

/* ── Routes ── */

/// Body-size ceiling for the submit endpoints. A bloat/traceability call ships
/// the WHOLE doc-set as one JSON body, which blows past axum's 2 MiB default
/// `Bytes` limit on any real set — lift it to a generous 64 MiB (the upstream
/// enforces its own limit; this just stops OUR gateway from 413-ing first).
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Shared prose for the four submit endpoints (they differ only in detector).
const SUBMIT_DESC: &str = "Submits the analysis to the external spec-quality service and \
     records a studio-tasks run that watches it to completion. The service key is \
     attached server-side; callers authenticate with their Studio token. Returns the \
     run id with 202: follow it on studio-events (subject_type task_run), or read \
     GET /studio-tasks/v1/runs/{run_id}. Send an Idempotency-Key header to make a retry \
     safe: a repeat with the same key answers the same run (the upstream analysis is \
     submitted again, and only the first one is watched).";

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    state: Arc<ProxyState>,
) -> Router {
    // Four detector submit endpoints (POST → upstream 202 TaskCreated). Kept
    // as explicit chains (rather than a loop) because each `.handler()` yields
    // a distinct builder type — the same shape llm_proxy uses.
    router = OperationBuilder::post("/studio-spec-quality/v1/analyze/bloat")
        .operation_id("studio_spec_quality.analyze_bloat")
        .summary("Submit a bloat (cross-document duplication) analysis")
        .description(SUBMIT_DESC)
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .param(crate::idempotency::param())
        .handler(analyze_bloat)
        .json_response(StatusCode::ACCEPTED, "The run watching this analysis")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-spec-quality/v1/analyze-batch")
        .operation_id("studio_spec_quality.analyze_batch")
        .summary("Run one detector over a set of documents, as a single run")
        .description(
            "Replaces a submit-and-wait loop in the caller. Records one              studio-tasks run that analyses each document in turn; follow it on              studio-events (subject_type task_run). The run's result names each              document's upstream task rather than carrying the verdicts              themselves — read those with GET /studio-spec-quality/v1/verdicts?task_id=….              Answers 202 with the run_id; send an Idempotency-Key header to make a retry              safe, since a repeat with the same key answers the same run.",
        )
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .param(crate::idempotency::param())
        .handler(analyze_batch)
        .json_response(StatusCode::ACCEPTED, "The run doing the sweep")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-spec-quality/v1/analyze/purpose")
        .operation_id("studio_spec_quality.analyze_purpose")
        .summary("Submit a purpose (section roles + purpose gate) analysis")
        .description(SUBMIT_DESC)
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .param(crate::idempotency::param())
        .handler(analyze_purpose)
        .json_response(StatusCode::ACCEPTED, "The run watching this analysis")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-spec-quality/v1/analyze/leak")
        .operation_id("studio_spec_quality.analyze_leak")
        .summary("Submit a leak (foreign-content verdict) analysis")
        .description(SUBMIT_DESC)
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .param(crate::idempotency::param())
        .handler(analyze_leak)
        .json_response(StatusCode::ACCEPTED, "The run watching this analysis")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-spec-quality/v1/analyze/traceability")
        .operation_id("studio_spec_quality.analyze_traceability")
        .summary("Submit a traceability (ID graph / drift) analysis")
        .description(SUBMIT_DESC)
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .param(crate::idempotency::param())
        .handler(analyze_traceability)
        .json_response(StatusCode::ACCEPTED, "The run watching this analysis")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-spec-quality/v1/verdicts")
        .operation_id("studio_spec_quality.get_verdict")
        .summary("One analysis, read rather than relayed")
        .description(
            "The upstream task a submit named, turned into a verdict. Every other              route here hands the upstream's bytes through untouched, which is right: the              wrapper's job is the key, not the schema. This one is different because reading a              detector's answer is a JUDGEMENT, and it was being made in the browser.

             The service does not document these shapes — its OpenAPI declares the four              request bodies and nothing else — so every key is read defensively and the              judgements are the product: a doc type is reported with the share of the document              that was recognised as specification at all, an absent boolean stays null rather              than becoming false, only duplication ACROSS documents counts as bloat, and              `recognised` separates a shape this reader did not understand from a document set              that genuinely references nothing.

             `?path=` repeats for the set detectors (`bloat`, `traceability`): a document              absent from it is absent from the answer, and absent reads as not analysed where              an empty list reads as analysed and nothing found.

             `findings` lists what the detector found, each placed in the analysed text: a              `purpose` gate violation by section and lines with its reason and evidence, a              `leak` by section and lines, a duplicated `bloat` passage by lines and the passage itself, with every              other copy as `related`. A finding's `id` hashes the rule, document, section and              passage and never the line numbers, so it is stable across re-runs and edits              elsewhere in the document.",
        )
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .handler(get_verdict)
        .json_response_with_schema::<VerdictDto>(openapi, StatusCode::OK, "The verdict")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-spec-quality/v1/health")
        .operation_id("studio_spec_quality.health")
        .summary("Upstream liveness (maps to the service's /healthz)")
        .description(
            "Reports whether the upstream detector service is answering; maps to \
             its `/healthz`. A 200 here says the wrapper reached it, not that a \
             detector will succeed.",
        )
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .handler(health)
        .json_response(StatusCode::OK, "Upstream health, passed through verbatim")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-spec-quality/v1/status")
        .operation_id("studio_spec_quality.status")
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

    router = OperationBuilder::get("/studio-spec-quality/v1/capabilities")
        .operation_id("studio_spec_quality.get_capabilities")
        .summary("Detectors and document types the upstream service declares")
        .description(
            "Read from the service's own OpenAPI document, so the portal does \
             not keep a second copy of a vocabulary it does not own. The copy \
             it used to keep had drifted: two of the workspace's built-in \
             document types were rejected by the upstream with a 422.",
        )
        .tag("SpecQuality")
        .authenticated()
        .require_license_features::<License>([])
        .handler(capabilities)
        .json_response_with_schema::<SpecQualityCapabilitiesDto>(
            openapi,
            StatusCode::OK,
            "What the upstream declares",
        )
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

#[cfg(test)]
mod tests {
    //! Where a forwarded request lands.
    //!
    //! This wrapper's whole job is to put the Studio gateway and a server-held
    //! key in front of somebody else's API, so the only thing it can get wrong
    //! on its own is the address.

    use super::upstream_url;

    const BASE: &str = "https://spec-quality.example";

    #[test]
    fn a_path_is_appended_to_the_base() {
        assert_eq!(
            upstream_url(BASE, "/v1/analyze/bloat", None),
            "https://spec-quality.example/v1/analyze/bloat"
        );
    }

    #[test]
    fn a_query_is_carried_through_as_written() {
        assert_eq!(
            upstream_url(BASE, "/v1/tasks", Some("limit=20")),
            "https://spec-quality.example/v1/tasks?limit=20"
        );
        // Several parameters, and a value the wrapper has no opinion about.
        assert_eq!(
            upstream_url(BASE, "/v1/tasks", Some("limit=20&state=failed")),
            "https://spec-quality.example/v1/tasks?limit=20&state=failed"
        );
    }

    /// A client that builds its URL by concatenation sends `?` with nothing
    /// after it. That is not a query, and forwarding it as one would put a
    /// bare `?` in front of the upstream for no reason.
    #[test]
    fn an_empty_query_is_the_same_as_none() {
        assert_eq!(
            upstream_url(BASE, "/v1/tasks", Some("")),
            upstream_url(BASE, "/v1/tasks", None)
        );
    }

    /// The config trims the trailing slash so this concatenation is safe. If
    /// that ever stops being true the doubled slash shows up here rather than
    /// as a 404 from somebody else's server.
    #[test]
    fn a_trimmed_base_and_a_rooted_path_join_with_one_slash() {
        let joined = upstream_url(BASE, "/healthz", None);
        assert_eq!(joined, "https://spec-quality.example/healthz");
        assert!(!joined.contains("//healthz"));
    }
}

#[cfg(test)]
mod verdict_query_tests {
    //! The verdict's query, read the way axum hands it over.

    use super::{Detector, VerdictQuery};

    /// What `axum::extract::Query<Vec<(String, String)>>` makes of a query:
    /// its pairs, decoded, in order. Only `%2F` occurs in these.
    fn pairs(query: &str) -> Vec<(String, String)> {
        query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .map(|(k, v)| (k.to_owned(), v.replace("%2F", "/")))
            .collect()
    }

    /// The regression: both portals send `?path=` once per document, and a
    /// derived `Query<VerdictQuery>` refused that with a bare 400.
    #[test]
    fn a_repeated_path_is_read_as_the_set_in_order() {
        let q = VerdictQuery::from_pairs(pairs(
            "task_id=t_1&detector=bloat&path=docs%2Fa.md&path=docs%2Fb.md",
        ))
        .expect("readable");
        assert_eq!(q.task_id, "t_1");
        assert!(matches!(q.detector, Detector::Bloat));
        assert_eq!(q.path, vec!["docs/a.md", "docs/b.md"]);
    }

    #[test]
    fn a_document_detector_needs_no_path() {
        let q = VerdictQuery::from_pairs(pairs("detector=purpose&task_id=t_2")).expect("readable");
        assert!(q.path.is_empty());
    }

    #[test]
    fn a_missing_task_or_an_unknown_detector_is_refused_with_the_reason() {
        assert_eq!(
            VerdictQuery::from_pairs(pairs("detector=purpose")).unwrap_err(),
            "task_id is required"
        );
        assert!(
            VerdictQuery::from_pairs(pairs("task_id=t&detector=spelling"))
                .unwrap_err()
                .contains("purpose, leak, bloat, traceability")
        );
    }
}
