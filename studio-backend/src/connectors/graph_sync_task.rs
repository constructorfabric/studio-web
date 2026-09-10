//! The `connector.graph_sync` task: walk a repository into the knowledge graph.
//!
//! ## Why this one moved first
//!
//! An import reads a repository's whole tree and its contributor list and
//! embeds every node it writes — measured at 12 seconds idle and over 30 under
//! load for 800 entries. It was already asynchronous, but its task state lived
//! in a `Mutex<HashMap<String, TaskRecord>>` that died with the process: a poll
//! arriving a second after a redeploy answered "no such task" about an import
//! that had really run, and there was no way to cancel one or retry it.
//!
//! Now it is a run: durable, retried with backoff, cancellable, and its counts
//! land in the run's `result` where the poll endpoint reads them.
//!
//! ## Progress crosses a sync boundary
//!
//! [`sync_repository`] reports its phase through a plain `&dyn Fn(String)`,
//! which cannot await a database write. So the callback hands its lines to a
//! [`SyncReporter`], and the drain task that comes with it turns each one into
//! a progress update. That keeps the walk's own signature untouched — it
//! predates all of this and has no business knowing about runs.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use toolkit::client_hub::{ClientHub, ClientScope};
use tracing::warn;
use uuid::Uuid;

use crate::tasks::registry::{TaskContext, TaskHandler, TaskOutcome};
use crate::user_profile::{AliasResolver, IDENTITY_INSTANCE_ID};

use super::graph_sync::{SyncRequest, sync_repository};
use super::service::ConnectorService;

/// Task type. A wire contract: stored on every queued run.
pub const TASK_TYPE: &str = "connector.graph_sync";

/// What the REST route puts on the queue.
///
/// `Serialize` as well as `Deserialize`: the route builds one of these and the
/// poll endpoint reads it back out of the run, so the two cannot drift.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPayload {
    pub connection_id: Uuid,
    pub repo_full_path: String,
    #[serde(default)]
    pub git_ref: Option<String>,
    pub max_entries: usize,
    pub max_contributors: u32,
    #[serde(default)]
    pub project_id: Option<Uuid>,
    #[serde(default)]
    pub project_name: Option<String>,
}

pub struct GraphSyncTask {
    service: Arc<ConnectorService>,
    hub: Arc<ClientHub>,
}

impl GraphSyncTask {
    pub fn new(service: Arc<ConnectorService>, hub: Arc<ClientHub>) -> Self {
        Self { service, hub }
    }
}

#[async_trait]
impl TaskHandler for GraphSyncTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let payload: SyncPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(payload) => payload,
            // Written by a different version of this route; a retry cannot make
            // it readable.
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "studio-connector: this run's payload is not a repository import ({e})"
                ));
            }
        };

        // Resolved per run, not held: graph-storage publishes its client in its
        // own `init`, and resolving here means this handler does not care which
        // gear initialized first.
        let graph = match self
            .hub
            .get::<dyn graph_storage_sdk::GraphStorageClientV1>()
        {
            Ok(graph) => graph,
            Err(e) => {
                warn!("studio-connector: graph-storage client not registered: {e}");
                return TaskOutcome::Retry(format!(
                    "the knowledge graph is not available in this deployment: {e}"
                ));
            }
        };
        // Absent when studio-user is inert; contributor nodes then stay keyed
        // per provider, which the walk already handles.
        let identity = self
            .hub
            .get_scoped::<dyn AliasResolver>(&ClientScope::gts_id(IDENTITY_INSTANCE_ID))
            .ok();

        // The walk reports phases synchronously; the bridge's drain task turns
        // them into progress writes.
        let (progress, drain) = ctx.progress_bridge();
        let outcome = {
            let report = |phase: String| progress.set(phase);
            sync_repository(
                &self.service,
                &graph,
                identity.as_ref(),
                &ctx.security,
                &SyncRequest {
                    connection_id: payload.connection_id,
                    tenant: ctx.tenant,
                    repo_full_path: &payload.repo_full_path,
                    git_ref: payload.git_ref.as_deref(),
                    max_entries: payload.max_entries,
                    max_contributors: payload.max_contributors,
                    project_id: payload.project_id,
                    project_name: payload.project_name.as_deref(),
                },
                &report,
            )
            .await
        };

        // Drop the sender so the drain ends, then let it finish the queue.
        drop(progress);
        let _ = drain.await;

        match outcome {
            Ok(outcome) => {
                let summary = format!(
                    "{} at {}: {} node(s), {} edge(s), {} file(s), {} contributor(s){}",
                    payload.repo_full_path,
                    outcome.git_ref,
                    outcome.nodes_upserted,
                    outcome.edges_upserted,
                    outcome.files,
                    outcome.contributors,
                    if outcome.truncated { ", truncated" } else { "" },
                );
                match serde_json::to_value(&outcome) {
                    Ok(result) => TaskOutcome::done_with(summary, result),
                    // The import happened; failing the run over a serialization
                    // problem would be a lie about the world.
                    Err(e) => {
                        warn!("studio-connector: could not record the import result: {e}");
                        TaskOutcome::done(summary)
                    }
                }
            }
            Err(e) => {
                let error = format!("{e:#}");
                // Most of what a walk fails with is worth another attempt: a
                // provider rate limit, a graph-storage blip, a token mid
                // rotation. The connection being gone is not — the route
                // refuses an unknown one up front, but a *scheduled* import
                // outliving the connection it names is the ordinary way this
                // happens, and retrying it five times helps nobody.
                let gone = error.contains("not found")
                    || error.contains("no driver for provider")
                    || error.contains("not readable");
                if gone {
                    TaskOutcome::Failed(error)
                } else {
                    TaskOutcome::Retry(error)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_payload_round_trips_through_the_queue() {
        let payload = SyncPayload {
            connection_id: Uuid::from_u128(7),
            repo_full_path: "org/repo".to_owned(),
            git_ref: Some("main".to_owned()),
            max_entries: 800,
            max_contributors: 50,
            project_id: None,
            project_name: None,
        };
        let json = serde_json::to_value(&payload).unwrap();
        let back: SyncPayload = serde_json::from_value(json).unwrap();
        assert_eq!(back.repo_full_path, "org/repo");
        assert_eq!(back.max_entries, 800);
        assert_eq!(back.git_ref.as_deref(), Some("main"));
    }

    #[test]
    fn a_vanished_connection_is_permanent_but_a_rate_limit_is_not() {
        // The distinction a scheduled import depends on: its connection can be
        // deleted between two firings, and that is not a transient fault.
        for (error, permanent) in [
            (
                "connection 3f7c1d84-9b2e-4a55-8c17-6e0b2f9d41aa not found",
                true,
            ),
            ("no driver for provider 'github' in this deployment", true),
            ("the token for connection 'Repo' is not readable", true),
            ("GitHub 429: rate limit exceeded", false),
            ("graph-storage 503", false),
        ] {
            let gone = error.contains("not found")
                || error.contains("no driver for provider")
                || error.contains("not readable");
            assert_eq!(gone, permanent, "{error}");
        }
    }

    #[test]
    fn a_payload_missing_the_repository_is_refused_where_it_is_read() {
        // Both required fields matter: a run that named neither could only
        // dead-letter, so serde is the right place to say no.
        let json = serde_json::json!({ "max_entries": 10, "max_contributors": 5 });
        assert!(serde_json::from_value::<SyncPayload>(json).is_err());
    }
}
