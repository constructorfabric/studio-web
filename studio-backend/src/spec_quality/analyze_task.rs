//! `spec_quality.analyze` — one detector analysis, watched from the backend.
//!
//! The upstream detector service is asynchronous: a submit answers 202 with a
//! task id, and the result arrives only to whoever asks for it again. That
//! second half used to be the browser's job — a `setTimeout` loop per analysis,
//! one per document on a fan-out — which made every long operation a thing the
//! portal had to stay open for, and gave the assembly no record that the work
//! had ever happened.
//!
//! Here the wait is a run like any other: `studio-tasks` owns it, every
//! transition is announced on `studio-events`, and the portal subscribes to
//! `task_run` the way it already does for imports and syncs. The browser's part
//! is a POST and a subscription.
//!
//! The submit stays in the REST handler on purpose. It is fast, its failures
//! are the caller's to see immediately (a malformed payload, an unconfigured
//! upstream), and keeping it out of the handler means a retried attempt
//! re-reads the upstream task rather than submitting a second analysis.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tracing::warn;

use super::rest::ProxyState;
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Stable task type. Stored on every run and every queue payload — renaming it
/// orphans whatever is already queued.
pub const ANALYZE_TASK_TYPE: &str = "spec_quality.analyze";

/// How long one analysis may stay unfinished before the attempt gives up.
///
/// Generous, because the expensive detectors are LLM round-trips over a whole
/// document set: the browser's own loop allowed three minutes and the timeout
/// it produced was the common complaint. Giving up is not the end of the
/// analysis — the attempt is retried, and the upstream task is still there to
/// be re-read.
const ATTEMPT_DEADLINE: Duration = Duration::from_secs(10 * 60);

/// How often the upstream task is re-read.
///
/// Two seconds rather than the browser's 1.2: nothing is watching a spinner
/// here, and a detector that finishes between two reads is reported on the next
/// one regardless.
const POLL_EVERY: Duration = Duration::from_secs(2);

/// What the run carries: which detector, and the upstream task the submit
/// already created.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzePayload {
    /// `bloat` | `purpose` | `leak` | `traceability`.
    pub detector: String,
    /// The upstream service's own task id. Opaque to us.
    pub upstream_task_id: String,
}

/// How watching one upstream task ended.
pub(super) enum Watched {
    /// The detector answered. Carries whatever `result` it returned.
    Succeeded(Option<serde_json::Value>),
    /// The detector refused or broke, with its own message.
    Failed(String),
    /// We lost sight of the upstream. The task itself is unaffected.
    Unreachable(String),
    /// Still unfinished when the attempt ran out of time.
    Deadline(String),
    /// Somebody asked this run to stop.
    Cancelled,
}

/// Watch one upstream analysis to its terminal state.
///
/// Shared by the single-analysis handler and the batch one, because two copies
/// of "what counts as finished" is exactly the drift this gear cannot afford:
/// the batch would keep reporting verdicts the single path had stopped
/// accepting.
pub(super) async fn watch_upstream(
    state: &ProxyState,
    ctx: &TaskContext,
    upstream_task_id: &str,
    deadline: Duration,
    mut on_phase: impl FnMut(&str),
) -> Watched {
    let started = Instant::now();
    let mut last_phase = String::new();

    loop {
        if ctx.cancelled() {
            return Watched::Cancelled;
        }

        let view = match state.upstream_task(upstream_task_id).await {
            Ok(view) => view,
            Err(e) => return Watched::Unreachable(format!("upstream task read failed: {e:#}")),
        };

        let status = view
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");

        match status {
            "succeeded" => return Watched::Succeeded(view.get("result").cloned()),
            "failed" => {
                return Watched::Failed(
                    view.get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("analysis failed")
                        .to_owned(),
                );
            }
            // Anything else is the upstream still working. An unknown status is
            // reported verbatim rather than guessed at.
            other => {
                if other != last_phase {
                    last_phase = other.to_owned();
                    on_phase(if other.is_empty() { "running" } else { other });
                }
            }
        }

        if started.elapsed() > deadline {
            return Watched::Deadline(format!(
                "upstream task {upstream_task_id} still {} after {} minutes",
                if last_phase.is_empty() {
                    "unfinished"
                } else {
                    &last_phase
                },
                deadline.as_secs() / 60
            ));
        }

        tokio::select! {
            () = tokio::time::sleep(POLL_EVERY) => {}
            // Waking on cancellation rather than sleeping through it: a Stop
            // should not wait out the poll interval.
            () = ctx.cancel.cancelled() => {}
        }
    }
}

