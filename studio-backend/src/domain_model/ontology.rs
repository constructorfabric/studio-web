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

/// Studio's own model, every organization's to start with: the types its
/// gears and screens read and write, with the bases they extend. An
/// organization's administrator uploads a domain model on top of it, which
/// extends it (see `Ontology::add_studio_types`).
const STUDIO_MODEL_JSON: &str = include_str!("ontology.studio.json");

/// The product team's model (studio-internal/domain-model-ui core + system):
/// what an organization uploads, used by the tests as such an upload.
#[cfg(test)]
pub(crate) const PRODUCT_MODEL_JSON: &str = include_str!("ontology.core.json");

fn studio_model() -> Value {
    serde_json::from_str(STUDIO_MODEL_JSON).expect("Studio's own model is valid JSON")
}

/// The type before `id` in its bucket's order in Studio's own model.
fn studio_predecessor(id: &str) -> Option<String> {
    let model = studio_model();
    model.get("buckets")?.as_array()?.iter().find_map(|b| {
        let order = b.get("entity_order")?.as_array()?;
        let at = order.iter().position(|v| v.as_str() == Some(id))?;
        at.checked_sub(1)
            .and_then(|i| order[i].as_str())
            .map(str::to_owned)
    })
}

fn studio_types() -> Vec<Value> {
    studio_model()
        .get("entities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

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
        Self {
            doc: studio_model(),
        }
    }

    /// Add the seed's bucket `id` when this model has none by that id, with
    /// an empty order.
    fn adopt_bucket(&mut self, id: &str) {
        let has = self
            .doc
            .get("buckets")
            .and_then(Value::as_array)
            .is_some_and(|bs| {
                bs.iter()
                    .any(|b| b.get("id").and_then(Value::as_str) == Some(id))
            });
        if has {
            return;
        }
        let seed = studio_model();
        let Some(mut bucket) = seed
            .get("buckets")
            .and_then(Value::as_array)
            .and_then(|bs| {
                bs.iter()
                    .find(|b| b.get("id").and_then(Value::as_str) == Some(id))
            })
            .cloned()
        else {
            return;
        };
        bucket["entity_order"] = json!([]);
        if let Some(bs) = self.doc.get_mut("buckets").and_then(Value::as_array_mut) {
            bs.push(bucket);
        } else if let Some(o) = self.doc.as_object_mut() {
            o.insert("buckets".into(), json!([bucket]));
        }
    }

    /// The ids of Studio's own types: what an organization starts with.
    pub fn studio_type_ids() -> Vec<String> {
        studio_types()
            .iter()
            .filter_map(|e| e.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect()
    }

    /// Mark every type that says nothing of where it came from as uploaded
    /// with the model `source`: what an import brings. Studio's own types
    /// are not marked; they are Studio's whichever model also carries them.
    pub fn mark_uploaded(&mut self, source: &str) {
        let studio = Self::studio_type_ids();
        let Some(entities) = self.doc.get_mut("entities").and_then(Value::as_array_mut) else {
            return;
        };
        for e in entities {
            let id = e.get("id").and_then(Value::as_str).unwrap_or_default();
            if studio.iter().any(|s| s == id) {
                continue;
            }
            if !e.get("meta").is_some_and(Value::is_object) {
                e["meta"] = json!({});
            }
            if e["meta"].get("origin").is_none() {
                e["meta"]["origin"] = json!("upload");
                e["meta"]["upload"] = json!(source);
            }
        }
    }

    /// Add the Studio types this model lacks, each in its bucket where
    /// Studio's own model orders it, and give a Studio type the model holds
    /// without a base the one Studio's has. Answers the ids touched.
    pub fn add_studio_types(&mut self) -> Vec<String> {
        let mut added = Vec::new();
        for entity in studio_types() {
            let Some(id) = entity.get("id").and_then(Value::as_str).map(str::to_owned) else {
                continue;
            };
            if self.has_entity(&id) {
                // A type Studio added before it named its base gets the base
                // now, and with it the fields every object carries
                // (`tenant_id`, scope, ...). One the model defined itself with
                // a base of its own keeps it.
                let base = entity
                    .get("extends")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let (Some(base), Ok(mine)) = (base, self.entity_mut(&id))
                    && mine
                        .get("extends")
                        .and_then(Value::as_str)
                        .is_none_or(str::is_empty)
                {
                    mine["extends"] = Value::String(base);
                    added.push(id.clone());
                }
                // And the fields and relations Studio's type has that this
                // one lacks, by name (its tabs among them). What is there
                // stays as it is.
                let theirs: Vec<Value> = entity
                    .get("properties")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if let Ok(mine) = self.entity_mut(&id) {
                    if !mine.get("properties").is_some_and(Value::is_array) {
                        mine["properties"] = json!([]);
                    }
                    if let Some(props) = mine["properties"].as_array_mut() {
                        let mut grew = false;
                        for p in theirs {
                            let name = p.get("name").and_then(Value::as_str).unwrap_or_default();
                            if !props
                                .iter()
                                .any(|q| q.get("name").and_then(Value::as_str) == Some(name))
                            {
                                props.push(p);
                                grew = true;
                            }
                        }
                        if grew && !added.contains(&id) {
                            added.push(id);
                        }
                    }
                }
                continue;
            }
            // After the type that precedes it in Studio's own bucket order.
            let after = studio_predecessor(&id);
            let bucket = entity
                .get("bucket")
                .and_then(Value::as_str)
                .map(str::to_owned);
            // A model without the bucket gets it from the seed, or the type
            // would sit in no group of the editor.
            if let Some(id) = &bucket {
                self.adopt_bucket(id);
            }
            let Some(entities) = self.doc.get_mut("entities").and_then(Value::as_array_mut) else {
                continue;
            };
            entities.push(entity);
            if let Some(order) = self
                .doc
                .get_mut("buckets")
                .and_then(Value::as_array_mut)
                .and_then(|bs| {
                    bs.iter_mut()
                        .find(|b| b.get("id").and_then(Value::as_str) == bucket.as_deref())
                })
                .and_then(|b| b.get_mut("entity_order"))
                .and_then(Value::as_array_mut)
            {
                let at = after
                    .and_then(|a| order.iter().position(|v| v.as_str() == Some(a.as_str())))
                    .map_or(order.len(), |i| i + 1);
                order.insert(at, Value::String(id.clone()));
            }
            added.push(id);
        }
        added
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
    /// The gear that keeps this type's objects (`meta.held_by`), when one does.
    pub fn held_by(&self, entity_id: &str) -> Option<&str> {
        self.entity(entity_id)?
            .get("meta")?
            .get("held_by")?
            .as_str()
            .filter(|g| !g.is_empty())
    }

    /// Mark a type as kept by `gear`; `false` when it already was.
    pub fn hold(
        &mut self,
        entity_id: &str,
        gear: &str,
        fields: &[String],
    ) -> Result<bool, OntologyError> {
        let entity = self
            .doc
            .get_mut("entities")
            .and_then(Value::as_array_mut)
            .ok_or(OntologyError::Malformed)?
            .iter_mut()
            .find(|e| e.get("id").and_then(Value::as_str) == Some(entity_id))
            .ok_or_else(|| OntologyError::UnknownEntity(entity_id.to_string()))?;
        let mut changed = false;
        // The fields the gear writes are its too: an administrator may add
        // fields beside them, but not rename, retype or drop one of them.
        if let Some(props) = entity.get_mut("properties").and_then(Value::as_array_mut) {
            for p in props.iter_mut() {
                let named = p
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| fields.iter().any(|f| f == n));
                if named && p.get("held_by").and_then(Value::as_str) != Some(gear) {
                    p["held_by"] = Value::String(gear.to_string());
                    changed = true;
                }
            }
        }
        if entity.pointer("/meta/held_by").and_then(Value::as_str) != Some(gear) {
            let obj = entity.as_object_mut().ok_or(OntologyError::Malformed)?;
            let meta = obj.entry("meta").or_insert_with(|| json!({}));
            if !meta.is_object() {
                *meta = json!({});
            }
            meta["held_by"] = Value::String(gear.to_string());
            changed = true;
        }
        Ok(changed)
    }

    /// Put back what gears keep that `current` has and this model lacks: a
    /// held type whole, a held field of a type. A revert or an import changes
    /// what people defined; it never takes a gear's records out from under it.
    /// Answers what it put back.
    pub fn keep_held_from(&mut self, current: &Ontology) -> Vec<String> {
        let mut kept = Vec::new();
        for held in current
            .entities()
            .iter()
            .filter(|e| e.pointer("/meta/held_by").is_some())
        {
            let Some(id) = held.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(entities) = self.doc.get_mut("entities").and_then(Value::as_array_mut) else {
                return kept;
            };
            match entities
                .iter_mut()
                .find(|e| e.get("id").and_then(Value::as_str) == Some(id))
            {
                None => {
                    entities.push(held.clone());
                    kept.push(id.to_string());
                }
                Some(mine) => {
                    if mine.pointer("/meta/held_by").is_none() {
                        let gear = held
                            .pointer("/meta/held_by")
                            .cloned()
                            .unwrap_or(Value::Null);
                        if let Some(obj) = mine.as_object_mut() {
                            let meta = obj.entry("meta").or_insert_with(|| json!({}));
                            if !meta.is_object() {
                                *meta = json!({});
                            }
                            meta["held_by"] = gear;
                        }
                        kept.push(id.to_string());
                    }
                    let held_props: Vec<Value> = held
                        .get("properties")
                        .and_then(Value::as_array)
                        .map(|ps| {
                            ps.iter()
                                .filter(|p| p.get("held_by").is_some())
                                .cloned()
                                .collect()
                        })
                        .unwrap_or_default();
                    let Some(props) = mine.get_mut("properties").and_then(Value::as_array_mut)
                    else {
                        continue;
                    };
                    for p in held_props {
                        let name = p
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        match props
                            .iter_mut()
                            .find(|q| q.get("name").and_then(Value::as_str) == Some(name.as_str()))
                        {
                            Some(q) => {
                                if q != &p {
                                    *q = p;
                                    kept.push(format!("{id}.{name}"));
                                }
                            }
                            None => {
                                props.push(p);
                                kept.push(format!("{id}.{name}"));
                            }
                        }
                    }
                }
            }
        }
        kept
    }

    /// Whether a gear's type is embedded for search by meaning
    /// (`meta.searchable`). A type no gear keeps always is.
    pub fn is_searchable(&self, entity_id: &str) -> bool {
        self.entity(entity_id)
            .and_then(|e| e.pointer("/meta/searchable"))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    /// Mark whether a gear's type is embedded for search; `false` when it
    /// already was as asked.
    pub fn set_searchable(
        &mut self,
        entity_id: &str,
        searchable: bool,
    ) -> Result<bool, OntologyError> {
        let entity = self
            .doc
            .get_mut("entities")
            .and_then(Value::as_array_mut)
            .ok_or(OntologyError::Malformed)?
            .iter_mut()
            .find(|e| e.get("id").and_then(Value::as_str) == Some(entity_id))
            .ok_or_else(|| OntologyError::UnknownEntity(entity_id.to_string()))?;
        if entity.pointer("/meta/searchable").and_then(Value::as_bool) == Some(searchable) {
            return Ok(false);
        }
        let obj = entity.as_object_mut().ok_or(OntologyError::Malformed)?;
        let meta = obj.entry("meta").or_insert_with(|| json!({}));
        if !meta.is_object() {
            *meta = json!({});
        }
        meta["searchable"] = Value::Bool(searchable);
        Ok(true)
    }

    /// Take in the types `other` defines that this model lacks, with the bases
    /// they extend: what objects moving here from `other` need. Answers the
    /// types taken in.
    pub fn adopt_from(&mut self, other: &Ontology, ids: &[String]) -> Vec<String> {
        let mut taken = Vec::new();
        for id in ids {
            for a in other.ancestors(id).into_iter().rev() {
                if self.has_entity(&a) {
                    // The type is here: the fields it was given there are too.
                    let theirs: Vec<Value> = other
                        .entity(&a)
                        .and_then(|e| e.get("properties"))
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let mine = self
                        .doc
                        .get_mut("entities")
                        .and_then(Value::as_array_mut)
                        .and_then(|es| {
                            es.iter_mut()
                                .find(|e| e.get("id").and_then(Value::as_str) == Some(a.as_str()))
                        })
                        .and_then(|e| e.get_mut("properties"))
                        .and_then(Value::as_array_mut);
                    if let Some(props) = mine {
                        for p in theirs {
                            let name = p
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            if !props.iter().any(|q| {
                                q.get("name").and_then(Value::as_str) == Some(name.as_str())
                            }) {
                                props.push(p);
                                taken.push(format!("{a}.{name}"));
                            }
                        }
                    }
                    continue;
                }
                let (Some(def), Some(entities)) = (
                    other.entity(&a).cloned(),
                    self.doc.get_mut("entities").and_then(Value::as_array_mut),
                ) else {
                    continue;
                };
                entities.push(def);
                taken.push(a);
            }
        }
        taken
    }

    /// The gear that writes this field of this type, when one does.
    pub fn field_held_by(&self, entity_id: &str, name: &str) -> Option<&str> {
        self.ancestors(entity_id).into_iter().find_map(|e| {
            self.entity(&e)?
                .get("properties")?
                .as_array()?
                .iter()
                .find(|p| p.get("name").and_then(Value::as_str) == Some(name))?
                .get("held_by")?
                .as_str()
        })
    }

    /// The fields declared on the type itself that no gear writes: what an
    /// administrator added beside a gear's own.
    pub fn open_own_fields(&self, entity_id: &str) -> Vec<String> {
        self.entity(entity_id)
            .and_then(|e| e.get("properties"))
            .and_then(Value::as_array)
            .map(|props| {
                props
                    .iter()
                    .filter(|p| p.get("held_by").is_none())
                    .filter(|p| {
                        !matches!(
                            p.get("extends").and_then(Value::as_str),
                            Some("edge") | Some("link")
                        )
                    })
                    .filter_map(|p| p.get("name").and_then(Value::as_str).map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn refuse_held_field(&self, entity_id: &str, name: &str) -> Result<(), OntologyError> {
        match self
            .own_property(entity_id, name)
            .and_then(|p| p.get("held_by"))
            .and_then(Value::as_str)
        {
            Some(gear) => Err(OntologyError::HeldField {
                name: name.to_string(),
                gear: gear.to_string(),
            }),
            None => Ok(()),
        }
    }

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

    /// Add an entity type to the model: a new kind of object, with no fields of
    /// its own until fields are added, and everything its base declares.
    ///
    /// The id becomes the type's GTS leaf, so it is held to what a leaf can be:
    /// lower-case words joined by hyphens, starting with a letter.
    pub fn add_entity(&mut self, spec: EntitySpec) -> Result<Value, OntologyError> {
        let id = spec.id.trim().to_string();
        let well_formed = id.len() <= 64
            && id.starts_with(|c: char| c.is_ascii_lowercase())
            && id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && !id.ends_with('-');
        if !well_formed {
            return Err(OntologyError::InvalidEntityId(id));
        }
        if self.has_entity(&id) {
            return Err(OntologyError::DuplicateEntity(id));
        }
        let extends = match spec
            .extends
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(base) => Some(
                self.resolve_entity_id(base)
                    .ok_or_else(|| OntologyError::UnknownEntity(base.to_string()))?,
            ),
            None => None,
        };
        // The bucket a new type is drawn in: the one asked for, else its base's.
        let bucket = spec
            .bucket
            .filter(|b| !b.trim().is_empty())
            .or_else(|| {
                extends
                    .as_deref()
                    .and_then(|b| self.entity(b))
                    .and_then(|e| e.get("bucket"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "planning".to_string());
        let name = Some(spec.name.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| id.clone());
        let entity = json!({
            "id": id,
            "layer": "product",
            "extends": extends,
            "abstract": false,
            "bucket": bucket,
            "name": name,
            "kind": "entity",
            "description": spec.description.unwrap_or_default(),
            "meta": spec.origin.map_or_else(|| json!({}), |o| json!({ "origin": o })),
            "properties": [],
            "methods": [],
            "examples": [],
        });
        self.doc
            .get_mut("entities")
            .and_then(Value::as_array_mut)
            .ok_or(OntologyError::Malformed)?
            .push(entity.clone());
        Ok(entity)
    }

    /// Declare a relation on an entity: `name` from it to `target` (an
    /// entity id) as a `verb` edge. Only adds; an existing property of that
    /// name is left as it is.
    /// Give `level` a tab: a relation of kind `shows` named `name`, to
    /// `target`, labelled `label`. False when the name is taken.
    pub fn add_tab(
        &mut self,
        level: &str,
        name: &str,
        label: &str,
        target: &str,
    ) -> Result<bool, OntologyError> {
        if !self.has_entity(target) {
            return Err(OntologyError::UnknownEntity(target.to_string()));
        }
        if !self.add_relation(level, name, target, "shows")? {
            return Ok(false);
        }
        if let Some(p) = self
            .entity_mut(level)?
            .get_mut("properties")
            .and_then(Value::as_array_mut)
            .and_then(|ps| {
                ps.iter_mut()
                    .find(|p| p.get("name").and_then(Value::as_str) == Some(name))
            })
        {
            p["relationLabel"] = Value::String(label.to_string());
            p["description"] = Value::String(format!("A tab of the {level}: what it shows."));
        }
        Ok(true)
    }

    pub fn add_relation(
        &mut self,
        entity_id: &str,
        name: &str,
        target: &str,
        verb: &str,
    ) -> Result<bool, OntologyError> {
        let target_name = self
            .entity(target)
            .and_then(|e| e.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(target)
            .to_string();
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
            .any(|p| p.get("name").and_then(Value::as_str) == Some(name))
        {
            return Ok(false);
        }
        props.push(json!({
            "name": name,
            "type": target_name,
            "description": "",
            "required": false,
            "extends": "edge",
            "relation": target,
            "relationType": verb,
            "relationLabel": name.replace('_', " "),
        }));
        Ok(true)
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

    /// Change a field a type already declares: rename it, retype it, make it
    /// required or not.
    ///
    /// Only the entity's **own** fields can be edited. A field it inherits
    /// belongs to the base that declares it, and editing it there is a
    /// different change with a much wider blast radius, so it is refused and
    /// says where the field actually lives.
    ///
    /// Relation properties are refused too: they are materialized as `declares`
    /// edges in the model graph, and editing one means removing an edge as well
    /// as a property. That is possible — a node read returns each incident
    /// edge's key, which `delete_edge` takes — but it is a second write path
    /// with its own failure modes, and it is not built. Refusing is honest;
    /// editing the property and leaving the edge would not be.
    pub fn edit_field(
        &mut self,
        entity_id: &str,
        name: &str,
        edit: &FieldEdit,
    ) -> Result<FieldChange, OntologyError> {
        self.refuse_held_field(entity_id, name)?;
        // A rename that has already landed: the old name is gone and the new
        // one is there. That is what a retried migration looks like, and it has
        // to be told apart from a mistyped field name, which is an error.
        if let Some(new_name) = &edit.rename_to
            && new_name != name
        {
            let source = self.own_property(entity_id, name).is_some();
            let target = self.own_property(entity_id, new_name).is_some();
            match (source, target) {
                (false, true) => return Err(OntologyError::AlreadyApplied),
                (true, true) => return Err(OntologyError::DuplicateField(new_name.clone())),
                _ => {}
            }
        }
        let index = self.own_property_index(entity_id, name)?;
        let entity = self.entity_mut(entity_id)?;
        let property = entity["properties"][index]
            .as_object_mut()
            .ok_or(OntologyError::Malformed)?;
        let before = Value::Object(property.clone());

        if let Some(new_name) = &edit.rename_to {
            property.insert("name".to_string(), json!(new_name));
        }
        if let Some(type_name) = &edit.type_name {
            property.insert("type".to_string(), json!(type_name));
        }
        if let Some(required) = edit.required {
            property.insert("required".to_string(), json!(required));
        }
        if let Some(description) = &edit.description {
            property.insert("description".to_string(), json!(description));
        }
        let after = Value::Object(property.clone());
        let entity = entity.clone();
        Ok(FieldChange {
            index,
            before,
            after,
            entity,
        })
    }

    /// Drop a field from a type. The stored objects keep whatever they hold
    /// under that key — removing a field from the model is not permission to
    /// delete data — so it starts being reported as undeclared instead.
    ///
    /// Same two refusals as [`Self::edit_field`]: inherited fields and relation
    /// properties.
    pub fn remove_field(
        &mut self,
        entity_id: &str,
        name: &str,
    ) -> Result<FieldChange, OntologyError> {
        self.refuse_held_field(entity_id, name)?;
        let index = match self.own_tab_index(entity_id, name)? {
            Some(index) => index,
            None => self.own_property_index(entity_id, name)?,
        };
        let entity = self.entity_mut(entity_id)?;
        let before = entity["properties"]
            .as_array_mut()
            .ok_or(OntologyError::Malformed)?
            .remove(index);
        let entity = entity.clone();
        Ok(FieldChange {
            index,
            before,
            after: Value::Null,
            entity,
        })
    }

    /// Where a tab the level declares itself sits: a relation of kind `shows`,
    /// which goes the way a field does. Its model edge is only drawn from the
    /// document, never written alone, so the document is all there is to
    /// change. Studio's own tabs are turned off, not removed: the start-up
    /// sweep would bring them back.
    fn own_tab_index(&self, level: &str, name: &str) -> Result<Option<usize>, OntologyError> {
        let named = |p: &&Value| p.get("name").and_then(Value::as_str) == Some(name);
        let Some(index) = self
            .entity(level)
            .and_then(|e| e.get("properties"))
            .and_then(Value::as_array)
            .and_then(|ps| {
                ps.iter().position(|p| {
                    named(&p) && p.get("relationType").and_then(Value::as_str) == Some("shows")
                })
            })
        else {
            return Ok(None);
        };
        let studio_s = studio_types().iter().any(|e| {
            e.get("id").and_then(Value::as_str) == Some(level)
                && e.get("properties")
                    .and_then(Value::as_array)
                    .is_some_and(|ps| ps.iter().any(|p| named(&p)))
        });
        if studio_s {
            return Err(OntologyError::StudioTab(name.to_string()));
        }
        Ok(Some(index))
    }

    /// A property the entity declares itself, ignoring what it inherits.
    fn own_property(&self, entity_id: &str, name: &str) -> Option<&Value> {
        self.entity(entity_id)?
            .get("properties")?
            .as_array()?
            .iter()
            .find(|p| p.get("name").and_then(Value::as_str) == Some(name))
    }

    /// Where an editable own property sits, or why it cannot be edited.
    fn own_property_index(&self, entity_id: &str, name: &str) -> Result<usize, OntologyError> {
        let entity = self
            .entity(entity_id)
            .ok_or_else(|| OntologyError::UnknownEntity(entity_id.to_string()))?;
        let properties = entity
            .get("properties")
            .and_then(Value::as_array)
            .ok_or(OntologyError::Malformed)?;
        let index = properties
            .iter()
            .position(|p| p.get("name").and_then(Value::as_str) == Some(name))
            .ok_or_else(|| {
                // Not its own — say whether a base has it, which is the usual
                // reason and not otherwise visible from the entity document.
                match self
                    .effective_properties(entity_id)
                    .into_iter()
                    .find(|p| p.name == name)
                {
                    Some(inherited) => OntologyError::InheritedField {
                        name: name.to_string(),
                        declared_by: inherited.declared_by,
                    },
                    None => OntologyError::UnknownField(name.to_string()),
                }
            })?;
        if matches!(
            properties[index].get("extends").and_then(Value::as_str),
            Some("edge") | Some("link")
        ) {
            return Err(OntologyError::RelationProperty(name.to_string()));
        }
        Ok(index)
    }

    fn entity_mut(&mut self, entity_id: &str) -> Result<&mut Value, OntologyError> {
        self.doc
            .get_mut("entities")
            .and_then(Value::as_array_mut)
            .ok_or(OntologyError::Malformed)?
            .iter_mut()
            .find(|e| e.get("id").and_then(Value::as_str) == Some(entity_id))
            .ok_or_else(|| OntologyError::UnknownEntity(entity_id.to_string()))
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

/// A type to add to the model.
#[derive(Debug, Clone, Default)]
pub struct EntitySpec {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// The bucket it is drawn in; its base's when absent.
    pub bucket: Option<String>,
    /// The type it extends, whose fields and relations it inherits.
    pub extends: Option<String>,
    /// Who added it, kept as `meta.origin`: `organization` for a type an
    /// administrator made, `studio` for one a gear needed.
    pub origin: Option<String>,
}

/// A field to add to a type (goal #2, "extend types by adding new fields").
#[derive(Debug, Clone)]
pub struct FieldSpec {
    pub name: String,
    pub type_name: String,
    pub description: Option<String>,
    pub required: bool,
}

/// What to change about a field that already exists. Every part is optional;
/// `None` leaves it as it was.
#[derive(Debug, Clone, Default)]
pub struct FieldEdit {
    /// Rename the field. The stored objects still carry the old key, so the
    /// caller is expected to migrate them — see
    /// [`super::service::DomainModelService::edit_field`].
    pub rename_to: Option<String>,
    pub type_name: Option<String>,
    pub required: Option<bool>,
    pub description: Option<String>,
}

impl FieldEdit {
    pub fn is_empty(&self) -> bool {
        self.rename_to.is_none()
            && self.type_name.is_none()
            && self.required.is_none()
            && self.description.is_none()
    }
}

/// One field before and after an edit, so the caller can record the change and
/// its inverse.
#[derive(Debug, Clone)]
pub struct FieldChange {
    /// Where the field sits in the entity's `properties` array.
    pub index: usize,
    pub before: Value,
    pub after: Value,
    pub entity: Value,
}

/// Why an ontology edit was refused.
#[derive(Debug)]
pub enum OntologyError {
    UnknownEntity(String),
    DuplicateEntity(String),
    InvalidEntityId(String),
    DuplicateField(String),
    UnknownField(String),
    /// The edit is already in the model — a retried rename, not a fault.
    AlreadyApplied,
    /// The field belongs to a base, not to this type.
    InheritedField {
        name: String,
        declared_by: String,
    },
    /// The field is a relation, which becomes an edge rather than payload.
    RelationProperty(String),
    /// One of the tabs Studio gives every level: turned off, not removed.
    StudioTab(String),
    /// A gear writes the field: renaming, retyping or dropping it would break
    /// the gear's records.
    HeldField {
        name: String,
        gear: String,
    },
    Malformed,
}

impl std::fmt::Display for OntologyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownEntity(id) => write!(f, "unknown domain entity: {id}"),
            Self::DuplicateEntity(id) => write!(f, "the model already has a type `{id}`"),
            Self::InvalidEntityId(id) => write!(
                f,
                "`{id}` is not a type id: lower-case words joined by hyphens, starting with a letter"
            ),
            Self::DuplicateField(name) => write!(f, "field already exists: {name}"),
            Self::UnknownField(name) => write!(f, "no such field: {name}"),
            Self::AlreadyApplied => write!(f, "the edit is already in the model"),
            Self::InheritedField { name, declared_by } => write!(
                f,
                "`{name}` is declared by `{declared_by}`, not by this type — edit it there, \
                 which changes it for everything that extends it"
            ),
            Self::RelationProperty(name) => write!(
                f,
                "`{name}` is a relation, not a payload field: it is stored as a `declares` edge \
                 in the model graph, and removing that edge is not implemented here"
            ),
            Self::StudioTab(name) => write!(
                f,
                "`{name}` is one of Studio's own tabs: turn it off in the level's tabs \
                 instead, since Studio would add it back"
            ),
            Self::HeldField { name, gear } => write!(
                f,
                "`{name}` is written by {gear}: add a field beside it instead of changing it"
            ),
            Self::Malformed => write!(f, "ontology document is malformed"),
        }
    }
}

impl std::error::Error for OntologyError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn studio_s_own_types_join_a_model_that_lacks_them_once() {
        let seeded = Ontology::load();
        assert!(
            seeded.has_entity("workspace"),
            "the seed carries Studio's types"
        );

        let core: Value = serde_json::from_str(PRODUCT_MODEL_JSON).unwrap();
        let mut imported = Ontology::from_value(core).unwrap();
        assert!(!imported.has_entity("workspace"));
        let added = imported.add_studio_types();
        assert!(added.contains(&"workspace".to_string()), "{added:?}");
        assert!(added.contains(&"organization".to_string()), "{added:?}");
        assert!(imported.has_entity("workspace"));
        let order = imported.doc["buckets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == "planning")
            .unwrap()["entity_order"]
            .clone();
        let at = |id: &str| order.as_array().unwrap().iter().position(|v| v == id);
        // In Studio's order: project, organization, workspace.
        assert_eq!(at("organization"), at("project").map(|p| p + 1), "{order}");
        assert_eq!(
            at("workspace"),
            at("organization").map(|p| p + 1),
            "{order}"
        );
        assert!(imported.add_studio_types().is_empty(), "added once");
    }

    #[test]
    fn a_workspace_studio_added_without_a_base_gets_one_and_its_tenant_id() {
        let mut doc: Value = serde_json::from_str(PRODUCT_MODEL_JSON).unwrap();
        doc["entities"].as_array_mut().unwrap().push(json!({
            "id": "workspace", "bucket": "planning", "name": "Workspace", "properties": []
        }));
        let mut model = Ontology::from_value(doc).unwrap();
        assert!(
            !model
                .effective_properties("workspace")
                .iter()
                .any(|p| p.name == "tenant_id")
        );
        assert!(model.add_studio_types().contains(&"workspace".to_string()));
        assert_eq!(
            model.entity("workspace").unwrap()["extends"],
            "managed-object"
        );
        assert!(
            model
                .effective_properties("workspace")
                .iter()
                .any(|p| p.name == "tenant_id")
        );
        assert!(model.add_studio_types().is_empty(), "repaired once");
    }

    #[test]
    fn a_model_s_own_workspace_type_is_kept() {
        let mut doc: Value = serde_json::from_str(PRODUCT_MODEL_JSON).unwrap();
        doc["entities"].as_array_mut().unwrap().push(json!({
            "id": "workspace", "bucket": "planning", "name": "Team space",
            "extends": "node", "properties": []
        }));
        let mut model = Ontology::from_value(doc).unwrap();
        model.add_studio_types();
        // Its own name and base stay; Studio's fields and tabs join it.
        let ws = model.entity("workspace").unwrap();
        assert_eq!(ws["name"], "Team space");
        assert_eq!(ws["extends"], "node");
        assert!(
            ws["properties"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["name"] == "projects" && p["relationType"] == "shows")
        );
        assert!(model.add_studio_types().is_empty(), "once");
    }

    #[test]
    fn every_level_shows_its_tabs_as_relations() {
        let model = Ontology::load();
        for (level, first) in [
            ("organization", "org"),
            ("workspace", "projects"),
            ("project", "overview"),
        ] {
            let tabs: Vec<&str> = model.entity(level).unwrap()["properties"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| p["relationType"] == "shows")
                .filter_map(|p| p["name"].as_str())
                .collect();
            assert_eq!(tabs.first(), Some(&first), "{level}: {tabs:?}");
        }
    }

    #[test]
    fn an_added_tab_is_removed_like_a_field_and_studio_s_are_not() {
        let mut model = Ontology::load();
        let tabs = |m: &Ontology| -> Vec<String> {
            m.entity("organization").unwrap()["properties"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| p["relationType"] == "shows")
                .filter_map(|p| p["name"].as_str().map(str::to_string))
                .collect()
        };
        assert!(
            model
                .add_tab(
                    "organization",
                    "repository_file",
                    "Files",
                    "repository-file"
                )
                .unwrap()
        );
        assert!(tabs(&model).contains(&"repository_file".to_string()));

        let change = model
            .remove_field("organization", "repository_file")
            .unwrap();
        assert_eq!(change.before["relationType"], "shows");
        assert!(!tabs(&model).contains(&"repository_file".to_string()));

        let refused = model.remove_field("organization", "projects").unwrap_err();
        assert!(matches!(refused, OntologyError::StudioTab(_)), "{refused}");
        assert!(tabs(&model).contains(&"projects".to_string()));

        // Any other relation is still not a field to drop.
        let other = model.entity("project").unwrap()["properties"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["extends"] == "edge" && p["relationType"] != "shows")
            .and_then(|p| p["name"].as_str())
            .unwrap()
            .to_string();
        let refused = model.remove_field("project", &other).unwrap_err();
        assert!(
            matches!(refused, OntologyError::RelationProperty(_)),
            "{refused}"
        );
    }

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
