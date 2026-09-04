//! GTS identifiers, type schemas and node/edge model for the gears catalog.
//!
//! The catalog mirrors the artifact-ingest graph model but for a different
//! domain: published crates ("gears") and their versions, pulled from
//! crates.io. Instance ids are deterministic (uuid5 of a stable key), so a
//! re-sync upserts the same nodes rather than duplicating them.

use serde_json::{Value, json};
use uuid::Uuid;

/// Fixed namespace for uuid5 instance ids (studio gears catalog). Distinct from
/// the artifact graph's namespace so the two never collide on a key.
const INSTANCE_NS: Uuid = Uuid::from_u128(0xcf57_0000_0000_4000_8000_0000_0000_0002);

/// A published crate — one of "our gears" on crates.io.
pub const GEAR_TYPE: &str = "gts.cf.studio.catalog.gear.v1~";
/// One published version of a gear crate.
pub const CRATE_VERSION_TYPE: &str = "gts.cf.studio.catalog.crate_version.v1~";
/// Studio-managed, editable catalog metadata for one gear. It is stored
/// independently from crates.io data, so a sync cannot erase it.
pub const GEAR_PROFILE_TYPE: &str = "gts.cf.studio.catalog.gear_profile.v1~";
/// The gear repository connected to one project — where that project's gears
/// live and where scaffolded gears are written. Keyed on the project id.
pub const PROJECT_GEAR_REPO_TYPE: &str = "gts.cf.studio.catalog.project_gear_repo.v1~";

/// Every catalog node type, for registering and enumerating.
pub const ALL_NODE_TYPES: [&str; 4] = [
    GEAR_TYPE,
    CRATE_VERSION_TYPE,
    GEAR_PROFILE_TYPE,
    PROJECT_GEAR_REPO_TYPE,
];

/// gear → crate_version — a version published under this crate.
///
/// Four name tokens (`vendor.package.namespace.type`), not five: the v1 gear
/// interned any string as a type, the v2 gear parses identifiers with the
/// platform's GTS grammar and refused `cf.studio.catalog.rel.has_version`.
pub const REL_HAS_VERSION: &str = "gts.cf.studio.catalog.has_version.v1~";

/// Every catalog relation type, for registering in the graph.
pub const ALL_EDGE_TYPES: [&str; 1] = [REL_HAS_VERSION];

/// The graph-storage families the catalog's types derive from. Catalog rows
/// are *owned* nodes (the graph is where they live) joined by *static* edges
/// (replaced wholesale by a re-sync).
const OWNED_NODE_FAMILY: &str = "gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~";
const STATIC_EDGE_FAMILY: &str = "gts.cf.core.graph.edge.v1~cf.core.graph.static_edge.v1~";

/// A GTS node to persist: type id, deterministic instance id, and payload.
#[derive(Debug, Clone)]
pub struct GtsNode {
    pub type_id: &'static str,
    pub instance_id: String,
    pub value: Value,
}

/// A GTS edge to persist: type id and endpoint instance ids.
#[derive(Debug, Clone)]
pub struct GtsEdge {
    pub type_id: &'static str,
    pub from: String,
    pub to: String,
}

/// The type id the graph-storage gear stores this type under.
///
/// Graph-storage requires every producer type to derive from one of its
/// families, and a derived type carries its ancestry in the identifier: our
/// `gts.cf.studio.catalog.gear.v1~` becomes
/// `gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~cf.studio.catalog.gear.v1~`.
pub fn graph_type_id(our_type: &str) -> String {
    let leaf = our_type.strip_prefix("gts.").unwrap_or(our_type);
    let family = if ALL_EDGE_TYPES.contains(&our_type) {
        STATIC_EDGE_FAMILY
    } else {
        OWNED_NODE_FAMILY
    };
    format!("{family}{leaf}")
}

/// Reverse of [`graph_type_id`]: map a graph-storage type id back to our
/// `&'static` constant so a node read back keeps its typed identity.
pub fn our_type_from_graph(graph_type: &str) -> Option<&'static str> {
    ALL_NODE_TYPES
        .into_iter()
        .find(|t| graph_type_id(t) == graph_type)
}

/// The node types, with a title and a description each.
const NODE_TYPE_DOCS: [(&str, &str, &str); 4] = [
    (
        GEAR_TYPE,
        "Gear",
        "A published crate — one of our gears on crates.io.",
    ),
    (
        CRATE_VERSION_TYPE,
        "CrateVersion",
        "One published version of a gear crate.",
    ),
    (
        GEAR_PROFILE_TYPE,
        "GearProfile",
        "Editable Studio metadata for one gear, kept separately from crates.io sync data.",
    ),
    (
        PROJECT_GEAR_REPO_TYPE,
        "ProjectGearRepo",
        "The gear repository connected to a project (connector, repo, branch).",
    ),
];

/// GTS type schemas registered with the **platform types-registry** at gear
/// init (free-form `type: object`, same shape the studio types use, so
/// registration never trips the narrowing check).
pub fn type_schemas() -> Vec<Value> {
    NODE_TYPE_DOCS
        .into_iter()
        .map(|(id, title, description)| {
            json!({
                "$id": format!("gts://{id}"),
                "$schema": "http://json-schema.org/draft-07/schema#",
                "title": title,
                "description": description,
                "type": "object",
            })
        })
        .collect()
}

