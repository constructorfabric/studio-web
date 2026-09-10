//! The domain-model ontology: the entities, their fields and their relations.
//!
//! The document is embedded from `ontology.core.json` — the full Studio product
//! core domain model + system bases (11 buckets, 140 entities) held in
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

/// One node type to register, with a human title and description. What the
/// graph indexes for it is not here: those paths are the same for every domain
/// type and fixed in [`gts::derived_node_schema`], because a registered
/// schema cannot change and anything read off the model eventually does.
#[derive(Debug, Clone)]
pub struct NodeType {
    pub type_id: String,
    pub title: String,
    pub description: String,
}

/// One payload field a type has — its own, or inherited from a base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveProperty {
    pub name: String,
    /// The declared type expression, verbatim (`string`, `timestamp?`,
    /// `draft | active | retired`, `EntityId[]`).
    pub type_expr: String,
    pub required: bool,
    pub description: String,
    /// The entity that declares it: the type itself, or the base it comes from.
    pub declared_by: String,
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

    /// The document's non-entity part (`model`, `source`, `buckets`, and any
    /// other top-level key a model carries). Stored as the single
    /// [`gts::META_MODEL`] node so the entities are not the only thing that
    /// survives a round trip through the graph.
    pub fn model_document(&self) -> Value {
        let mut head = self.doc.clone();
        if let Some(obj) = head.as_object_mut() {
            obj.remove("entities");
        }
        head
    }

    /// Reassemble an ontology from what the graph stores: the model document's
    /// non-entity part plus one entity document per `object_type` node. The
    /// inverse of [`Self::model_document`] + [`Self::model_graph`], and the
    /// reason the graph — not the embedded file — can be the model's system of
    /// record.
    ///
    /// `entities` must already be in the model's order — the graph returns
    /// nodes in projection order, which is not it. Each `object_type` node
    /// carries the `ordinal` it was stored at for exactly this reason: the
    /// order of the entity array is part of the document (the model UI renders
    /// in it), so it is data to be stored, not something to re-derive.
    pub fn from_parts(model_document: Value, entities: Vec<Value>) -> Result<Self, OntologyError> {
        let mut doc = match model_document {
            Value::Object(_) => model_document,
            _ => json!({}),
        };
        doc.as_object_mut()
            .ok_or(OntologyError::Malformed)?
            .insert("entities".to_string(), Value::Array(entities));
        Self::from_value(doc)
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

    /// Every declared relation as a named row: which entity declares it, its
    /// property name, verb, target (raw name + resolved entity id) and
    /// cardinality/label. Surfaces the per-relation cardinality that the
    /// verb-level edge types do not carry.
    pub fn declared_relations(&self) -> Vec<DeclaredRelation> {
        let mut out = Vec::new();
        for e in self.entities() {
            let source = e
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            for p in relation_properties(e) {
                let target = p
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                out.push(DeclaredRelation {
                    source: source.clone(),
                    name: p
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    verb: p
                        .get("relationType")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    target_entity: self.target_entity_id(&target),
                    target,
                    cardinality: p
                        .get("cardinality")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    label: p
                        .get("relationLabel")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                });
            }
        }
        out
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

        nodes.extend(
            self.entities()
                .iter()
                .enumerate()
                .filter_map(|(i, e)| object_type_meta(e, i)),
        );

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
                        discriminator: None,
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
                        // The property name distinguishes parallel relations
                        // between the same pair (e.g. tenant owns team *and*
                        // tenant contains team).
                        discriminator: p.get("name").and_then(Value::as_str).map(str::to_string),
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

    /// Every payload field the type actually has — its own and everything it
    /// inherits — with the nearest declaration winning.
    ///
    /// The model puts most of a type's fields on its bases: `team` declares a
    /// handful and *has* 24, because `organization-entity`, `managed-object`,
    /// `node`, `entity` and `system-object` each add some. Reading an entity
    /// straight out of the document therefore shows a fraction of the type, and
    /// every consumer that wanted the whole thing had to walk `extends` itself.
    ///
    /// Ordered base-first, so a field arrives where it was introduced and an
    /// override (the model marks those) replaces it in place. Relation
    /// properties are excluded: they become edges, not payload.
    pub fn effective_properties(&self, entity_id: &str) -> Vec<EffectiveProperty> {
        let mut out: Vec<EffectiveProperty> = Vec::new();
        // `ancestors` is nearest-first; the root has to be applied first for the
        // nearest declaration to win.
        for ancestor in self.ancestors(entity_id).into_iter().rev() {
            let Some(entity) = self.entity(&ancestor) else {
                continue;
            };
            for p in entity
                .get("properties")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
            {
                if matches!(
                    p.get("extends").and_then(Value::as_str),
                    Some("edge") | Some("link")
                ) {
                    continue;
                }
                let Some(name) = p.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let property = EffectiveProperty {
                    name: name.to_string(),
                    type_expr: p
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    required: p.get("required").and_then(Value::as_bool).unwrap_or(false),
                    description: p
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    declared_by: ancestor.clone(),
                };
                match out.iter_mut().find(|e| e.name == property.name) {
                    Some(existing) => *existing = property,
                    None => out.push(property),
                }
            }
        }
        out
    }

    /// An entity and every base it extends, nearest first. A relation declared
    /// on a base is a relation of everything that extends it, so endpoint
    /// checking walks this rather than comparing one id.
    ///
    /// Cycles in `extends` are a malformed model, not a reason to hang: the
    /// walk stops at the first id it has already seen.
    pub fn ancestors(&self, entity_id: &str) -> Vec<String> {
        let mut chain = vec![entity_id.to_string()];
        let mut at = entity_id.to_string();
        while let Some(base) = self
            .entity(&at)
            .and_then(|e| e.get("extends"))
            .and_then(Value::as_str)
            .filter(|b| !b.is_empty())
            .and_then(|b| self.resolve_entity_id(b))
        {
            if chain.contains(&base) {
                break;
            }
            chain.push(base.clone());
            at = base;
        }
        chain
    }

    /// One declared relation by the entity that declares it and its property
    /// name — the `project.uses` form. A bare name is *not* resolved here: on
    /// its own it can mean several relations, or a verb, and only the endpoints
    /// being related can say which.
    pub fn declared_relation(&self, entity_id: &str, name: &str) -> Option<DeclaredRelation> {
        let entity = self.resolve_entity_id(entity_id)?;
        self.declared_relations()
            .into_iter()
            .find(|d| d.source == entity && d.name == name)
    }

    /// The entity ids, in the model's own order. Stored on the model node, so
    /// a reload knows both which entities the model has and what order they go
    /// in.
    pub fn entity_ids(&self) -> Vec<String> {
        self.entities()
            .iter()
            .filter_map(|e| e.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect()
    }

    /// Where an entity sits in the document's `entities` array — the index a
    /// JSON Patch path against it needs.
    pub fn entity_index(&self, entity_id: &str) -> Option<usize> {
        self.entities()
            .iter()
            .position(|e| e.get("id").and_then(Value::as_str) == Some(entity_id))
    }

    /// The `object_type` node for one entity — what the model-graph sync
    /// stores for it. Used to write a single changed type back to the graph
    /// without re-syncing the whole model.
    pub fn object_type_node(&self, entity_id: &str) -> Option<ObjectTypeMeta> {
        self.entities()
            .iter()
            .enumerate()
            .find(|(_, e)| e.get("id").and_then(Value::as_str) == Some(entity_id))
            .and_then(|(i, e)| object_type_meta(e, i))
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

/// One edge in the model graph, addressed by the endpoint *entity ids*. The
/// `discriminator` (the relation-property name for `declares`) keeps parallel
/// relations between the same two entities distinct.
#[derive(Debug, Clone)]
pub struct ModelEdgeMeta {
    pub kind: ModelEdgeKind,
    pub from_entity: String,
    pub to_entity: String,
    pub discriminator: Option<String>,
    pub payload: Value,
}

/// One declared relation, with its cardinality — the per-relation detail the
/// verb-level edge types omit.
#[derive(Debug, Clone)]
pub struct DeclaredRelation {
    pub source: String,
    pub name: String,
    pub verb: String,
    pub target: String,
    pub target_entity: Option<String>,
    pub cardinality: Option<String>,
    pub label: String,
}

/// The two kinds of model-graph edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelEdgeKind {
    /// An entity to the base it `extends`.
    Inherits,
    /// An entity to a related entity (one declared relation).
    Declares,
}

/// One entity as the `object_type` node the model graph stores for it: the
/// flat keys a query or a visualization reads, plus the whole entity document
/// verbatim under `entity`. That document is the authoritative copy — it is
/// what makes the sync lossless, so the ontology can be reassembled from the
/// graph rather than only written to it.
fn object_type_meta(e: &Value, ordinal: usize) -> Option<ObjectTypeMeta> {
    let id = e.get("id").and_then(Value::as_str)?;
    let name = e.get("name").and_then(Value::as_str).unwrap_or(id);
    let field_count = e
        .get("properties")
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
        .unwrap_or(0);
    Some(ObjectTypeMeta {
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
            "field_count": field_count,
            "relation_count": relation_properties(e).count(),
            "entity": e.clone(),
            // The entity's position in the model's entity array. That order is
            // part of the document — the model UI renders in it — and the graph
            // has no order of its own to recover it from.
            "ordinal": ordinal,
        }),
    })
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
    fn the_model_round_trips_through_its_graph_form() {
        let o = Ontology::load();
        // What the sync stores: the document's non-entity part as one node,
        // and one entity document per object_type node.
        let head = o.model_document();
        assert!(head.get("buckets").is_some());
        assert!(head.get("entities").is_none());
        let entities = ordered_entities(&o);
        assert_eq!(entities.len(), o.entities().len());

        // What a reload reassembles: the same document, entity for entity, in
        // the same order — so a boot off the graph is a boot off the model.
        let back = Ontology::from_parts(head, entities).expect("reassembles");
        assert_eq!(back.document(), o.document());
    }

    /// The entity documents in model order, the way a reload reconstructs them
    /// from the graph: sorted on the `ordinal` each node was stored with, out of
    /// nodes handed back in whatever order the graph likes.
    fn ordered_entities(o: &Ontology) -> Vec<Value> {
        let mut nodes = o.model_graph().nodes;
        nodes.reverse(); // the graph's order is not the model's
        nodes.sort_by_key(|n| n.payload["ordinal"].as_u64().unwrap_or(u64::MAX));
        nodes
            .into_iter()
            .map(|n| n.payload["entity"].clone())
            .collect()
    }

    #[test]
    fn the_stored_ordinal_is_what_recovers_the_models_order() {
        let o = Ontology::load();
        // Without the ordinal the graph's order stands, and what comes back is
        // not the document that was stored.
        let scrambled: Vec<Value> = o
            .model_graph()
            .nodes
            .into_iter()
            .rev()
            .map(|n| n.payload["entity"].clone())
            .collect();
        let wrong = Ontology::from_parts(o.model_document(), scrambled).expect("reassembles");
        assert_ne!(wrong.document(), o.document());
        // With it, the model comes back exactly.
        let back = Ontology::from_parts(o.model_document(), ordered_entities(&o)).unwrap();
        assert_eq!(back.document(), o.document());
    }

    #[test]
    fn one_types_node_carries_the_edit() {
        let mut o = Ontology::load();
        o.add_field(
            "team",
            FieldSpec {
                name: "cost_center".into(),
                type_name: "string".into(),
                description: None,
                required: false,
            },
        )
        .unwrap();
        // The single node written back carries the new field, so a reload sees
        // the edit without the whole model being re-synced.
        let node = o.object_type_node("team").expect("team object_type node");
        let props = node.payload["entity"]["properties"].as_array().unwrap();
        assert!(
            props
                .iter()
                .any(|p| p["name"] == "cost_center" && p["type"] == "string")
        );
        // field_count counts payload fields, not the relation properties that
        // become edges.
        let scalar = props
            .iter()
            .filter(|p| {
                !matches!(
                    p.get("extends").and_then(Value::as_str),
                    Some("edge") | Some("link")
                )
            })
            .count();
        assert_eq!(node.payload["field_count"], json!(scalar));
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
