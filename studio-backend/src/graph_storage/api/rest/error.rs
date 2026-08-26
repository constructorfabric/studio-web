//! Boundary mapping from `DomainError` to the canonical error envelope.
//!
//! This is the single authoritative mapping: both the REST adapter and the
//! in-process client surface the same category for the same failure, as the
//! Error Model section of `docs/DESIGN.md` requires.

use toolkit::api::canonical_prelude::*;

use crate::graph_storage::domain::error::DomainError;

#[resource_error(gts_id!("cf.core.kg.node.v1~"))]
pub(crate) struct GraphResourceError;

impl From<DomainError> for CanonicalError {
    fn from(err: DomainError) -> Self {
        match err {
            DomainError::Storage(_) => GraphResourceError::unknown(err.to_string()).create(),
            DomainError::BatchTooLarge { .. } => GraphResourceError::out_of_range(err.to_string())
                .with_field_violation("batch", err.to_string(), "LIMIT_EXCEEDED")
                .create(),
            DomainError::UnknownType(ref t) => GraphResourceError::invalid_argument()
                .with_field_violation("type_id", err.to_string(), "TYPE_NOT_REGISTERED")
                .with_resource(t.clone())
                .create(),
            DomainError::UnknownEndpoint(ref k) => GraphResourceError::invalid_argument()
                .with_field_violation("node_key", err.to_string(), "ENDPOINT_NOT_DEFINED")
                .with_resource(k.clone())
                .create(),
            // 404, not 403: telling a caller that a node exists but is not
            // theirs is itself a disclosure.
            DomainError::NodeNotFound(ref key) => GraphResourceError::not_found(err.to_string())
                .with_resource(key.clone())
                .create(),
            DomainError::PayloadTooLarge { ref node_key, .. } => {
                GraphResourceError::out_of_range(err.to_string())
                    .with_field_violation("payload", err.to_string(), "PAYLOAD_CEILING_EXCEEDED")
                    .with_resource(node_key.clone())
                    .create()
            }
            DomainError::PayloadNotAnObject(ref key) => GraphResourceError::invalid_argument()
                .with_field_violation("payload", err.to_string(), "PAYLOAD_NOT_AN_OBJECT")
                .with_resource(key.clone())
                .create(),
            // The JSON pointer is reported as the violating field so a producer
            // can navigate straight to the attribute the schema rejected, which
            // is what DESIGN asks of payload validation errors.
            DomainError::PayloadInvalid {
                ref node_key,
                ref pointer,
                ..
            } => GraphResourceError::invalid_argument()
                .with_field_violation(pointer.clone(), err.to_string(), "PAYLOAD_SCHEMA_VIOLATION")
                .with_resource(node_key.clone())
                .create(),
            DomainError::EmbeddingDimensionMismatch { ref node_key, .. } => {
                GraphResourceError::invalid_argument()
                    .with_field_violation("embedding", err.to_string(), "EMBEDDING_DIMENSION")
                    .with_resource(node_key.clone())
                    .create()
            }
            DomainError::PruneUnfiltered => GraphResourceError::invalid_argument()
                .with_field_violation("filter", err.to_string(), "PRUNE_UNFILTERED")
                .create(),
            DomainError::BadCursor => GraphResourceError::invalid_argument()
                .with_field_violation("cursor", err.to_string(), "CURSOR_INVALID")
                .create(),
            DomainError::NotInitialised => GraphResourceError::failed_precondition()
                .with_precondition_violation(
                    "graph-storage",
                    err.to_string(),
                    "SERVICE_NOT_INITIALISED",
                )
                .create(),
        }
    }
}
