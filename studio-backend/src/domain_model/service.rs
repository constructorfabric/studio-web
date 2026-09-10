//! The domain-model service: the ontology plus the object store.
//!
//! It answers the three goals directly — create objects of the domain types,
//! extend a type with a new field, and read the ontology back so the frontend
//! can be regenerated from the stored model.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use super::gts;
use super::ontology::{DeclaredRelation, EffectiveProperty, FieldSpec, ModelEdgeKind, Ontology};
use super::store::{DomainStore, EdgeUpsert, EdgeView, NodeUpsert, ObjectNode};
use super::validate::{Report, ValidateMode};

/// Everything about one object write except the object: where it is scoped,
/// whether it may replace what is there, and how hard it is checked.
#[derive(Debug, Clone, Copy, Default)]
pub struct WriteOptions<'a> {
    /// Workspace/project scope. The same key in two scopes is two objects;
    /// `None` is tenant-wide.
    pub scope: Option<&'a str>,
    /// Refuse the write when the object already exists, instead of replacing
    /// it.
    pub if_absent: bool,
    /// How hard the payload is checked against the type.
    pub validate: ValidateMode,
}

/// The outcome of relating two objects.
#[derive(Debug, Clone)]
pub struct CreatedRelation {
    pub type_id: String,
    /// The relation verb (`member`, `owns`, …).
    pub verb: String,
    /// The declared relation's property name, when the pair matched one.
    pub name: Option<String>,
    /// Its human label from the model, when there is one.
    pub label: Option<String>,
    /// The declared cardinality, when the model states one.
    pub cardinality: Option<String>,
}

/// The outcome of creating an object.
#[derive(Debug, Clone)]
pub struct CreatedObject {
    pub type_id: String,
    pub instance_id: String,
    /// What checking the payload against the type found. Always reported, even
    /// in `warn`, where the write went ahead anyway.
    pub report: Report,
}

/// A type as it actually is: its own fields plus everything it inherits, and
/// the relations it may take part in.
#[derive(Debug, Clone)]
pub struct EffectiveType {
    pub entity_id: String,
    pub name: String,
    pub description: String,
    pub bucket: String,
    /// The entity and every base it extends, nearest first.
    pub ancestors: Vec<String>,
    pub properties: Vec<EffectiveProperty>,
    /// Relations declared on this type or on any of its bases.
    pub relations: Vec<DeclaredRelation>,
}

/// One relation as registered — its verb, edge type id and endpoint typing.
#[derive(Debug, Clone)]
pub struct RelationEntry {
    pub relation_kind: String,
    pub type_id: String,
    pub src_type_ids: Vec<String>,
    pub dst_type_ids: Vec<String>,
}

/// The relation catalog: relation verbs with their endpoints, every declared
/// relation (with cardinality), plus the targets not yet resolvable.
#[derive(Debug, Clone)]
pub struct RelationCatalog {
    pub relations: Vec<RelationEntry>,
    pub declared: Vec<super::ontology::DeclaredRelation>,
    pub unresolved: Vec<(String, String)>,
}

/// One model-graph edge with its properties (for `declares`: name / verb /
/// cardinality / label; for `inherits`: the base).
#[derive(Debug, Clone)]
pub struct ModelGraphEdge {
    pub type_id: String,
    pub from: String,
    pub to: String,
    pub payload: Value,
}

/// One created object as a graph node (its entity type + bucket for colouring,
/// plus the full stored payload — the object's document in Graph Storage).
#[derive(Debug, Clone)]
pub struct ObjectGraphNode {
    pub instance_id: String,
    pub entity: String,
    pub bucket: String,
    pub name: String,
    pub value: Value,
}

/// What a model-graph sync wrote.
#[derive(Debug, Clone)]
pub struct ModelSyncReport {
    /// The model version now stored.
    pub version: u64,
    /// Type ids that kept an older registered schema (see
    /// [`DomainModelService::ensure_types`]).
    pub pinned_types: Vec<String>,
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

/// How many times an edit recomputes itself against another writer's before
/// giving up.
const EDIT_ATTEMPTS: usize = 4;

/// What a revert did.
#[derive(Debug, Clone)]
pub struct RevertReport {
    /// The new head — a revert is recorded as a version of its own.
    pub version: u64,
    /// The versions it undid, newest first.
    pub undone: Vec<u64>,
}

/// One recorded change to the model.
///
/// A revision is a *node*, keyed on its number, and the numbers are what make
/// concurrent edits safe: claiming version N is an insert at a key only one
/// writer can take (see [`DomainModelService::claim_version`]).
///
/// `patch` and `undo` are RFC-6902 patches over the ontology document — the
/// forward change and its inverse. They are emitted by the edit that knows
/// what it did, never diffed after the fact. An operation too coarse to
/// express as a patch (importing a whole model) records empty ones and says so
/// by refusing to be reverted through.
#[derive(Debug, Clone)]
pub struct Revision {
    pub version: u64,
    /// RFC-3339, when the edit was made.
    pub at: String,
    /// The subject that made it.
    pub by: String,
    /// `seed` | `add_field` | `import` | `revert`.
    pub op: String,
    /// The entity the edit touched, empty for a whole-model operation.
    pub target: String,
    pub summary: String,
    pub patch: Value,
    pub undo: Value,
}

impl Revision {
    fn new(version: u64, ctx: &SecurityContext, op: &str, target: &str, summary: String) -> Self {
        Self {
            version,
            at: OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_default(),
            by: ctx.subject_id().to_string(),
            op: op.to_string(),
            target: target.to_string(),
            summary,
            patch: json!([]),
            undo: json!([]),
        }
    }

    fn with_patches(mut self, patch: Value, undo: Value) -> Self {
        self.patch = patch;
        self.undo = undo;
        self
    }

    fn payload(&self) -> Value {
        json!({
            "version": self.version,
            "at": self.at,
            "by": self.by,
            "op": self.op,
            "target": self.target,
            "summary": self.summary,
            "patch": self.patch,
            "undo": self.undo,
        })
    }

    fn from_payload(v: &Value) -> Option<Self> {
        Some(Self {
            version: v.get("version")?.as_u64()?,
            at: v["at"].as_str().unwrap_or("").to_string(),
            by: v["by"].as_str().unwrap_or("").to_string(),
            op: v["op"].as_str().unwrap_or("").to_string(),
            target: v["target"].as_str().unwrap_or("").to_string(),
            summary: v["summary"].as_str().unwrap_or("").to_string(),
            patch: v.get("patch").cloned().unwrap_or_else(|| json!([])),
            undo: v.get("undo").cloned().unwrap_or_else(|| json!([])),
        })
    }

    /// True when this revision can be undone — an import replaces the whole
    /// document, so it records no inverse and nothing can be reverted past it.
    fn is_reversible(&self) -> bool {
        self.undo.as_array().is_some_and(|a| !a.is_empty())
    }
}

/// One tenant's live model. The graph is the model's system of record, so this
/// is a *cache* of what the graph holds — not the model itself.
struct TenantModel {
    /// Shared by every in-flight read; an edit replaces the `Arc`
    /// (copy-on-write) rather than mutating in place.
    ontology: Arc<Ontology>,
    /// The graph holds this model. False while the tenant is running the
    /// embedded seed and nothing has been stored for it yet.
    persisted: bool,
    /// This model's node and edge types are registered for this tenant.
    registered: bool,
    /// Type ids whose registered schema is older than the model — see
    /// [`DomainModelService::ensure_types`].
    pinned: Vec<String>,
    /// The model version this cache holds. Also the head the next edit claims
    /// one past.
    version: u64,
}

pub struct DomainModelService {
    store: Arc<dyn DomainStore>,
    /// Per tenant, because the model is per tenant: the graph is tenant-scoped,
    /// so two tenants can run different models. A single process-wide ontology
    /// could not represent that.
    tenants: Mutex<HashMap<Uuid, TenantModel>>,
}

impl DomainModelService {
    pub fn new(store: Arc<dyn DomainStore>) -> Self {
        Self {
            store,
            tenants: Mutex::new(HashMap::new()),
        }
    }

