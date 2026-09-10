//! studio-session — Studio's first own gear.
//!
//! Launches, tracks and reaps per-workspace Theia IDE sessions (theia/ image).
//! The runtime lives behind a [`driver::SessionDriver`]: [`docker::DockerDriver`]
//! runs containers on the local daemon (the MVP), the Kubernetes driver runs
//! Pods behind the backend's proxy — same REST contract either way. See
//! docs/adr/0003-theia-sessions.md for the architecture and the k8s path.

pub mod config;
pub mod docker;
pub mod driver;
pub mod gear;
pub mod k8s;
pub mod proxy;
pub mod reap_task;
pub mod rest;
pub mod sdk;
pub mod service;

/// The schedules this gear asks for.
///
/// Read by `studio-scheduler` at its `start` phase, alongside `studio-tasks`'
/// own — see [`crate::tasks::PlatformSchedule`]. `ensure` does not overwrite,
/// so an operator who slowed this down or switched it off keeps that across
/// restarts.
///
/// Asked for unconditionally, and dropped for us where it makes no sense: a
/// gear that stood down — sessions switched off, or no container runtime to
/// reach — registered no `session.reap` handler, and the scheduler skips a
/// schedule whose task type nothing can run.
pub fn platform_schedules() -> Vec<crate::tasks::PlatformSchedule> {
    vec![crate::tasks::PlatformSchedule {
        name: "session-reaper",
        task_type: reap_task::TASK_TYPE,
        cron: reap_task::CRON,
        payload: serde_json::json!({}),
    }]
}
