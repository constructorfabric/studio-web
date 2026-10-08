//! `spec_quality.analyze_batch` — one detector over many documents, as one run.
//!
//! ## What this replaces
//!
//! A sweep over a document set was a loop in the browser: submit, wait, submit
//! the next. Twenty documents meant twenty submits and twenty waits driven from
//! a tab that had to stay open, with the portal acting as the scheduler for
//! work that takes minutes. Closing it abandoned the sweep half-done, and
//! nothing recorded that it had happened.
//!
//! Here the sweep is one run. The queue owns it, progress says which document
//! it has reached, and the portal follows the same `task_run` it follows for
//! everything else.
//!
//! ## What it deliberately does NOT do
//!
//! Decide anything. It reports which analyses finished and which did not; what
//! a verdict *means* — the score a caller trusts, whether that clears a gate,
//! whether a type gets bound — stays with the caller. `documents::classify`
//! says the leftover set is the caller's to drive, and moving the fan-out is
//! not a reason to quietly move the policy with it.
//!
//! ## Why the result carries pointers, not verdicts
//!
//! A run's `result` is stored whole and broadcast to every subscriber in the
//! tenant. A detector's verdict is a sizeable document, and fifty of them in
//! one payload would push megabytes down a channel everyone in the
//! organization is reading. So the result names each document's upstream task
//! and how it ended; a caller reads the verdicts it actually wants through
//! `GET /studio-spec-quality/v1/verdicts?task_id=…`, which is a cheap finished read
//! rather than a wait.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::warn;

use super::analyze_task::{Watched, watch_upstream};
use super::record::{RecordSpec, readings};
use super::rest::{ProxyState, accepted_doc_types};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Stable task type. A wire contract: stored on every queued run.
pub const BATCH_TASK_TYPE: &str = "spec_quality.analyze_batch";

/// How long ONE document's analysis may take before the sweep gives up on it.
///
/// Per document rather than per sweep: a set of forty must not fail because it
/// is forty, and one document that hangs must not hold the rest hostage.
const PER_ITEM_DEADLINE: Duration = Duration::from_secs(5 * 60);

/// The most documents one run will accept.
///
/// A sweep is sequential and each item is an LLM round-trip, so two hundred is
/// already the better part of an hour. Refusing a larger set at the door beats
/// accepting a run nobody will wait for.
pub const MAX_ITEMS: usize = 200;

/// One document to analyse: the caller's own id for it, and the detector
/// payload it would have posted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchItem {
    /// Whatever identifies this document to the caller — a graph node id, a
    /// path. Echoed back untouched, so the caller can join the results up.
    pub id: String,
    /// The body the detector expects for this document. Opaque here.
    pub payload: serde_json::Value,
}

/// What the run carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchPayload {
    /// `bloat` | `purpose` | `leak` | `traceability`.
    pub detector: String,
    pub items: Vec<BatchItem>,
    /// When present, the run records each document's result itself as it
    /// finishes — see [`super::record`]. Absent, it reports pointers only and
    /// recording stays with whoever reads them.
    #[serde(default)]
    pub record: Option<RecordSpec>,
}

/// How one document's analysis ended.
#[derive(Debug, Clone, Serialize)]
struct ItemOutcome {
    id: String,
    /// The upstream task to read the verdict from, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    /// `succeeded` | `failed` | `unreachable` | `timed_out` | `not_submitted`.
    status: &'static str,
    /// Why it did not succeed. Absent when it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Runs one detector across a document set.
pub struct AnalyzeBatchTask {
    state: Arc<ProxyState>,
}

impl AnalyzeBatchTask {
    pub fn new(state: Arc<ProxyState>) -> Self {
        Self { state }
    }

    /// A document the service will not analyse — a type it does not judge —
    /// recorded as a pending gate verdict that says so.
    async fn record_refusal(&self, spec: &RecordSpec, detector: &str, item_id: &str, why: &str) {
        let Some(subject) = spec.subjects.get(item_id) else {
            return;
        };
        if subject.binding_id.is_none() && subject.document_id.is_none() {
            return;
        }
        let Ok(recorder) = self
            .state
            .hub
            .get::<dyn crate::documents::port::AnalysisRecorder>()
        else {
            return;
        };
        if let Err(e) = recorder
            .record_detector_verdict(crate::documents::port::DetectorVerdict {
                workspace_id: spec.workspace_id,
                binding_id: subject.binding_id,
                document_id: subject.document_id,
                detector: detector.to_owned(),
                state: "pending".to_owned(),
                task_id: None,
                summary: format!("{detector}: not analysed — {why}"),
            })
            .await
        {
            warn!(detector, item = %item_id, error = %e, "studio-spec-quality: could not record why a document was not analysed");
        }
    }