    /// This tenant's ontology, loaded from the graph on first touch.
    ///
    /// The graph is the system of record: `ontology.core.json` is only the
    /// bootstrap seed, used when the graph holds no model for this tenant yet.
    /// A tenant running the seed is *not* persisted — nothing is written until
    /// something asks for it (see [`Self::ensure_persisted`]), so a read stays
    /// a read.
    ///
    /// Two callers racing a cold tenant may both load; the load is idempotent
    /// and the first result wins, which is the cheaper trade than holding the
    /// lock across the await.
    async fn model(&self, ctx: &SecurityContext) -> anyhow::Result<Arc<Ontology>> {
        let tenant = ctx.subject_tenant_id();
        if let Some(m) = self.tenants_lock()?.get(&tenant) {
            return Ok(m.ontology.clone());
        }
        let (ontology, version, persisted) = match self.load_from_graph(ctx).await {
            Ok(Some((o, version))) => {
                info!(
                    %tenant, version,
                    entities = o.entities().len(),
                    "studio-domain-model: model loaded from the graph"
                );
                (o, version, true)
            }
            Ok(None) => {
                info!(%tenant, "studio-domain-model: no stored model — running the embedded seed");
                (Ontology::load(), 0, false)
            }
            // A model that cannot be read is not a reason to serve nothing: the
            // seed still answers every read, and the next write persists it.
            Err(e) => {
                warn!(
                    %tenant, error = %e,
                    "studio-domain-model: could not read the stored model — running the embedded seed"
                );
                (Ontology::load(), 0, false)
            }
        };
        let mut guard = self.tenants_lock()?;
        let entry = guard.entry(tenant).or_insert(TenantModel {
            ontology: Arc::new(ontology),
            persisted,
            registered: false,
            pinned: Vec::new(),
            version,
        });
        Ok(entry.ontology.clone())
    }

    /// The tenant's ontology, checked against the graph first.
    ///
    /// [`Self::model`] answers from cache, which is what the object paths want
    /// — they run per request and the model rarely moves. But a *second
    /// replica* editing the model leaves this one's cache behind, and nothing
    /// in the cache can notice. So the paths that show or change the model read
    /// the stored head version (one node) and reload when it has moved. It is
    /// one extra single-row read on the endpoints where being a version behind
    /// would be visibly wrong.
    async fn model_current(&self, ctx: &SecurityContext) -> anyhow::Result<Arc<Ontology>> {
        let ontology = self.model(ctx).await?;
        let tenant = ctx.subject_tenant_id();
        let (cached, persisted) = {
            let guard = self.tenants_lock()?;
            match guard.get(&tenant) {
                Some(m) => (m.version, m.persisted),
                None => return Ok(ontology),
            }
        };
        // Nothing is stored yet, so there is no newer version to be behind.
        if !persisted {
            return Ok(ontology);
        }
        if self.stored_version(ctx).await? == cached {
            return Ok(ontology);
        }
        self.reload(ctx).await
    }

    /// Drop this tenant's cache and read the model from the graph again.
    async fn reload(&self, ctx: &SecurityContext) -> anyhow::Result<Arc<Ontology>> {
        let tenant = ctx.subject_tenant_id();
        let Some((ontology, version)) = self.load_from_graph(ctx).await? else {
            return self.model(ctx).await;
        };
        let ontology = Arc::new(ontology);
        let mut guard = self.tenants_lock()?;
        let entry = guard.entry(tenant).or_insert_with(|| TenantModel {
            ontology: ontology.clone(),
            persisted: true,
            registered: false,
            pinned: Vec::new(),
            version,
        });
        entry.ontology = ontology.clone();
        entry.version = version;
        entry.persisted = true;
        Ok(ontology)
    }

    /// The model node: the document's non-entity part, the head version, and
    /// the entity ids the model consists of — in order.
    ///
    /// That list is what makes the model node authoritative about *membership*,
    /// not just content. An import can shrink the model, and the `object_type`
    /// nodes of the entities it dropped stay in the graph: a tombstoned node
    /// key cannot be re-ingested before a purge, so deleting them would make
    /// re-adding an entity fail — the opposite of what a reconfigurable model
    /// needs. They are left as history and simply not read back, and an entity
    /// that returns is adopted again for free.
    fn model_node(&self, ontology: &Ontology, version: u64) -> NodeUpsert {
        let mut payload = ontology.model_document();
        if let Some(o) = payload.as_object_mut() {
            o.insert("version".to_string(), json!(version));
            o.insert("entity_ids".to_string(), json!(ontology.entity_ids()));
        }
        NodeUpsert {
            type_id: gts::META_MODEL.to_string(),
            node_key: gts::model_node_key(),
            name: ontology
                .document()
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            payload,
            expected_version: None,
        }
    }

    /// The version this process believes the tenant is on.
    fn cached_version(&self, ctx: &SecurityContext) -> anyhow::Result<u64> {
        Ok(self
            .tenants_lock()?
            .get(&ctx.subject_tenant_id())
            .map(|m| m.version)
            .unwrap_or(0))
    }

    /// Take version `rev.version` for this tenant, or report that another
    /// writer took it first.
    ///
    /// The claim is an insert at a key derived from the number, under a
    /// compare-and-set that says *the node must not exist*. That is the whole
    /// mutual exclusion: two writers racing the same number both try to create
    /// the same key and the store lets exactly one through. It works across
    /// replicas, which an in-process lock would not, and it needs no read —
    /// graph-storage takes an expected version on write but reports none on
    /// read, so there is no read-then-write CAS to form.
    async fn claim_version(&self, ctx: &SecurityContext, rev: &Revision) -> anyhow::Result<bool> {
        let node = NodeUpsert {
            type_id: gts::META_MODEL_VERSION.to_string(),
            node_key: gts::version_node_key(rev.version),
            name: Some(format!("v{}", rev.version)),
            payload: rev.payload(),
            expected_version: Some(0),
        };
        match self.store.upsert_nodes(ctx, &[node]).await {
            Err(e) if crate::domain_model::store::is_version_taken(&e) => Ok(false),
            Err(e) => Err(e),
            Ok(_) => {
                if rev.version > 0 {
                    self.store
                        .upsert_edges(
                            ctx,
                            &[EdgeUpsert {
                                type_id: gts::META_REVISES.to_string(),
                                from: gts::version_node_key(rev.version),
                                to: gts::version_node_key(rev.version - 1),
                                discriminator: None,
                                payload: None,
                            }],
                        )
                        .await?;
                }
                Ok(true)
            }
        }
    }

