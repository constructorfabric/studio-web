//! The domain-model ontology: the entities, their fields and their relations.
//!
//! The document is embedded from `ontology.core.json` — the full Studio product
//! core domain model (all 10 buckets, 133 entities) held in
//! `studio-internal/domain-model-ui`. Its shape is the domain-entity schema the
//! model UI already renders from, so reading it back out of the graph is what
//! lets the frontend be regenerated from the stored model.
//!
//! The ontology is held as a live [`serde_json::Value`] so a type can be
//! *extended* at runtime (a new field appended to an entity's `properties`).
//! Because the graph type registered for each entity is open (see [`super::gts`]),
//! adding a field is a pure ontology edit — no graph migration, no re-register.

use serde_json::{Value, json};

use super::gts;

/// The embedded ontology: the full core domain model (all buckets).
const ONTOLOGY_JSON: &str = include_str!("ontology.core.json");

/// One node type to register, with a human title and description.
#[derive(Debug, Clone)]
pub struct NodeType {
    pub type_id: String,
    pub title: String,
    pub description: String,
}

/// One edge type to register (a distinct relation kind across the ontology),
/// with its endpoint typing: the node types that may sit at each end, gathered
/// across every relation-property that uses this kind. Empty = unconstrained.
#[derive(Debug, Clone)]
pub struct EdgeType {
    pub type_id: String,
    pub relation_kind: String,
    /// Our node type ids allowed as the edge source.
    pub src_type_ids: Vec<String>,
    /// Our node type ids allowed as the edge target (only targets that resolve
    /// to an entity in the current ontology; cross-bucket targets are reported
    /// separately by [`Ontology::unresolved_relation_targets`]).
    pub dst_type_ids: Vec<String>,
}

/// The parsed ontology. `doc` is the whole document (mutable so a field can be
/// appended); everything else is derived from it on demand.
#[derive(Debug, Clone)]
pub struct Ontology {
    doc: Value,
}

impl Ontology {
    /// Load the embedded ontology. Panics only on a malformed embedded file,
    /// which is a build-time error, not a runtime one.
    pub fn load() -> Self {
        let doc: Value =
            serde_json::from_str(ONTOLOGY_JSON).expect("embedded domain ontology is valid JSON");
        Self { doc }
    }

    /// Build an ontology from an uploaded document — the same domain-entity
    /// shape the embedded model uses. Rejected unless it carries an `entities`
    /// array, so a stray file cannot silently replace the model.
    pub fn from_value(doc: Value) -> Result<Self, OntologyError> {
        if doc.get("entities").and_then(Value::as_array).is_none() {
            return Err(OntologyError::Malformed);
        }
        Ok(Self { doc })
    }

    /// The distinct buckets across the entities.
    pub fn bucket_count(&self) -> usize {
        let mut seen: Vec<&str> = Vec::new();
        for e in self.entities() {
            if let Some(b) = e.get("bucket").and_then(Value::as_str)
                && !seen.contains(&b)
            {
                seen.push(b);
            }
        }
        seen.len()
    }

    /// The whole ontology document (what the frontend regenerates from).
    pub fn document(&self) -> &Value {
        &self.doc
    }

    /// The entities array.
    pub fn entities(&self) -> &[Value] {
        self.doc
            .get("entities")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// One entity by its ontology id (`team`, `role-assignment`, …).
    pub fn entity(&self, entity_id: &str) -> Option<&Value> {
        self.entities()
            .iter()
            .find(|e| e.get("id").and_then(Value::as_str) == Some(entity_id))
    }

    /// The node types to register — one per entity.
    pub fn node_types(&self) -> Vec<NodeType> {
        self.entities()
            .iter()
            .filter_map(|e| {
                let entity_id = e.get("id").and_then(Value::as_str)?.to_string();
                let title = e
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&entity_id)
                    .to_string();
                let description = e
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                Some(NodeType {
                    type_id: gts::node_type_id(&entity_id),
                    title,
                    description,
                })
            })
            .collect()
    }

