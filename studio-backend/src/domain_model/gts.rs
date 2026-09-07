//! GTS identifiers and derivation for the Studio domain model.
//!
//! The domain model (see `ontology.identity.json`, sourced from
//! `studio-internal/domain-model-ui`) is a set of *entities* with fields and
//! relations. Each entity becomes a GTS node type, each distinct relation kind
//! a GTS edge type, and every type derives from a graph-storage family so the
//! graph-storage gear will register it — a free-form type has no derivation
//! chain to validate against and is refused (see the artifact gear and
//! `docs/gears-rust-issues.md` §4).
//!
//! Unlike the tenant-metadata envelope (closed by OP#12 narrowing), the
//! graph-storage `owned_node` family lets a payload carry arbitrary fields.
//! That is deliberate here: extending a domain type with a new field must not
//! require a schema migration, so the registered graph type stays open and the
//! *field-level* definitions live in the ontology document, which is the source
//! the frontend is (re)generated from.

use uuid::Uuid;

/// Fixed namespace for uuid5 instance ids (studio domain-model graph). Distinct
/// from the artifact graph's namespace so the two never collide on a key.
const INSTANCE_NS: Uuid = Uuid::from_u128(0xcf57_0000_0000_4000_8000_0000_0000_0002);

/// Node types live under the `domain` namespace: `gts.cf.studio.domain.<t>.v1~`.
const NODE_NAMESPACE: &str = "domain";

// ── Meta layer: the model itself, stored as a graph ────────────────────────
// The ontology's *structure* — its entities and how they relate and inherit —
// is materialized as a graph of `object_type` nodes joined by `inherits` and
// `declares` edges, so the domain model is itself queryable (the model's own
// ObjectType / RelationType / KnowledgeGraph notion).
/// One node per domain entity (an object type in the model).
pub const META_OBJECT_TYPE: &str = "gts.cf.studio.domainmeta.object_type.v1~";
/// object_type → the object_type it extends.
pub const META_INHERITS: &str = "gts.cf.studio.domainmeta.inherits.v1~";
/// object_type → a related object_type (one declared relation).
pub const META_DECLARES: &str = "gts.cf.studio.domainmeta.declares.v1~";
/// Edge types live under their own `domainrel` namespace so a domain relation
/// (`references`, `owns`, …) never shares a graph type with the artifact graph's
/// `rel` namespace, which happens to reuse some of the same verbs.
const EDGE_NAMESPACE: &str = "domainrel";

/// The graph-storage families our types derive from. Domain entities are
/// *owned* nodes — the graph is their system of record — and domain relations
/// are *static* edges (a re-sync replaces them wholesale).
const OWNED_NODE_FAMILY: &str = "gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~";
const STATIC_EDGE_FAMILY: &str = "gts.cf.core.graph.edge.v1~cf.core.graph.static_edge.v1~";

/// GTS segment token: a type/leaf token may not contain a dot (dots separate
/// the five segment parts), so an entity id like `role-assignment` becomes
/// `role_assignment`. Reversible for read-back via [`leaf_to_entity_id`].
fn sanitize_leaf(raw: &str) -> String {
    raw.replace(['-', '.', ' '], "_")
}

/// The GTS node type id for a domain entity id, e.g.
/// `role-assignment` -> `gts.cf.studio.domain.role_assignment.v1~`.
pub fn node_type_id(entity_id: &str) -> String {
    format!(
        "gts.cf.studio.{NODE_NAMESPACE}.{}.v1~",
        sanitize_leaf(entity_id)
    )
}

/// The GTS edge type id for a relation kind, e.g.
/// `references` -> `gts.cf.studio.domainrel.references.v1~`.
pub fn edge_type_id(relation_kind: &str) -> String {
    format!(
        "gts.cf.studio.{EDGE_NAMESPACE}.{}.v1~",
        sanitize_leaf(relation_kind)
    )
}

/// True for a domain edge type id (`…studio.domainrel.…`) or a meta edge
/// (`inherits` / `declares`), false for a node.
pub fn is_edge_type(type_id: &str) -> bool {
    type_id.contains(&format!(".{EDGE_NAMESPACE}."))
        || type_id == META_INHERITS
        || type_id == META_DECLARES
}

/// The type id the graph-storage gear stores this type under: a derived type
/// carries its ancestry, so our `gts.cf.studio.domain.team.v1~` becomes
/// `gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~cf.studio.domain.team.v1~`.
pub fn graph_type_id(our_type: &str) -> String {
    let leaf = our_type.strip_prefix("gts.").unwrap_or(our_type);
    let family = if is_edge_type(our_type) {
        STATIC_EDGE_FAMILY
    } else {
        OWNED_NODE_FAMILY
    };
    format!("{family}{leaf}")
}

/// Reverse of [`graph_type_id`]: map a graph-storage type id (which carries the
/// family ancestry) back to our `gts.…` id by stripping the family prefix. Used
/// when reading nodes/edges back out of the graph. Falls back to the input if it
/// is not one of our derived types.
pub fn our_type_from_graph(graph_type: &str) -> String {
    for family in [OWNED_NODE_FAMILY, STATIC_EDGE_FAMILY] {
        if let Some(leaf) = graph_type.strip_prefix(family) {
            return format!("gts.{leaf}");
        }
    }
    graph_type.to_string()
}