    /// The model's recorded history, newest first.
    pub async fn revisions(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<Revision>> {
        self.store.register_meta_types(ctx).await?;
        let mut out: Vec<Revision> = self
            .store
            .list_objects(ctx, &[gts::META_MODEL_VERSION.to_string()], None, None)
            .await?
            .iter()
            .filter_map(|row| Revision::from_payload(&row.value))
            .collect();
        out.sort_by_key(|r| std::cmp::Reverse(r.version));
        Ok(out)
    }

    /// The head version the graph holds for this tenant, 0 when it holds no
    /// model. One single-row read.
    async fn stored_version(&self, ctx: &SecurityContext) -> anyhow::Result<u64> {
        Ok(self
            .store
            .list_objects(ctx, &[gts::META_MODEL.to_string()], None, Some(1))
            .await?
            .first()
            .and_then(|row| row.value["version"].as_u64())
            .unwrap_or(0))
    }

    /// Read the stored model back out of the graph: the single model node (the
    /// document's non-entity part) plus one entity document per `object_type`
    /// node. `None` when the graph holds no `object_type` node for this tenant.
    async fn load_from_graph(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<Option<(Ontology, u64)>> {
        // The model is read from the meta types, so they must exist before
        // there is an ontology to register the domain types from.
        self.store.register_meta_types(ctx).await?;
        let rows = self
            .store
            .list_objects(
                ctx,
                &[
                    gts::META_MODEL.to_string(),
                    gts::META_OBJECT_TYPE.to_string(),
                ],
                None,
                None,
            )
            .await?;
        let mut head: Option<Value> = None;
        // The graph hands nodes back in projection order, not the model's, so
        // each entity comes back with the `ordinal` it was stored at.
        let mut entities: Vec<(u64, Value)> = Vec::new();
        for row in rows {
            if row.type_id == gts::META_MODEL {
                head = Some(row.value);
            } else if let Some(entity) = row.value.get("entity") {
                let ordinal = row.value["ordinal"].as_u64().unwrap_or(u64::MAX);
                entities.push((ordinal, entity.clone()));
            }
        }
        if entities.is_empty() {
            return Ok(None);
        }
        let mut head = head.unwrap_or_else(|| json!({}));

        // The model node names its entities in order, and that list is the
        // model: `object_type` nodes it does not name belong to a model this
        // tenant used to run (see `model_node`). Without the list — a model
        // node written before it existed — fall back to the stored ordinals.
        let named: Option<Vec<String>> = head["entity_ids"].as_array().map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        });
        let entities: Vec<Value> = match named {
            Some(ids) => {
                let mut by_id: HashMap<&str, &Value> = HashMap::new();
                for (_, e) in &entities {
                    if let Some(id) = e.get("id").and_then(Value::as_str) {
                        by_id.insert(id, e);
                    }
                }
                let picked: Vec<Value> = ids
                    .iter()
                    .filter_map(|id| by_id.get(id.as_str()).map(|e| (*e).clone()))
                    .collect();
                if picked.len() != ids.len() {
                    warn!(
                        named = ids.len(),
                        found = picked.len(),
                        "studio-domain-model: the stored model names entities the graph has no \
                         object_type node for"
                    );
                }
                picked
            }
            None => {
                let mut ordered = entities;
                ordered.sort_by_key(|(ordinal, _)| *ordinal);
                ordered.into_iter().map(|(_, e)| e).collect()
            }
        };
        if entities.is_empty() {
            return Ok(None);
        }
        // The version is the model node's, not the document's: it describes
        // the stored history, and putting it in the document would make it
        // part of what the frontend regenerates from.
        let version = head
            .as_object_mut()
            .and_then(|o| o.remove("version"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        // Membership and version describe what is *stored*; neither belongs in
        // the document the frontend regenerates from.
        if let Some(o) = head.as_object_mut() {
            o.remove("entity_ids");
        }
        Ontology::from_parts(head, entities)
            .map(|o| Some((o, version)))
            .map_err(|e| anyhow::anyhow!("stored model is malformed: {e}"))
    }

    /// Make sure the graph holds this tenant's model, syncing the seed if it
    /// does not. Every edit goes through here first: writing one changed
    /// `object_type` node into a graph that holds no model would leave a
    /// one-entity model behind for the next load to find.
    async fn ensure_persisted(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        self.model(ctx).await?;
        let tenant = ctx.subject_tenant_id();
        let persisted = self
            .tenants_lock()?
            .get(&tenant)
            .is_some_and(|m| m.persisted);
        if !persisted {
            self.sync_model(ctx).await?;
        }
        Ok(())
    }

    fn tenants_lock(
        &self,
    ) -> anyhow::Result<std::sync::MutexGuard<'_, HashMap<Uuid, TenantModel>>> {
        self.tenants
            .lock()
            .map_err(|_| anyhow::anyhow!("tenant model lock poisoned"))
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
        // Start from the stored head, so the import lands on top of whatever
        // history the tenant already has rather than restarting it.
        self.model_current(ctx).await?;
        let head = self.cached_version(ctx)?;
        let stored = self
            .tenants_lock()?
            .get(&ctx.subject_tenant_id())
            .is_some_and(|m| m.persisted);
        // An import replaces the whole document, which no useful patch
        // describes — so it records none, and nothing can be reverted past it.
        let version = if stored { head + 1 } else { 0 };
        if stored {
            let rev = Revision::new(
                version,
                ctx,
                "import",
                "",
                format!(
                    "import {} entities in {} buckets",
                    summary.entities, summary.buckets
                ),
            );
            if !self.claim_version(ctx, &rev).await? {
                return Err(anyhow::anyhow!(
                    "another writer changed the model — reload and import again"
                ));
            }
        }
        // A new model is a new type set and a new stored document, so this
        // tenant's registration is stale and the graph no longer holds what it
        // is running.
        self.tenants_lock()?.insert(
            ctx.subject_tenant_id(),
            TenantModel {
                ontology: Arc::new(ontology),
                persisted: false,
                registered: false,
                pinned: Vec::new(),
                version,
            },
        );
        // Register the uploaded model's types, then store the model itself so
        // the next boot loads the import rather than the seed.
        self.ensure_types(ctx).await?;
        self.sync_model(ctx).await?;
        Ok(summary)
    }

    /// The whole ontology document — the source the frontend regenerates from.
    pub async fn ontology_document(&self, ctx: &SecurityContext) -> anyhow::Result<Value> {
        Ok(self.model_current(ctx).await?.document().clone())
    }

    /// The relation catalog — how relations are synced into the graph and the
    /// type-registry: each relation kind with its endpoint typing, plus the
    /// cross-bucket targets still pending a wider sync.
    pub async fn relation_catalog(&self, ctx: &SecurityContext) -> anyhow::Result<RelationCatalog> {
        let o = self.model_current(ctx).await?;
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
        let declared = o.declared_relations();
        let unresolved = o.unresolved_relation_targets();
        Ok(RelationCatalog {
            relations,
            declared,
            unresolved,
        })
    }

    /// Register every domain node and edge type with the store, once per
    /// (tenant, ontology generation).
    ///
    /// Registration is idempotent but far from free: it ships every node and
    /// edge schema the model declares — for the core model, 145 of them — so
    /// doing it ahead of each write made a single object creation cost ~470 ms
    /// against ~35 ms for the equivalent ingest, and capped the endpoint at
    /// ~15 objects/s no matter the concurrency. The type *set* only changes
    /// when a model is imported, which bumps `generation`; adding a field to a
    /// type leaves the set alone (the registered schema is open).
    ///
    /// Two writers racing a cold tenant may both register — the call is
    /// idempotent and converges, which is the cheaper trade than holding a lock
    /// across the await.
    ///
    /// A node type's schema carries the payload paths it is searched and
    /// embedded on, and those are derived from the entity's own fields — so
    /// adding a field changes the schema, while graph-storage treats a
    /// registered type's schema as immutable. Extending a type is therefore a
    /// pure ontology edit for *storage* (the payload is open) but not for
    /// *indexing*: the type keeps the paths it was first registered with until
    /// a migration replaces it. Those types are reported as `pinned` rather
    /// than failing the write — one refused type used to abort the whole batch
    /// and with it every object creation in the model.
    async fn ensure_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        let tenant = ctx.subject_tenant_id();
        let ontology = self.model(ctx).await?;
        if self
            .tenants_lock()?
            .get(&tenant)
            .is_some_and(|m| m.registered)
        {
            return Ok(());
        }
        let (node_types, edge_types) = (ontology.node_types(), ontology.edge_types());
        let pinned = self
            .store
            .register_types(ctx, &node_types, &edge_types)
            .await?;
        if !pinned.is_empty() {
            warn!(
                %tenant,
                count = pinned.len(),
                types = ?pinned,
                "studio-domain-model: these types keep the schema they were registered with — \
                 the model declares different search paths, which needs a type migration"
            );
        }
        if let Some(m) = self.tenants_lock()?.get_mut(&tenant) {
            m.registered = true;
            m.pinned = pinned;
        }
        Ok(())
    }

