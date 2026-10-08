//! How a document is read for the mapping. The documents gear calls these when
//! it indexes a document; nothing else computes what a document needs.

pub(crate) use super::reading::{InferredCapability, declared_requirements, inferred_capabilities};
