//! What another gear asks studio-environments for directly.
//!
//! - [`record`] / [`Published`]: a pipeline's published images become the
//!   project's image records (ADR-0062 §4); studio-artifact-ingest hands
//!   them over when it reads a build's report.

pub(crate) use super::images_sink::{Published, record};
