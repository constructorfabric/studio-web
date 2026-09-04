//! In-memory registry of repository-import tasks.
//!
//! An import walks a repository through the provider API and the gear embeds
//! every node it writes, which for a few hundred files takes longer than the
//! gateway's request deadline (measured: 12 s idle, over 30 s under load for
//! 800 entries). So `POST …/graph-sync` enqueues and returns a task id, and the
//! caller polls — the same shape studio-artifact-ingest uses. State is
//! in-memory and resets on restart; an import is cheap to re-run and converges.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use uuid::Uuid;

use super::graph_sync::SyncOutcome;

/// Where an import is in its lifecycle.
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

    fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed)
    }
}

/// A snapshot of one import task, cloned out for the poll endpoint.
#[derive(Debug, Clone)]
pub struct TaskRecord {
    pub id: String,
    pub connection_id: Uuid,
    pub repo_full_path: String,
    pub status: TaskStatus,
    /// The current phase while running, the error once failed.
    pub message: Option<String>,
    /// What the import wrote, once it succeeded.
    pub outcome: Option<SyncOutcome>,
    pub created: Instant,
    pub finished: Option<Instant>,
}

/// How many finished tasks are kept for polling before the oldest are evicted.
const RETAINED_FINISHED: usize = 200;
/// A finished task older than this is evicted regardless of the count.
const RETENTION: Duration = Duration::from_secs(60 * 60);

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

    /// Register a freshly-enqueued import and return its id.
    pub fn create(&self, connection_id: Uuid, repo_full_path: &str) -> String {
        let id = Uuid::new_v4().to_string();
        if let Ok(mut map) = self.inner.lock() {
            evict(&mut map);
            map.insert(
                id.clone(),
                TaskRecord {
                    id: id.clone(),
                    connection_id,
                    repo_full_path: repo_full_path.to_string(),
                    status: TaskStatus::Queued,
                    message: Some("queued".to_string()),
                    outcome: None,
                    created: Instant::now(),
                    finished: None,
                },
            );
        }
        id
    }

    /// The import is running; `phase` is what it is doing right now.
    pub fn progress(&self, id: &str, phase: &str) {
        self.update(id, |r| {
            r.status = TaskStatus::Running;
            r.message = Some(phase.to_string());
        });
    }

    pub fn succeed(&self, id: &str, outcome: SyncOutcome) {
        self.update(id, |r| {
            r.status = TaskStatus::Succeeded;
            r.message = None;
            r.outcome = Some(outcome);
            r.finished = Some(Instant::now());
        });
    }

    pub fn fail(&self, id: &str, error: &str) {
        self.update(id, |r| {
            r.status = TaskStatus::Failed;
            r.message = Some(error.to_string());
            r.finished = Some(Instant::now());
        });
    }

    pub fn get(&self, id: &str) -> Option<TaskRecord> {
        self.inner.lock().ok().and_then(|m| m.get(id).cloned())
    }
}

/// Drop finished tasks past the retention window, then the oldest finished
/// ones past the count cap. Running tasks are never evicted.
fn evict(map: &mut HashMap<String, TaskRecord>) {
    let now = Instant::now();
    map.retain(|_, r| {
        !(r.status.is_terminal()
            && r.finished
                .is_some_and(|f| now.duration_since(f) > RETENTION))
    });
    let mut finished: Vec<(Instant, String)> = map
        .values()
        .filter(|r| r.status.is_terminal())
        .map(|r| (r.finished.unwrap_or(r.created), r.id.clone()))
        .collect();
    if finished.len() > RETAINED_FINISHED {
        finished.sort();
        for (_, id) in finished.iter().take(finished.len() - RETAINED_FINISHED) {
            map.remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_task_moves_from_queued_through_running_to_a_terminal_state() {
        let reg = TaskRegistry::default();
        let id = reg.create(Uuid::nil(), "o/r");
        assert_eq!(reg.get(&id).map(|r| r.status), Some(TaskStatus::Queued));
        reg.progress(&id, "fetching the tree");
        let rec = reg.get(&id).expect("recorded");
        assert_eq!(rec.status, TaskStatus::Running);
        assert_eq!(rec.message.as_deref(), Some("fetching the tree"));
        reg.fail(&id, "boom");
        let rec = reg.get(&id).expect("recorded");
        assert_eq!(rec.status, TaskStatus::Failed);
        assert!(rec.finished.is_some());
        assert!(reg.get("nope").is_none());
    }

    #[test]
    fn finished_tasks_are_capped_but_running_ones_survive() {
        let reg = TaskRegistry::default();
        let running = reg.create(Uuid::nil(), "o/r");
        reg.progress(&running, "…");
        let mut finished = Vec::new();
        for _ in 0..(RETAINED_FINISHED + 5) {
            let id = reg.create(Uuid::nil(), "o/r");
            reg.fail(&id, "x");
            finished.push(id);
        }
        // One more create triggers eviction.
        let _ = reg.create(Uuid::nil(), "o/r");
        assert!(
            reg.get(&running).is_some(),
            "a running task is never evicted"
        );
        let kept = finished.iter().filter(|id| reg.get(id).is_some()).count();
        assert!(kept <= RETAINED_FINISHED, "kept {kept}");
        assert!(
            reg.get(finished.last().expect("some")).is_some(),
            "the newest finished task is kept"
        );
    }
}
