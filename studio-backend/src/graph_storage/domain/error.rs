//! Domain error type.
//!
//! The mapping to `CanonicalError` lives at the API boundary
//! (`api::rest::error`), per the Error Model section of `docs/DESIGN.md`.

use thiserror::Error;

/// Errors produced by the domain layer.
#[derive(Debug, Error)]
pub enum DomainError {
    /// The gear is not fully initialised yet.
    #[error("graph-storage service is not initialised")]
    NotInitialised,
    /// A referenced GTS type is not registered for this tenant.
    #[error("type is not registered: {0}")]
    UnknownType(String),
    /// A referenced node key is absent from both the batch and the store.
    #[error("edge endpoint is not defined: {0}")]
    UnknownEndpoint(String),
    /// A batch exceeded its configured admission limit.
    #[error("{kind} batch of {requested} exceeds the limit of {limit}")]
    BatchTooLarge {
        /// Which family overflowed.
        kind: &'static str,
        /// Configured hard bound.
        limit: u32,
        /// Size the caller requested.
        requested: usize,
    },
    /// A node addressed directly does not exist, or is outside the caller's
    /// scope — the two are deliberately indistinguishable to the caller.
    #[error("node not found: {0}")]
    NodeNotFound(String),
    /// One payload exceeded the configured ceiling.
    #[error("payload of {node_key} is {actual} bytes, over the limit of {limit}")]
    PayloadTooLarge {
        /// Key of the offending row.
        node_key: String,
        /// Configured hard bound in bytes.
        limit: u32,
        /// Serialized size the caller sent.
        actual: usize,
    },
    /// A payload was not a JSON object.
    #[error("payload of {0} must be a JSON object")]
    PayloadNotAnObject(String),
    /// A payload failed validation against its type's schema.
    #[error("payload of {node_key} is invalid at {pointer}: {message}")]
    PayloadInvalid {
        /// Key of the offending row.
        node_key: String,
        /// JSON pointer to the offending location.
        pointer: String,
        /// What the schema objected to.
        message: String,
    },
    /// A supplied embedding had the wrong dimension.
    #[error("embedding of {node_key} has {actual} dimensions, expected {expected}")]
    EmbeddingDimensionMismatch {
        /// Key of the offending row.
        node_key: String,
        /// Dimension the column declares.
        expected: u16,
        /// Dimension the caller sent.
        actual: usize,
    },
    /// A prune arrived with no filter at all.
    #[error("a prune needs at least one filter; refusing to delete the whole graph")]
    PruneUnfiltered,
    /// A cursor could not be decoded.
    #[error("cursor is not one this endpoint issued")]
    BadCursor,
    /// A storage operation failed.
    #[error("storage failure: {0}")]
    Storage(String),
}