/// Watches one upstream analysis to its terminal state.
pub struct AnalyzeTask {
    state: Arc<ProxyState>,
}

impl AnalyzeTask {
    pub fn new(state: Arc<ProxyState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl TaskHandler for AnalyzeTask {
    fn task_type(&self) -> &'static str {
        ANALYZE_TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let payload: AnalyzePayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            // A payload this version cannot read will not become readable on a
            // retry, so this is terminal rather than a retry.
            Err(e) => return TaskOutcome::Failed(format!("unreadable analyze payload: {e}")),
        };

        // Phase lines are collected rather than awaited inside the watcher: it
        // is shared with the batch, where one line per document is the useful
        // grain, not one per upstream status change.
        let mut phase: Option<String> = None;
        let watched = watch_upstream(
            &self.state,
            ctx,
            &payload.upstream_task_id,
            ATTEMPT_DEADLINE,
            |p| phase = Some(p.to_owned()),
        )
        .await;
        if let Some(phase) = phase {
            ctx.progress(phase).await;
        }

        match watched {
            Watched::Succeeded(result) => {
                let summary = summarise(&payload.detector, result.as_ref());
                match result {
                    Some(result) => {
                        TaskOutcome::done_with(summary, folded(&payload.detector, result))
                    }
                    None => TaskOutcome::done(summary),
                }
            }
            Watched::Failed(message) => TaskOutcome::Failed(message),
            Watched::Unreachable(why) | Watched::Deadline(why) => {
                warn!(
                    upstream_task = %payload.upstream_task_id,
                    detector = %payload.detector,
                    "studio-spec-quality: {why}"
                );
                TaskOutcome::Retry(why)
            }
            // The upstream exposes no cancel endpoint, so stopping is something
            // only WE stop doing. Say so rather than implying the analysis was
            // called off.
            Watched::Cancelled => TaskOutcome::Failed(format!(
                "cancelled while watching upstream task {} — the analysis itself keeps                  running upstream and can still be read there",
                payload.upstream_task_id
            )),
        }
    }
}

/// One line for a person, from whatever the detector returned.
///
/// The detector's answer, plus the reading of it that a screen needs.
///
/// `bloat` answers about TEXT — clusters of repeated passages — and the
/// question somebody opened the tab with is which DOCUMENT to go and fix. That
/// fold used to happen in the browser on every render; here it happens once,
/// when the analysis does, and every consumer of the stored result inherits
/// it. The detector's own fields are untouched beside it.
///
/// Only `bloat`: the other detectors answer about one document already.
fn folded(detector: &str, mut result: serde_json::Value) -> serde_json::Value {
    if detector != "bloat" {
        return result;
    }
    let by_document = super::analysis::bloat_by_document(&result);
    if let Some(object) = result.as_object_mut() {
        object.insert("by_document".to_owned(), by_document);
    }
    result
}

/// The result shape belongs to the detector, not to us, so this reads only what
/// every one of them has — and says the plain thing when it has nothing.
fn summarise(detector: &str, result: Option<&serde_json::Value>) -> String {
    let findings = result
        .and_then(|r| r.get("findings"))
        .and_then(serde_json::Value::as_array)
        .map(Vec::len);
    match findings {
        Some(1) => format!("{detector}: 1 finding"),
        Some(n) => format!("{detector}: {n} findings"),
        None => format!("{detector}: analysis complete"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_summary_counts_findings_when_the_detector_reports_them() {
        let result = json!({ "findings": [{ "id": 1 }, { "id": 2 }] });
        assert_eq!(summarise("bloat", Some(&result)), "bloat: 2 findings");
    }

    #[test]
    fn one_finding_is_not_reported_as_plural() {
        let result = json!({ "findings": [{ "id": 1 }] });
        assert_eq!(summarise("leak", Some(&result)), "leak: 1 finding");
    }

    #[test]
    fn a_result_shape_we_do_not_recognise_still_gets_a_line() {
        let result = json!({ "verdict": "clean" });
        assert_eq!(
            summarise("purpose", Some(&result)),
            "purpose: analysis complete"
        );
        assert_eq!(summarise("purpose", None), "purpose: analysis complete");
    }
}
