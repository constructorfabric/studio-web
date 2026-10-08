//! The catalogue graph: the GTS vocabulary of catalogue nodes and the store
//! they are written to.
//!
//! Shared code, not a gear. `studio-components-catalog` and `studio-product`
//! both keep records here; each registers the types-registry schemas of the
//! node types it owns (`gts::type_schemas`, `gts::product_type_schemas`) and
//! reads and writes only those.

pub(crate) mod gts;
mod sink;

pub(crate) use sink::{CatalogNodeView, CatalogSink, build_sink};
#[cfg(test)]
pub(crate) use sink::{GraphNodeType, MemorySink};