/// The payload paths that make a catalog node findable, declared once on the
/// type: the gear composes the lexical search text and the embedding input
/// from these, so a producer no longer hands over a `search_text` string.
const SEARCHABLE_PATHS: [&str; 8] = [
    "/payload/name",
    "/payload/description",
    "/payload/kind",
    "/payload/keywords",
    "/payload/categories",
    "/payload/crate",
    "/payload/num",
    "/payload/license",
];

/// The same types as **graph-storage** ontology entries: each derives from a
/// graph-storage family and declares which payload paths are searched.
pub fn graph_node_type_schemas() -> Vec<Value> {
    NODE_TYPE_DOCS
        .into_iter()
        .map(|(id, title, description)| {
            json!({
                "$id": format!("gts://{}", graph_type_id(id)),
                "$schema": "http://json-schema.org/draft-07/schema#",
                "title": title,
                "description": description,
                "type": "object",
                "x-gts-traits": {
                    "full_text_search": SEARCHABLE_PATHS,
                    "vector_search": ["/payload/name", "/payload/description", "/payload/keywords", "/payload/categories"],
                },
                "allOf": [{ "$ref": format!("gts://{OWNED_NODE_FAMILY}") }],
            })
        })
        .collect()
}

/// The relation types as graph-storage ontology entries.
pub fn graph_edge_type_schemas() -> Vec<Value> {
    ALL_EDGE_TYPES
        .into_iter()
        .map(|id| {
            json!({
                "$id": format!("gts://{}", graph_type_id(id)),
                "$schema": "http://json-schema.org/draft-07/schema#",
                "title": "HasVersion",
                "description": "A version published under a gear crate.",
                "type": "object",
                "allOf": [{ "$ref": format!("gts://{STATIC_EDGE_FAMILY}") }],
            })
        })
        .collect()
}

/// Deterministic instance id from a stable composite key.
fn anon_id(parts: &[&str]) -> String {
    Uuid::new_v5(&INSTANCE_NS, parts.join("|").as_bytes()).to_string()
}

/// The instance id of a gear node (keyed on crate name).
pub fn gear_instance_id(name: &str) -> String {
    anon_id(&["gear", name])
}

/// The instance id of a version node (keyed on crate name + version number).
pub fn version_instance_id(name: &str, num: &str) -> String {
    anon_id(&["crate_version", name, num])
}

/// The instance id of a custom profile node (keyed on the gear crate name).
pub fn gear_profile_instance_id(name: &str) -> String {
    anon_id(&["gear_profile", name])
}

/// A gear node. `value` is the curated crate payload built by the service.
pub fn gear_node(name: &str, value: Value) -> GtsNode {
    GtsNode {
        type_id: GEAR_TYPE,
        instance_id: gear_instance_id(name),
        value,
    }
}

/// A crate-version node. `value` is the curated version payload.
pub fn crate_version_node(name: &str, num: &str, value: Value) -> GtsNode {
    GtsNode {
        type_id: CRATE_VERSION_TYPE,
        instance_id: version_instance_id(name, num),
        value,
    }
}

/// An editable profile for a gear. The caller owns the profile payload; the
/// service injects its stable `gear_name` identity before persisting it.
pub fn gear_profile_node(name: &str, value: Value) -> GtsNode {
    GtsNode {
        type_id: GEAR_PROFILE_TYPE,
        instance_id: gear_profile_instance_id(name),
        value,
    }
}

/// The instance id of a project's gear-repo node (keyed on the project id).
pub fn project_gear_repo_instance_id(project_id: &str) -> String {
    anon_id(&["project_gear_repo", project_id])
}

/// The gear repository connected to one project. `value` carries `project_id`
/// plus `{connection_id, repo, branch}`.
pub fn project_gear_repo_node(project_id: &str, value: Value) -> GtsNode {
    GtsNode {
        type_id: PROJECT_GEAR_REPO_TYPE,
        instance_id: project_gear_repo_instance_id(project_id),
        value,
    }
}

/// gear → crate_version.
pub fn has_version_edge(gear_id: &str, version_id: &str) -> GtsEdge {
    GtsEdge {
        type_id: REL_HAS_VERSION,
        from: gear_id.to_string(),
        to: version_id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The GTS grammar allows exactly four name tokens before the version in
    /// each `~`-segment; the v2 gear enforces it where the v1 gear did not.
    #[test]
    fn every_type_leaf_is_a_valid_gts_segment() {
        for id in ALL_NODE_TYPES.into_iter().chain(ALL_EDGE_TYPES) {
            let leaf = id.strip_prefix("gts.").unwrap_or(id).trim_end_matches('~');
            let tokens: Vec<&str> = leaf.split('.').collect();
            assert!(
                tokens.len() == 5 && tokens[4].starts_with('v'),
                "{id}: expected vendor.package.namespace.type.vN, got {tokens:?}"
            );
        }
    }

    #[test]
    fn graph_type_ids_derive_from_a_family_and_round_trip() {
        let id = graph_type_id(GEAR_TYPE);
        assert!(id.starts_with(OWNED_NODE_FAMILY), "{id}");
        assert!(id.ends_with("cf.studio.catalog.gear.v1~"), "{id}");
        assert_eq!(our_type_from_graph(&id), Some(GEAR_TYPE));
        assert!(graph_type_id(REL_HAS_VERSION).starts_with(STATIC_EDGE_FAMILY));
    }
}