    /// Create (or upsert) an object of a domain type. `type_ref` may be an
    /// ontology id (`role-assignment`), a node type id
    /// (`gts.cf.studio.domain.role_assignment.v1~`) or its leaf. `key` is a
    /// caller-chosen stable key; the same `(type, key)` upserts.
    ///
    /// `validate` decides how hard the payload is checked against the type —
    /// see [`ValidateMode`]. The report comes back either way.
    ///
    /// `if_absent` refuses the write when the object already exists, instead of
    /// replacing it. It is the only conditional write graph-storage can express
    /// — `expected_version: Some(0)` means "no stored version", and a live
    /// node's is 1 or more. There is deliberately no `if_version` next to it:
    /// the gear takes an expected version on write but reports none on any
    /// read, so a caller has no version to pass back (see
    /// `docs/gears-rust-issues.md` §5). Until that is closed, an *update* is
    /// last-writer-wins.
    pub async fn create_object(
        &self,
        ctx: &SecurityContext,
        type_ref: &str,
        key: &str,
        options: WriteOptions<'_>,
        mut payload: Value,
    ) -> anyhow::Result<CreatedObject> {
        let WriteOptions {
            scope,
            if_absent,
            validate,
        } = options;
        let ontology = self.model(ctx).await?;
        let entity_id = ontology
            .resolve_entity_id(type_ref)
            .ok_or_else(|| anyhow::anyhow!("unknown domain type: {type_ref}"))?;

        // Against the whole type, bases included — most of what a type requires
        // is declared on one of them.
        let report = match validate {
            ValidateMode::Off => Report::default(),
            _ => super::validate::check(&ontology.effective_properties(&entity_id), &payload),
        };
        if validate == ValidateMode::Strict && !report.is_clean() {
            return Err(anyhow::anyhow!(
                "{entity_id} does not satisfy its type: {}",
                report
                    .violations
                    .iter()
                    .map(|v| format!("{} — {}", v.field, v.detail))
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
        let type_id = gts::node_type_id(&entity_id);
        // Types are tenant/platform-shared; an object is scoped by an optional
        // workspace/project key, so the same `key` in two scopes is two objects
        // and a scoped listing shows only its own. The scope is folded into the
        // instance id and tagged on the payload (`_scope`) for filtering.
        let scope = scope.map(str::trim).filter(|s| !s.is_empty());
        let instance_key = match scope {
            Some(s) => format!("{s}|{key}"),
            None => key.to_string(),
        };
        let instance_id = gts::instance_id(&type_id, &instance_key);
        if let Some(s) = scope
            && let Some(obj) = payload.as_object_mut()
        {
            obj.insert("_scope".to_string(), Value::String(s.to_string()));
        }
        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string);

        self.ensure_types(ctx).await?;
        self.store
            .upsert_nodes(
                ctx,
                &[NodeUpsert {
                    type_id: type_id.clone(),
                    node_key: instance_id.clone(),
                    name,
                    payload,
                    expected_version: if_absent.then_some(0),
                }],
            )
            .await
            .map_err(|e| {
                if crate::domain_model::store::is_version_taken(&e) {
                    anyhow::anyhow!("object already exists: type={entity_id} key={key}")
                } else {
                    e
                }
            })?;
        Ok(CreatedObject {
            type_id,
            instance_id,
            report,
        })
    }

    /// One type as it actually is: every field it has, own and inherited, and
    /// every relation it or its bases declare. What `GET /types` cannot show
    /// without the consumer walking `extends` itself.
    pub async fn effective_type(
        &self,
        ctx: &SecurityContext,
        type_ref: &str,
    ) -> anyhow::Result<EffectiveType> {
        let ontology = self.model_current(ctx).await?;
        let entity_id = ontology
            .resolve_entity_id(type_ref)
            .ok_or_else(|| anyhow::anyhow!("unknown domain type: {type_ref}"))?;
        let entity = ontology.entity(&entity_id).expect("resolved").clone();
        let ancestors = ontology.ancestors(&entity_id);
        let relations = ontology
            .declared_relations()
            .into_iter()
            .filter(|d| ancestors.contains(&d.source))
            .collect();
        Ok(EffectiveType {
            name: entity
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&entity_id)
                .to_string(),
            description: entity
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            bucket: entity
                .get("bucket")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            properties: ontology.effective_properties(&entity_id),
            relations,
            ancestors,
            entity_id,
        })
    }

    /// Create (or upsert) a relation between two objects, addressed by their
    /// instance ids. `relation_kind` is one of the ontology's relation verbs
    /// (`member`, `owns`, `references`, `composes`).
    /// Relate two objects, checking the pair against the model.
    ///
    /// `relation_ref` is either a declared relation — `project.uses`, or a bare
    /// `uses` when only one entity declares it — or a bare verb (`member`,
    /// `owns`, …), in which case the declared relation is looked up from the
    /// endpoints' own types.
    ///
    /// Either way the pair has to be one the model declares. The model
    /// describes 339 relations with their source and target; letting an
    /// undeclared pair through would mean the model describes the graph without
    /// constraining it, and there would be nothing to reconfigure.
    ///
    /// A relation declared on a base counts for everything that extends it.
    pub async fn create_relation(
        &self,
        ctx: &SecurityContext,
        relation_ref: &str,
        from: &str,
        to: &str,
    ) -> anyhow::Result<CreatedRelation> {
        let ontology = self.model(ctx).await?;
        let relation_ref = relation_ref.trim();

        // The endpoints' own types are what the pair is checked against, so
        // both objects have to exist. They would have to anyway — an edge
        // endpoint that is not there is a caller relating before creating.
        let src = self.endpoint_entity(ctx, &ontology, from, "from").await?;
        let dst = self.endpoint_entity(ctx, &ontology, to, "to").await?;

        let src_chain = ontology.ancestors(&src);
        let dst_chain = ontology.ancestors(&dst);

        let declared = match relation_ref.split_once('.') {
            // Qualified: exactly one relation, and the endpoints have to fit it.
            Some((entity, name)) => {
                let d = ontology.declared_relation(entity, name).ok_or_else(|| {
                    anyhow::anyhow!("the model declares no relation `{relation_ref}`")
                })?;
                if !src_chain.contains(&d.source) {
                    return Err(anyhow::anyhow!(
                        "{}.{} is declared on `{}`, but the source object is a `{src}`",
                        d.source,
                        d.name,
                        d.source
                    ));
                }
                match &d.target_entity {
                    Some(target) if !dst_chain.contains(target) => {
                        return Err(anyhow::anyhow!(
                            "{}.{} points at `{target}`, but the target object is a `{dst}`",
                            d.source,
                            d.name
                        ));
                    }
                    // A target outside the current model (see GET /relations
                    // `unresolved`) cannot be checked, only carried.
                    _ => {}
                }
                d
            }
            // Bare: it may be a property name or a verb — `owns` is both, on
            // different entities — so the endpoints are what decide. Matching
            // against the pair first means a token never has to be one or
            // the other in the abstract.
            None => {
                let mut hits: Vec<DeclaredRelation> = ontology
                    .declared_relations()
                    .into_iter()
                    .filter(|d| d.name == relation_ref || d.verb == relation_ref)
                    .filter(|d| src_chain.contains(&d.source))
                    .filter(|d| {
                        d.target_entity
                            .as_ref()
                            .is_some_and(|t| dst_chain.contains(t))
                    })
                    .collect();
                match hits.len() {
                    1 => hits.remove(0),
                    0 => {
                        let allowed = self.relations_from(&ontology, &src_chain);
                        return Err(anyhow::anyhow!(
                            "the model declares no `{relation_ref}` from `{src}` to `{dst}`{allowed}"
                        ));
                    }
                    _ => {
                        return Err(anyhow::anyhow!(
                            "`{relation_ref}` from `{src}` to `{dst}` is ambiguous — name one of: {}",
                            hits.iter()
                                .map(|d| format!("{}.{}", d.source, d.name))
                                .collect::<Vec<_>>()
                                .join(", ")
                        ));
                    }
                }
            }
        };

        let edge_type_id = gts::edge_type_id(&declared.verb);
        self.ensure_types(ctx).await?;
        self.store
            .create_relation(
                ctx,
                &edge_type_id,
                from,
                to,
                // Which declared relation this is. Without it two relations of
                // one verb between the same pair — `tenant owns team` and
                // `tenant contains team` — would collapse into a single edge.
                Some(&declared.name),
                Some(json!({
                    "name": declared.name,
                    "verb": declared.verb,
                    "label": declared.label,
                    "cardinality": declared.cardinality,
                    "source": declared.source,
                    "target": declared.target_entity,
                })),
            )
            .await?;
        Ok(CreatedRelation {
            type_id: edge_type_id,
            verb: declared.verb,
            name: Some(declared.name),
            label: Some(declared.label).filter(|l| !l.is_empty()),
            cardinality: declared.cardinality,
        })
    }

    /// The entity an endpoint object is of, or a message naming what is wrong.
    async fn endpoint_entity(
        &self,
        ctx: &SecurityContext,
        ontology: &Ontology,
        instance_id: &str,
        which: &str,
    ) -> anyhow::Result<String> {
        let node = self
            .store
            .get_object(ctx, instance_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("no such object: {which}={instance_id}"))?;
        ontology.resolve_entity_id(&node.type_id).ok_or_else(|| {
            anyhow::anyhow!(
                "the {which} object is a `{}`, which this model has no entity for",
                node.type_id
            )
        })
    }

    /// A short list of what the model does allow from these types, for the
    /// error that says a pair is not declared. An empty tail rather than a
    /// misleading one when there is nothing to suggest.
    fn relations_from(&self, ontology: &Ontology, src_chain: &[String]) -> String {
        let mut names: Vec<String> = ontology
            .declared_relations()
            .into_iter()
            .filter(|d| src_chain.contains(&d.source))
            .filter_map(|d| {
                d.target_entity
                    .map(|t| format!("{}.{} -{}-> {t}", d.source, d.name, d.verb))
            })
            .collect();
        names.sort();
        names.dedup();
        if names.is_empty() {
            return String::new();
        }
        names.truncate(8);
        format!(". It declares: {}", names.join("; "))
    }

    /// List objects, optionally of one type and/or one scope. `None` type =
    /// every domain type; `None` scope = every scope.
    pub async fn list_objects(
        &self,
        ctx: &SecurityContext,
        type_ref: Option<&str>,
        scope: Option<&str>,
    ) -> anyhow::Result<Vec<ObjectNode>> {
        let o = self.model(ctx).await?;
        let type_ids: Vec<String> = match type_ref.map(str::trim).filter(|s| !s.is_empty()) {
            None => o.node_types().into_iter().map(|n| n.type_id).collect(),
            Some(r) => match o.resolve_entity_id(r) {
                Some(entity_id) => vec![gts::node_type_id(&entity_id)],
                // Unknown type -> no rows, rather than every row.
                None => Vec::new(),
            },
        };
        if type_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.ensure_types(ctx).await?;
        let scope = scope.map(str::trim).filter(|s| !s.is_empty());
        self.store.list_objects(ctx, &type_ids, scope, None).await
    }

    /// Sync the model *as a graph*: materialize one object-type node per entity
    /// and the `inherits` / `declares` edges among them, so the domain model —
    /// with its relations — is itself queryable in the graph. Idempotent: node
    /// keys and edge endpoints are deterministic, so a re-sync converges.
    pub async fn sync_model(&self, ctx: &SecurityContext) -> anyhow::Result<ModelSyncReport> {
        // Registers the instance types and the meta layer (object_type node +
        // inherits/declares edges) the sync writes into.
        self.ensure_types(ctx).await?;

        let ontology = self.model(ctx).await?;
        let graph = ontology.model_graph();

        let node_key = |entity_id: &str| gts::instance_id(gts::META_OBJECT_TYPE, entity_id);

        // The document's non-entity part (`model`, `source`, `buckets`) as one
        // node, so what comes back out of the graph is the whole model and not
        // just its entities.
        let version = self.cached_version(ctx)?;
        let mut nodes: Vec<NodeUpsert> = vec![self.model_node(&ontology, version)];
        nodes.extend(graph.nodes.iter().map(|n| NodeUpsert {
            type_id: gts::META_OBJECT_TYPE.to_string(),
            node_key: node_key(&n.entity_id),
            name: Some(n.name.clone()),
            payload: n.payload.clone(),
            expected_version: None,
        }));

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
                discriminator: e.discriminator.clone(),
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
        // The graph now holds what this tenant is running, so a later edit may
        // write through a single node instead of re-syncing the whole model.
        if let Some(m) = self.tenants_lock()?.get_mut(&ctx.subject_tenant_id()) {
            m.persisted = true;
        }
        // Version 0 is the model as it was first stored. Recording it gives the
        // history a base to chain from, so every later edit has a predecessor.
        if version == 0 {
            let entities = ontology.entities().len();
            let _ = self
                .claim_version(
                    ctx,
                    &Revision::new(
                        0,
                        ctx,
                        "seed",
                        "",
                        format!("model stored, {entities} entities"),
                    ),
                )
                .await?;
        }

        Ok(ModelSyncReport {
            version,
            pinned_types: self
                .tenants_lock()?
                .get(&ctx.subject_tenant_id())
                .map(|m| m.pinned.clone())
                .unwrap_or_default(),
            object_types: graph.nodes.len() as u64,
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
    ) -> anyhow::Result<(Vec<ObjectNode>, Vec<ModelGraphEdge>)> {
        self.ensure_types(ctx).await?;
        // Nodes are read back from the graph (proof they are stored); edges come
        // from the ontology so they carry their properties (verb / cardinality /
        // label / name) — adjacency reads drop the payload, and the ontology is
        // 1:1 with what the sync wrote. Endpoints are the same deterministic node
        // keys the sync used, so they line up with the graph nodes.
        let ontology = self.model_current(ctx).await?;
        // Narrowed to the entities the model currently names: the graph also
        // holds the object_type nodes of models this tenant used to run.
        let current: std::collections::HashSet<String> = ontology
            .entity_ids()
            .into_iter()
            .map(|id| gts::instance_id(gts::META_OBJECT_TYPE, &id))
            .collect();
        let mut nodes = self
            .store
            .list_objects(ctx, &[gts::META_OBJECT_TYPE.to_string()], None, None)
            .await?;
        nodes.retain(|n| current.contains(&n.instance_id));
        let graph = ontology.model_graph();
        let edges = graph
            .edges
            .iter()
            .map(|e| ModelGraphEdge {
                type_id: match e.kind {
                    ModelEdgeKind::Inherits => gts::META_INHERITS.to_string(),
                    ModelEdgeKind::Declares => gts::META_DECLARES.to_string(),
                },
                from: gts::instance_id(gts::META_OBJECT_TYPE, &e.from_entity),
                to: gts::instance_id(gts::META_OBJECT_TYPE, &e.to_entity),
                payload: e.payload.clone(),
            })
            .collect();
        Ok((nodes, edges))
    }

    /// The graph of created *objects* (instances) and the relations between
    /// them (`member`/`owns`/…), read out of Graph Storage — the instance layer,
    /// distinct from the type/model graph. Nodes carry their entity type and
    /// bucket for colouring.
    ///
    /// Bounded: a visualization wants a subgraph, and the instance layer has no
    /// natural ceiling — it grew to 14 657 nodes on a load run, which the
    /// unbounded version answered in 26 s with every payload inlined. `limit`
    /// caps the nodes; `type_ref` and `scope` narrow which ones, with the same
    /// meaning they have on `GET /objects`.
    pub async fn objects_graph(
        &self,
        ctx: &SecurityContext,
        limit: usize,
        type_ref: Option<&str>,
        scope: Option<&str>,
    ) -> anyhow::Result<(Vec<ObjectGraphNode>, Vec<EdgeView>, bool)> {
        self.ensure_types(ctx).await?;
        // type ids to project + a map back to (entity id, bucket) for labels.
        let (type_ids, meta) = {
            let o = self.model(ctx).await?;
            let type_ids: Vec<String> = match type_ref.map(str::trim).filter(|s| !s.is_empty()) {
                None => o.node_types().into_iter().map(|n| n.type_id).collect(),
                // Unknown type -> no rows, rather than every row.
                Some(r) => o
                    .resolve_entity_id(r)
                    .map(|id| vec![gts::node_type_id(&id)])
                    .unwrap_or_default(),
            };
            let mut meta: std::collections::HashMap<String, (String, String)> =
                std::collections::HashMap::new();
            for e in o.entities() {
                if let Some(id) = e.get("id").and_then(Value::as_str) {
                    let bucket = e
                        .get("bucket")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    meta.insert(gts::node_type_id(id), (id.to_string(), bucket));
                }
            }
            (type_ids, meta)
        };
        // One over the bound: if it comes back, there was more to show.
        let scope = scope.map(str::trim).filter(|s| !s.is_empty());
        let mut objs = self
            .store
            .list_objects(ctx, &type_ids, scope, Some(limit + 1))
            .await?;
        let truncated = objs.len() > limit;
        objs.truncate(limit);
        let nodes = objs
            .iter()
            .map(|o| {
                let (entity, bucket) = meta.get(&o.type_id).cloned().unwrap_or_default();
                let name = o
                    .value
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&o.instance_id)
                    .to_string();
                ObjectGraphNode {
                    instance_id: o.instance_id.clone(),
                    entity,
                    bucket,
                    name,
                    value: o.value.clone(),
                }
            })
            .collect();
        let seeds: std::collections::HashSet<String> =
            objs.iter().map(|o| o.instance_id.clone()).collect();
        let seed_list: Vec<String> = objs.iter().map(|o| o.instance_id.clone()).collect();
        let edges = self
            .store
            .read_edges(ctx, &seed_list)
            .await?
            .into_iter()
            // Domain relations only, and only those whose both endpoints are on
            // the page — a bounded read must not hand back dangling edges.
            .filter(|e| {
                e.type_id.contains(".domainrel.")
                    && seeds.contains(&e.from)
                    && seeds.contains(&e.to)
            })
            .collect();
        Ok((nodes, edges, truncated))
    }

    /// Extend a domain type with a new field. Returns the updated entity. The
    /// registered graph type is open, so this is a pure ontology edit — no
    /// migration, no re-registration.
    ///
    /// The edit is written through to the graph as the one `object_type` node
    /// it changes, which is what makes it survive a restart. A scalar field
    /// declares no relation, so no model edge changes and the rest of the model
    /// graph is left alone.
    ///
    /// Read-modify-write: two concurrent adds of *different* fields to the same
    /// type can lose one, since both start from the same base document. The fix
    /// is a compare-and-set on the node's version, which is what the versioned
    /// model edits will carry.
    pub async fn add_field(
        &self,
        ctx: &SecurityContext,
        entity_ref: &str,
        field: FieldSpec,
    ) -> anyhow::Result<(Value, u64)> {
        // A write-through into a graph that holds no model would leave a
        // one-entity model behind, so store the whole thing first.
        self.ensure_persisted(ctx).await?;

        // Losing the claim means someone else's edit landed first, so this one
        // is recomputed against theirs rather than overwriting it. A handful of
        // attempts is enough for contention this rare; past that, the caller is
        // better told than left spinning.
        for attempt in 0..EDIT_ATTEMPTS {
            let current = self.model_current(ctx).await?;
            let entity_id = current
                .resolve_entity_id(entity_ref)
                .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity_ref}"))?;

            // Copy-on-write: the current ontology is shared by every in-flight
            // read, so the edit lands on a copy that replaces it once stored.
            let mut next = (*current).clone();
            let entity = next
                .add_field(&entity_id, field.clone())
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            let index = next
                .entity_index(&entity_id)
                .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity_ref}"))?;
            let props = entity["properties"].as_array().map(Vec::len).unwrap_or(0);
            let added = entity["properties"][props.saturating_sub(1)].clone();

            let version = self.cached_version(ctx)? + 1;
            let rev = Revision::new(
                version,
                ctx,
                "add_field",
                &entity_id,
                format!("add field {entity_id}.{} : {}", field.name, field.type_name),
            )
            .with_patches(
                json!([{
                    "op": "add",
                    "path": format!("/entities/{index}/properties/-"),
                    "value": added,
                }]),
                json!([{
                    "op": "remove",
                    "path": format!("/entities/{index}/properties/{}", props - 1),
                }]),
            );
            if !self.claim_version(ctx, &rev).await? {
                warn!(
                    attempt,
                    version, "studio-domain-model: model version taken, retrying the edit"
                );
                self.reload(ctx).await?;
                continue;
            }

            // Claimed, so this edit owns the version: write the one type it
            // changed, then move the head. A failure between the two leaves the
            // head where it was — the model reads back unchanged and the
            // claimed number is simply burned, which a re-run steps past.
            let node = next
                .object_type_node(&entity_id)
                .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity_ref}"))?;
            self.store
                .upsert_nodes(
                    ctx,
                    &[
                        NodeUpsert {
                            type_id: gts::META_OBJECT_TYPE.to_string(),
                            node_key: gts::instance_id(gts::META_OBJECT_TYPE, &entity_id),
                            name: Some(node.name.clone()),
                            payload: node.payload.clone(),
                            expected_version: None,
                        },
                        self.model_node(&next, version),
                    ],
                )
                .await?;
            // Stored, then adopted: a failed write leaves the in-memory model
            // matching the graph rather than ahead of it.
            if let Some(m) = self.tenants_lock()?.get_mut(&ctx.subject_tenant_id()) {
                m.ontology = Arc::new(next);
                m.version = version;
            }
            return Ok((entity, version));
        }
        Err(anyhow::anyhow!(
            "the model is being edited concurrently — no version could be claimed in \
             {EDIT_ATTEMPTS} attempts"
        ))
    }

