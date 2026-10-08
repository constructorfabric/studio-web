//! The `reports.refresh` task: read a report's plan again and queue a sync of
//! its board.
//!
//! What a person's "Refresh" queues, and what a schedule targets to keep a
//! report current on its own. Schedules are platform-level -- they fire in the
//! platform tenant -- so a schedule's payload names the organization
//! (`{ "report": "roadmap", "organization_id": "…" }`), and a run that fires
//! elsewhere hands itself to that organization: it queues the same refresh in
//! the organization's tenant, where its source is.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use toolkit::client_hub::{ClientHub, ClientScope};
use uuid::Uuid;

use super::service::{ReportsService, kind};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Task type. A wire contract: stored on every queued run and every schedule.
pub const TASK_TYPE: &str = "reports.refresh";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RefreshPayload {
    pub report: String,
    /// The organization whose report it is, when the run may fire elsewhere
    /// (a schedule's). Absent: the run's own tenant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<Uuid>,
}

pub struct RefreshTask {
    service: Arc<ReportsService>,
    hub: Arc<ClientHub>,
}

impl RefreshTask {
    pub fn new(service: Arc<ReportsService>, hub: Arc<ClientHub>) -> Self {
        Self { service, hub }
    }
}

/// Where a run does its work: here, or handed to another organization.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Here,
    HandTo(Uuid),
}

pub fn route(p: &RefreshPayload, run_tenant: Uuid) -> Route {
    match p.organization_id {
        Some(org) if org != run_tenant => Route::HandTo(org),
        _ => Route::Here,
    }
}

/// The run's payload, or why it cannot be one.
pub fn payload_of(v: &serde_json::Value) -> Result<RefreshPayload, String> {
    let p: RefreshPayload = serde_json::from_value(v.clone())
        .map_err(|e| format!("studio-reports: this run's payload is not a refresh ({e})"))?;
    if kind(&p.report).is_none() {
        return Err(format!("studio-reports: there is no report `{}`", p.report));
    }
    Ok(p)
}

#[async_trait]
impl TaskHandler for RefreshTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let p = match payload_of(&ctx.payload) {
            Ok(p) => p,
            // Written by another version, or naming a report gone since: a
            // retry cannot fix either.
            Err(e) => return TaskOutcome::Failed(e),
        };
        if let Route::HandTo(org) = route(&p, ctx.tenant) {
            return self.hand_to(ctx, org, &p.report).await;
        }
        match self.service.refresh(&ctx.security, &p.report).await {
            Ok(r) => {
                let summary = match r.sync_run {
                    Some(run) => format!("plan read; board sync {run} queued"),
                    None => "plan read".to_string(),
                };
                match serde_json::to_value(&r) {
                    Ok(result) => TaskOutcome::done_with(summary, result),
                    Err(_) => TaskOutcome::done(summary),
                }
            }
            // The usual causes -- a file the token cannot see, a plan that
            // names no board -- are a person's to fix, and are recorded on the
            // source for them to read; one retry covers a network blip.
            Err(e) => TaskOutcome::Retry(format!("{e:#}")),
        }
    }

    fn max_attempts(&self) -> i16 {
        2
    }
}

impl RefreshTask {
    async fn hand_to(&self, ctx: &TaskContext, org: Uuid, report: &str) -> TaskOutcome {
        match self
            .hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            )) {
            Ok(queue) => hand_to(queue.as_ref(), &ctx.security, org, report).await,
            Err(_) => TaskOutcome::Retry("studio-tasks is not available".to_string()),
        }
    }
}

