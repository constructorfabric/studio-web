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

use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

use super::service::{CatalogCounts, CatalogService, SyncSources};

/// Task type. A wire contract: stored on every queued run.
pub const TASK_TYPE: &str = "catalog.sync";

/// Every day at 03:00 UTC: the platform's catalogue (ADR-0042) follows its
/// sources once a day; its administrator syncs sooner from the page.
pub const DAILY: &str = "0 3 * * *";

/// The payload of a sync of the platform's catalogue: its stored sources,
/// read when the run starts.
pub fn platform_payload() -> serde_json::Value {
    serde_json::json!({ "platform": true })
}

/// The schedule that keeps the platform's catalogue current. Schedules fire
/// in the platform's tenant, which is where this one's run belongs.
pub fn platform_schedule_spec() -> crate::scheduler::port::ScheduleSpec {
    crate::scheduler::port::ScheduleSpec {
        name: "Sync the platform's component catalogue".to_owned(),
        task_type: TASK_TYPE,
        payload: platform_payload(),
        cron: DAILY.to_owned(),
        enabled: true,
    }
}

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
        let mut sources: SyncSources = match serde_json::from_value(ctx.payload.clone()) {
            Ok(sources) => sources,
            // Written by a different version of this route; a retry cannot make
            // it readable.
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "studio-components-catalog: this run's payload is not a catalog sync ({e})"
                ));
            }
        };
        // The platform's catalogue (ADR-0042): what its administrator saved,
        // read now, so a schedule syncs today's sources. Only ever in the
        // platform's tenant.
        let mut security = ctx.security.clone();
        if sources.platform {
            if ctx.tenant != super::tiers::PLATFORM_TENANT {
                return TaskOutcome::Failed(
                    "studio-components-catalog: the platform's catalogue syncs in the platform's tenant only".to_owned(),
                );
            }
            security = match super::registry::in_tenant(&ctx.security, ctx.tenant) {
                Ok(s) => s,
                Err(e) => return TaskOutcome::Failed(format!("studio-components-catalog: {e:#}")),
            };
            sources = match self.service.platform_sync_sources(&security).await {
                Ok(s) if s.names_a_catalogue_source() => s,
                Ok(_) => {
                    return TaskOutcome::done(
                        "the platform names no catalogue source; nothing to sync",
                    );
                }
                Err(e) => return TaskOutcome::Failed(format!("studio-components-catalog: {e:#}")),
            };
        }
        if !sources.names_a_catalogue_source() && !sources.registry {
            return TaskOutcome::Failed(
                "studio-components-catalog: this run names no source to read".to_owned(),
            );
        }
        // An organization's sync leaves to the platform what the platform's
        // catalogue already reads (ADR-0042 §3): reading it here only writes
        // nodes the organization's reads then hide.
        let left = if sources.platform || super::tiers::is_platform(&security) {
            Vec::new()
        } else {
            self.service
                .leave_to_platform(&security, &mut sources)
                .await
        };
        // An organization reads only through connections it owns; the
        // platform's sync, in the root, reads with the root's by design.
        let not_owned = if super::tiers::is_platform(&security) {
            Vec::new()
        } else {
            self.service
                .retain_owned_sources(&security, &mut sources)
                .await
        };

        let (progress, drain) = ctx.progress_bridge();
        let registry = sources.registry;
        let mut outcome = if sources.names_a_catalogue_source() {
            self.service.run_sync(&security, sources, &progress).await
        } else {
            Ok(CatalogCounts::default())
        };
        if let Ok(counts) = &mut outcome {
            counts.left_to_platform = left;
            counts.not_owned = not_owned;
        }
        // The registry phase, last: the catalogue is written whether or not
        // it finishes, and the run's result says how it went.
        if registry && let Ok(counts) = &mut outcome {
            match self.service.run_registry(&security, &[], &progress).await {
                Ok(r) => counts.registry = Some(r),
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), "studio-components-catalog: the registry phase failed");
                    counts.registry_error = Some(format!("{e:#}"));
                }
            }
        }
        // Drop the sender so the drain ends, then let it finish the queue.
        drop(progress);
        let _ = drain.await;

        match outcome {
            Ok(counts) => {
                let mut summary = format!(
                    "{} gear(s), {} version(s), {} node(s) stored",
                    counts.gears, counts.versions, counts.stored,
                );
                if let Some(r) = &counts.registry {
                    summary.push_str(&format!(
                        "; registry: {} project(s), {} new entr(ies)",
                        r.projects, r.entries_created
                    ));
                }
                if !counts.left_to_platform.is_empty() {
                    summary.push_str(&format!(
                        "; left to the platform's catalogue: {}",
                        counts.left_to_platform.join(", ")
                    ));
                }
                if !counts.not_owned.is_empty() {
                    summary.push_str(&format!(
                        "; not read, its connection is not the organization's: {}",
                        counts.not_owned.join(", ")
                    ));
                }
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
            roadmaps: Vec::new(),
            registry: false,
            platform: false,
        };
        let back: SyncSources =
            serde_json::from_value(serde_json::to_value(&sources).unwrap()).unwrap();
        assert_eq!(back.crates_io.as_deref(), Some("constructorfabric"));
        assert_eq!(back.repos.len(), 1);
        assert_eq!(back.repos[0].repo, "org/gears");
        assert_eq!(back.repos[0].tenant, Uuid::from_u128(3));
    }

    #[test]
    fn a_registry_only_payload_names_a_source_and_no_catalogue_source() {
        let back: SyncSources =
            serde_json::from_value(serde_json::json!({ "registry": true })).unwrap();
        assert!(back.registry);
        assert!(!back.names_a_catalogue_source());
        // An older payload has no `registry` and keeps meaning what it meant.
        let old: SyncSources =
            serde_json::from_value(serde_json::json!({ "crates_io": "k" })).unwrap();
        assert!(!old.registry);
        assert!(
            !serde_json::to_value(&old)
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("registry")
        );
    }

    #[test]
    fn the_platform_schedule_syncs_the_platform_from_its_stored_sources() {
        let spec = platform_schedule_spec();
        assert_eq!(spec.task_type, TASK_TYPE);
        assert_eq!(spec.cron, DAILY);
        let back: SyncSources = serde_json::from_value(spec.payload.clone()).unwrap();
        assert!(back.platform);
        assert!(!back.registry);
        assert!(!back.names_a_catalogue_source());
        assert!(crate::scheduler::port::payload_matches(
            &spec.payload,
            &platform_payload()
        ));
        // An organization's payload does not name it.
        let org: SyncSources =
            serde_json::from_value(serde_json::json!({ "crates_io": "k" })).unwrap();
        assert!(!org.platform);
        assert!(
            !serde_json::to_value(&org)
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("platform")
        );
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
