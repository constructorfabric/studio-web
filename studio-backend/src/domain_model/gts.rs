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
/// The single node holding the model document's non-entity part (`model`,
/// `source`, `buckets`). With the `object_type` nodes — each of which carries
/// its whole entity document — it is what lets the ontology be *read back out
/// of the graph* rather than only written to it, so the graph is the model's
/// system of record and the embedded file only its bootstrap seed.
pub const META_MODEL: &str = "gts.cf.studio.domainmeta.model.v1~";
/// One node per recorded change to the model — its number, who made it, and
/// the JSON Patch that made it. The chain of these is the model's history.
pub const META_MODEL_VERSION: &str = "gts.cf.studio.domainmeta.model_version.v1~";
/// model_version → the version it succeeded.
pub const META_REVISES: &str = "gts.cf.studio.domainmeta.revises.v1~";
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
        || type_id == META_REVISES
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
///
/// Deliberately content-free beyond the `$id` and the family `$ref`: a type id
/// registers to the byte-identical schema regardless of the model's names or
/// descriptions, so re-uploading an edited model (or swapping models that reuse
/// a type id) re-registers idempotently instead of conflicting. The human names
/// live in the ontology, not the graph type.
/// The payload paths the gear composes a node's lexical search text from.
///
/// `/payload` is the whole payload object: the gear resolves the pointer and
/// stringifies whatever it finds, so every value in the payload reaches the
/// search text. That costs some precision — the field *names* become tokens
/// too — and buys the thing that matters more: the set does not depend on
/// which fields the model declares.
const FULL_TEXT_PATHS: [&str; 2] = ["/name", "/payload"];

/// The payload paths that are embedded.
///
/// Prose only: a vector over identifiers, enums and timestamps adds noise
/// without adding meaning. A conventional list rather than a derived one, for
/// the same reason as above; the gear skips a path a payload does not have, so
/// naming one that a given type never carries costs nothing.
const VECTOR_PATHS: [&str; 18] = [
    "/payload/abstract",
    "/payload/body",
    "/payload/content",
    "/payload/description",
    "/payload/display_name",
    "/payload/full_name",
    "/payload/goal",
    "/payload/heading",
    "/payload/headline",
    "/payload/label",
    "/payload/message",
    "/payload/name",
    "/payload/notes",
    "/payload/purpose",
    "/payload/rationale",
    "/payload/statement",
    "/payload/summary",
    "/payload/title",
];

/// [`derived_schema`] plus the search traits a *node* type carries: the payload
/// paths the gear composes its lexical search text from, and the ones it
/// embeds.
///
/// Without them the gear indexes only the node name, which left every domain
/// object matchable by its title and nothing else: a lexical search for words
/// that appear in a payload returned no hits at all, while the same query
/// answered fine as a vector search.
///
/// **The same paths for every domain type, and never derived from the model.**
/// They used to be gathered from each entity's own fields, which made the
/// registered schema a function of the model — and graph-storage treats a
/// registered type's schema as immutable, so adding a field to a type made its
/// schema unregistrable and pinned its indexing to whatever it happened to
/// declare first. One drifted type used to abort the whole registration batch
/// and with it every write in the model. Nothing model-derived belongs in a
/// schema that cannot change; the edge types already worked this way and the
/// node types now do too.
pub fn derived_node_schema(type_id: &str) -> serde_json::Value {
    let mut schema = derived_schema(type_id);
    schema["x-gts-traits"] = serde_json::json!({
        "full_text_search": FULL_TEXT_PATHS,
        "vector_search": VECTOR_PATHS,
    });
    schema
}

pub fn derived_schema(type_id: &str) -> serde_json::Value {
    let family = if is_edge_type(type_id) {
        STATIC_EDGE_FAMILY
    } else {
        OWNED_NODE_FAMILY
    };
    serde_json::json!({
        "$id": format!("gts://{}", graph_type_id(type_id)),
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "allOf": [{ "$ref": format!("gts://{family}") }],
    })
}

/// The catalog description every domain *relation* type is registered with.
///
/// A constant because two callers must emit the same bytes: the gear at `init`
/// and the offline inventory (`crate::gts_inventory`) that the drift test
/// diffs against the committed snapshot.
pub const EDGE_CATALOG_DESCRIPTION: &str = "A relation between two domain objects.";

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

/// The meta-layer types as catalog entries for the platform registry, so the
/// three types the model graph lives in are cataloged like every other type
/// this gear registers (`crate::gts_inventory` asserts that direction).
pub const META_CATALOG_DOCS: [(&str, &str, &str); 6] = [
    (
        META_MODEL_VERSION,
        "ModelVersion",
        "One recorded change to the model, with the patch that made it.",
    ),
    (
        META_REVISES,
        "Revises",
        "A model version and the version it succeeded.",
    ),
    (
        META_MODEL,
        "Model",
        "The model document's non-entity part (model, source, buckets).",
    ),
    (
        META_OBJECT_TYPE,
        "ObjectType",
        "One domain entity as an object type in the model graph.",
    ),
    (
        META_INHERITS,
        "Inherits",
        "An object type and the object type it extends.",
    ),
    (
        META_DECLARES,
        "Declares",
        "An object type and a related object type (one declared relation).",
    ),
];

/// The meta-layer type registrations (object_type node + inherits/declares
/// edges) as `(graph type id, schema)` pairs, for registering the graph in
/// which the model itself lives. Fixed, so registration is idempotent.
pub fn meta_type_registrations() -> Vec<(String, serde_json::Value)> {
    [
        META_MODEL,
        META_MODEL_VERSION,
        META_REVISES,
        META_OBJECT_TYPE,
        META_INHERITS,
        META_DECLARES,
    ]
    .into_iter()
    .map(|id| (graph_type_id(id), derived_schema(id)))
    .collect()
}

/// The node key the single [`META_MODEL`] node is stored under. Fixed, so a
/// re-sync replaces the model document rather than accumulating copies.
pub fn model_node_key() -> String {
    instance_id(META_MODEL, "model")
}

/// The node key one model version is stored under. Derived from the number, so
/// claiming a version is an insert at a key only one writer can take.
pub fn version_node_key(version: u64) -> String {
    instance_id(META_MODEL_VERSION, &version.to_string())
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