    /// Record one finished item's readings against the subjects `spec`
    /// names, and say how many documents were recorded.
    ///
    /// Never fails the run. The analysis happened and its pointer is in the
    /// result either way; a recording that could not be written is logged
    /// and costs a re-run, not the sweep. Both writers are resolved here
    /// rather than at init, for the reason the queue is: this gear keeps no
    /// opinion about which gear initialised first, and a deployment without
    /// the graph or the documents database simply records less.
    async fn record(
        &self,
        ctx: &TaskContext,
        spec: &RecordSpec,
        detector: &str,
        item: &BatchItem,
        task_id: &str,
        result: Option<&serde_json::Value>,
    ) -> usize {
        // A set detector answers about every document its payload carried.
        let set: Vec<String> = item
            .payload
            .get("docs")
            .and_then(serde_json::Value::as_object)
            .map(|docs| docs.keys().cloned().collect())
            .unwrap_or_default();
        let readings: Vec<_> = readings(detector, &item.id, result, &set)
            .into_iter()
            .filter_map(|r| spec.subjects.get(&r.path).map(|s| (s.clone(), r)))
            .collect();
        if readings.is_empty() {
            return 0;
        }

        let workspace = spec.workspace_id.to_string();
        let project = spec.project_id.map(|p| p.to_string());
        if let Ok(writer) = self
            .state
            .hub
            .get::<dyn crate::artifact_ingest::port::SpecFindingWriter>()
        {
            let findings: Vec<_> = readings
                .iter()
                .map(
                    |(subject, r)| crate::artifact_ingest::port::QualityFinding {
                        detector: detector.to_owned(),
                        subject: subject.node.clone(),
                        path: Some(r.path.clone()),
                        severity: Some(r.severity.to_owned()),
                        summary: Some(r.summary.clone()),
                        score: r.score,
                        details: r.details.clone(),
                    },
                )
                .collect();
            // Two documents sharing text are related in the graph too, as the
            // Specs tab recorded them: a `duplicates` edge per pair, between
            // the subjects' nodes. Only pairs whose ends are both graph nodes:
            // a Studio document has none.
            let duplicates: Vec<_> = if detector == "bloat" {
                super::verdict::bloat(result, &set)
                    .pairs
                    .into_iter()
                    .filter_map(|(a, b)| {
                        let (a, b) = (spec.subjects.get(&a)?, spec.subjects.get(&b)?);
                        (a.binding_id.is_some() && b.binding_id.is_some()).then(|| {
                            crate::artifact_ingest::port::QualityLink {
                                from: a.node.clone(),
                                to: b.node.clone(),
                            }
                        })
                    })
                    .collect()
            } else {
                Vec::new()
            };
            if let Err(e) = writer
                .write_spec_findings(
                    &ctx.security,
                    &findings,
                    &duplicates,
                    Some(&workspace),
                    project.as_deref(),
                )
                .await
            {
                warn!(detector, item = %item.id, error = %e, "studio-spec-quality: could not record findings");
            }
        }
        if let Ok(recorder) = self
            .state
            .hub
            .get::<dyn crate::documents::port::AnalysisRecorder>()
        {
            for (subject, r) in &readings {
                if subject.binding_id.is_none() && subject.document_id.is_none() {
                    continue;
                }
                if let Err(e) = recorder
                    .record_detector_verdict(crate::documents::port::DetectorVerdict {
                        workspace_id: spec.workspace_id,
                        binding_id: subject.binding_id,
                        document_id: subject.document_id,
                        detector: detector.to_owned(),
                        state: r.gate.as_str().to_owned(),
                        task_id: Some(task_id.to_owned()),
                        summary: r.summary.clone(),
                    })
                    .await
                {
                    warn!(detector, path = %r.path, error = %e, "studio-spec-quality: could not record the gate verdict");
                }
            }
        }
        readings.len()
    }
}

#[async_trait]
impl TaskHandler for AnalyzeBatchTask {
    fn task_type(&self) -> &'static str {
        BATCH_TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let payload: BatchPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => return TaskOutcome::Failed(format!("unreadable batch payload: {e}")),
        };
        if payload.items.is_empty() {
            return TaskOutcome::done_with(
                "nothing to analyse".to_owned(),
                json!({ "detector": payload.detector, "items": [] }),
            );
        }

