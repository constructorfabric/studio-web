//! What another gear uses of the artifact graph's ingest: cloning a repository
//! into the shared checkout, and the scrubbing every graph write needs.

pub(crate) use super::clone::clone_or_update;
#[cfg(feature = "graph")]
pub(crate) use super::graph_backend::{str_without_nul, without_nul};
