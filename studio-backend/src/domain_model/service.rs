//! The domain-model service: the ontology plus the object store.
//!
//! It answers the three goals directly — create objects of the domain types,
//! extend a type with a new field, and read the ontology back so the frontend
//! can be regenerated from the stored model.

use std::sync::Arc;
use std::sync::Mutex;

use serde_json::Value;
use toolkit_security::SecurityContext;

use super::gts;
use super::ontology::{FieldSpec, ModelEdgeKind, Ontology};
use super::store::{DomainStore, EdgeUpsert, EdgeView, NodeUpsert, ObjectNode};

/// The outcome of creating an object.
#[derive(Debug, Clone)]
pub struct CreatedObject {
    pub type_id: String,
    pub instance_id: String,
}

/// One relation as registered — its verb, edge type id and endpoint typing.
#[derive(Debug, Clone)]
pub struct RelationEntry {
    pub relation_kind: String,
    pub type_id: String,
    pub src_type_ids: Vec<String>,
    pub dst_type_ids: Vec<String>,
}

/// The relation catalog: every relation with its endpoints, plus the
/// cross-bucket targets not yet resolvable in the current ontology.
#[derive(Debug, Clone)]
pub struct RelationCatalog {
    pub relations: Vec<RelationEntry>,
    pub unresolved: Vec<(String, String)>,
}

/// What a model-graph sync wrote.
#[derive(Debug, Clone)]
pub struct ModelSyncReport {
    /// Object-type nodes upserted (one per entity).
    pub object_types: u64,
    /// `inherits` edges upserted.
    pub inherits: u64,
    /// `declares` edges upserted.
    pub declares: u64,
    /// Endpoints skipped because they named no modeled entity (no dangling
    /// edge was produced).
    pub skipped_endpoints: u64,
}

/// The outcome of importing an uploaded model.
#[derive(Debug, Clone)]
pub struct ImportSummary {
    pub entities: u64,
    pub buckets: u64,
    pub node_types: u64,
    pub edge_types: u64,
}

pub struct DomainModelService {
    /// The live ontology (mutable: a field can be appended to a type, or the
    /// whole model replaced by an uploaded one).
    ontology: Mutex<Ontology>,
    store: Arc<dyn DomainStore>,
}

impl DomainModelService {
    pub fn new(store: Arc<dyn DomainStore>) -> Self {
        Self {
            ontology: Mutex::new(Ontology::load()),
            store,
        }
    }

    /// Import an uploaded model document (the domain-entity shape), making it
    /// the active ontology and registering its types. This is what the frontend
    /// upload posts — the model is loaded through the UI rather than only from
    /// the embedded default. Idempotent per type; new types are added.
    pub async fn import_model(
        &self,
        ctx: &SecurityContext,
        doc: Value,
    ) -> anyhow::Result<ImportSummary> {
        let ontology = Ontology::from_value(doc).map_err(|e| anyhow::anyhow!("{e}"))?;
        let summary = ImportSummary {
            entities: ontology.entities().len() as u64,
            buckets: ontology.bucket_count() as u64,
            node_types: ontology.node_types().len() as u64,
            edge_types: ontology.edge_types().len() as u64,
        };
        {
            let mut o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            *o = ontology;
        }
        // Register the uploaded model's types with the graph + type-registry.
        self.ensure_types(ctx).await?;
        Ok(summary)
    }

    /// The whole ontology document — the source the frontend regenerates from.
    pub fn ontology_document(&self) -> anyhow::Result<Value> {
        let o = self
            .ontology
            .lock()
            .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
        Ok(o.document().clone())
    }

    /// The relation catalog — how relations are synced into the graph and the
    /// type-registry: each relation kind with its endpoint typing, plus the
    /// cross-bucket targets still pending a wider sync.
    pub fn relation_catalog(&self) -> anyhow::Result<RelationCatalog> {
        let o = self
            .ontology
            .lock()
            .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
        let relations = o
            .edge_types()
            .into_iter()
            .map(|e| RelationEntry {
                relation_kind: e.relation_kind,
                type_id: e.type_id,
                src_type_ids: e.src_type_ids,
                dst_type_ids: e.dst_type_ids,
            })
            .collect();
        let unresolved = o.unresolved_relation_targets();
        Ok(RelationCatalog {
            relations,
            unresolved,
        })
    }

