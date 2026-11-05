//! Where a pipeline's published images become image records (ADR-0062 §4).
//!
//! studio-artifact-ingest reads a pipeline's `studio-build.json` and records
//! the build; the images in it are recorded here, beside those of the builds
//! Studio runs, so a project's Images list is the same whichever way it built.
//! The environments' service is set here when the gear registers its routes;
//! before that, and without the gear's tables, nothing is recorded.

use std::sync::{Arc, OnceLock};

use super::service::EnvironmentService;

static SINK: OnceLock<Arc<EnvironmentService>> = OnceLock::new();

pub(super) fn set(service: Arc<EnvironmentService>) {
    let _ = SINK.set(service);
}

/// What a pipeline's manifest published.
#[derive(Debug, Clone, Default)]
pub struct Published<'a> {
    pub project_id: &'a str,
    pub build_id: &'a str,
    pub commit: Option<&'a str>,
    pub description_revision: Option<i64>,
    pub lock_hash: Option<&'a str>,
    /// `(app, host/repo:tag@digest)`.
    pub images: &'a [(String, String)],
    pub chart_ref: Option<&'a str>,
    pub chart_version: Option<&'a str>,
    /// The subject that reported it.
    pub pushed_by: &'a str,
}

/// Record what a pipeline published. Best effort: a failure is logged.
pub async fn record(published: Published<'_>) {
    let Some(service) = SINK.get() else {
        return;
    };
    if let Err(e) = service.record_published(&published).await {
        tracing::warn!(
            project = published.project_id,
            build = published.build_id,
            "studio-environments: a pipeline's images could not be recorded ({e:#})"
        );
    }
}