    /// Undo every change back to version `to`, recorded as a new version of its
    /// own. History is appended to, never rewritten: reverting to v3 from v7
    /// produces v8 whose content is v3's.
    ///
    /// Refused when anything in the range records no inverse — an import
    /// replaces the whole document, so there is nothing to undo it with.
    pub async fn revert(&self, ctx: &SecurityContext, to: u64) -> anyhow::Result<RevertReport> {
        self.ensure_persisted(ctx).await?;
        for attempt in 0..EDIT_ATTEMPTS {
            let current = self.model_current(ctx).await?;
            let head = self.cached_version(ctx)?;
            if to > head {
                return Err(anyhow::anyhow!(
                    "no such model version: {to} (head is {head})"
                ));
            }
            if to == head {
                return Ok(RevertReport {
                    version: head,
                    undone: Vec::new(),
                });
            }
            let undone: Vec<Revision> = self
                .revisions(ctx)
                .await?
                .into_iter()
                .filter(|r| r.version > to && r.version <= head)
                .collect();
            if let Some(blocker) = undone.iter().find(|r| !r.is_reversible()) {
                return Err(anyhow::anyhow!(
                    "cannot revert past v{}: it is a `{}` and records no inverse",
                    blocker.version,
                    blocker.op
                ));
            }

            // Newest first, so each undo lands on the document its own change
            // produced — the paths in a patch only hold against that state.
            let mut doc = current.document().clone();
            for r in &undone {
                let patch: json_patch::Patch = serde_json::from_value(r.undo.clone())
                    .map_err(|e| anyhow::anyhow!("v{}: malformed inverse patch: {e}", r.version))?;
                json_patch::patch(&mut doc, &patch).map_err(|e| {
                    anyhow::anyhow!("v{}: inverse patch does not apply: {e}", r.version)
                })?;
            }
            let next = Ontology::from_value(doc).map_err(|e| anyhow::anyhow!("{e}"))?;

            let version = head + 1;
            let versions: Vec<u64> = undone.iter().map(|r| r.version).collect();
            // Its own inverse is the forward patches of everything it undid,
            // oldest first — so a revert can itself be reverted.
            let mut redo = Vec::new();
            for r in undone.iter().rev() {
                if let Some(ops) = r.patch.as_array() {
                    redo.extend(ops.iter().cloned());
                }
            }
            let mut forward = Vec::new();
            for r in &undone {
                if let Some(ops) = r.undo.as_array() {
                    forward.extend(ops.iter().cloned());
                }
            }
            let rev = Revision::new(
                version,
                ctx,
                "revert",
                "",
                format!("revert to v{to} ({} change(s) undone)", undone.len()),
            )
            .with_patches(Value::Array(forward), Value::Array(redo));
            if !self.claim_version(ctx, &rev).await? {
                warn!(
                    attempt,
                    version, "studio-domain-model: model version taken, retrying the revert"
                );
                self.reload(ctx).await?;
                continue;
            }

            // A revert can touch any number of entities, so the whole model is
            // written rather than one node.
            if let Some(m) = self.tenants_lock()?.get_mut(&ctx.subject_tenant_id()) {
                m.ontology = Arc::new(next);
                m.version = version;
            }
            self.sync_model(ctx).await?;
            return Ok(RevertReport {
                version,
                undone: versions,
            });
        }
        Err(anyhow::anyhow!(
            "the model is being edited concurrently — no version could be claimed in \
             {EDIT_ATTEMPTS} attempts"
        ))
    }
}