/// Queue the same refresh in the organization's tenant, where its source is
/// and where the worker reads and writes as that organization. The handed-on
/// payload names no organization, so it cannot hand itself on again.
pub async fn hand_to(
    queue: &dyn crate::tasks::TaskQueue,
    security: &toolkit_security::SecurityContext,
    org: Uuid,
    report: &str,
) -> TaskOutcome {
    let payload = match serde_json::to_value(RefreshPayload {
        report: report.to_string(),
        organization_id: None,
    }) {
        Ok(p) => p,
        Err(e) => return TaskOutcome::Failed(e.to_string()),
    };
    match queue
        .enqueue(
            security,
            crate::tasks::sdk::NewRun {
                tenant: org,
                task_type: TASK_TYPE,
                payload,
                partition_key: Some("reports"),
                idempotency_key: None,
                coalesce_queued: true,
                notify_workspace_id: None,
            },
        )
        .await
    {
        Ok(run) => TaskOutcome::done(format!("handed to organization {org}: run {run}")),
        Err(e) => TaskOutcome::Retry(format!("{e:#}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_payload_names_a_report_this_deployment_has() {
        assert_eq!(
            payload_of(&json!({ "report": "roadmap" })),
            Ok(RefreshPayload {
                report: "roadmap".into(),
                organization_id: None,
            })
        );
        let org = Uuid::from_u128(7);
        assert_eq!(
            payload_of(&json!({ "report": "roadmap", "organization_id": org }))
                .map(|p| p.organization_id),
            Ok(Some(org))
        );
        assert!(payload_of(&json!({ "report": "roadmap", "organization_id": "nope" })).is_err());
        assert!(
            payload_of(&json!({ "report": "weekly" }))
                .unwrap_err()
                .contains("no report")
        );
        assert!(
            payload_of(&json!({}))
                .unwrap_err()
                .contains("not a refresh")
        );
        assert!(payload_of(&json!("roadmap")).is_err());
    }

    #[test]
    fn a_scheduled_run_is_handed_to_the_organization_it_names() {
        let org = Uuid::from_u128(7);
        let root = Uuid::from_u128(1);
        let p = |o: Option<Uuid>| RefreshPayload {
            report: "roadmap".into(),
            organization_id: o,
        };
        // Fired by the platform schedule, in the platform tenant.
        assert_eq!(route(&p(Some(org)), root), Route::HandTo(org));
        // Already in the organization: the work is done here.
        assert_eq!(route(&p(Some(org)), org), Route::Here);
        // A person's refresh names no organization: their own.
        assert_eq!(route(&p(None), root), Route::Here);
        // The handed-on payload names none, so it cannot hand itself on again.
        let handed = serde_json::to_value(p(None)).unwrap();
        assert!(handed.get("organization_id").is_none());
    }

    /// A queue that remembers what it was asked to queue.
    #[derive(Default)]
    struct Recorder {
        runs: std::sync::Mutex<Vec<(Uuid, String, serde_json::Value)>>,
        fail: bool,
    }

    #[async_trait]
    impl crate::tasks::TaskQueue for Recorder {
        async fn enqueue(
            &self,
            _ctx: &toolkit_security::SecurityContext,
            run: crate::tasks::sdk::NewRun<'_>,
        ) -> anyhow::Result<Uuid> {
            if self.fail {
                anyhow::bail!("queue down");
            }
            self.runs
                .lock()
                .unwrap()
                .push((run.tenant, run.task_type.to_string(), run.payload));
            Ok(Uuid::from_u128(42))
        }
        async fn run(
            &self,
            _tenant: Uuid,
            _run: Uuid,
        ) -> anyhow::Result<Option<crate::tasks::RunView>> {
            Ok(None)
        }
        async fn request_cancel(&self, _tenant: Uuid, _run: Uuid) -> anyhow::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_handed_on_refresh_is_queued_in_the_organizations_tenant() {
        let q = Recorder::default();
        let org = Uuid::from_u128(0xc31d);
        let root = crate::reports::test_ctx(1);
        let out = hand_to(&q, &root, org, "roadmap").await;
        assert!(matches!(out, TaskOutcome::Done { .. }), "{out:?}");
        let runs = q.runs.lock().unwrap().clone();
        assert_eq!(runs.len(), 1);
        assert_eq!(
            runs[0].0, org,
            "queued in the organization's tenant, not the platform's"
        );
        assert_eq!(runs[0].1, TASK_TYPE);
        // The handed-on run refreshes there and cannot hand itself on again.
        let handed = payload_of(&runs[0].2).unwrap();
        assert_eq!(route(&handed, org), Route::Here);
        assert_eq!(route(&handed, Uuid::from_u128(1)), Route::Here);
        // A queue that is down is worth another attempt.
        let down = Recorder {
            fail: true,
            ..Recorder::default()
        };
        assert!(matches!(
            hand_to(&down, &root, org, "roadmap").await,
            TaskOutcome::Retry(_)
        ));
    }

    #[test]
    fn a_payload_round_trips_through_the_queue() {
        let p = RefreshPayload {
            report: "roadmap".into(),
            organization_id: Some(Uuid::from_u128(9)),
        };
        let back = payload_of(&serde_json::to_value(&p).unwrap()).unwrap();
        assert_eq!(back, p);
    }
}
