//! GTS identifiers owned by the graph-storage gear.

use toolkit_gts::gts_id;

/// Resource type of a graph node, used for authorization decisions.
pub const NODE_TYPE_RESOURCE: &str = gts_id!("cf.core.kg.node.v1~");

/// Resource type of a graph edge.
pub const EDGE_TYPE_RESOURCE: &str = gts_id!("cf.core.kg.edge.v1~");