    /// The distinct relation kinds across every entity's relation-properties,
    /// each mapped to an endpoint-typed edge type. A relation-property is one
    /// carrying an `extends: "edge" | "link"` and a `relationType`; the
    /// `relationType` verb (`member`, `owns`, `references`, `composes`) is the
    /// relation kind. For each kind we gather the source node types (the
    /// entities that declare it) and the target node types (the entities the
    /// relation points at), so the relation is registered with its endpoints —
    /// not as a bare verb.
    pub fn edge_types(&self) -> Vec<EdgeType> {
        // Preserve first-seen order of kinds while accumulating endpoint sets.
        let mut order: Vec<String> = Vec::new();
        let mut src: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let mut dst: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();

        for e in self.entities() {
            let Some(src_entity) = e.get("id").and_then(Value::as_str) else {
                continue;
            };
            let src_type = gts::node_type_id(src_entity);
            for p in relation_properties(e) {
                let Some(kind) = p.get("relationType").and_then(Value::as_str) else {
                    continue;
                };
                if kind.is_empty() {
                    continue;
                }
                if !order.iter().any(|k| k == kind) {
                    order.push(kind.to_string());
                }
                push_unique(src.entry(kind.to_string()).or_default(), src_type.clone());
                if let Some(target) = p.get("type").and_then(Value::as_str)
                    && let Some(target_id) = self.target_entity_id(target)
                {
                    push_unique(
                        dst.entry(kind.to_string()).or_default(),
                        gts::node_type_id(&target_id),
                    );
                }
            }
        }

        order
            .into_iter()
            .map(|kind| EdgeType {
                type_id: gts::edge_type_id(&kind),
                src_type_ids: src.remove(&kind).unwrap_or_default(),
                dst_type_ids: dst.remove(&kind).unwrap_or_default(),
                relation_kind: kind,
            })
            .collect()
    }

    /// Relation targets that name an entity outside the current ontology (a
    /// cross-bucket type not yet synced), as `(source entity, target name)`
    /// pairs. These endpoints are omitted from `dst_types` until the buckets
    /// that define them are added — surfacing exactly which relations reach
    /// beyond the current slice.
    pub fn unresolved_relation_targets(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        for e in self.entities() {
            let src_entity = e.get("id").and_then(Value::as_str).unwrap_or("");
            for p in relation_properties(e) {
                if let Some(target) = p.get("type").and_then(Value::as_str)
                    && self.target_entity_id(target).is_none()
                {
                    let pair = (src_entity.to_string(), target.to_string());
                    if !out.contains(&pair) {
                        out.push(pair);
                    }
                }
            }
        }
        out
    }

