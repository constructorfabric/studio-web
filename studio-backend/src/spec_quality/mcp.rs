//! The spec-quality detectors as MCP tools (`crate::mcp`).
//!
//! The agent sends the text it is working on, so a draft is checked before it
//! is committed: nothing is read from a repository. A check is what the portal
//! does in three steps -- submit, follow the run, read the verdict -- done in
//! one call, with a wait the agent can cut short.

use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::mcp::sdk::{Api, Effect, Run, Tool, ToolError, ToolFuture, object, pause};

const DETECTORS: [&str; 4] = ["purpose", "leak", "bloat", "traceability"];

/// How long `spec_check` waits by default, and at most. A detector takes from
/// seconds to minutes; past the wait the agent gets the ids to ask again.
const DEFAULT_WAIT_SECS: u64 = 60;
const MAX_WAIT_SECS: u64 = 600;
const POLL: Duration = Duration::from_secs(3);

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "spec_check",
            description: "Check specification text with one spec-quality detector and return \
                its verdict. Send the text as it is now, saved or not: nothing is read from a \
                repository. `purpose` (what the document is, and whether it passes its purpose \
                gate) and `leak` (content that belongs in another kind of document) take ONE \
                document; `bloat` (passages duplicated across documents) and `traceability` (ids \
                and references between documents) take the SET. Waits up to `wait_seconds`; \
                if the detector is not done by then, the answer says `running` with the ids to \
                pass to `spec_check_result`.",
            input_schema: || {
                object(
                    json!({
                        "detector": { "type": "string", "enum": DETECTORS },
                        "documents": { "type": "array", "minItems": 1, "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string", "description": "The file's path in the repository, e.g. docs/PRD.md." },
                                "text": { "type": "string", "description": "The whole text, as it is now." }
                            },
                            "required": ["path", "text"],
                            "additionalProperties": false
                        } },
                        "doc_type": { "type": "string",
                            "description": "purpose and leak: the kind of document it is meant to be (e.g. prd, design, adr); the detector classifies it when absent." },
                        "wait_seconds": { "type": "integer", "minimum": 0, "maximum": MAX_WAIT_SECS,
                            "description": "How long to wait for the verdict. Default 60." }
                    }),
                    &["detector", "documents"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Custom(spec_check),
        },
        Tool {
            name: "spec_check_result",
            description: "The verdict of a check `spec_check` answered `running` for: pass back \
                the `run_id`, `task_id`, `detector` and `paths` it gave. Answers `running` \
                again while the detector is still working; call it again a little later.",
            input_schema: || {
                object(
                    json!({
                        "run_id": { "type": "string" },
                        "task_id": { "type": "string" },
                        "detector": { "type": "string", "enum": DETECTORS },
                        "paths": { "type": "array", "items": { "type": "string" } }
                    }),
                    &["run_id", "task_id", "detector"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Custom(spec_check_result),
        },
    ]
}

/// What `spec_check` was asked, checked before anything is submitted.
#[derive(Debug, PartialEq)]
struct Check {
    detector: String,
    /// `(path, text)`, in the order sent.
    documents: Vec<(String, String)>,
    doc_type: Option<String>,
    wait: Duration,
}

impl Check {
    fn read(args: &Map<String, Value>) -> Result<Self, ToolError> {
        let detector = args
            .get("detector")
            .and_then(Value::as_str)
            .filter(|d| DETECTORS.contains(d))
            .ok_or_else(|| {
                ToolError::new("`detector` is one of purpose, leak, bloat, traceability")
            })?
            .to_owned();
        let documents: Vec<(String, String)> = args
            .get("documents")
            .and_then(Value::as_array)
            .map(|docs| {
                docs.iter()
                    .filter_map(|d| {
                        Some((
                            d.get("path")?.as_str()?.to_owned(),
                            d.get("text")?.as_str()?.to_owned(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if documents.is_empty() {
            return Err(ToolError::new(
                "`documents` holds at least one {path, text}",
            ));
        }
        if single(&detector) && documents.len() != 1 {
            return Err(ToolError::new(format!(
                "`{detector}` checks one document per call; this call sent {}",
                documents.len()
            )));
        }
        let wait = args
            .get("wait_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_WAIT_SECS)
            .min(MAX_WAIT_SECS);
        Ok(Self {
            detector,
            documents,
            doc_type: args
                .get("doc_type")
                .and_then(Value::as_str)
                .filter(|t| !t.trim().is_empty())
                .map(str::to_owned),
            wait: Duration::from_secs(wait),
        })
    }

    /// The body the detector takes, as the portal sends it.
    fn body(&self) -> Value {
        if single(&self.detector) {
            let (path, text) = &self.documents[0];
            let mut body = json!({ "path": path, "text": text });
            if let Some(t) = &self.doc_type {
                body["doc_type"] = json!(t);
            }
            body
        } else {
            let docs: Map<String, Value> = self
                .documents
                .iter()
                .map(|(path, text)| (path.clone(), json!(text)))
                .collect();
            json!({ "docs": docs })
        }
    }

    fn paths(&self) -> Vec<String> {
        self.documents.iter().map(|(p, _)| p.clone()).collect()
    }
}

/// `purpose` and `leak` judge one document; the others judge a set.
fn single(detector: &str) -> bool {
    matches!(detector, "purpose" | "leak")
}

fn spec_check(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let check = Check::read(&args)?;
        api.take("spec_check")?;
        let created = api
            .post(
                &format!("/studio-spec-quality/v1/analyze/{}", check.detector),
                &[],
                &check.body(),
            )
            .await?;
        let field = |name: &str| {
            created
                .get(name)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| ToolError::new(format!("the submit answered without `{name}`")))
        };
        let pending = Pending {
            run_id: field("run_id")?,
            task_id: field("task_id")?,
            detector: check.detector.clone(),
            paths: check.paths(),
        };
        pending.wait(&api, check.wait).await
    })
}

fn spec_check_result(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let text = |name: &str| {
            args.get(name)
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| ToolError::new(format!("`{name}` is required")))
        };
        let pending = Pending {
            run_id: text("run_id")?,
            task_id: text("task_id")?,
            detector: text("detector")?,
            paths: args
                .get("paths")
                .and_then(Value::as_array)
                .map(|ps| {
                    ps.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
        };
        pending.wait(&api, Duration::ZERO).await
    })
}

/// A submitted check: the run that watches it and the upstream task it reads.
struct Pending {
    run_id: String,
    task_id: String,
    detector: String,
    paths: Vec<String>,
}

impl Pending {
    /// Follow the run until it ends or `wait` is up, then read the verdict.
    async fn wait(&self, api: &Api, wait: Duration) -> Result<Value, ToolError> {
        let deadline = Instant::now() + wait;
        loop {
            let run = api
                .get(&format!("/studio-tasks/v1/runs/{}", self.run_id), &[])
                .await?;
            let state = run.get("state").and_then(Value::as_str).unwrap_or("");
            match state {
                "succeeded" => return self.verdict(api).await,
                "failed" | "cancelled" => {
                    let why = run
                        .get("last_error")
                        .and_then(Value::as_str)
                        .unwrap_or("no reason given");
                    return Err(ToolError::new(format!("the check {state}: {why}")));
                }
                _ if Instant::now() >= deadline => return Ok(self.running(state)),
                _ => pause(POLL).await,
            }
        }
    }

    async fn verdict(&self, api: &Api) -> Result<Value, ToolError> {
        let mut query = vec![
            ("task_id".to_owned(), self.task_id.clone()),
            ("detector".to_owned(), self.detector.clone()),
        ];
        query.extend(self.paths.iter().map(|p| ("path".to_owned(), p.clone())));
        let verdict = api.get("/studio-spec-quality/v1/verdicts", &query).await?;
        Ok(json!({ "status": "done", "verdict": verdict }))
    }

    fn running(&self, state: &str) -> Value {
        json!({
            "status": "running",
            "state": state,
            "run_id": self.run_id,
            "task_id": self.task_id,
            "detector": self.detector,
            "paths": self.paths,
            "next": "call spec_check_result with these run_id, task_id, detector and paths",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn one_document_detectors_send_the_text_with_its_path() {
        let check = Check::read(&args(json!({
            "detector": "purpose",
            "documents": [{"path": "docs/PRD.md", "text": "# PRD"}],
            "doc_type": "prd"
        })))
        .unwrap();
        assert_eq!(
            check.body(),
            json!({"path": "docs/PRD.md", "text": "# PRD", "doc_type": "prd"})
        );
        assert_eq!(check.wait, Duration::from_secs(DEFAULT_WAIT_SECS));
    }

    #[test]
    fn set_detectors_send_the_documents_by_path() {
        let check = Check::read(&args(json!({
            "detector": "bloat",
            "documents": [{"path": "a.md", "text": "A"}, {"path": "b.md", "text": "B"}],
            "wait_seconds": 9999
        })))
        .unwrap();
        assert_eq!(check.body(), json!({"docs": {"a.md": "A", "b.md": "B"}}));
        assert_eq!(check.paths(), vec!["a.md", "b.md"]);
        assert_eq!(check.wait, Duration::from_secs(MAX_WAIT_SECS));
    }

    #[test]
    fn what_cannot_be_checked_is_refused_before_anything_is_sent() {
        let two = json!([{"path": "a.md", "text": "A"}, {"path": "b.md", "text": "B"}]);
        let err = Check::read(&args(json!({"detector": "leak", "documents": two}))).unwrap_err();
        assert_eq!(
            err.0,
            "`leak` checks one document per call; this call sent 2"
        );
        assert!(Check::read(&args(json!({"detector": "x", "documents": two}))).is_err());
        assert!(Check::read(&args(json!({"detector": "bloat", "documents": []}))).is_err());
    }
}