#[cfg(test)]
mod tests {
    //! The model is per tenant and lives in the store, so the two things worth
    //! asserting offline are that a tenant's edit stays its own and that a
    //! fresh service reads back what an earlier one wrote. Both need a store
    //! that scopes by tenant the way graph-storage does — the in-memory
    //! fallback is one flat map, so it cannot show either.

    use super::*;
    use crate::domain_model::ontology::{EdgeType, NodeType};
    use crate::domain_model::store::{EdgeView, ObjectNode};
    use async_trait::async_trait;

    /// A store that keys everything by tenant, like the real graph does.
    #[derive(Default)]
    struct TenantScopedStore {
        nodes: Mutex<HashMap<(Uuid, String), ObjectNode>>,
    }

    #[async_trait]
    impl DomainStore for TenantScopedStore {
        async fn register_meta_types(&self, _ctx: &SecurityContext) -> anyhow::Result<()> {
            Ok(())
        }

        async fn register_types(
            &self,
            _ctx: &SecurityContext,
            _node_types: &[NodeType],
            _edge_types: &[EdgeType],
        ) -> anyhow::Result<Vec<String>> {
            Ok(Vec::new())
        }

        async fn create_relation(
            &self,
            _ctx: &SecurityContext,
            _edge_type_id: &str,
            _from: &str,
            _to: &str,
            _discriminator: Option<&str>,
            _payload: Option<Value>,
        ) -> anyhow::Result<()> {
            Ok(())
        }

        async fn get_object(
            &self,
            ctx: &SecurityContext,
            instance_id: &str,
        ) -> anyhow::Result<Option<ObjectNode>> {
            Ok(self
                .nodes
                .lock()
                .unwrap()
                .get(&(ctx.subject_tenant_id(), instance_id.to_string()))
                .cloned())
        }

        async fn list_objects(
            &self,
            ctx: &SecurityContext,
            type_ids: &[String],
            _scope: Option<&str>,
            _limit: Option<usize>,
        ) -> anyhow::Result<Vec<ObjectNode>> {
            let tenant = ctx.subject_tenant_id();
            Ok(self
                .nodes
                .lock()
                .unwrap()
                .iter()
                .filter(|((t, _), n)| *t == tenant && type_ids.iter().any(|w| w == &n.type_id))
                .map(|(_, n)| n.clone())
                .collect())
        }

        async fn upsert_nodes(
            &self,
            ctx: &SecurityContext,
            nodes: &[NodeUpsert],
        ) -> anyhow::Result<u64> {
            let mut map = self.nodes.lock().unwrap();
            for n in nodes {
                // `Some(0)` is "must not exist" — the claim the real store
                // enforces, and the whole of the version protocol.
                if n.expected_version == Some(0)
                    && map.contains_key(&(ctx.subject_tenant_id(), n.node_key.clone()))
                {
                    return Err(anyhow::anyhow!(
                        "{}: {}",
                        crate::domain_model::store::VERSION_TAKEN,
                        n.node_key
                    ));
                }
                map.insert(
                    (ctx.subject_tenant_id(), n.node_key.clone()),
                    ObjectNode {
                        type_id: n.type_id.clone(),
                        instance_id: n.node_key.clone(),
                        value: n.payload.clone(),
                    },
                );
            }
            Ok(nodes.len() as u64)
        }

