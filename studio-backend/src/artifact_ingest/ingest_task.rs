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
use uuid::Uuid;

use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

use super::service::IngestService;

/// Task type. A wire contract: stored on every queued run.
pub const TASK_TYPE: &str = "artifact.ingest";

/// One ingest at a time in this process.
///
/// The task queue runs eight handlers at once, and runs for different
/// repositories do not share a partition, so two large repositories could
/// ingest side by side and peak together -- the shape of the OOM kills on
/// studio-dev (studio-web#561). A second ingest waits here instead. Other task
/// types are not held up: the wait occupies one worker, and there are eight.
static INGEST_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

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

impl IngestPayload {
    /// The tenant the sync is for: its project, else its workspace, else
    /// `run_tenant` (the run's own). An id that does not parse is the run's
    /// tenant too: the ownership check then asks about that.
    pub fn tenant(&self, run_tenant: Uuid) -> Uuid {
        self.project_id
            .as_deref()
            .or(self.workspace_id.as_deref())
            .and_then(|id| Uuid::parse_str(id.trim()).ok())
            .unwrap_or(run_tenant)
    }

    /// Two syncs that would write the same graph keys must not run at once.
    /// Those keys are built from exactly these four things (see `gts::*_node`),
    /// so the same four make the partition key: the same repository under a
    /// different project is a different set of nodes and may run in parallel.
    ///
    /// Both enqueues of this task — the portal's sync and a push through
    /// `studio-git` — take the key from here, so the two queue behind each
    /// other instead of racing on one checkout.
    pub fn partition_key(&self) -> String {
        let scope = self
            .project_id
            .as_deref()
            .or(self.workspace_id.as_deref())
            .unwrap_or("unscoped");
        format!(
            "{}:{}:{scope}:{}",
            self.provider, self.secret_ref, self.repo_full_path
        )
    }
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

        // The token must be the organization's own, whoever enqueued the run
        // (`connectors::sdk::ownership`). Permanent: retrying cannot change
        // whose connection it is.
        if let Err(refused) = self
            .service
            .ensure_token_owned(
                &ctx.security,
                ctx.tenant,
                payload.tenant(ctx.tenant),
                &payload.secret_ref,
            )
            .await
        {
            return TaskOutcome::Failed(format!(
                "studio-artifact-ingest: {repo} is not read with this token: {refused}",
                repo = payload.repo_full_path
            ));
        }

        // Per attempt, as the module note says. The worker's own identity: the
        // caller's is long gone, and a scheduled sync never had one.
        let token = match self
            .service
            .resolve_token(&ctx.security, &payload.secret_ref)
            .await
        {
            Ok(Some(token)) => token,
            // Nothing stored under that reference. A public repository does not
            // need one, so the run proceeds unauthenticated rather than
            // dead-lettering; a private one will fail at the provider, which
            // says more about what is wrong than we can from here.
            Ok(None) => {
                tracing::warn!(
                    secret_ref = %payload.secret_ref,
                    repo = %payload.repo_full_path,
                    "studio-artifact-ingest: no readable token — syncing without credentials"
                );
                String::new()
            }
            Err(e) => {
                let error = format!("{e:#}");
                // A malformed reference will not become well-formed on the
                // fourth attempt. A credstore that is down will come back.
                if permanent_token_error(&error) {
                    return TaskOutcome::Failed(error);
                }
                return TaskOutcome::Retry(error);
            }
        };

        let (progress, drain) = ctx.progress_bridge();
        // Held until the sync returns. A closed semaphore cannot happen -- it is
        // a static nobody closes -- so an error just runs unguarded. A run that
        // has to wait says so, rather than sitting at "queued" looking stuck.
        let _slot = match INGEST_SLOT.try_acquire() {
            Ok(slot) => Some(slot),
            Err(_) => {
                progress.set("waiting for another repository's sync to finish…");
                INGEST_SLOT.acquire().await.ok()
            }
        };
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
                let mut summary = format!(
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
                // Only when it happened: most syncs forget nothing, and "0
                // deleted file(s) forgotten" on every one of them is noise.
                if counts.pruned > 0 {
                    summary.push_str(&format!(", {} deleted file(s) forgotten", counts.pruned));
                }
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
///
/// An absent secret is no longer in here: it does not fail the run at all, it
/// runs it unauthenticated. What remains is a reference that cannot be parsed,
/// which no number of attempts will fix.
fn permanent_token_error(error: &str) -> bool {
    error.contains("bad secret reference")
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
    fn a_run_is_for_its_project_else_its_workspace_else_its_own_tenant() {
        let run = Uuid::from_u128(1);
        let project = Uuid::from_u128(2);
        let workspace = Uuid::from_u128(3);
        let mut payload = IngestPayload {
            provider: "github".to_owned(),
            base_url: None,
            secret_ref: "s".to_owned(),
            repo_full_path: "org/repo".to_owned(),
            since: None,
            workspace_id: Some(workspace.to_string()),
            project_id: Some(project.to_string()),
            repo_dir: None,
        };
        assert_eq!(payload.tenant(run), project);
        payload.project_id = None;
        assert_eq!(payload.tenant(run), workspace);
        payload.workspace_id = Some("not-a-tenant".to_owned());
        assert_eq!(payload.tenant(run), run);
    }

    #[test]
    fn a_malformed_reference_is_permanent_but_a_credstore_outage_is_not() {
        assert!(permanent_token_error("bad secret reference: empty"));
        assert!(!permanent_token_error("credstore: connection refused"));
    }
}