    /// The model *as a graph*: one [`ObjectTypeMeta`] node per entity, plus the
    /// edges between them — `inherits` (an entity to the base it `extends`) and
    /// `declares` (an entity to each related entity). Endpoints that name no
    /// entity in the current model (a non-core base, a cross-bucket target) are
    /// not emitted and are counted in the returned `skipped` total, so a sync
    /// never produces a dangling edge. This is what makes the domain model —
    /// with its relations — itself a queryable graph.
    pub fn model_graph(&self) -> ModelGraph {
        let mut nodes: Vec<ObjectTypeMeta> = Vec::new();
        let mut edges: Vec<ModelEdgeMeta> = Vec::new();
        let mut skipped: usize = 0;

        let field_count = |e: &Value| -> usize {
            e.get("properties")
                .and_then(Value::as_array)
                .map(|ps| {
                    ps.iter()
                        .filter(|p| {
                            !matches!(
                                p.get("extends").and_then(Value::as_str),
                                Some("edge") | Some("link")
                            )
                        })
                        .count()
                })
                .unwrap_or(0)
        };

        for e in self.entities() {
            let Some(id) = e.get("id").and_then(Value::as_str) else {
                continue;
            };
            let name = e.get("name").and_then(Value::as_str).unwrap_or(id);
            let relation_count = relation_properties(e).count();
            nodes.push(ObjectTypeMeta {
                entity_id: id.to_string(),
                name: name.to_string(),
                payload: json!({
                    "id": id,
                    "name": name,
                    "bucket": e.get("bucket").and_then(Value::as_str).unwrap_or(""),
                    "kind": e.get("kind").and_then(Value::as_str).unwrap_or(""),
                    "layer": e.get("layer").and_then(Value::as_str).unwrap_or(""),
                    "abstract": e.get("abstract").and_then(Value::as_bool).unwrap_or(false),
                    "extends": e.get("extends").and_then(Value::as_str),
                    "description": e.get("description").and_then(Value::as_str).unwrap_or(""),
                    "node_type_id": gts::node_type_id(id),
                    "field_count": field_count(e),
                    "relation_count": relation_count,
                }),
            });
        }

        for e in self.entities() {
            let Some(id) = e.get("id").and_then(Value::as_str) else {
                continue;
            };
            // inherits: extends -> a base that is itself a modeled entity.
            match e.get("extends").and_then(Value::as_str) {
                Some(base) if !base.is_empty() => match self.resolve_entity_id(base) {
                    Some(base_id) => edges.push(ModelEdgeMeta {
                        kind: ModelEdgeKind::Inherits,
                        from_entity: id.to_string(),
                        to_entity: base_id,
                        payload: json!({ "base": base }),
                    }),
                    None => skipped += 1,
                },
                _ => {}
            }
            // declares: one edge per relation-property whose target resolves.
            for p in relation_properties(e) {
                match p
                    .get("type")
                    .and_then(Value::as_str)
                    .and_then(|t| self.target_entity_id(t))
                {
                    Some(target_id) => edges.push(ModelEdgeMeta {
                        kind: ModelEdgeKind::Declares,
                        from_entity: id.to_string(),
                        to_entity: target_id,
                        payload: json!({
                            "name": p.get("name").and_then(Value::as_str).unwrap_or(""),
                            "verb": p.get("relationType").and_then(Value::as_str).unwrap_or(""),
                            "cardinality": p.get("cardinality").and_then(Value::as_str),
                            "label": p.get("relationLabel").and_then(Value::as_str).unwrap_or(""),
                            "kind": p.get("extends").and_then(Value::as_str).unwrap_or(""),
                        }),
                    }),
                    None => skipped += 1,
                }
            }
        }

        ModelGraph {
            nodes,
            edges,
            skipped,
        }
    }

    /// Resolve a relation-property `type` (a target entity *name* like `Person`,
    /// `RoleGrant`, `OrganizationalUnit`) to an ontology entity id, matching on
    /// the normalized entity name or id. `None` if it names no current entity.
    fn target_entity_id(&self, target: &str) -> Option<String> {
        let t = normalize(target);
        if t.is_empty() {
            return None;
        }
        self.entities()
            .iter()
            .find(|e| {
                normalize(e.get("name").and_then(Value::as_str).unwrap_or("")) == t
                    || normalize(e.get("id").and_then(Value::as_str).unwrap_or("")) == t
            })
            .and_then(|e| e.get("id").and_then(Value::as_str))
            .map(str::to_string)
    }

    /// True when `entity_id` is one of the ontology's entities.
    pub fn has_entity(&self, entity_id: &str) -> bool {
        self.entity(entity_id).is_some()
    }

    /// Resolve an incoming type reference — a full GTS node type id
    /// (`gts.cf.studio.domain.team.v1~`), its leaf (`team`), or an ontology id
    /// (`role-assignment`) — to the ontology entity id, if it names one.
    pub fn resolve_entity_id(&self, reference: &str) -> Option<String> {
        let reference = reference.trim();
        if reference.is_empty() {
            return None;
        }
        // Direct ontology id.
        if self.has_entity(reference) {
            return Some(reference.to_string());
        }
        // Full node type id or bare leaf: match on the sanitized leaf, so
        // `role-assignment` and `role_assignment` both resolve.
        let wanted_leaf = gts::type_leaf(reference);
        self.entities()
            .iter()
            .filter_map(|e| e.get("id").and_then(Value::as_str))
            .find(|eid| {
                gts::type_leaf(&gts::node_type_id(eid)) == wanted_leaf
                    || gts::type_leaf(&gts::node_type_id(eid)) == reference
            })
            .map(str::to_string)
    }

