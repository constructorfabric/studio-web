//! In-memory sync-task registry.
//!
//! Cloning a repository can take seconds, so a sync runs as a background task:
//! the REST call enqueues it and returns a task id, and the portal polls for
//! the outcome. State lives in memory (like the graph store) and resets on
//! restart — a sync is cheap to re-run.

use std::collections::HashMap;
use std::sync::Mutex;

/// Where a sync task is in its lifecycle.
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

/// A snapshot of one sync task, cloned out for the poll endpoint.
#[derive(Debug, Clone)]
pub struct TaskRecord {
    pub id: String,
    pub status: TaskStatus,
    pub repo_full_path: String,
    /// A short human line: the current phase, or the error on failure.
    pub message: Option<String>,
    pub issues: u32,
    pub pull_requests: u32,
    pub files: u32,
}

/// Concurrency-safe map of task id → record.
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

    /// Register a freshly-enqueued task.
    pub fn create(&self, id: &str, repo_full_path: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(
                id.to_string(),
                TaskRecord {
                    id: id.to_string(),
                    status: TaskStatus::Queued,
                    repo_full_path: repo_full_path.to_string(),
                    message: Some("queued".to_string()),
                    issues: 0,
                    pull_requests: 0,
                    files: 0,
                },
            );
        }
    }

    pub fn set_running(&self, id: &str, message: &str) {
        self.update(id, |r| {
            r.status = TaskStatus::Running;
            r.message = Some(message.to_string());
        });
    }

    pub fn succeed(&self, id: &str, issues: u32, pull_requests: u32, files: u32) {
        self.update(id, |r| {
            r.status = TaskStatus::Succeeded;
            r.message = None;
            r.issues = issues;
            r.pull_requests = pull_requests;
            r.files = files;
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
