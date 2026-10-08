//! studio-spec-quality — a thin, authenticated wrapper over the external
//! spec-quality service (the detector API whose Swagger lives at the
//! configured `base_url`/docs).
//!
//! The service analyses specification documents with four async detectors —
//! `bloat` (cross-doc duplication), `purpose` (section roles + a purpose
//! gate), `leak` (foreign-content verdicts) and `traceability` (an ID graph
//! or LLM drift judging) — and authenticates with its OWN shared secret. This
//! gear exposes those endpoints under the Studio gateway
//! (`/cf/studio-spec-quality/v1/*`) and forwards a submission to the upstream
//! verbatim, attaching the server-held key. Callers authenticate with their normal Studio token —
//! the spec-quality key never leaves the backend (it lives in this gear's
//! config, same pattern as `studio-llm-proxy`).
//!
//! The upstream is asynchronous — submit → 202 `TaskCreated`, then read
//! `GET /v1/tasks/{id}` until it is done — and that second half used to be the
//! caller's. It is not any more: a submit records a `spec_quality.analyze` run
//! ([`analyze_task`]) that watches the upstream task to its verdict, so a
//! minutes-long analysis is a background run like every other one in the
//! assembly and the portal is told about it on `studio-events` rather than
//! polling for it.
//!
//! A finished analysis is read as a verdict (`GET /verdicts`): the upstream
//! task interpreted once, here, rather than relayed and judged in every
//! client. The raw task passthrough that used to sit beside it (and a second
//! status vocabulary beside studio-tasks) is gone; the run's handler reads the
//! upstream directly.

pub mod analysis;
pub mod analyze_task;
pub mod batch_task;
pub mod config;
pub mod findings;
pub mod gear;
pub mod record;
pub mod rest;
pub mod sdk;
pub mod verdict;

/// Whether this process can reach the upstream: a base URL and a key were
/// configured. Set once, when the gear initialises.
///
/// For a caller deciding whether to queue analysis nobody asked for — a source
/// sync — where a run that can only fail item by item is noise, not news. A
/// caller a person is waiting on submits anyway and shows the 500 that says
/// what is missing.
static CONFIGURED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[must_use]
pub fn is_configured() -> bool {
    CONFIGURED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Flip [`is_configured`] for a test of a caller that consults it.
///
/// Process-wide, like the flag: a test that sets it must hold whatever lock
/// its suite uses to keep tests that read it apart, and put it back.
#[cfg(test)]
pub(crate) fn set_configured_for_tests(configured: bool) {
    CONFIGURED.store(configured, std::sync::atomic::Ordering::Relaxed);
}
