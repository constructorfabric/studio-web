//! What another gear needs to run its work here, and nothing else.
//!
//! A producer registers a [`TaskHandler`] for its task type at `init` and
//! enqueues a [`NewRun`] through the [`TaskQueue`](super::TaskQueue) client on
//! the ClientHub. The handler gets a [`TaskContext`], may report progress with
//! a [`SyncReporter`], and ends with a [`TaskOutcome`]. `studio-scheduler`
//! also asks which task types exist ([`known_task_types`], [`handler`]) to
//! refuse a schedule for one that does not.
//!
//! The registry, the service and the dispatcher behind these stay private to
//! the gear.

pub use super::registry::{
    SyncReporter, TaskContext, TaskHandler, TaskOutcome, handler, known_task_types, register,
};
pub use super::service::NewRun;
