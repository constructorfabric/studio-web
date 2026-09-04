//! In-memory sync-task registry for the gears catalog.
//!
//! A catalog sync fetches ~70 crates + their versions from crates.io, which
//! takes a while (polite throttling), so it runs as a background task: the REST
//! call enqueues it and returns a task id, and the portal polls for progress.
//! State lives in memory and resets on restart — a sync is cheap to re-run.

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}

/// A snapshot of one catalog sync task, cloned out for the poll endpoint.
#[derive(Debug, Clone)]
pub struct TaskRecord {
    pub id: String,
    pub status: TaskStatus,
    /// Current phase while running, or the error message on failure.
    pub message: Option<String>,
    /// Gears (crates) discovered from the keyword listing.
    pub gears: u32,
    /// Version nodes built so far.
    pub versions: u32,
    /// Nodes flushed to the graph store so far.
    pub stored: u32,
}

#[derive(Default)]
pub struct TaskRegistry {
    inner: Mutex<HashMap<String, TaskRecord>>,
}

impl TaskRegistry {
    fn update<F: FnOnce(&mut TaskRecord)>(&self, id: &str, f: F) {
        if let Ok(mut map) = self.inner.lock()
            && let Some(rec) = map.get_mut(id)
        {
            f(rec);
        }
    }

    pub fn create(&self, id: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(
                id.to_string(),
                TaskRecord {
                    id: id.to_string(),
                    status: TaskStatus::Queued,
                    message: Some("queued".to_string()),
                    gears: 0,
                    versions: 0,
                    stored: 0,
                },
            );
        }
    }

    /// Update phase + running counts while the sync is in flight.
    pub fn report(&self, id: &str, message: &str, gears: u32, versions: u32, stored: u32) {
        self.update(id, |r| {
            r.status = TaskStatus::Running;
            r.message = Some(message.to_string());
            r.gears = gears;
            r.versions = versions;
            r.stored = stored;
        });
    }

    pub fn succeed(&self, id: &str, gears: u32, versions: u32, stored: u32) {
        self.update(id, |r| {
            r.status = TaskStatus::Succeeded;
            r.message = None;
            r.gears = gears;
            r.versions = versions;
            r.stored = stored;
        });
    }

    pub fn fail(&self, id: &str, error: &str) {
        self.update(id, |r| {
            r.status = TaskStatus::Failed;
            r.message = Some(error.to_string());
        });
    }

    pub fn get(&self, id: &str) -> Option<TaskRecord> {
        self.inner.lock().ok().and_then(|m| m.get(id).cloned())
    }
}
