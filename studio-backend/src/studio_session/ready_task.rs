//! `session.await_ready` — the wait for an IDE session to answer.
//!
//! ## Why the browser could not keep doing this
//!
//! Kubernetes returns a session record before its Pod is scheduled, and a Pod
//! is `Running` well before Theia binds its port. Whether the IDE is answering
//! yet is therefore something only a probe can tell, and the probe lives in
//! [`SessionService::get`] — which means **the read is what advances the
//! state**. The portal's poll loop was not observing the transition, it was
//! causing it.
//!
//! That is a strange contract to hand a browser. Close the tab during a launch
//! and nothing probes; the session sits `starting` until somebody else asks.
//! And the wait was invisible: no record that a session took ninety seconds to
//! come up, or never did.
//!
//! So the probing read is a run. The portal follows it on `studio-events` like
//! any other background work, and a session comes up whether or not anyone is
//! watching.
//!
//! ## What the result deliberately does not carry
//!
//! The session URL. It embeds a one-shot gate token, and a run's `result` is
//! broadcast to every subscriber in the tenant — so publishing it there would
//! hand one person's IDE credential to everybody. The result says which
//! session reached which state; the caller re-reads the session record, with
//! its own token, to get the URL.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::service::SessionService;
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Task type. A wire contract: stored on every queued run.
pub const TASK_TYPE: &str = "session.await_ready";

/// How long one attempt watches before handing the wait back to the queue.
///
/// The portal's own loop allowed two minutes and that was the number people
/// complained about on a cold image pull. Three here, and running out is a
/// retry rather than a failure — the session is still coming up, and the next
/// attempt picks the probe back up.
const ATTEMPT_DEADLINE: Duration = Duration::from_secs(3 * 60);

/// How often the session is probed. The same second the browser used: this is
/// a TCP connect against a port that is about to open.
const PROBE_EVERY: Duration = Duration::from_secs(1);

/// Which session this run is waiting for.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadyPayload {
    pub session_id: Uuid,
}

/// Probes one starting session until it answers.
pub struct SessionReadyTask {
    service: Arc<SessionService>,
}

impl SessionReadyTask {
    pub fn new(service: Arc<SessionService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl TaskHandler for SessionReadyTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let payload: ReadyPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => return TaskOutcome::Failed(format!("unreadable await_ready payload: {e}")),
        };

        let started = Instant::now();
        let mut announced_starting = false;

        loop {
            if ctx.cancelled() {
                return TaskOutcome::Failed(format!(
                    "cancelled while waiting for session {} — the session itself is untouched",
                    payload.session_id
                ));
            }

            // This read IS the probe: it connects to the session port and
            // promotes `starting` to `running` when the IDE answers. It makes
            // no access decision and needs none -- a TaskContext is not a
            // SecurityContext, and this run exists because `create` already
            // authorized the launch it is waiting for.
            let Some(session) = self.service.probe(payload.session_id).await else {
                // Destroyed while we waited, or never ours. Either way there is
                // nothing left to wait for, and retrying cannot bring it back.
                return TaskOutcome::Failed(format!(
                    "session {} is gone (stopped, or never existed in this tenant)",
                    payload.session_id
                ));
            };

            match session.state.as_str() {
                "running" => {
                    return TaskOutcome::done_with(
                        format!("session ready in {}s", started.elapsed().as_secs().max(1)),
                        json!({
                            "session_id": payload.session_id,
                            "workspace_id": session.workspace_id,
                            "state": "running",
                        }),
                    );
                }
                "starting" => {
                    if !announced_starting {
                        announced_starting = true;
                        ctx.progress("starting").await;
                    }
                }
                // Stopped, or a state a newer driver reports: either way the
                // session is not coming up, and saying which state it reached
                // beats a generic timeout.
                other => {
                    return TaskOutcome::Failed(format!(
                        "session {} stopped before it became ready (state: {other})",
                        payload.session_id
                    ));
                }
            }

            if started.elapsed() > ATTEMPT_DEADLINE {
                return TaskOutcome::Retry(format!(
                    "session {} still starting after {} minutes",
                    payload.session_id,
                    ATTEMPT_DEADLINE.as_secs() / 60
                ));
            }

            tokio::select! {
                () = tokio::time::sleep(PROBE_EVERY) => {}
                // A Stop should not wait out the probe interval.
                () = ctx.cancel.cancelled() => {}
            }
        }
    }
}