/// The leaf token of a node type id: `team` from
/// `gts.cf.studio.domain.team.v1~` (the token before the version).
pub fn type_leaf(type_id: &str) -> &str {
    let toks: Vec<&str> = type_id.trim_end_matches('~').split('.').collect();
    if toks.len() >= 2 {
        toks[toks.len() - 2]
    } else {
        type_id
    }
}

/// A derived type-registration schema for the graph-storage gear: the family
/// derivation is what makes it registrable; the payload stays open so a field
/// can be added to the ontology without a graph migration.
pub fn derived_schema(type_id: &str, title: &str, description: &str) -> serde_json::Value {
    let family = if is_edge_type(type_id) {
        STATIC_EDGE_FAMILY
    } else {
        OWNED_NODE_FAMILY
    };
    serde_json::json!({
        "$id": format!("gts://{}", graph_type_id(type_id)),
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": title,
        "description": description,
        "type": "object",
        "allOf": [{ "$ref": format!("gts://{family}") }],
    })
}

/// A derived edge schema that also declares its endpoint typing via
/// `x-gts-traits.src_types` / `dst_types` (the graph-storage gear surfaces these
/// as effective traits — see `docs/graph-storage-api.md`). `src_types` /
/// `dst_types` are given as *our* node type ids and converted to their graph
/// type ids here. An empty side is left unconstrained rather than declared as
/// "no valid endpoint", so a relation whose targets are all still cross-bucket
/// does not reject every edge.
pub fn edge_derived_schema(
    type_id: &str,
    title: &str,
    description: &str,
    src_type_ids: &[String],
    dst_type_ids: &[String],
) -> serde_json::Value {
    let mut schema = derived_schema(type_id, title, description);
    let mut traits = serde_json::Map::new();
    let map_graph = |ids: &[String]| -> Vec<serde_json::Value> {
        ids.iter()
            .map(|t| serde_json::Value::String(graph_type_id(t)))
            .collect()
    };
    if !src_type_ids.is_empty() {
        traits.insert("src_types".to_string(), map_graph(src_type_ids).into());
    }
    if !dst_type_ids.is_empty() {
        traits.insert("dst_types".to_string(), map_graph(dst_type_ids).into());
    }
    if !traits.is_empty() {
        schema["x-gts-traits"] = serde_json::Value::Object(traits);
    }
    schema
}

/// A free-form registration schema for the platform types-registry — the same
/// shape studio's other types use, so registration never trips the
/// closed-envelope narrowing check. Catalogs *what a domain type is*; the graph
/// derivation (above) is a separate document for a separate registry.
pub fn catalog_schema(type_id: &str, title: &str, description: &str) -> serde_json::Value {
    serde_json::json!({
        "$id": format!("gts://{type_id}"),
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": title,
        "description": description,
        "type": "object",
    })
}

/// The meta-layer type registrations (object_type node + inherits/declares
/// edges) as `(graph type id, schema)` pairs, for registering the graph in
/// which the model itself lives. Fixed, so registration is idempotent.
pub fn meta_type_registrations() -> Vec<(String, serde_json::Value)> {
    [
        (
            META_OBJECT_TYPE,
            "ObjectType",
            "A domain object type — one entity of the model.",
        ),
        (
            META_INHERITS,
            "inherits",
            "An object type to the object type it extends.",
        ),
        (
            META_DECLARES,
            "declares",
            "An object type to a related object type (one declared relation).",
        ),
    ]
    .into_iter()
    .map(|(id, title, desc)| (graph_type_id(id), derived_schema(id, title, desc)))
    .collect()
}

/// Deterministic instance id for an object of `type_id` keyed by `key`, so
/// creating "the same" object twice upserts rather than duplicates.
pub fn instance_id(type_id: &str, key: &str) -> String {
    Uuid::new_v5(&INSTANCE_NS, format!("{type_id}|{key}").as_bytes()).to_string()
}

/// Deterministic edge instance key `(type, from, to)`, idempotent on re-create.
pub fn edge_key(type_id: &str, from: &str, to: &str) -> String {
    format!("{type_id}|{from}|{to}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_ids_sanitize_hyphens() {
        assert_eq!(node_type_id("team"), "gts.cf.studio.domain.team.v1~");
        assert_eq!(
            node_type_id("role-assignment"),
            "gts.cf.studio.domain.role_assignment.v1~"
        );
    }

    #[test]
    fn edge_ids_use_their_own_namespace() {
        let id = edge_type_id("references");
        assert_eq!(id, "gts.cf.studio.domainrel.references.v1~");
        assert!(is_edge_type(&id));
        assert!(!is_edge_type(&node_type_id("team")));
    }

    #[test]
    fn node_and_edge_derive_from_the_right_family() {
        assert!(graph_type_id(&node_type_id("team")).starts_with(OWNED_NODE_FAMILY));
        assert!(graph_type_id(&edge_type_id("owns")).starts_with(STATIC_EDGE_FAMILY));
    }

    #[test]
    fn leaf_round_trips() {
        assert_eq!(type_leaf(&node_type_id("person")), "person");
    }

    #[test]
    fn instance_ids_are_deterministic() {
        let t = node_type_id("team");
        assert_eq!(instance_id(&t, "core"), instance_id(&t, "core"));
        assert_ne!(instance_id(&t, "core"), instance_id(&t, "devex"));
    }
}