        async fn upsert_edges(
            &self,
            _ctx: &SecurityContext,
            edges: &[EdgeUpsert],
        ) -> anyhow::Result<u64> {
            Ok(edges.len() as u64)
        }

        async fn read_edges(
            &self,
            _ctx: &SecurityContext,
            _seeds: &[String],
        ) -> anyhow::Result<Vec<EdgeView>> {
            Ok(Vec::new())
        }
    }

    fn ctx_for(tenant: u128) -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(1))
            .subject_tenant_id(Uuid::from_u128(tenant))
            .token_scopes(vec!["*".to_string()])
            .build()
            .expect("test security context")
    }

    fn field(name: &str) -> FieldSpec {
        FieldSpec {
            name: name.to_string(),
            type_name: "string".to_string(),
            description: None,
            required: false,
        }
    }

    fn has_field(doc: &Value, entity_id: &str, field: &str) -> bool {
        doc["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == entity_id)
            .expect("entity")["properties"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == field)
    }

    #[tokio::test]
    async fn a_tenants_edit_stays_its_own() {
        let store = Arc::new(TenantScopedStore::default());
        let service = DomainModelService::new(store);
        let (a, b) = (ctx_for(1), ctx_for(2));

        service
            .add_field(&a, "team", field("cost_center"))
            .await
            .unwrap();

        assert!(has_field(
            &service.ontology_document(&a).await.unwrap(),
            "team",
            "cost_center"
        ));
        // Tenant B runs the seed and never sees A's field.
        assert!(!has_field(
            &service.ontology_document(&b).await.unwrap(),
            "team",
            "cost_center"
        ));
    }

    #[tokio::test]
    async fn an_edit_survives_the_process_that_made_it() {
        let store = Arc::new(TenantScopedStore::default());
        let ctx = ctx_for(1);
        // A write on a tenant whose model was never synced stores the whole
        // model, not just the type it touched.
        DomainModelService::new(store.clone())
            .add_field(&ctx, "team", field("cost_center"))
            .await
            .unwrap();

        // A new service over the same store is the next boot.
        let next = DomainModelService::new(store);
        let doc = next.ontology_document(&ctx).await.unwrap();
        assert_eq!(
            doc["entities"].as_array().unwrap().len(),
            Ontology::load().entities().len()
        );
        assert!(has_field(&doc, "team", "cost_center"));
        // The document's non-entity part comes back too, not only its entities.
        assert_eq!(doc["model"], Ontology::load().document()["model"]);
        assert_eq!(
            doc["buckets"].as_array().unwrap().len(),
            Ontology::load().document()["buckets"]
                .as_array()
                .unwrap()
                .len()
        );
    }

    #[tokio::test]
    async fn every_edit_is_a_numbered_revision() {
        let store = Arc::new(TenantScopedStore::default());
        let service = DomainModelService::new(store);
        let ctx = ctx_for(1);

        let (_, v1) = service
            .add_field(&ctx, "team", field("cost_center"))
            .await
            .unwrap();
        let (_, v2) = service
            .add_field(&ctx, "team", field("chargeback"))
            .await
            .unwrap();
        assert_eq!((v1, v2), (1, 2));

        let history = service.revisions(&ctx).await.unwrap();
        // Newest first, down to the seed the first write stored.
        let versions: Vec<u64> = history.iter().map(|r| r.version).collect();
        assert_eq!(versions, vec![2, 1, 0]);
        assert_eq!(history[2].op, "seed");
        assert_eq!(history[0].op, "add_field");
        assert_eq!(history[0].target, "team");
        assert!(
            history[0].summary.contains("cost_center")
                || history[1].summary.contains("cost_center")
        );
        // Each edit carries the patch that made it and its inverse.
        assert!(history[0].is_reversible());
        assert!(!history[2].is_reversible());
    }

    #[tokio::test]
    async fn a_revert_restores_the_model_and_is_itself_a_version() {
        let store = Arc::new(TenantScopedStore::default());
        let service = DomainModelService::new(store);
        let ctx = ctx_for(1);

        service
            .add_field(&ctx, "team", field("cost_center"))
            .await
            .unwrap();
        let (_, v2) = service
            .add_field(&ctx, "risk", field("mitigation_owner"))
            .await
            .unwrap();

        let report = service.revert(&ctx, 1).await.unwrap();
        assert_eq!(report.version, v2 + 1);
        assert_eq!(report.undone, vec![2]);

        let doc = service.ontology_document(&ctx).await.unwrap();
        // v1's change stands, v2's is gone.
        assert!(has_field(&doc, "team", "cost_center"));
        assert!(!has_field(&doc, "risk", "mitigation_owner"));
        // History is appended to, not rewritten.
        let versions: Vec<u64> = service
            .revisions(&ctx)
            .await
            .unwrap()
            .iter()
            .map(|r| r.version)
            .collect();
        assert_eq!(versions, vec![3, 2, 1, 0]);

        // And the revert is itself reversible.
        service.revert(&ctx, 2).await.unwrap();
        let doc = service.ontology_document(&ctx).await.unwrap();
        assert!(has_field(&doc, "risk", "mitigation_owner"));
    }

    #[tokio::test]
    async fn a_reverted_model_survives_a_reload() {
        let store = Arc::new(TenantScopedStore::default());
        let ctx = ctx_for(1);
        let service = DomainModelService::new(store.clone());
        service
            .add_field(&ctx, "team", field("cost_center"))
            .await
            .unwrap();
        service.revert(&ctx, 0).await.unwrap();

        // A revert can touch any number of entities, so it writes the whole
        // model — the next boot has to see that, not the pre-revert nodes.
        let doc = DomainModelService::new(store)
            .ontology_document(&ctx)
            .await
            .unwrap();
        assert!(!has_field(&doc, "team", "cost_center"));
        assert_eq!(doc, *Ontology::load().document());
    }

    #[tokio::test]
    async fn an_edit_that_loses_the_version_lands_on_the_winners_model() {
        let store = Arc::new(TenantScopedStore::default());
        let ctx = ctx_for(1);
        // Two services over one store are two replicas. Both start caching the
        // same head.
        let a = DomainModelService::new(store.clone());
        let b = DomainModelService::new(store);
        a.sync_model(&ctx).await.unwrap();
        b.ontology_document(&ctx).await.unwrap();

        let (_, va) = a
            .add_field(&ctx, "team", field("cost_center"))
            .await
            .unwrap();
        // B's cache is a version behind and its first claim is taken; it
        // recomputes against A's model instead of overwriting it.
        let (_, vb) = b
            .add_field(&ctx, "risk", field("mitigation_owner"))
            .await
            .unwrap();
        assert_eq!((va, vb), (1, 2));

        let doc = b.ontology_document(&ctx).await.unwrap();
        assert!(has_field(&doc, "team", "cost_center"));
        assert!(has_field(&doc, "risk", "mitigation_owner"));
    }

    #[tokio::test]
    async fn an_import_that_shrinks_the_model_reloads_shrunk() {
        let store = Arc::new(TenantScopedStore::default());
        let ctx = ctx_for(1);
        let service = DomainModelService::new(store.clone());
        service.sync_model(&ctx).await.unwrap();
        service
            .import_model(
                &ctx,
                json!({
                    "model": "tiny",
                    "buckets": [{"id": "b", "name": "B"}],
                    "entities": [{
                        "id": "widget", "name": "Widget", "bucket": "b",
                        "properties": [{"name": "name", "type": "string"}]
                    }],
                }),
            )
            .await
            .unwrap();

        // The 140 object_type nodes of the previous model are still in the
        // graph on purpose — a tombstoned key could not be re-ingested. The
        // model node names the entities, so the reload is the imported model
        // and not the union of both.
        let doc = DomainModelService::new(store)
            .ontology_document(&ctx)
            .await
            .unwrap();
        assert_eq!(doc["model"], "tiny");
        assert_eq!(doc["entities"].as_array().unwrap().len(), 1);
        assert!(doc.get("entity_ids").is_none());
        assert!(doc.get("version").is_none());
    }

    /// Create an object and hand back its instance id.
    async fn object(
        service: &DomainModelService,
        ctx: &SecurityContext,
        ty: &str,
        key: &str,
    ) -> String {
        service
            .create_object(
                ctx,
                ty,
                key,
                WriteOptions {
                    validate: ValidateMode::Off,
                    ..Default::default()
                },
                json!({ "name": key }),
            )
            .await
            .unwrap()
            .instance_id
    }

    #[tokio::test]
    async fn if_absent_refuses_to_replace_an_object() {
        let service = DomainModelService::new(Arc::new(TenantScopedStore::default()));
        let ctx = ctx_for(1);
        let create = |if_absent: bool, name: &'static str| {
            let ctx = ctx.clone();
            let service = &service;
            async move {
                service
                    .create_object(
                        &ctx,
                        "team",
                        "core",
                        WriteOptions {
                            if_absent,
                            ..Default::default()
                        },
                        json!({ "name": name }),
                    )
                    .await
            }
        };

        create(true, "Core Team").await.expect("first create");
        // The one conditional write the graph can express: a second create at
        // the same key is refused rather than silently replacing the first.
        let e = create(true, "Impostor").await.expect_err("second create");
        assert!(e.to_string().contains("object already exists"), "{e}");
        // Without it, the historical upsert still stands.
        create(false, "Renamed").await.expect("upsert");
    }

    #[tokio::test]
    async fn a_type_has_the_fields_its_bases_declare() {
        let service = DomainModelService::new(Arc::new(TenantScopedStore::default()));
        let ctx = ctx_for(1);
        let team = service.effective_type(&ctx, "team").await.unwrap();

        // The model puts most of a type on its bases, so the effective type is
        // several times what the entity itself declares.
        assert_eq!(
            team.ancestors,
            [
                "team",
                "organization-entity",
                "managed-object",
                "node",
                "entity",
                "system-object"
            ]
        );
        let own = Ontology::load().entity("team").unwrap()["properties"]
            .as_array()
            .unwrap()
            .len();
        assert!(
            team.properties.len() > own,
            "{} effective vs {own} declared",
            team.properties.len()
        );

        // Each field says where it comes from, and the root's arrives first.
        let tenant_id = team
            .properties
            .iter()
            .find(|p| p.name == "tenant_id")
            .expect("inherited from the root");
        assert_eq!(tenant_id.declared_by, "system-object");
        assert_eq!(team.properties[0].name, "tenant_id");

        // Relations declared on a base belong to the type too.
        assert!(
            team.relations
                .iter()
                .any(|r| r.name == "typed_by" && r.source == "managed-object")
        );
    }

    #[tokio::test]
    async fn the_nearest_declaration_of_a_field_wins() {
        let o = Ontology::load();
        // `project` re-declares `id`, which the model marks as an override.
        let props = o.effective_properties("project");
        let id = props.iter().find(|p| p.name == "id").expect("id");
        assert_eq!(id.declared_by, "project");
        // And it appears once, in the position the base introduced it.
        assert_eq!(props.iter().filter(|p| p.name == "id").count(), 1);
    }

    #[tokio::test]
    async fn a_write_is_checked_against_the_type_and_says_what_it_found() {
        let service = DomainModelService::new(Arc::new(TenantScopedStore::default()));
        let ctx = ctx_for(1);
        let created = service
            .create_object(
                &ctx,
                "project",
                "apollo",
                WriteOptions::default(),
                json!({ "name": "Apollo", "status": "started", "portfolio": "platform" }),
            )
            .await
            .expect("warn writes anyway");

        // `status` is an enum on project, and `started` is not one of its values.
        let status = created
            .report
            .violations
            .iter()
            .find(|v| v.field == "status")
            .expect("enum violation");
        assert_eq!(status.kind, "enum");
        // Required fields the caller did not send are reported, and named with
        // the base that asks for them.
        assert!(
            created
                .report
                .violations
                .iter()
                .any(|v| v.kind == "missing" && v.field == "key")
        );
        // A field the model does not declare is reported, never a violation.
        assert_eq!(created.report.undeclared, ["portfolio"]);
    }

    #[tokio::test]
    async fn strict_refuses_what_warn_only_reports() {
        let service = DomainModelService::new(Arc::new(TenantScopedStore::default()));
        let ctx = ctx_for(1);
        let bad = json!({ "name": "Apollo", "status": "started" });
        let e = service
            .create_object(
                &ctx,
                "project",
                "apollo",
                WriteOptions {
                    validate: ValidateMode::Strict,
                    ..Default::default()
                },
                bad,
            )
            .await
            .expect_err("strict refuses");
        assert!(e.to_string().contains("does not satisfy its type"), "{e}");

        // Off writes without looking, and reports nothing.
        let created = service
            .create_object(
                &ctx,
                "project",
                "apollo",
                WriteOptions {
                    validate: ValidateMode::Off,
                    ..Default::default()
                },
                json!({ "status": "started" }),
            )
            .await
            .unwrap();
        assert!(created.report.violations.is_empty());
        assert!(created.report.undeclared.is_empty());
    }

    #[tokio::test]
    async fn a_field_added_to_the_model_stops_being_undeclared() {
        let service = DomainModelService::new(Arc::new(TenantScopedStore::default()));
        let ctx = ctx_for(1);
        let payload = json!({ "name": "Core Team", "cost_center": "CC-42" });
        let before = service
            .create_object(
                &ctx,
                "team",
                "core",
                WriteOptions::default(),
                payload.clone(),
            )
            .await
            .unwrap();
        assert_eq!(before.report.undeclared, ["cost_center"]);

        service
            .add_field(&ctx, "team", field("cost_center"))
            .await
            .unwrap();

        let after = service
            .create_object(&ctx, "team", "core", WriteOptions::default(), payload)
            .await
            .unwrap();
        assert!(after.report.undeclared.is_empty());
    }

    #[tokio::test]
    async fn a_relation_the_model_declares_carries_its_name() {
        let service = DomainModelService::new(Arc::new(TenantScopedStore::default()));
        let ctx = ctx_for(1);
        let team = object(&service, &ctx, "team", "core").await;
        let person = object(&service, &ctx, "person", "ak").await;

        // By verb: the model says exactly one `member` relation runs from a
        // team to a person, so the edge picks up which one it is.
        let by_verb = service
            .create_relation(&ctx, "member", &team, &person)
            .await
            .unwrap();
        assert_eq!(by_verb.verb, "member");
        assert_eq!(by_verb.name.as_deref(), Some("has_members"));

        // By name, qualified and bare, resolve to the same relation.
        for named in ["team.has_members", "has_members"] {
            let r = service
                .create_relation(&ctx, named, &team, &person)
                .await
                .unwrap();
            assert_eq!(r.name.as_deref(), Some("has_members"), "{named}");
            assert_eq!(r.type_id, by_verb.type_id, "{named}");
        }
    }

    #[tokio::test]
    async fn a_pair_the_model_does_not_declare_is_refused() {
        let service = DomainModelService::new(Arc::new(TenantScopedStore::default()));
        let ctx = ctx_for(1);
        let team = object(&service, &ctx, "team", "core").await;
        let person = object(&service, &ctx, "person", "ak").await;

        // A team owns a Project, not a Person.
        let e = service
            .create_relation(&ctx, "owns", &team, &person)
            .await
            .expect_err("undeclared pair");
        let msg = e.to_string();
        assert!(
            msg.contains("declares no `owns` from `team` to `person`"),
            "{msg}"
        );
        // The refusal says what the model does allow instead of only saying no.
        assert!(msg.contains("It declares:"), "{msg}");

        // Naming the relation explicitly reports the mismatch it is.
        let e = service
            .create_relation(&ctx, "team.delivers", &team, &person)
            .await
            .expect_err("wrong target");
        assert!(
            e.to_string().contains("points at `project`")
                && e.to_string().contains("is a `person`"),
            "{e}"
        );
    }

    #[tokio::test]
    async fn a_relation_declared_on_a_base_counts_for_what_extends_it() {
        let service = DomainModelService::new(Arc::new(TenantScopedStore::default()));
        let ctx = ctx_for(1);
        // `typed_by` is declared on managed-object; project extends it.
        let project = object(&service, &ctx, "project", "apollo").await;
        let object_type = object(&service, &ctx, "object-type", "epic").await;
        let r = service
            .create_relation(&ctx, "typed_by", &project, &object_type)
            .await
            .unwrap();
        assert_eq!(r.name.as_deref(), Some("typed_by"));
        assert_eq!(r.verb, "references");
    }

    #[tokio::test]
    async fn relating_something_that_is_not_there_says_so() {
        let service = DomainModelService::new(Arc::new(TenantScopedStore::default()));
        let ctx = ctx_for(1);
        let team = object(&service, &ctx, "team", "core").await;
        let e = service
            .create_relation(
                &ctx,
                "member",
                &team,
                "00000000-0000-0000-0000-0000000000ff",
            )
            .await
            .expect_err("missing endpoint");
        assert!(e.to_string().contains("no such object: to="), "{e}");
    }

    #[tokio::test]
    async fn a_reload_keeps_the_models_entity_order() {
        let store = Arc::new(TenantScopedStore::default());
        let ctx = ctx_for(1);
        DomainModelService::new(store.clone())
            .sync_model(&ctx)
            .await
            .unwrap();
        let doc = DomainModelService::new(store)
            .ontology_document(&ctx)
            .await
            .unwrap();
        assert_eq!(doc, *Ontology::load().document());
    }
}