    /// Append a field to an entity's `properties`, extending the type. Returns
    /// the updated entity, or an error if the entity is unknown or the field
    /// already exists. This is the whole cost of "extend a type by adding a
    /// field": the open graph type needs no change.
    pub fn add_field(&mut self, entity_id: &str, field: FieldSpec) -> Result<Value, OntologyError> {
        let entities = self
            .doc
            .get_mut("entities")
            .and_then(Value::as_array_mut)
            .ok_or(OntologyError::Malformed)?;
        let entity = entities
            .iter_mut()
            .find(|e| e.get("id").and_then(Value::as_str) == Some(entity_id))
            .ok_or_else(|| OntologyError::UnknownEntity(entity_id.to_string()))?;

        let props = entity
            .get_mut("properties")
            .and_then(Value::as_array_mut)
            .ok_or(OntologyError::Malformed)?;
        if props
            .iter()
            .any(|p| p.get("name").and_then(Value::as_str) == Some(field.name.as_str()))
        {
            return Err(OntologyError::DuplicateField(field.name));
        }
        props.push(json!({
            "name": field.name,
            "type": field.type_name,
            "description": field.description.unwrap_or_default(),
            "required": field.required,
            "relationLabel": "",
        }));
        Ok(entity.clone())
    }
}

/// The relation-properties of an entity — those carrying an `extends`
/// (`edge`/`link`), i.e. the ones that become graph edges rather than payload
/// scalar fields.
fn relation_properties(entity: &Value) -> impl Iterator<Item = &Value> {
    entity
        .get("properties")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|p| {
            matches!(
                p.get("extends").and_then(Value::as_str),
                Some("edge") | Some("link")
            )
        })
}

/// The model materialized as a graph: object-type nodes and the edges among
/// them. `skipped` counts endpoints that named no modeled entity (so no
/// dangling edge is produced).
#[derive(Debug, Clone)]
pub struct ModelGraph {
    pub nodes: Vec<ObjectTypeMeta>,
    pub edges: Vec<ModelEdgeMeta>,
    pub skipped: usize,
}

/// One object-type node — an entity of the model, as a graph node.
#[derive(Debug, Clone)]
pub struct ObjectTypeMeta {
    pub entity_id: String,
    pub name: String,
    pub payload: Value,
}

/// One edge in the model graph, addressed by the endpoint *entity ids*.
#[derive(Debug, Clone)]
pub struct ModelEdgeMeta {
    pub kind: ModelEdgeKind,
    pub from_entity: String,
    pub to_entity: String,
    pub payload: Value,
}

/// The two kinds of model-graph edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelEdgeKind {
    /// An entity to the base it `extends`.
    Inherits,
    /// An entity to a related entity (one declared relation).
    Declares,
}

/// Push `value` onto `list` only if it is not already present (small sets, so
/// a linear check is fine and keeps insertion order stable).
fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

/// Normalize an entity name/id for matching a relation target: lowercase,
/// alphanumeric only. So `"Role Grant"`, `"RoleGrant"` and `"role grant"` all
/// compare equal (but note `"role-assignment"` normalizes to `roleassignment`,
/// which is why targets match on the *name*, not the id).
fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// A field to add to a type (goal #2, "extend types by adding new fields").
#[derive(Debug, Clone)]
pub struct FieldSpec {
    pub name: String,
    pub type_name: String,
    pub description: Option<String>,
    pub required: bool,
}

/// Why an ontology edit was refused.
#[derive(Debug)]
pub enum OntologyError {
    UnknownEntity(String),
    DuplicateField(String),
    Malformed,
}

impl std::fmt::Display for OntologyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownEntity(id) => write!(f, "unknown domain entity: {id}"),
            Self::DuplicateField(name) => write!(f, "field already exists: {name}"),
            Self::Malformed => write!(f, "ontology document is malformed"),
        }
    }
}