    /// Register every domain node and edge type with the store. Idempotent, so
    /// it runs before each create/list; the type *set* is fixed (adding a field
    /// does not add a type), so this never needs to react to an ontology edit.
    async fn ensure_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        let (node_types, edge_types) = {
            let o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            (o.node_types(), o.edge_types())
        };
        self.store
            .register_types(ctx, &node_types, &edge_types)
            .await
    }

    /// Create (or upsert) an object of a domain type. `type_ref` may be an
    /// ontology id (`role-assignment`), a node type id
    /// (`gts.cf.studio.domain.role_assignment.v1~`) or its leaf. `key` is a
    /// caller-chosen stable key; the same `(type, key)` upserts.
    pub async fn create_object(
        &self,
        ctx: &SecurityContext,
        type_ref: &str,
        key: &str,
        payload: Value,
    ) -> anyhow::Result<CreatedObject> {
        let entity_id = {
            let o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            o.resolve_entity_id(type_ref)
                .ok_or_else(|| anyhow::anyhow!("unknown domain type: {type_ref}"))?
        };
        let type_id = gts::node_type_id(&entity_id);
        let instance_id = gts::instance_id(&type_id, key);
        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string);

        self.ensure_types(ctx).await?;
        self.store
            .create_object(ctx, &type_id, &instance_id, name, payload)
            .await?;
        Ok(CreatedObject {
            type_id,
            instance_id,
        })
    }

    /// Create (or upsert) a relation between two objects, addressed by their
    /// instance ids. `relation_kind` is one of the ontology's relation verbs
    /// (`member`, `owns`, `references`, `composes`).
    pub async fn create_relation(
        &self,
        ctx: &SecurityContext,
        relation_kind: &str,
        from: &str,
        to: &str,
    ) -> anyhow::Result<String> {
        let known = {
            let o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            o.edge_types()
                .into_iter()
                .any(|e| e.relation_kind == relation_kind)
        };
        if !known {
            return Err(anyhow::anyhow!("unknown relation kind: {relation_kind}"));
        }
        let edge_type_id = gts::edge_type_id(relation_kind);
        self.ensure_types(ctx).await?;
        self.store
            .create_relation(ctx, &edge_type_id, from, to)
            .await?;
        Ok(edge_type_id)
    }

    /// List objects, optionally of one type. `None` = every domain type.
    pub async fn list_objects(
        &self,
        ctx: &SecurityContext,
        type_ref: Option<&str>,
    ) -> anyhow::Result<Vec<ObjectNode>> {
        let type_ids: Vec<String> = {
            let o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            match type_ref.map(str::trim).filter(|s| !s.is_empty()) {
                None => o.node_types().into_iter().map(|n| n.type_id).collect(),
                Some(r) => match o.resolve_entity_id(r) {
                    Some(entity_id) => vec![gts::node_type_id(&entity_id)],
                    // Unknown type -> no rows, rather than every row.
                    None => Vec::new(),
                },
            }
        };
        if type_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.ensure_types(ctx).await?;
        self.store.list_objects(ctx, &type_ids).await
    }

    /// Sync the model *as a graph*: materialize one object-type node per entity
    /// and the `inherits` / `declares` edges among them, so the domain model —
    /// with its relations — is itself queryable in the graph. Idempotent: node
    /// keys and edge endpoints are deterministic, so a re-sync converges.
    pub async fn sync_model(&self, ctx: &SecurityContext) -> anyhow::Result<ModelSyncReport> {
        // Registers the instance types and the meta layer (object_type node +
        // inherits/declares edges) the sync writes into.
        self.ensure_types(ctx).await?;

        let graph = {
            let o = self
                .ontology
                .lock()
                .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
            o.model_graph()
        };

        let node_key = |entity_id: &str| gts::instance_id(gts::META_OBJECT_TYPE, entity_id);

        let nodes: Vec<NodeUpsert> = graph
            .nodes
            .iter()
            .map(|n| NodeUpsert {
                type_id: gts::META_OBJECT_TYPE.to_string(),
                node_key: node_key(&n.entity_id),
                name: Some(n.name.clone()),
                payload: n.payload.clone(),
            })
            .collect();

        let edges: Vec<EdgeUpsert> = graph
            .edges
            .iter()
            .map(|e| EdgeUpsert {
                type_id: match e.kind {
                    ModelEdgeKind::Inherits => gts::META_INHERITS.to_string(),
                    ModelEdgeKind::Declares => gts::META_DECLARES.to_string(),
                },
                from: node_key(&e.from_entity),
                to: node_key(&e.to_entity),
                payload: Some(e.payload.clone()),
            })
            .collect();

        let inherits = graph
            .edges
            .iter()
            .filter(|e| e.kind == ModelEdgeKind::Inherits)
            .count() as u64;
        let declares = graph
            .edges
            .iter()
            .filter(|e| e.kind == ModelEdgeKind::Declares)
            .count() as u64;

        // Nodes first, then edges: every endpoint exists before its edge. The
        // store's return is the ingest *delta* (0 on an idempotent re-sync), so
        // report what was synced (present in the graph after this call), which
        // is stable across re-runs.
        self.store.upsert_nodes(ctx, &nodes).await?;
        self.store.upsert_edges(ctx, &edges).await?;

        Ok(ModelSyncReport {
            object_types: nodes.len() as u64,
            inherits,
            declares,
            skipped_endpoints: graph.skipped as u64,
        })
    }

    /// Read the model graph back *out of the graph store* (not the embedded
    /// ontology): the `object_type` nodes and their `inherits`/`declares` edges
    /// as materialized by [`Self::sync_model`]. This is the read side of the
    /// sync — proof the model round-trips through Graph Storage, and the data a
    /// visualization renders.
    pub async fn model_graph_view(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<(Vec<ObjectNode>, Vec<EdgeView>)> {
        self.ensure_types(ctx).await?;
        let nodes = self
            .store
            .list_objects(ctx, &[gts::META_OBJECT_TYPE.to_string()])
            .await?;
        let seeds: Vec<String> = nodes.iter().map(|n| n.instance_id.clone()).collect();
        let edges = self
            .store
            .read_edges(ctx, &seeds)
            .await?
            .into_iter()
            .filter(|e| e.type_id == gts::META_INHERITS || e.type_id == gts::META_DECLARES)
            .collect();
        Ok((nodes, edges))
    }

    /// Extend a domain type with a new field. Returns the updated entity. The
    /// registered graph type is open, so this is a pure ontology edit — no
    /// migration, no re-registration.
    pub fn add_field(&self, entity_ref: &str, field: FieldSpec) -> anyhow::Result<Value> {
        let mut o = self
            .ontology
            .lock()
            .map_err(|_| anyhow::anyhow!("ontology lock poisoned"))?;
        let entity_id = o
            .resolve_entity_id(entity_ref)
            .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity_ref}"))?;
        o.add_field(&entity_id, field)
            .map_err(|e| anyhow::anyhow!("{e}"))
    }
}
