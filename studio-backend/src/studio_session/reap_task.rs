//! The `session.reap` task: stop IDE sessions past their maximum age.
//!
//! ## Why this one moved
//!
//! This was a `tokio::time::interval` in the gear's `start`, ticking every 60
//! seconds in every replica, reporting to the log and nowhere else. Three
//! things were wrong with that. It fired N times per minute for N replicas,
//! each pass walking its own partial view of the world. Its cadence and its
//! very existence were compile-time facts — an operator who wanted it hourly,
//! or off for an afternoon, needed a redeploy. And it left no record: "reaped 3
//! expired session(s)" in one replica's log is not something anybody can look
//! up afterwards.
//!
//! Now the trigger is a schedule and the work is a run: one firing per
//! deployment, a cadence an operator owns, and a row per pass saying what it
//! stopped.
//!
//! ## The pass had to stop trusting its own memory first
//!
//! A scheduled run executes in whichever replica the queue hands it to, and
//! `SessionService`'s session map is per-process — it holds what this replica
//! launched plus what it adopted at boot. Reaping from that map in one replica
//! would have missed every session another replica launched since.
//!
//! So [`SessionService::reap_expired`] now lists the runtime through the driver
//! and reaps what it finds there. That is also the honest model of a session:
//! the container or Pod is the fact, and our map is a cache of it.

use std::sync::Arc;

use async_trait::async_trait;

use crate::tasks::registry::{TaskContext, TaskHandler, TaskOutcome};

use super::service::SessionService;

/// Task type. A wire contract: stored on every queued run.
pub const TASK_TYPE: &str = "session.reap";

/// How often the platform schedule fires it.
///
/// Five minutes rather than the old minute: a session's maximum age is measured
/// in hours (four, by default), so reaping one up to five minutes late is not a
/// difference anybody can perceive — and this asks the container runtime for a
/// full listing every time it runs.
pub const CRON: &str = "*/5 * * * *";

pub struct SessionReapTask {
    service: Arc<SessionService>,
}

impl SessionReapTask {
    pub fn new(service: Arc<SessionService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl TaskHandler for SessionReapTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        // No payload: what to reap is a property of the deployment
        // (`max_session_secs`), not of a firing. A schedule someone edited to
        // carry one is not an error worth failing over.
        let _ = &ctx.payload;

        match self.service.reap_expired().await {
            Ok(outcome) => {
                let summary = if outcome.expired == 0 {
                    "nothing expired".to_owned()
                } else {
                    format!(
                        "{} expired, {} stopped, {} refused",
                        outcome.expired, outcome.stopped, outcome.failed
                    )
                };
                match serde_json::to_value(outcome) {
                    Ok(result) => TaskOutcome::done_with(summary, result),
                    // The sessions are stopped; failing the run over a
                    // serialization problem would be a lie about the world.
                    Err(e) => {
                        tracing::warn!("studio-session: could not record the reap counts: {e}");
                        TaskOutcome::done(summary)
                    }
                }
            }
            // The runtime could not be listed: a Docker socket that went away,
            // a cluster API that is busy. Always transient — the sessions are
            // still there and the next attempt (or the next firing) sees them.
            Err(e) => TaskOutcome::Retry(format!(
                "studio-session: cannot list the session runtime: {e:#}"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cadence_is_a_five_field_cron_expression_this_deployment_accepts() {
        // The schedule is created at boot from this constant, and a schedule
        // the evaluator refuses would be a warning nobody reads.
        assert_eq!(CRON.split_whitespace().count(), 5);
        assert!(crate::scheduler::cron::Cron::parse(CRON).is_ok(), "{CRON}");
    }
}