impl std::error::Error for OntologyError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_slice_loads_with_its_entities() {
        let o = Ontology::load();
        assert!(o.has_entity("team"));
        assert!(o.has_entity("role-assignment"));
        // Every entity yields a node type.
        assert_eq!(o.node_types().len(), o.entities().len());
    }

    #[test]
    fn relation_kinds_collapse_to_edge_types() {
        let o = Ontology::load();
        let kinds: Vec<String> = o
            .edge_types()
            .into_iter()
            .map(|e| e.relation_kind)
            .collect();
        // The identity bucket's relations are these four verbs.
        for k in ["member", "owns", "references", "composes"] {
            assert!(kinds.contains(&k.to_string()), "missing relation kind {k}");
        }
    }

    #[test]
    fn edge_types_carry_resolved_endpoints() {
        let o = Ontology::load();
        let member = o
            .edge_types()
            .into_iter()
            .find(|e| e.relation_kind == "member")
            .expect("member edge type");
        // team -member-> person is declared in the slice, so both endpoints
        // resolve to their node types.
        assert!(
            member
                .src_type_ids
                .contains(&"gts.cf.studio.domain.team.v1~".to_string())
        );
        assert!(
            member
                .dst_type_ids
                .contains(&"gts.cf.studio.domain.person.v1~".to_string())
        );
    }

    #[test]
    fn unresolved_targets_are_reported_not_silently_dropped() {
        let o = Ontology::load();
        let unresolved = o.unresolved_relation_targets();
        // `ShadowNode` names no entity in the core model (ownership points at
        // it), so it is surfaced as pending rather than hidden.
        assert!(
            unresolved.iter().any(|(_, target)| target == "ShadowNode"),
            "expected an unresolved target (ShadowNode) to be reported"
        );
    }

    #[test]
    fn a_type_reference_resolves_three_ways() {
        let o = Ontology::load();
        assert_eq!(o.resolve_entity_id("team").as_deref(), Some("team"));
        assert_eq!(
            o.resolve_entity_id("gts.cf.studio.domain.team.v1~")
                .as_deref(),
            Some("team")
        );
        assert_eq!(
            o.resolve_entity_id("role-assignment").as_deref(),
            Some("role-assignment")
        );
        assert_eq!(o.resolve_entity_id("nope"), None);
    }

    #[test]
    fn model_graph_has_a_node_per_entity_and_typed_edges() {
        let o = Ontology::load();
        let g = o.model_graph();
        // One object-type node per entity.
        assert_eq!(g.nodes.len(), o.entities().len());
        // Both edge kinds are produced.
        assert!(g.edges.iter().any(|e| e.kind == ModelEdgeKind::Inherits));
        assert!(g.edges.iter().any(|e| e.kind == ModelEdgeKind::Declares));
        // team -declares-> person (its has_members relation) is present.
        assert!(g.edges.iter().any(|e| e.kind == ModelEdgeKind::Declares
            && e.from_entity == "team"
            && e.to_entity == "person"));
        // Non-core endpoints are skipped, not turned into dangling edges.
        assert!(g.skipped > 0);
    }

    #[test]
    fn adding_a_field_extends_the_type() {
        let mut o = Ontology::load();
        let before = o.entity("team").unwrap()["properties"]
            .as_array()
            .unwrap()
            .len();
        let updated = o
            .add_field(
                "team",
                FieldSpec {
                    name: "cost_center".into(),
                    type_name: "string".into(),
                    description: Some("Finance cost center".into()),
                    required: false,
                },
            )
            .unwrap();
        assert_eq!(updated["properties"].as_array().unwrap().len(), before + 1);
        // A second add of the same field is refused.
        assert!(matches!(
            o.add_field(
                "team",
                FieldSpec {
                    name: "cost_center".into(),
                    type_name: "string".into(),
                    description: None,
                    required: false,
                }
            ),
            Err(OntologyError::DuplicateField(_))
        ));
    }
}
