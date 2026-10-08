//! What another gear uses of the artifact graph: the scrubbing every graph
//! write needs.

#[cfg(feature = "graph")]
pub(crate) use super::graph_backend::{str_without_nul, without_nul};
