//! The `artifact.ingest` task: one repository's issues, pull requests and
//! files into the artifact graph.
//!
//! ## Why this one moved
//!
//! Cloning a repository and walking it takes seconds to minutes, so this was
//! already a background job — `tokio::spawn` plus a `Mutex<HashMap<String,
//! TaskRecord>>` that died with the process. A poll arriving after a redeploy
//! answered "no such sync task" about a sync that had really run, a sync
//! interrupted mid-clone left nothing behind, and there was no way to cancel
//! one or to see the ones that failed yesterday.
//!
//! Now it is a run, and the poll endpoint reads that run.
//!
//! ## The token is not in the payload
//!
//! The old path resolved the connector token in the request handler and moved
//! it into the spawned job. A queued run is a database row, possibly read
//! minutes later by another process, and a bearer token has no business living
//! there. So the payload carries the credstore *reference* and the handler
//! resolves it per attempt — which also means a rotated token is picked up by
//! a retry instead of failing it.
//!
//! The route still resolves the token once, before enqueuing, so a wrong
//! `secret_ref` is answered with a 400 there rather than found by a poll.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::tasks::registry::{TaskContext, TaskHandler, TaskOutcome};

use super::service::IngestService;

/// Task type. A wire contract: stored on every queued run.
pub const TASK_TYPE: &str = "artifact.ingest";

/// What the REST route puts on the queue.
///
/// `Serialize` as well as `Deserialize`: the route builds one and the poll
/// endpoint reads it back off the run to answer with the repository it names,
/// so the two cannot drift.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestPayload {
    pub provider: String,
    #[serde(default)]
    pub base_url: Option<String>,
    /// credstore reference for the connector token — not the token.
    pub secret_ref: String,
    pub repo_full_path: String,
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub repo_dir: Option<String>,
}

pub struct IngestTask {
    service: Arc<IngestService>,
}

impl IngestTask {
    pub fn new(service: Arc<IngestService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl TaskHandler for IngestTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let payload: IngestPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(payload) => payload,
            // Written by a different version of this route; a retry cannot make
            // it readable.
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "studio-artifact-ingest: this run's payload is not a repository sync ({e})"
                ));
            }
        };

        // Per attempt, as the module note says. The worker's own identity: the
        // caller's is long gone, and a scheduled sync never had one.
        let token = match self
            .service
            .resolve_token(&ctx.security, &payload.secret_ref)
            .await
        {
            Ok(token) => token,
            Err(e) => {
                let error = format!("{e:#}");
                // A reference that is malformed, or one this identity cannot
                // read, will not become readable on the fourth attempt. A
                // credstore that is down will.
                if permanent_token_error(&error) {
                    return TaskOutcome::Failed(error);
                }
                return TaskOutcome::Retry(error);
            }
        };

        let (progress, drain) = ctx.progress_bridge();
        let outcome = self
            .service
            .run_sync(
                &ctx.security,
                &payload.provider,
                payload.base_url.as_deref(),
                &payload.secret_ref,
                &payload.repo_full_path,
                payload.since.as_deref(),
                &token,
                payload.workspace_id.as_deref(),
                payload.project_id.as_deref(),
                payload.repo_dir.as_deref(),
                &progress,
            )
            .await;
        // Drop the sender so the drain ends, then let it finish the queue.
        drop(progress);
        let _ = drain.await;

        match outcome {
            Ok(counts) => {
                let summary = format!(
                    "{}: {} issue(s), {} pull request(s), {} file(s), {} comment(s), \
                     {} commit(s), {} node(s) stored",
                    payload.repo_full_path,
                    counts.issues,
                    counts.pull_requests,
                    counts.files,
                    counts.comments,
                    counts.commits,
                    counts.stored,
                );
                match serde_json::to_value(counts) {
                    Ok(result) => TaskOutcome::done_with(summary, result),
                    // The sync happened; failing the run over a serialization
                    // problem would be a lie about the world.
                    Err(e) => {
                        tracing::warn!(
                            "studio-artifact-ingest: could not record the sync counts: {e}"
                        );
                        TaskOutcome::done(summary)
                    }
                }
            }
            Err(e) => {
                let error = format!("{e:#}");
                // A provider rate limit, a graph-storage blip, a clone the
                // network killed: all worth another attempt. A driver that is
                // not linked into this deployment is not — and a *scheduled*
                // sync naming a provider whose plugin was removed is the
                // ordinary way that happens.
                if error.contains("no driver for provider") {
                    TaskOutcome::Failed(error)
                } else {
                    TaskOutcome::Retry(error)
                }
            }
        }
    }
}

/// Whether a `resolve_token` failure is about the reference rather than about
/// credstore being reachable.
fn permanent_token_error(error: &str) -> bool {
    error.contains("bad secret reference") || error.contains("is not readable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_payload_round_trips_through_the_queue() {
        let payload = IngestPayload {
            provider: "github".to_owned(),
            base_url: None,
            secret_ref: "secret://tenant/github-token".to_owned(),
            repo_full_path: "org/repo".to_owned(),
            since: None,
            workspace_id: None,
            project_id: Some("11111111-1111-1111-1111-111111111111".to_owned()),
            repo_dir: Some("repo".to_owned()),
        };
        let back: IngestPayload =
            serde_json::from_value(serde_json::to_value(&payload).unwrap()).unwrap();
        assert_eq!(back.repo_full_path, "org/repo");
        assert_eq!(back.provider, "github");
        assert_eq!(back.repo_dir.as_deref(), Some("repo"));
    }

    #[test]
    fn a_payload_missing_the_repository_is_refused_where_it_is_read() {
        // A run that named no repository could only dead-letter, so serde is
        // the right place to say no.
        let json = serde_json::json!({ "provider": "github", "secret_ref": "s" });
        assert!(serde_json::from_value::<IngestPayload>(json).is_err());
    }

    #[test]
    fn the_payload_never_carries_the_token_itself() {
        // The reason this task type has a `secret_ref` and no `token` field:
        // the run is a row somebody can read.
        let json = serde_json::to_value(IngestPayload {
            provider: "github".to_owned(),
            base_url: None,
            secret_ref: "secret://tenant/github-token".to_owned(),
            repo_full_path: "org/repo".to_owned(),
            since: None,
            workspace_id: None,
            project_id: None,
            repo_dir: None,
        })
        .unwrap();
        assert!(json.get("token").is_none(), "{json}");
    }

    #[test]
    fn an_unreadable_secret_is_permanent_but_a_credstore_outage_is_not() {
        assert!(permanent_token_error("bad secret reference: empty"));
        assert!(permanent_token_error(
            "the token for 'x' is not readable (wrong scope or removed)"
        ));
        assert!(!permanent_token_error("credstore: connection refused"));
    }
}
