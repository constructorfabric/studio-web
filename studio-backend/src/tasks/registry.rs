//! The task contract, and the registry that binds a task type to code.
//!
//! ## Why the registry is a process-global
//!
//! A handler needs runtime state — the service that actually does the work —
//! so it cannot be submitted at link time the way `inventory` submits gears.
//! It has to be registered during some gear's `init`. But gear `init` order is
//! a topological sort over declared dependencies, and a handler's owner has no
//! reason to depend on `studio-tasks`: `studio-connector` does not need the
//! task manager to serve its REST surface, it only wants its imports to
//! survive a restart.
//!
//! Publishing the registry on the ClientHub would therefore be a race: a gear
//! whose `init` ran before `studio-tasks`' could not find it. So the registry
//! is a process-global in this crate. That is honest for a single-binary
//! assembly — it is the same scope `inventory` already uses for the gear set
//! itself — and it removes the ordering question rather than answering it.
//!
//! Registration is idempotent per task type and refuses a second, different
//! handler for the same type: two gears claiming one task type is a bug that
//! should be loud at boot, not a coin toss at dispatch.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use toolkit_security::SecurityContext;
use tracing::info;
use uuid::Uuid;

/// What a handler did with a task.
#[derive(Debug, Clone)]
pub enum TaskOutcome {
    /// Finished. `summary` is one line for a person — "412 nodes, 39 edges",
    /// not a log. `result` is for a program, and its shape belongs to the task
    /// type: this gear stores it and does not read it.
    ///
    /// Built through [`TaskOutcome::done`] / [`TaskOutcome::done_with`] /
    /// [`TaskOutcome::nothing`] rather than by hand.
    Done {
        summary: Option<String>,
        result: Option<Value>,
    },
    /// Did not finish, but might next time: a rate limit, a provider that is
    /// down, a lock somebody else holds. Retried with backoff up to the
    /// dispatcher's cap.
    Retry(String),
    /// Will not finish without a human. Goes straight to the dead-letter table
    /// and the run reads `failed`.
    Failed(String),
}

impl TaskOutcome {
    /// Finished, with a line for the history.
    pub fn done(summary: impl Into<String>) -> Self {
        Self::Done {
            summary: Some(summary.into()),
            result: None,
        }
    }

    /// Finished, with a line for a person and a result for a program.
    pub fn done_with(summary: impl Into<String>, result: Value) -> Self {
        Self::Done {
            summary: Some(summary.into()),
            result: Some(result),
        }
    }
}

/// Everything a handler is given, and the only things it may assume.
pub struct TaskContext {
    /// Tenant the run belongs to. Every read and write a handler makes must be
    /// scoped to it.
    pub tenant: Uuid,
    pub run_id: Uuid,
    /// Which task type this run is. Redundant for a handler that serves one
    /// type — which is all of them today — and there for the diagnostics a
    /// handler puts in its own logs.
    #[allow(
        dead_code,
        reason = "contract surface; first consumers are the handler migrations"
    )]
    pub task_type: String,
    /// Whatever the caller enqueued. The handler owns its own shape and is
    /// responsible for refusing a payload it does not recognise — a task
    /// enqueued by an older version of the code is a real case.
    pub payload: Value,
    /// 1 on the first attempt. A handler that wants to behave differently on a
    /// later attempt (skip an expensive precheck, say) reads this.
    pub attempt: i16,
    /// The worker's identity for this tenant. Not the identity of whoever
    /// asked: see the module note in [`super::dispatch`].
    ///
    /// Used by any handler that calls another gear — a repository import
    /// reaching `studio-connector`, a delivery reaching the notifier. The
    /// retention sweep touches only its own tables, so nothing reads it yet.
    #[allow(
        dead_code,
        reason = "contract surface; first consumers are the handler migrations"
    )]
    pub security: SecurityContext,
    /// Cancelled when somebody asked the run to stop, and when the process is
    /// shutting down. **Cooperative**: a handler that never checks it cannot be
    /// stopped, and cancellation will report as a request that was not honoured.
    pub cancel: CancellationToken,
    /// Report the current phase, for the poll endpoint. Cheap to call but not
    /// free — one UPDATE — so call it per phase, not per item.
    pub(super) progress: Arc<dyn ProgressSink>,
}

impl TaskContext {
    /// Record what the run is doing now.
    pub async fn progress(&self, phase: impl Into<String>) {
        self.progress
            .set(self.tenant, self.run_id, phase.into(), None)
            .await;
    }

    /// A progress handle for code that cannot await, and the task that drains
    /// it.
    ///
    /// Work that predates runs reports its phase from a plain `fn` — a
    /// `&dyn Fn(String)` callback, or a `&self` method deep in a pipeline —
    /// which cannot await a database write. The [`SyncReporter`] takes those
    /// calls without blocking and the returned task turns each one into a
    /// progress update.
    ///
    /// The channel is unbounded because a report must never make the work wait,
    /// and the work reports per phase, not per item. Drop the reporter and await
    /// the handle to be sure the last line was written:
    ///
    /// ```ignore
    /// let (progress, drain) = ctx.progress_bridge();
    /// let outcome = walk(&progress).await;
    /// drop(progress);
    /// let _ = drain.await;
    /// ```
    pub fn progress_bridge(&self) -> (SyncReporter, JoinHandle<()>) {
        let (tx, mut rx) = mpsc::unbounded_channel::<(String, Option<Value>)>();
        let sink = Arc::clone(&self.progress);
        let (tenant, run_id) = (self.tenant, self.run_id);
        let drain = tokio::spawn(async move {
            while let Some((phase, detail)) = rx.recv().await {
                sink.set(tenant, run_id, phase, detail).await;
            }
        });
        (SyncReporter { tx }, drain)
    }

