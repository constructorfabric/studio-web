//! The `catalog.registry` task: walk an organization's projects into its
//! component registry (ADR-0041).
//!
//! Its own task type, and also the last phase of a `catalog.sync` that names
//! `registry: true` (what `POST /sync` without repositories queues), so the
//! button on the Components page refreshes both. Alone it is what a schedule
//! and a push queue:
//!
//! - **The schedule.** Schedules are platform-level -- they fire in the
//!   platform tenant -- so the hourly one names the organization in its
//!   payload (`{ "organization_id": "…" }`) and a run that fires elsewhere
//!   hands itself to that organization, as `reports.refresh` does. It is
//!   ensured when the organization saves its sources or its excluded projects
//!   ([`schedule_spec`]).
//! - **A push.** `studio-git` queues a run naming the pushed project
//!   (`project_ids`), through `port::Registry::queue_refresh`.
//!
//! Every run shares the `catalog` partition with `catalog.sync`: both write
//! the same organization's catalogue nodes, so they queue behind each other.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use toolkit::client_hub::{ClientHub, ClientScope};
use uuid::Uuid;

use super::service::CatalogService;
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Task type. A wire contract: stored on every queued run and every schedule.
pub const TASK_TYPE: &str = "catalog.registry";

/// Every hour, on the hour (UTC).
pub const HOURLY: &str = "0 * * * *";

/// The partition every write of one organization's catalogue queues in.
pub const PARTITION: &str = "catalog";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RegistryPayload {
    /// The organization whose registry it is, when the run may fire
    /// elsewhere (a schedule's). Absent: the run's own tenant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<Uuid>,
    /// Walk only these projects (a push names the one it went to). Empty:
    /// every project of the organization, and what is gone is pruned.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub project_ids: Vec<Uuid>,
}

/// Where a run does its work: here, or handed to another organization.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Here,
    HandTo(Uuid),
}

pub fn route(p: &RegistryPayload, run_tenant: Uuid) -> Route {
    match p.organization_id {
        Some(org) if org != run_tenant => Route::HandTo(org),
        _ => Route::Here,
    }
}

/// The schedule that keeps one organization's registry current.
pub fn schedule_spec(org: Uuid) -> crate::scheduler::port::ScheduleSpec {
    crate::scheduler::port::ScheduleSpec {
        // Names are unique per tenant, and every one of these lives in the
        // platform's: the organization makes it one.
        name: format!("Refresh the component registry of {org}"),
        task_type: TASK_TYPE,
        payload: schedule_payload(org),
        cron: HOURLY.to_string(),
        enabled: true,
    }
}

/// The payload a schedule fires with, and what finds it again.
pub fn schedule_payload(org: Uuid) -> serde_json::Value {
    serde_json::json!({ "organization_id": org })
}

pub struct RegistryTask {
    service: Arc<CatalogService>,
    hub: Arc<ClientHub>,
}

impl RegistryTask {
    pub fn new(service: Arc<CatalogService>, hub: Arc<ClientHub>) -> Self {
        Self { service, hub }
    }
}

#[async_trait]
impl TaskHandler for RegistryTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let p: RegistryPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "studio-components-catalog: this run's payload is not a registry walk ({e})"
                ));
            }
        };
        if let Route::HandTo(org) = route(&p, ctx.tenant) {
            return match queue(&self.hub) {
                Ok(queue) => {
                    let handed = RegistryPayload {
                        organization_id: None,
                        project_ids: p.project_ids,
                    };
                    match enqueue(queue.as_ref(), &ctx.security, org, &handed).await {
                        Ok(run) => {
                            TaskOutcome::done(format!("handed to organization {org}: run {run}"))
                        }
                        Err(e) => TaskOutcome::Retry(format!("{e:#}")),
                    }
                }
                Err(e) => TaskOutcome::Retry(format!("{e:#}")),
            };
        }
        let (progress, drain) = ctx.progress_bridge();
        let outcome = self
            .service
            .run_registry(&ctx.security, &p.project_ids, &progress)
            .await;
        drop(progress);
        let _ = drain.await;
        match outcome {
            Ok(counts) => {
                let summary = format!(
                    "{} project(s): {} repository(ies) read, {} unchanged; {} new entr(ies)",
                    counts.projects,
                    counts.repos_read,
                    counts.repos_unchanged,
                    counts.entries_created,
                );
                match serde_json::to_value(&counts) {
                    Ok(result) => TaskOutcome::done_with(summary, result),
                    Err(_) => TaskOutcome::done(summary),
                }
            }
            // A tree listing or a graph write that failed is usually
            // transient; the attempt cap ends the rest.
            Err(e) => TaskOutcome::Retry(format!("{e:#}")),
        }
    }

    fn max_attempts(&self) -> i16 {
        2
    }
}

/// The task queue, when studio-tasks has one.
pub fn queue(hub: &ClientHub) -> anyhow::Result<Arc<dyn crate::tasks::TaskQueue>> {
    hub.get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
        crate::tasks::TASK_QUEUE_INSTANCE_ID,
    ))
    .map_err(|_| anyhow::anyhow!("studio-tasks is not available in this deployment"))
}

/// Queue a walk in the organization's tenant, where its registry is.
pub async fn enqueue(
    queue: &dyn crate::tasks::TaskQueue,
    security: &toolkit_security::SecurityContext,
    org: Uuid,
    payload: &RegistryPayload,
) -> anyhow::Result<Uuid> {
    queue
        .enqueue(
            security,
            crate::tasks::sdk::NewRun {
                tenant: org,
                task_type: TASK_TYPE,
                payload: serde_json::to_value(payload)?,
                partition_key: Some(PARTITION),
                idempotency_key: None,
                coalesce_queued: true,
                notify_workspace_id: None,
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_scheduled_run_is_handed_to_the_organization_it_names() {
        let org = Uuid::from_u128(7);
        let root = Uuid::from_u128(1);
        let p = |o: Option<Uuid>| RegistryPayload {
            organization_id: o,
            project_ids: Vec::new(),
        };
        assert_eq!(route(&p(Some(org)), root), Route::HandTo(org));
        assert_eq!(route(&p(Some(org)), org), Route::Here);
        assert_eq!(route(&p(None), root), Route::Here);
    }

    #[test]
    fn the_schedule_names_the_organization_and_finds_itself_again() {
        let org = Uuid::from_u128(9);
        let spec = schedule_spec(org);
        assert_eq!(spec.task_type, TASK_TYPE);
        assert_eq!(spec.cron, HOURLY);
        assert!(crate::scheduler::port::payload_matches(
            &spec.payload,
            &schedule_payload(org)
        ));
        let back: RegistryPayload = serde_json::from_value(spec.payload).unwrap();
        assert_eq!(back.organization_id, Some(org));
        assert!(back.project_ids.is_empty());
    }

    #[test]
    fn a_push_payload_names_its_projects_and_an_empty_one_is_everything() {
        let p = Uuid::from_u128(3);
        let back: RegistryPayload = serde_json::from_value(json!({ "project_ids": [p] })).unwrap();
        assert_eq!(back.project_ids, vec![p]);
        let all: RegistryPayload = serde_json::from_value(json!({})).unwrap();
        assert_eq!(all, RegistryPayload::default());
        assert_eq!(serde_json::to_value(&all).unwrap(), json!({}));
    }
}
