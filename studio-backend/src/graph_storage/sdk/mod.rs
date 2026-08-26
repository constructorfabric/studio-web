//! Graph Storage SDK — the public, transport-agnostic contract of the gear.
//!
//! Consumers obtain the client from `ClientHub`:
//!
//! ```ignore
//! use crate::graph_storage::sdk::GraphStorageClientV1;
//! let graph = hub.get::<dyn GraphStorageClientV1>()?;
//! ```
//!
//! This crate deliberately carries no serde, HTTP or database dependencies so
//! that consuming gears do not inherit the implementation's transport choices.

pub mod client;
pub mod gts;
pub mod models;

pub use client::GraphStorageClientV1;
pub use models::{
    DeleteResult, Direction, EdgeInput, EdgeView, GraphStats, HybridHit, HybridQuery, IngestResult,
    NodeInput, NodeView, Page, PruneRequest, SearchQuery, Subgraph, TraversalQuery, TypeView,
};

/// Error type returned by every fallible SDK operation.
pub type GraphStorageError = toolkit_canonical_errors::CanonicalError;