    /// Whether somebody has asked this run to stop.
    ///
    /// A long-running handler should check this between units of work and
    /// return [`TaskOutcome::Failed`] with a reason mentioning cancellation, or
    /// finish early with [`TaskOutcome::Done`] — whichever leaves the world in
    /// a coherent state.
    pub fn cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

/// Progress reporting from code that cannot await. Built by
/// [`TaskContext::progress_bridge`].
#[derive(Clone)]
pub struct SyncReporter {
    tx: mpsc::UnboundedSender<(String, Option<Value>)>,
}

impl SyncReporter {
    /// Record the current phase.
    pub fn set(&self, phase: impl Into<String>) {
        self.send(phase.into(), None);
    }

    /// Record the current phase and what the run has counted so far.
    ///
    /// The detail lands in the run's `result`, where a poll endpoint reads it:
    /// partial while the run works, replaced by the handler's own result when
    /// it finishes. That is why the two want the same shape — an import's poll
    /// response must not lose its comment count the moment it succeeds.
    pub fn set_with(&self, phase: impl Into<String>, detail: Value) {
        self.send(phase.into(), Some(detail));
    }

    fn send(&self, phase: String, detail: Option<Value>) {
        // A closed channel means the drain is gone, which happens on the way
        // out. Losing a progress line then is not worth noticing.
        let _ = self.tx.send((phase, detail));
    }
}

/// How a [`TaskContext`] writes progress back. A trait so the contract does not
/// drag a database handle through every handler signature.
#[async_trait]
pub(super) trait ProgressSink: Send + Sync + 'static {
    /// `detail`, when given, replaces the run's `result`; `None` leaves
    /// whatever is there alone, so a phase line does not erase counts an
    /// earlier one reported.
    async fn set(&self, tenant: Uuid, run_id: Uuid, phase: String, detail: Option<Value>);
}

/// One kind of background work.
#[async_trait]
pub trait TaskHandler: Send + Sync + 'static {
    /// Stable identifier, `<gear>.<verb>` — `connector.graph_sync`,
    /// `notify.deliver`. It is stored on every run and on every queue payload,
    /// so it is a wire contract: renaming one orphans the runs already queued
    /// under the old name.
    fn task_type(&self) -> &'static str;

    /// Do the work.
    ///
    /// Runs outside any database transaction, with a lease — so it may take as
    /// long as it needs, and it must be safe to run twice. A handler that
    /// cannot be made idempotent has to make its own writes conditional.
    async fn run(&self, ctx: &TaskContext) -> TaskOutcome;

    /// How many attempts this kind of work gets before it is dead-lettered.
    ///
    /// The default suits work that is expensive and rarely transient — a
    /// repository import that has failed five times is not usually about to
    /// succeed. Work whose failures are mostly rate limits wants more: a chat
    /// platform's 429 clears on its own, and giving up on a notification after
    /// five backoffs would drop a message the platform was only asking us to
    /// slow down about.
    fn max_attempts(&self) -> i16 {
        super::DEFAULT_MAX_ATTEMPTS
    }
}

/// The process-wide task-type → handler map.
static HANDLERS: RwLock<BTreeMap<&'static str, Arc<dyn TaskHandler>>> =
    RwLock::new(BTreeMap::new());

/// Make a task type executable. Called by the gear that owns the work, during
/// its `init`.
///
/// # Errors
///
/// Refuses a second handler for a task type that already has one.
pub fn register(handler: Arc<dyn TaskHandler>) -> anyhow::Result<()> {
    let task_type = handler.task_type();
    let mut handlers = HANDLERS
        .write()
        .map_err(|_| anyhow::anyhow!("studio-tasks: handler registry poisoned"))?;
    if handlers.contains_key(task_type) {
        return Err(anyhow::anyhow!(
            "studio-tasks: task type '{task_type}' already has a handler — two gears \
             cannot own one task type"
        ));
    }
    handlers.insert(task_type, handler);
    info!(task_type, "studio-tasks: handler registered");
    Ok(())
}

/// The handler for a task type, if this deployment has one.
pub fn handler(task_type: &str) -> Option<Arc<dyn TaskHandler>> {
    HANDLERS.read().ok()?.get(task_type).cloned()
}

/// Every registered task type, for the REST surface and for refusing an
/// enqueue of something nothing can run.
pub fn known_task_types() -> Vec<&'static str> {
    HANDLERS
        .read()
        .map(|h| h.keys().copied().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Stub(&'static str);

    #[async_trait]
    impl TaskHandler for Stub {
        fn task_type(&self) -> &'static str {
            self.0
        }
        async fn run(&self, _ctx: &TaskContext) -> TaskOutcome {
            TaskOutcome::done("stub")
        }
    }

    #[test]
    fn a_registered_type_becomes_resolvable_and_is_listed() {
        // A distinctive name: the registry is process-global, so tests share it.
        register(Arc::new(Stub("test.registered"))).unwrap();
        assert!(handler("test.registered").is_some());
        assert!(known_task_types().contains(&"test.registered"));
    }

    #[test]
    fn a_second_handler_for_one_type_is_refused_not_silently_replaced() {
        register(Arc::new(Stub("test.contested"))).unwrap();
        let err = register(Arc::new(Stub("test.contested")))
            .unwrap_err()
            .to_string();
        assert!(err.contains("already has a handler"), "{err}");
    }

    #[test]
    fn an_unknown_type_resolves_to_nothing_rather_than_a_default() {
        assert!(handler("test.never-registered").is_none());
    }
}
