//! The `catalog.sync` task: crates.io and the gear repositories into the
//! catalog graph.
//!
//! ## Why this one moved
//!
//! A catalog sync lists ~70 crates under a keyword, then pulls each one's
//! detail and version history, throttled to be polite to crates.io — minutes,
//! not seconds. Like the artifact sync it was a `tokio::spawn` plus a
//! `Mutex<HashMap<String, TaskRecord>>`: a restart lost the record of a sync
//! that had really run, and the portal's poll answered "no such sync task".
//!
//! Now it is a run. Nothing else about the pipeline changed — it is handed a
//! place to report progress instead of a task id.

use std::sync::Arc;

use async_trait::async_trait;

use crate::tasks::registry::{TaskContext, TaskHandler, TaskOutcome};

use super::service::{CatalogService, SyncSources};

/// Task type. A wire contract: stored on every queued run.
pub const TASK_TYPE: &str = "catalog.sync";

pub struct CatalogSyncTask {
    service: Arc<CatalogService>,
}

impl CatalogSyncTask {
    pub fn new(service: Arc<CatalogService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl TaskHandler for CatalogSyncTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let sources: SyncSources = match serde_json::from_value(ctx.payload.clone()) {
            Ok(sources) => sources,
            // Written by a different version of this route; a retry cannot make
            // it readable.
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "studio-components-catalog: this run's payload is not a catalog sync ({e})"
                ));
            }
        };
        if sources.crates_io.is_none() && sources.repos.is_empty() {
            return TaskOutcome::Failed(
                "studio-components-catalog: this run names no source to read".to_owned(),
            );
        }

        let (progress, drain) = ctx.progress_bridge();
        let outcome = self
            .service
            .run_sync(&ctx.security, sources, &progress)
            .await;
        // Drop the sender so the drain ends, then let it finish the queue.
        drop(progress);
        let _ = drain.await;

        match outcome {
            Ok(counts) => {
                let summary = format!(
                    "{} gear(s), {} version(s), {} node(s) stored",
                    counts.gears, counts.versions, counts.stored,
                );
                match serde_json::to_value(counts) {
                    Ok(result) => TaskOutcome::done_with(summary, result),
                    // The sync happened; failing the run over a serialization
                    // problem would be a lie about the world.
                    Err(e) => {
                        tracing::warn!(
                            "studio-components-catalog: could not record the sync counts: {e}"
                        );
                        TaskOutcome::done(summary)
                    }
                }
            }
            // Nearly everything a catalog sync fails with is transient — a
            // crates.io rate limit, a graph-storage blip, a connector token
            // mid-rotation — and the one thing that is not (a source this
            // deployment cannot read at all) still costs one cheap listing per
            // attempt. So: retry, and let the attempt cap end it.
            Err(e) => TaskOutcome::Retry(format!("{e:#}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components_catalog::service::RepoSource;
    use uuid::Uuid;

    #[test]
    fn a_payload_round_trips_through_the_queue() {
        let sources = SyncSources {
            crates_io: Some("constructorfabric".to_owned()),
            repos: vec![RepoSource {
                tenant: Uuid::from_u128(3),
                connection_id: Some(Uuid::from_u128(4)),
                repo: "org/gears".to_owned(),
                git_ref: "main".to_owned(),
                mode: "gears".to_owned(),
            }],
        };
        let back: SyncSources =
            serde_json::from_value(serde_json::to_value(&sources).unwrap()).unwrap();
        assert_eq!(back.crates_io.as_deref(), Some("constructorfabric"));
        assert_eq!(back.repos.len(), 1);
        assert_eq!(back.repos[0].repo, "org/gears");
        assert_eq!(back.repos[0].tenant, Uuid::from_u128(3));
    }

    #[test]
    fn a_keyword_only_payload_is_still_a_payload() {
        // What `POST /sync` with no body enqueues.
        let back: SyncSources =
            serde_json::from_value(serde_json::json!({ "crates_io": "constructorfabric" }))
                .unwrap();
        assert!(back.repos.is_empty());
        assert_eq!(back.crates_io.as_deref(), Some("constructorfabric"));
    }
}