        let total = payload.items.len();
        let mut recorded = 0usize;
        // What each item that answered is made of, for the set's own reading.
        let mut shares: Vec<serde_json::Value> = Vec::new();
        let mut outcomes = Vec::with_capacity(total);
        let mut succeeded = 0usize;

        // Asked once, before any submit: the workspace offers more document
        // types than this service analyses -- it owns the templates, the
        // service owns what it can judge -- and a document bound to one of the
        // others used to be found out by posting it and reading
        // `422 Input should be 'prd', 'design', ...` back. That is a round trip
        // to be told something the service publishes, and a failure where the
        // truthful word is "skipped".
        let accepted = accepted_doc_types(&self.state).await;

        for (index, item) in payload.items.iter().enumerate() {
            if ctx.cancelled() {
                // Everything analysed so far is real and worth keeping: report
                // it rather than throwing away an hour of finished work.
                return TaskOutcome::done_with(
                    format!("stopped after {} of {total} — {succeeded} analysed", index),
                    json!({
                        "detector": payload.detector,
                        "stopped": true,
                        "items": outcomes,
                    }),
                );
            }

            ctx.progress(format!("{}/{total} · {}", index + 1, item.id))
                .await;

            if let Some(why) = unanalysable(accepted.as_deref(), &item.payload) {
                // Recorded as a pending gate with the reason, so a stage says
                // why it is not satisfied, and a sync that analyses documents
                // never analysed does not ask about this one every time.
                if let Some(spec) = payload.record.as_ref() {
                    self.record_refusal(spec, &payload.detector, &item.id, &why)
                        .await;
                }
                outcomes.push(ItemOutcome {
                    id: item.id.clone(),
                    task_id: None,
                    status: "not_submitted",
                    error: Some(why),
                });
                continue;
            }

            // Submitted here rather than up front: submitting all two hundred
            // at once would queue an hour of upstream work that a Stop could no
            // longer call off.
            let submitted = self
                .state
                .upstream_json(
                    reqwest::Method::POST,
                    &format!("/v1/analyze/{}", payload.detector),
                    Some(serde_json::to_vec(&item.payload).unwrap_or_default().into()),
                )
                .await;

            let task_id = match submitted.as_ref().map(|created| {
                created
                    .get("task_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            }) {
                Ok(Some(task_id)) => task_id,
                Ok(None) => {
                    outcomes.push(ItemOutcome {
                        id: item.id.clone(),
                        task_id: None,
                        status: "not_submitted",
                        error: Some("upstream accepted the analysis without a task_id".to_owned()),
                    });
                    continue;
                }
                Err(e) => {
                    // One document's submit failing is that document's problem.
                    // The sweep carries on — a set of forty must not be lost to
                    // one bad payload.
                    outcomes.push(ItemOutcome {
                        id: item.id.clone(),
                        task_id: None,
                        status: "not_submitted",
                        error: Some(format!("{e:#}")),
                    });
                    continue;
                }
            };

            let watched =
                watch_upstream(&self.state, ctx, &task_id, PER_ITEM_DEADLINE, |_| {}).await;
            outcomes.push(match watched {
                Watched::Succeeded(result) => {
                    succeeded += 1;
                    if let Some(spec) = payload.record.as_ref() {
                        recorded += self
                            .record(ctx, spec, &payload.detector, item, &task_id, result.as_ref())
                            .await;
                    }
                    // Kept for the set-wide reading below, and only the two
                    // fields it weighs: a batch result carrying every item's
                    // full analysis would be the whole run stored twice. The
                    // per-item verdicts are read through `/verdicts`, one task
                    // id at a time, which is why the run reports pointers.
                    if let Some(result) = result.as_ref()
                        && result.get("mixture").is_some()
                    {
                        shares.push(json!({
                            "mixture": result.get("mixture"),
                            "n_tokens": result.get("n_tokens"),
                        }));
                    }
                    ItemOutcome {
                        id: item.id.clone(),
                        task_id: Some(task_id),
                        status: "succeeded",
                        error: None,
                    }
                }
                Watched::Failed(message) => ItemOutcome {
                    id: item.id.clone(),
                    task_id: Some(task_id),
                    status: "failed",
                    error: Some(message),
                },
                Watched::Unreachable(why) => {
                    warn!(detector = %payload.detector, item = %item.id, "studio-spec-quality: {why}");
                    ItemOutcome {
                        id: item.id.clone(),
                        task_id: Some(task_id),
                        status: "unreachable",
                        error: Some(why),
                    }
                }
                Watched::Deadline(why) => ItemOutcome {
                    id: item.id.clone(),
                    task_id: Some(task_id),
                    status: "timed_out",
                    error: Some(why),
                },
                Watched::Cancelled => {
                    return TaskOutcome::done_with(
                        format!("stopped after {} of {total} — {succeeded} analysed", index),
                        json!({
                            "detector": payload.detector,
                            "stopped": true,
                            "items": outcomes,
                            "mixture": super::analysis::purpose_mixture(&shares),
                        }),
                    );
                }
            });
        }

        TaskOutcome::done_with(
            format!("{succeeded} of {total} analysed"),
            json!({
                "detector": payload.detector,
                "items": outcomes,
                // How many documents' results this run recorded itself. Zero
                // for a run that was not asked to.
                "recorded": recorded,
                // What the SET is made of, weighted by how long each document
                // is. Read here rather than by whoever draws the bar: an
                // unweighted average lets a forty-word stub count as much as a
                // four-thousand-word specification, which is how a set that is
                // nearly all requirements comes out looking evenly mixed.
                // Empty for a detector that answers no mixture, which is every
                // one but `purpose`.
                "mixture": super::analysis::purpose_mixture(&shares),
            }),
        )
    }

    /// One attempt. A sweep is not idempotent in any useful sense — a retry
    /// resubmits every document, paying for the whole set again to recover the
    /// few that failed — and each item already survives its own failure.
    fn max_attempts(&self) -> i16 {
        1
    }
}

/// Why this document cannot be analysed, or `None` to go ahead.
///
/// Only one reason exists: the payload names a `doc_type` the service does not
/// have. The message says what it accepts, because the person reading it is
/// looking at a document type their workspace defines and the upstream has
/// never heard of, and "unsupported" alone would not tell them which half to
/// change.
///
/// `accepted: None` means the service did not say what it takes, and then
/// nothing is refused here: being wrong in that direction costs one 422,
/// while being wrong the other way would silently skip work the service would
/// happily have done.
fn unanalysable(accepted: Option<&[String]>, payload: &serde_json::Value) -> Option<String> {
    let accepted = accepted?;
    let doc_type = payload.get("doc_type")?.as_str()?;
    if accepted.iter().any(|t| t == doc_type) {
        return None;
    }
    Some(format!(
        "Spec Quality does not analyse `{doc_type}` documents; it accepts {}",
        accepted.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_outcome_omits_the_fields_it_has_nothing_for() {
        let done = ItemOutcome {
            id: "node-1".to_owned(),
            task_id: Some("t-1".to_owned()),
            status: "succeeded",
            error: None,
        };
        let json = serde_json::to_value(&done).unwrap();
        assert_eq!(json["status"], "succeeded");
        assert_eq!(json["task_id"], "t-1");
        assert!(
            json.get("error").is_none(),
            "a succeeded item carries no error: {json}"
        );
    }

    #[test]
    fn a_submit_that_never_happened_names_no_upstream_task() {
        let lost = ItemOutcome {
            id: "node-2".to_owned(),
            task_id: None,
            status: "not_submitted",
            error: Some("upstream refused".to_owned()),
        };
        let json = serde_json::to_value(&lost).unwrap();
        assert!(json.get("task_id").is_none(), "{json}");
        assert_eq!(json["error"], "upstream refused");
    }
    /// The case that sent this: a workspace type the service has no name for.
    #[test]
    fn a_document_type_the_service_does_not_have_is_skipped_rather_than_posted() {
        let accepted = ["prd".to_owned(), "design".to_owned(), "adr".to_owned()];
        let why = unanalysable(
            Some(&accepted),
            &serde_json::json!({ "doc_type": "app_spec", "text": "..." }),
        )
        .expect("app_spec is not one of the three");
        assert!(why.contains("app_spec"), "{why}");
        assert!(why.contains("prd, design, adr"), "{why}");
    }

    #[test]
    fn a_document_type_the_service_has_goes_through() {
        let accepted = ["prd".to_owned(), "design".to_owned()];
        assert!(
            unanalysable(
                Some(&accepted),
                &serde_json::json!({ "doc_type": "prd", "text": "..." })
            )
            .is_none()
        );
    }

    /// Nothing is refused on a guess: a service that did not say what it takes
    /// has not said it takes nothing, and the two detectors that need no type
    /// send none.
    #[test]
    fn nothing_is_refused_when_the_service_did_not_say_or_the_payload_has_no_type() {
        let payload = serde_json::json!({ "doc_type": "app_spec" });
        assert!(unanalysable(None, &payload).is_none());
        let accepted = ["prd".to_owned()];
        assert!(unanalysable(Some(&accepted), &serde_json::json!({ "text": "..." })).is_none());
        assert!(unanalysable(Some(&accepted), &serde_json::json!({ "doc_type": null })).is_none());
    }

    // ── what a run records ───────────────────────────────────────────────
    //
    // `record` is the only place a finished analysis turns into rows somebody
    // else reads: the `spec_finding` node the editor and the Specs tab draw
    // findings from, and the gate verdict a stage reads. Both writers are hub
    // ports, so the tests below put fakes on a hub and read back exactly what
    // the run handed them -- no upstream, no graph, no database.

    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use toolkit::client_hub::ClientHub;
    use toolkit_security::SecurityContext;
    use uuid::Uuid;

    use crate::artifact_ingest::port::{QualityFinding, QualityLink, SpecFindingWriter};
    use crate::documents::port::{AnalysisRecorder, DetectorVerdict};
    use crate::spec_quality::record::RecordSubject;

    /// One `write_spec_findings` call, as plain values: the port's own types
    /// carry no `Clone`, and a test wants to hold on to what it was given.
    #[derive(Debug, Clone)]
    struct Written {
        findings: Vec<serde_json::Value>,
        duplicates: Vec<(String, String)>,
        workspace: Option<String>,
        project: Option<String>,
    }

    #[derive(Default)]
    struct FakeWriter(Mutex<Vec<Written>>);

    #[async_trait]
    impl SpecFindingWriter for FakeWriter {
        async fn write_spec_findings(
            &self,
            _ctx: &SecurityContext,
            findings: &[QualityFinding],
            duplicates: &[QualityLink],
            workspace_id: Option<&str>,
            project_id: Option<&str>,
        ) -> anyhow::Result<(usize, usize)> {
            self.0.lock().unwrap().push(Written {
                findings: findings
                    .iter()
                    .map(|f| {
                        json!({
                            "detector": f.detector,
                            "subject": f.subject,
                            "path": f.path,
                            "severity": f.severity,
                            "summary": f.summary,
                            "score": f.score,
                            "details": f.details,
                        })
                    })
                    .collect(),
                duplicates: duplicates
                    .iter()
                    .map(|l| (l.from.clone(), l.to.clone()))
                    .collect(),
                workspace: workspace_id.map(str::to_owned),
                project: project_id.map(str::to_owned),
            });
            Ok((findings.len(), duplicates.len()))
        }
    }

    #[derive(Default)]
    struct FakeRecorder(Mutex<Vec<DetectorVerdict>>);

    #[async_trait]
    impl AnalysisRecorder for FakeRecorder {
        async fn record_detector_verdict(&self, verdict: DetectorVerdict) -> anyhow::Result<()> {
            self.0.lock().unwrap().push(verdict);
            Ok(())
        }
    }

    const WS: Uuid = Uuid::from_u128(0x5157_0000_0000_4000_8000_0000_0000_0001);
    const PROJECT: Uuid = Uuid::from_u128(0x5157_0000_0000_4000_8000_0000_0000_0002);
    const BINDING_A: Uuid = Uuid::from_u128(0x5157_0000_0000_4000_8000_0000_0000_00a1);
    const BINDING_B: Uuid = Uuid::from_u128(0x5157_0000_0000_4000_8000_0000_0000_00b1);
    const STUDIO_DOC: Uuid = Uuid::from_u128(0x5157_0000_0000_4000_8000_0000_0000_00c1);

    fn security() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::new_v4())
            .subject_type("user")
            .subject_tenant_id(WS)
            .build()
            .expect("security context")
    }

    struct Rig {
        task: AnalyzeBatchTask,
        ctx: TaskContext,
        writer: Arc<FakeWriter>,
        recorder: Arc<FakeRecorder>,
    }

    impl Rig {
        fn written(&self) -> Vec<Written> {
            self.writer.0.lock().unwrap().clone()
        }
        fn verdicts(&self) -> Vec<DetectorVerdict> {
            self.recorder.0.lock().unwrap().clone()
        }
    }

    /// A run with both writers present, as in the assembled backend.
    fn rig() -> Rig {
        let hub = Arc::new(ClientHub::new());
        let writer = Arc::new(FakeWriter::default());
        let recorder = Arc::new(FakeRecorder::default());
        hub.register::<dyn SpecFindingWriter>(writer.clone());
        hub.register::<dyn AnalysisRecorder>(recorder.clone());
        Rig {
            task: bare_task(hub),
            ctx: TaskContext::for_tests(json!({}), security()),
            writer,
            recorder,
        }
    }

    fn bare_task(hub: Arc<ClientHub>) -> AnalyzeBatchTask {
        AnalyzeBatchTask::new(Arc::new(ProxyState {
            client: reqwest::Client::new(),
            base_url: String::new(),
            api_key: None,
            hub,
        }))
    }

    fn binding(node: &str, id: Uuid) -> RecordSubject {
        RecordSubject {
            node: node.to_owned(),
            binding_id: Some(id),
            document_id: None,
        }
    }

    fn studio_doc(id: Uuid) -> RecordSubject {
        RecordSubject {
            node: format!("studio-doc:{id}"),
            binding_id: None,
            document_id: Some(id),
        }
    }

    fn spec(subjects: &[(&str, RecordSubject)]) -> RecordSpec {
        RecordSpec {
            workspace_id: WS,
            project_id: Some(PROJECT),
            subjects: subjects
                .iter()
                .map(|(path, s)| ((*path).to_owned(), s.clone()))
                .collect::<BTreeMap<_, _>>(),
        }
    }

    fn item(id: &str, payload: serde_json::Value) -> BatchItem {
        BatchItem {
            id: id.to_owned(),
            payload,
        }
    }

    /// The case the editor exists for: a purpose gate that failed, on a
    /// repository document. The graph gets one finding carrying the reading
    /// in the clients' words and the placed findings under `details`; the
    /// stage gate gets `failed` with the upstream task it came from.
    #[tokio::test]
    async fn a_purpose_verdict_is_recorded_as_a_finding_and_a_failed_gate() {
        let rig = rig();
        let spec = spec(&[("docs/PRD.md", binding("node-prd", BINDING_A))]);
        let result = json!({
            "path": "docs/PRD.md",
            "doc_type": "prd",
            "mixture": { "other": 0.1, "design": 0.9 },
            "gate": { "passed": false, "leak_share": 0.18, "threshold": 0.05, "violations": [
                { "section": "Scope", "role": "design", "line_start": 4, "line_end": 9,
                  "confidence": 0.97, "reason": "PRD section reads as DESIGN" }
            ]}
        });
        let n = rig
            .task
            .record(
                &rig.ctx,
                &spec,
                "purpose",
                &item("docs/PRD.md", json!({ "text": "..." })),
                "t-1",
                Some(&result),
            )
            .await;
        assert_eq!(n, 1);

        let written = rig.written();
        assert_eq!(written.len(), 1, "one write per finished item");
        let w = &written[0];
        assert_eq!(w.workspace.as_deref(), Some(WS.to_string().as_str()));
        assert_eq!(w.project.as_deref(), Some(PROJECT.to_string().as_str()));
        assert!(w.duplicates.is_empty(), "only bloat relates documents");
        assert_eq!(w.findings.len(), 1);
        let f = &w.findings[0];
        assert_eq!(f["detector"], "purpose");
        assert_eq!(f["subject"], "node-prd", "keyed on the graph file node");
        assert_eq!(f["path"], "docs/PRD.md");
        assert_eq!(f["severity"], "gate-failed");
        assert_eq!(f["summary"], "purpose: prd (90% specification)");
        assert_eq!(f["details"]["gate_leak_share"], 0.18);
        assert_eq!(f["details"]["gate_threshold"], 0.05);
        let placed = f["details"]["findings"].as_array().unwrap();
        assert_eq!(placed.len(), 1, "{f}");
        assert_eq!(placed[0]["anchor"]["line_start"], 4);

        let verdicts = rig.verdicts();
        assert_eq!(verdicts.len(), 1);
        let v = &verdicts[0];
        assert_eq!(v.workspace_id, WS);
        assert_eq!(v.binding_id, Some(BINDING_A));
        assert_eq!(v.document_id, None);
        assert_eq!(v.detector, "purpose");
        assert_eq!(v.state, "failed");
        assert_eq!(v.task_id.as_deref(), Some("t-1"));
        assert_eq!(v.summary, "purpose: prd (90% specification)");
    }

    /// A Studio document has no graph node and no binding: its finding is
    /// keyed `studio-doc:<id>` and its gate is the document's own.
    #[tokio::test]
    async fn a_clean_leak_on_a_studio_document_passes_that_documents_gate() {
        let rig = rig();
        let path = format!("studio-doc/{STUDIO_DOC}.md");
        let spec = spec(&[(path.as_str(), studio_doc(STUDIO_DOC))]);
        let result =
            json!({ "passed": true, "leak_share": 0.01, "foreign_roles": [], "leaks": [] });
        let n = rig
            .task
            .record(
                &rig.ctx,
                &spec,
                "leak",
                &item(&path, json!({ "text": "...", "doc_type": "prd" })),
                "t-2",
                Some(&result),
            )
            .await;
        assert_eq!(n, 1);

        let f = &rig.written()[0].findings[0];
        assert_eq!(f["subject"], format!("studio-doc:{STUDIO_DOC}"));
        assert_eq!(f["severity"], "clean");
        assert_eq!(f["summary"], "leak: clean (1% foreign)");
        assert!(f["details"]["findings"].as_array().unwrap().is_empty());

        let v = &rig.verdicts()[0];
        assert_eq!(v.binding_id, None);
        assert_eq!(v.document_id, Some(STUDIO_DOC));
        assert_eq!(v.state, "passed");
    }

    /// Bloat answers about the whole set. Every document in it gets a
    /// reading, and two documents sharing text get a `duplicates` edge --
    /// but only when both ends are graph nodes. A Studio document's
    /// `studio-doc:` key is not a node, and an edge to it would point at
    /// nothing.
    #[tokio::test]
    async fn bloat_records_every_document_and_relates_only_graph_documents() {
        let rig = rig();
        let studio_path = format!("studio-doc/{STUDIO_DOC}.md");
        let spec = spec(&[
            ("a.md", binding("node-a", BINDING_A)),
            ("b.md", binding("node-b", BINDING_B)),
            (studio_path.as_str(), studio_doc(STUDIO_DOC)),
        ]);
        let result = json!({ "clusters": [
            { "occurrences": [
                { "file": "a.md", "section": "S", "line": 3, "line_end": 3, "text": "same words" },
                { "file": "b.md", "section": "T", "line": 9, "line_end": 9, "text": "same words" },
            ]},
            { "occurrences": [
                { "file": "a.md", "section": "S", "line": 7, "line_end": 7, "text": "other words" },
                { "file": studio_path, "section": "U", "line": 2, "line_end": 2, "text": "other words" },
            ]},
        ]});
        let docs = json!({ "a.md": "...", "b.md": "...", studio_path.clone(): "..." });
        let n = rig
            .task
            .record(
                &rig.ctx,
                &spec,
                "bloat",
                &item("set", json!({ "docs": docs })),
                "t-3",
                Some(&result),
            )
            .await;
        assert_eq!(n, 3, "one reading per document in the set");

        let w = &rig.written()[0];
        let mut subjects: Vec<&str> = w
            .findings
            .iter()
            .map(|f| f["subject"].as_str().unwrap())
            .collect();
        subjects.sort_unstable();
        let studio_key = format!("studio-doc:{STUDIO_DOC}");
        assert_eq!(subjects, ["node-a", "node-b", studio_key.as_str()]);
        let a = w
            .findings
            .iter()
            .find(|f| f["subject"] == "node-a")
            .unwrap();
        assert_eq!(a["severity"], "high");
        assert_eq!(
            a["details"]["findings"].as_array().unwrap().len(),
            2,
            "a.md repeats twice, and only its own findings are on it: {a}"
        );

        // One edge: a ↔ b. a ↔ the Studio document is real duplication, but
        // it has no node on the Studio side to hang an edge from.
        assert_eq!(w.duplicates.len(), 1, "{:?}", w.duplicates);
        let (from, to) = &w.duplicates[0];
        let mut ends = [from.as_str(), to.as_str()];
        ends.sort_unstable();
        assert_eq!(ends, ["node-a", "node-b"]);

        let verdicts = rig.verdicts();
        assert_eq!(verdicts.len(), 3, "every subject with an id gets a gate");
        assert!(
            verdicts
                .iter()
                .all(|v| v.state == "failed" && v.detector == "bloat"),
            "all three repeat something: {verdicts:?}"
        );
        assert!(
            verdicts
                .iter()
                .any(|v| v.document_id == Some(STUDIO_DOC) && v.binding_id.is_none())
        );
    }

    /// The run records what its caller named and nothing else: a document in
    /// the set that the `record` block does not mention is not recorded, and
    /// a subject with neither a binding nor a document gets its graph finding
    /// but no gate row -- there is no gate to write it against.
    #[tokio::test]
    async fn only_named_subjects_are_recorded_and_only_ones_with_an_id_get_a_gate() {
        let rig = rig();
        let spec = spec(&[
            ("a.md", binding("node-a", BINDING_A)),
            (
                "b.md",
                RecordSubject {
                    node: "node-b".to_owned(),
                    binding_id: None,
                    document_id: None,
                },
            ),
        ]);
        let docs = json!({ "a.md": "...", "b.md": "...", "unnamed.md": "..." });
        let n = rig
            .task
            .record(
                &rig.ctx,
                &spec,
                "bloat",
                &item("set", json!({ "docs": docs })),
                "t-4",
                Some(&json!({ "clusters": [] })),
            )
            .await;
        assert_eq!(n, 2, "unnamed.md is not this run's to record");

        let w = &rig.written()[0];
        assert_eq!(w.findings.len(), 2);
        assert!(w.findings.iter().all(|f| f["severity"] == "clean"));
        assert!(w.findings.iter().all(|f| f["path"] != "unnamed.md"));

        let verdicts = rig.verdicts();
        assert_eq!(verdicts.len(), 1, "{verdicts:?}");
        assert_eq!(verdicts[0].binding_id, Some(BINDING_A));
        assert_eq!(verdicts[0].state, "passed");
    }

    /// A reading for a path nobody named writes nothing at all -- not an
    /// empty findings call, which would still be a graph round trip.
    #[tokio::test]
    async fn an_item_nobody_named_writes_nothing() {
        let rig = rig();
        let spec = spec(&[("docs/a.md", binding("node-a", BINDING_A))]);
        let n = rig
            .task
            .record(
                &rig.ctx,
                &spec,
                "purpose",
                &item("docs/other.md", json!({})),
                "t-5",
                Some(&json!({ "doc_type": "prd" })),
            )
            .await;
        assert_eq!(n, 0);
        assert!(rig.written().is_empty());
        assert!(rig.verdicts().is_empty());
    }

    /// A deployment without the graph or the documents database records less,
    /// and the run does not fail for it: the reading is still counted.
    #[tokio::test]
    async fn a_hub_without_either_writer_records_nothing_and_does_not_fail() {
        let task = bare_task(Arc::new(ClientHub::new()));
        let ctx = TaskContext::for_tests(json!({}), security());
        let spec = spec(&[("docs/a.md", binding("node-a", BINDING_A))]);
        let n = task
            .record(
                &ctx,
                &spec,
                "purpose",
                &item("docs/a.md", json!({})),
                "t-6",
                Some(&json!({ "doc_type": "prd" })),
            )
            .await;
        assert_eq!(n, 1);
    }

    /// A document the service will not judge is recorded as `pending` with
    /// the reason, so a stage says why it is not satisfied and the next sync
    /// does not count it as never analysed. No upstream task stands behind
    /// it, so none is named.
    #[tokio::test]
    async fn a_refused_document_is_recorded_as_pending_with_the_reason() {
        let rig = rig();
        let spec = spec(&[("docs/app.md", binding("node-app", BINDING_A))]);
        rig.task
            .record_refusal(
                &spec,
                "leak",
                "docs/app.md",
                "Spec Quality does not analyse `app_spec` documents",
            )
            .await;
        let verdicts = rig.verdicts();
        assert_eq!(verdicts.len(), 1);
        let v = &verdicts[0];
        assert_eq!(v.state, "pending");
        assert_eq!(v.binding_id, Some(BINDING_A));
        assert_eq!(v.detector, "leak");
        assert_eq!(v.task_id, None);
        assert!(
            v.summary.starts_with("leak: not analysed — "),
            "{}",
            v.summary
        );
        assert!(v.summary.contains("app_spec"), "{}", v.summary);
        assert!(
            rig.written().is_empty(),
            "a refusal is a gate state, not a finding"
        );
    }

    #[tokio::test]
    async fn a_refusal_for_an_unnamed_or_id_less_subject_records_nothing() {
        let rig = rig();
        let spec = spec(&[(
            "b.md",
            RecordSubject {
                node: "node-b".to_owned(),
                binding_id: None,
                document_id: None,
            },
        )]);
        rig.task
            .record_refusal(&spec, "purpose", "nobody.md", "why")
            .await;
        rig.task
            .record_refusal(&spec, "purpose", "b.md", "why")
            .await;
        assert!(rig.verdicts().is_empty());
    }
}
