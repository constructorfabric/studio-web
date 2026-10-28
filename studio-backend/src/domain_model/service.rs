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

use super::access::{self, AccessError, ObjectPolicy, TenantOnly};
use super::gts;
use super::ontology::{
    DeclaredRelation, EffectiveProperty, EntitySpec, FieldChange, FieldEdit, FieldSpec,
    ModelEdgeKind, Ontology,
};
use super::store::{DomainStore, EdgeUpsert, EdgeView, NodeUpsert, ObjectNode};
use super::validate::{Report, ValidateMode};

/// The outcome of changing a field of a type.
#[derive(Debug, Clone)]
pub struct FieldEdited {
    /// The type definition after the change.
    pub entity: Value,
    pub version: u64,
    /// How many stored objects were rewritten to follow a rename. `None` when
    /// the edit was not a rename, or when migration was not asked for.
    pub migrated: Option<u64>,
}

/// One object whose `_scope` names no tenant (ADR-0035 §3).
#[derive(Debug, Clone)]
pub struct LegacyScoped {
    pub instance_id: String,
    pub entity: String,
    pub name: Option<String>,
    pub scope: String,
}

/// The objects stored with a free-form scope, as far as one bounded read saw.
#[derive(Debug, Clone, Default)]
pub struct LegacyScopes {
    pub items: Vec<LegacyScoped>,
    /// How many objects were read to find them.
    pub scanned: usize,
    /// False when there were more objects than the read took.
    pub complete: bool,
}

/// How the objects of one type measure up against the type as it is now.
#[derive(Debug, Clone, Default)]
pub struct Conformance {
    pub entity_id: String,
    pub checked: u64,
    pub conforming: u64,
    /// More objects exist than were read — the answer covers `checked` of them.
    pub truncated: bool,
    /// `(field, kind, count)`, most frequent first.
    pub violations: Vec<(String, String, u64)>,
    /// `(field, count)` for fields the objects carry and the type does not
    /// declare, most frequent first.
    pub undeclared: Vec<(String, u64)>,
    /// A few offending objects, so the numbers can be traced to something.
    pub sample: Vec<(String, Vec<String>)>,
}

/// Objects read in one conformance pass unless the caller says otherwise. The
/// instance layer has no natural ceiling, and the answer is a count, not a
/// listing — so this bounds the read rather than the response.
pub const CONFORMANCE_LIMIT: usize = 5_000;
/// Objects or edges per graph write in a gear's trusted batch: under the
/// graph's safe batch size (ADR-0051 §6).
const TRUSTED_BATCH: usize = 500;
/// Objects per graph write when they are embedded: graph-storage embeds a
/// batch in process, holding all of it, and a catalogue sync of thousands of
/// versions in batches of hundreds took the backend down (the catalogue graph
/// sink wrote 32 for that reason).
const EMBEDDED_BATCH: usize = 32;
/// Offending objects named in the sample.
const CONFORMANCE_SAMPLE: usize = 5;

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

/// Objects rewritten per ingest batch during a migration. Well under the
/// gear's per-batch ceilings, and small enough that a failure re-runs cheaply.
const MIGRATE_BATCH: usize = 100;

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
    /// Who may read and write objects (ADR-0035). Tenant-only unless a PDP is
    /// wired in, which is what the in-memory build and the tests run.
    policy: Arc<dyn ObjectPolicy>,
    /// Per tenant, because the model is per tenant: the graph is tenant-scoped,
    /// so two tenants can run different models. A single process-wide ontology
    /// could not represent that.
    tenants: Mutex<HashMap<Uuid, TenantModel>>,
    /// Tells open screens what changed (`events.rs`).
    notify: super::events::Notifier,
    /// When each tenant's cached model was last checked against the stored
    /// head: another replica's edit shows here within [`MODEL_RECHECK`].
    checked: Mutex<HashMap<Uuid, std::time::Instant>>,
    /// The highest version each tenant has seen claimed. A claim whose model
    /// write never landed (the process died between the two) leaves its
    /// number taken while the stored head stays behind it; the next edit
    /// numbers past it instead of asking for it forever.
    claimed: Mutex<HashMap<Uuid, u64>>,
}

/// How long an object path trusts its cached model before asking the graph
/// for the head version again (one single-node read).
const MODEL_RECHECK: std::time::Duration = std::time::Duration::from_secs(10);

impl DomainModelService {
    pub fn new(store: Arc<dyn DomainStore>) -> Self {
        Self {
            store,
            policy: Arc::new(TenantOnly),
            tenants: Mutex::new(HashMap::new()),
            notify: super::events::Notifier::default(),
            checked: Mutex::new(HashMap::new()),
            claimed: Mutex::new(HashMap::new()),
        }
    }

    /// Publish changes on studio-events, through `hub`.
    pub fn attach_events(&self, hub: Arc<toolkit::client_hub::ClientHub>) {
        self.notify.attach(hub);
    }

    /// The same service, asking `policy` who may touch which objects.
    #[must_use]
    pub fn with_policy(mut self, policy: Arc<dyn ObjectPolicy>) -> Self {
        self.policy = policy;
        self
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
        let cached = self
            .tenants_lock()?
            .get(&tenant)
            .map(|m| (m.ontology.clone(), m.version, m.persisted));
        if let Some((ontology, version, persisted)) = cached {
            if !persisted || !self.due_for_recheck(tenant) {
                return Ok(ontology);
            }
            // Another replica may have moved the model on: compare the head,
            // and reload only when it did.
            match self.stored_version(ctx).await {
                Ok(head) if head != version => {
                    if let Some((fresh, head)) = self.load_from_graph(ctx).await? {
                        let fresh = Arc::new(fresh);
                        if let Some(m) = self.tenants_lock()?.get_mut(&tenant) {
                            m.ontology = fresh.clone();
                            m.version = head;
                            m.registered = false;
                        }
                        info!(%tenant, head, "studio-domain-model: the model moved on elsewhere; reloaded");
                        return Ok(fresh);
                    }
                    return Ok(ontology);
                }
                _ => return Ok(ontology),
            }
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

    /// Whether the cached model of `tenant` is due a check against the stored
    /// head; marks it checked.
    fn due_for_recheck(&self, tenant: Uuid) -> bool {
        let Ok(mut checked) = self.checked.lock() else {
            return false;
        };
        let now = std::time::Instant::now();
        match checked.get(&tenant) {
            Some(at) if now.duration_since(*at) < MODEL_RECHECK => false,
            _ => {
                checked.insert(tenant, now);
                true
            }
        }
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
    /// The version the next edit claims: past the stored head, and past any
    /// number already seen taken.
    fn next_version(&self, ctx: &SecurityContext) -> anyhow::Result<u64> {
        let tenant = ctx.subject_tenant_id();
        let claimed = self
            .claimed
            .lock()
            .map_err(|_| anyhow::anyhow!("claimed-version lock poisoned"))?
            .get(&tenant)
            .copied()
            .unwrap_or(0);
        Ok(self.cached_version(ctx)?.max(claimed) + 1)
    }

    /// Note the highest version claimed for this tenant, after a claim was
    /// refused: another writer's, or one abandoned mid-edit.
    async fn note_claimed(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        let top = self.revisions(ctx).await?.first().map_or(0, |r| r.version);
        if let Ok(mut c) = self.claimed.lock() {
            let e = c.entry(ctx.subject_tenant_id()).or_insert(0);
            *e = (*e).max(top);
        }
        Ok(())
    }

    async fn claim_version(&self, ctx: &SecurityContext, rev: &Revision) -> anyhow::Result<bool> {
        let node = NodeUpsert {
            type_id: gts::META_MODEL_VERSION.to_string(),
            node_key: gts::version_node_key(rev.version),
            name: Some(format!("v{}", rev.version)),
            payload: rev.payload(),
            expected_version: Some(0),
        };
        match self.store.upsert_nodes(ctx, &[node]).await {
            Err(e) if crate::domain_model::store::is_version_taken(&e) => {
                self.note_claimed(ctx).await?;
                Ok(false)
            }
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
                self.notify.model_changed(ctx, rev.version, &rev.op);
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
    /// Add the types Studio's own screens need to a stored model that lacks
    /// them; a model on the seed has them already. Answers the ids added.
    /// How many live objects of each type the organization holds, by type
    /// id, from the read model. `None` while it is still being filled (the
    /// first ask starts the fill).
    pub async fn type_counts(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<Option<std::collections::BTreeMap<String, u64>>> {
        let model = self.model(ctx).await?;
        let Some(mirror) = self.store.read_model(ctx, &model).await else {
            return Ok(None);
        };
        let by_node_type: HashMap<String, String> = model
            .entities()
            .iter()
            .filter_map(|e| e.get("id").and_then(Value::as_str))
            .map(|id| (gts::node_type_id(id), id.to_owned()))
            .collect();
        let mut out = std::collections::BTreeMap::new();
        for (type_id, n) in mirror.counts_by_type(ctx.subject_tenant_id()).await? {
            let id = by_node_type
                .get(&type_id)
                .cloned()
                .unwrap_or_else(|| gts::type_leaf(&type_id).to_owned());
            *out.entry(id).or_insert(0) += n;
        }
        Ok(Some(out))
    }

    pub async fn prepare_model(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        // A tenant on the seed is stored (seed = Studio's own model), a stored
        // one gains what it lacks, and either way its types are registered.
        self.ensure_persisted(ctx).await?;
        self.ensure_studio_types(ctx).await?;
        self.ensure_types(ctx).await?;
        Ok(())
    }

    pub async fn ensure_studio_types(&self, ctx: &SecurityContext) -> anyhow::Result<usize> {
        let model = self.model_current(ctx).await?;
        // Asked of a copy first: a model with nothing to add stays unwritten.
        if (*model).clone().add_studio_types().is_empty() {
            return Ok(0);
        }
        self.edit_entities(ctx, "studio-types", "take in Studio's own types", |next| {
            Ok(next.add_studio_types())
        })
        .await
    }

    pub async fn import_model(
        &self,
        ctx: &SecurityContext,
        doc: Value,
    ) -> anyhow::Result<ImportSummary> {
        let mut ontology = Ontology::from_value(doc).map_err(|e| anyhow::anyhow!("{e}"))?;
        // What it brings is marked as uploaded, with the model it came in.
        let source = ontology
            .document()
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("uploaded model")
            .to_owned();
        ontology.mark_uploaded(&source);
        // An import replaces what people defined, never what gears keep, nor
        // the types Studio's own screens read.
        let current = self.model_current(ctx).await?;
        ontology.keep_held_from(&current);
        ontology.add_studio_types();
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
        let version = if stored {
            self.next_version(ctx)?.max(head + 1)
        } else {
            0
        };
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
    /// `docs/upstream/gears-rust-issues.md` §5). Until that is closed, an *update* is
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
        if let Some(gear) = ontology.held_by(&entity_id) {
            return Err(AccessError::Held(format!("{entity_id} is kept by {gear}")).into());
        }

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
        let write = self
            .policy
            .access(ctx, access::WRITE, Some(&entity_id))
            .await?;
        if !write.admits_owner(ctx, write.owner_of_scope(scope)).await {
            return Err(AccessError::Denied.into());
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
        self.notify.objects_changed(
            ctx,
            &entity_id,
            std::slice::from_ref(&instance_id),
            "upsert",
        );
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
        let declared = self.checked_relation(ctx, relation_ref, from, to).await?;
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
        self.notify
            .objects_changed(ctx, &declared.source, &[from.to_owned()], "relate");
        Ok(CreatedRelation {
            type_id: edge_type_id,
            verb: declared.verb,
            name: Some(declared.name),
            label: Some(declared.label).filter(|l| !l.is_empty()),
            cardinality: declared.cardinality,
        })
    }

    /// Remove a relation between two objects, checked like
    /// [`Self::create_relation`]: the same reference, the same endpoints, the
    /// same rights. Answers whether there was one to remove.
    pub async fn delete_relation(
        &self,
        ctx: &SecurityContext,
        relation_ref: &str,
        from: &str,
        to: &str,
    ) -> anyhow::Result<bool> {
        let declared = self.checked_relation(ctx, relation_ref, from, to).await?;
        let removed = self
            .store
            .delete_relation(
                ctx,
                &gts::edge_type_id(&declared.verb),
                from,
                to,
                Some(&declared.name),
            )
            .await?;
        if removed {
            self.notify
                .objects_changed(ctx, &declared.source, &[from.to_owned()], "unrelate");
        }
        Ok(removed)
    }

    /// Change some fields of an object and keep the rest: `set` replaces the
    /// named fields, `unset` drops them. The object's key, scope and type stay
    /// what they are, so a field starting with `_` is the store's, not the
    /// caller's.
    pub async fn patch_object(
        &self,
        ctx: &SecurityContext,
        instance_id: &str,
        set: serde_json::Map<String, Value>,
        unset: &[String],
        validate: ValidateMode,
    ) -> anyhow::Result<CreatedObject> {
        if let Some(reserved) = set.keys().chain(unset.iter()).find(|k| k.starts_with('_')) {
            return Err(anyhow::anyhow!(
                "`{reserved}` is kept by the store and cannot be changed"
            ));
        }
        let ontology = self.model(ctx).await?;
        let (entity_id, node) = self
            .endpoint_entity(ctx, &ontology, instance_id, "id")
            .await?;
        // A gear's record takes a person's change only in the fields no gear
        // writes: what an administrator added to the type beside the gear's.
        if let Some(gear) = ontology.held_by(&entity_id) {
            let open = ontology.open_own_fields(&entity_id);
            if let Some(field) = set
                .keys()
                .chain(unset.iter())
                .find(|k| !open.contains(k) || ontology.field_held_by(&entity_id, k).is_some())
            {
                return Err(
                    AccessError::Held(format!("{entity_id}.{field} is kept by {gear}")).into(),
                );
            }
        }
        let write = self
            .policy
            .access(ctx, access::WRITE, Some(&entity_id))
            .await?;
        if !write.admits(ctx, &node).await {
            return Err(AccessError::Denied.into());
        }
        let mut payload = match node.value {
            Value::Object(m) => m,
            _ => serde_json::Map::new(),
        };
        for k in unset {
            payload.remove(k);
        }
        // A patch answers for what it touches: the fields it sets or unsets.
        // What the object lacked before is the object's state, not this
        // change's fault, and reporting it on every edit buries the one
        // problem the edit made.
        let touched: Vec<String> = set.keys().cloned().chain(unset.iter().cloned()).collect();
        payload.extend(set);
        let payload = Value::Object(payload);
        let report = match validate {
            ValidateMode::Off => Report::default(),
            _ => {
                let mut r =
                    super::validate::check(&ontology.effective_properties(&entity_id), &payload);
                r.violations.retain(|v| touched.contains(&v.field));
                r.undeclared.retain(|f| touched.contains(f));
                r
            }
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
        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string);
        self.ensure_types(ctx).await?;
        self.store
            .upsert_nodes(
                ctx,
                &[NodeUpsert {
                    type_id: node.type_id.clone(),
                    node_key: node.instance_id.clone(),
                    name,
                    payload,
                    expected_version: None,
                }],
            )
            .await?;
        self.notify.objects_changed(
            ctx,
            &entity_id,
            std::slice::from_ref(&node.instance_id),
            "patch",
        );
        Ok(CreatedObject {
            type_id: node.type_id,
            instance_id: node.instance_id,
            report,
        })
    }

    /// Delete an object. It is marked rather than removed from the graph,
    /// which would forbid its key for good (see
    /// [`super::store::DELETED_FIELD`]); every read leaves it out, and
    /// writing the same type and key again brings it back as a new object.
    pub async fn delete_object(
        &self,
        ctx: &SecurityContext,
        instance_id: &str,
    ) -> anyhow::Result<()> {
        let ontology = self.model(ctx).await?;
        let (entity_id, node) = self
            .endpoint_entity(ctx, &ontology, instance_id, "id")
            .await?;
        if let Some(gear) = ontology.held_by(&entity_id) {
            return Err(AccessError::Held(format!("{entity_id} is kept by {gear}")).into());
        }
        let write = self
            .policy
            .access(ctx, access::WRITE, Some(&entity_id))
            .await?;
        if !write.admits(ctx, &node).await {
            return Err(AccessError::Denied.into());
        }
        let mut payload = match node.value {
            Value::Object(m) => m,
            _ => serde_json::Map::new(),
        };
        let changed = node.instance_id.clone();
        payload.insert(super::store::DELETED_FIELD.to_string(), Value::Bool(true));
        payload.insert(
            "_deleted_at".to_string(),
            Value::String(
                OffsetDateTime::now_utc()
                    .format(&Rfc3339)
                    .unwrap_or_default(),
            ),
        );
        self.store
            .upsert_nodes_keeping_vectors(
                ctx,
                &[NodeUpsert {
                    type_id: node.type_id,
                    node_key: node.instance_id,
                    name: None,
                    payload: Value::Object(payload),
                    expected_version: None,
                }],
            )
            .await?;
        self.notify
            .objects_changed(ctx, &entity_id, std::slice::from_ref(&changed), "delete");
        Ok(())
    }

    /// Create one object of a gear's type only if no object has its id yet:
    /// `false` when one already does. What a gear serializes concurrent
    /// writers with, on every replica — the model's own versions are claimed
    /// the same way.
    pub async fn claim_trusted(
        &self,
        ctx: &SecurityContext,
        entity_ref: &str,
        id: &str,
        payload: Value,
    ) -> anyhow::Result<bool> {
        let ontology = self.model(ctx).await?;
        let entity_id = ontology
            .resolve_entity_id(entity_ref)
            .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity_ref}"))?;
        let write = self
            .policy
            .access(ctx, access::WRITE, Some(&entity_id))
            .await?;
        if !write.admits_owner(ctx, write.owner_of_scope(None)).await {
            return Err(AccessError::Denied.into());
        }
        self.ensure_types(ctx).await?;
        let node = NodeUpsert {
            type_id: gts::node_type_id(&entity_id),
            node_key: id.to_owned(),
            name: None,
            payload,
            expected_version: Some(0),
        };
        match self.store.upsert_nodes_keeping_vectors(ctx, &[node]).await {
            Ok(_) => Ok(true),
            Err(e) if super::store::is_version_taken(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Move the objects the root's model holds in `scope` into the model of
    /// the organization `org_ctx` acts in, with the relations between them,
    /// and mark them gone from the root.
    ///
    /// Before records lived in their organization's model, a platform
    /// administrator's writes — attributes, milestones, views, a gear's
    /// records — went to the root's, where nobody in the organization sees
    /// them. Idempotent: what moved is gone from the root.
    pub async fn rehome_scope(
        &self,
        root_ctx: &SecurityContext,
        org_ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<usize> {
        if root_ctx.subject_tenant_id() == org_ctx.subject_tenant_id() {
            return Ok(0);
        }
        let root = self.model(root_ctx).await?;
        let mut found: Vec<(String, String, Value)> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for e in root.entities() {
            let Some(id) = e.get("id").and_then(Value::as_str) else {
                continue;
            };
            if e.get("abstract").and_then(Value::as_bool) == Some(true)
                || e.get("bucket").and_then(Value::as_str) == Some("system-primitives")
            {
                continue;
            }
            let q = super::query::Query::from_json(json!({"type": id, "project_id": scope}))
                .map_err(|e| anyhow::anyhow!(e))?;
            let rows = match self.query_bulk(root_ctx, &q).await {
                Ok(out) => out.rows.items,
                Err(_) => continue,
            };
            for r in rows {
                if seen.insert(r.id.clone()) {
                    found.push((r.id, r.entity, r.value));
                }
            }
        }
        if found.is_empty() {
            return Ok(0);
        }
        // The organization's model gets the types the objects need.
        let entities: Vec<String> = {
            let mut v: Vec<String> = found.iter().map(|(_, e, _)| e.clone()).collect();
            v.sort();
            v.dedup();
            v
        };
        // The organization's model gets the types and the fields the objects
        // need; nothing taken in writes no version.
        self.edit_entities(org_ctx, "rehome", "take in from the root", |next| {
            Ok(if next.adopt_from(&root, &entities).is_empty() {
                Vec::new()
            } else {
                entities.clone()
            })
        })
        .await?;
        self.ensure_types(org_ctx).await?;
        let nodes: Vec<NodeUpsert> = found
            .iter()
            .map(|(id, entity, value)| NodeUpsert {
                type_id: gts::node_type_id(entity),
                node_key: id.clone(),
                name: value
                    .get("name")
                    .or_else(|| value.get("title"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                payload: value.clone(),
                expected_version: None,
            })
            .collect();
        for chunk in nodes.chunks(EMBEDDED_BATCH) {
            self.store.upsert_nodes(org_ctx, chunk).await?;
        }
        let ids: Vec<String> = found.iter().map(|(id, ..)| id.clone()).collect();
        let moved: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
        let edges: Vec<EdgeUpsert> = self
            .store
            .read_edges(root_ctx, &ids)
            .await?
            .into_iter()
            .filter(|e| moved.contains(e.from.as_str()) && moved.contains(e.to.as_str()))
            .map(|e| EdgeUpsert {
                type_id: e.type_id,
                from: e.from,
                to: e.to,
                payload: e.relation.as_ref().map(|r| json!({"name": r})),
                discriminator: e.relation,
            })
            .collect();
        for chunk in edges.chunks(TRUSTED_BATCH) {
            self.store.upsert_edges(org_ctx, chunk).await?;
        }
        let gone: Vec<NodeUpsert> = found
            .into_iter()
            .map(|(id, entity, mut value)| {
                if let Some(m) = value.as_object_mut() {
                    m.insert(super::store::DELETED_FIELD.to_string(), Value::Bool(true));
                }
                NodeUpsert {
                    type_id: gts::node_type_id(&entity),
                    node_key: id,
                    name: None,
                    payload: value,
                    expected_version: None,
                }
            })
            .collect();
        for chunk in gone.chunks(TRUSTED_BATCH) {
            self.store
                .upsert_nodes_keeping_vectors(root_ctx, chunk)
                .await?;
        }
        info!(scope, objects = nodes.len(), relations = edges.len(), org = %org_ctx.subject_tenant_id(), "studio-domain-model: objects moved from the root's model into their organization's");
        self.notify.objects_changed(org_ctx, "*", &ids, "rehome");
        Ok(nodes.len())
    }

    /// For a gear's batch write: the values its objects already hold in the
    /// fields no gear writes, by object id. Nothing is read when the type has
    /// no such field, which is every type nobody extended.
    async fn open_fields_of(
        &self,
        ctx: &SecurityContext,
        ontology: &Ontology,
        entity_id: &str,
        items: &[(String, String, Value)],
    ) -> anyhow::Result<HashMap<String, Value>> {
        let open = ontology.open_own_fields(entity_id);
        if open.is_empty() || ontology.held_by(entity_id).is_none() {
            return Ok(HashMap::new());
        }
        let ids: Vec<Value> = items
            .iter()
            .map(|(id, ..)| Value::String(id.clone()))
            .collect();
        let mut fields: Vec<Value> = open.iter().cloned().map(Value::String).collect();
        fields.push(Value::String("id".into()));
        let q = super::query::Query::from_json(json!({
            "type": entity_id,
            "where": {"id": {"_in": ids}},
            "fields": fields,
        }))
        .map_err(|e| anyhow::anyhow!(e))?;
        let out = self.query_bulk(ctx, &q).await.map_err(|e| match e {
            super::query::QueryError::Invalid(m) => anyhow::anyhow!(m),
            super::query::QueryError::Failed(e) => e,
        })?;
        Ok(out
            .rows
            .items
            .into_iter()
            .map(|r| {
                let mut v = r.value;
                if let Some(m) = v.as_object_mut() {
                    m.retain(|k, _| open.contains(k));
                }
                (r.id, v)
            })
            .collect())
    }

    /// Write a batch of objects of one type for a gear that owns their shape
    /// and their ids (ADR-0051 §8a): unchecked against the type, a graph
    /// write per few hundred objects, and the caller's right to write asked
    /// once per scope rather than once per object. Each item is
    /// `(id, scope, payload)`; `scope` empty is organization-wide.
    pub async fn put_objects_trusted(
        &self,
        ctx: &SecurityContext,
        entity_ref: &str,
        items: Vec<(String, String, Value)>,
    ) -> anyhow::Result<usize> {
        if items.is_empty() {
            return Ok(0);
        }
        let ontology = self.model(ctx).await?;
        let entity_id = ontology
            .resolve_entity_id(entity_ref)
            .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity_ref}"))?;
        let write = self
            .policy
            .access(ctx, access::WRITE, Some(&entity_id))
            .await?;
        let mut scopes: Vec<&str> = items.iter().map(|(_, s, _)| s.as_str()).collect();
        scopes.sort_unstable();
        scopes.dedup();
        for scope in scopes {
            let scope = Some(scope).filter(|s| !s.is_empty());
            if !write.admits_owner(ctx, write.owner_of_scope(scope)).await {
                return Err(AccessError::Denied.into());
            }
        }
        let type_id = gts::node_type_id(&entity_id);
        let kept = self
            .open_fields_of(ctx, &ontology, &entity_id, &items)
            .await?;
        let nodes: Vec<NodeUpsert> = items
            .into_iter()
            .map(|(id, scope, mut payload)| {
                if let Some(obj) = payload.as_object_mut() {
                    if !scope.is_empty() {
                        obj.insert("_scope".to_string(), Value::String(scope));
                    }
                    // A gear rewrites its record whole; what a person set in
                    // a field the gear does not write stays.
                    if let Some(Value::Object(old)) = kept.get(&id) {
                        for (k, v) in old {
                            obj.entry(k.clone()).or_insert_with(|| v.clone());
                        }
                    }
                }
                let name = payload
                    .get("name")
                    .or_else(|| payload.get("title"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                NodeUpsert {
                    node_key: id,
                    type_id: type_id.clone(),
                    name,
                    payload,
                    expected_version: None,
                }
            })
            .collect();
        self.ensure_types(ctx).await?;
        // A gear's records are embedded only where people search them by
        // meaning; the rest keep no vector and go in larger batches.
        if ontology.held_by(&entity_id).is_some() && !ontology.is_searchable(&entity_id) {
            for chunk in nodes.chunks(TRUSTED_BATCH) {
                self.store.upsert_nodes_keeping_vectors(ctx, chunk).await?;
            }
        } else {
            for chunk in nodes.chunks(EMBEDDED_BATCH) {
                self.store.upsert_nodes(ctx, chunk).await?;
            }
        }
        let ids: Vec<String> = nodes.iter().map(|n| n.node_key.clone()).collect();
        self.notify.objects_changed(ctx, &entity_id, &ids, "upsert");
        Ok(nodes.len())
    }

    /// Mark a gear's objects deleted, by id, in one write per batch. What
    /// they held is dropped: the mark is all that stays, and writing the
    /// same id again brings the object back.
    pub async fn remove_objects_trusted(
        &self,
        ctx: &SecurityContext,
        entity_ref: &str,
        ids: Vec<String>,
    ) -> anyhow::Result<usize> {
        if ids.is_empty() {
            return Ok(0);
        }
        let ontology = self.model(ctx).await?;
        let entity_id = ontology
            .resolve_entity_id(entity_ref)
            .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity_ref}"))?;
        let write = self
            .policy
            .access(ctx, access::WRITE, Some(&entity_id))
            .await?;
        if !write.admits_owner(ctx, ctx.subject_tenant_id()).await {
            return Err(AccessError::Denied.into());
        }
        let type_id = gts::node_type_id(&entity_id);
        let nodes: Vec<NodeUpsert> = ids
            .into_iter()
            .map(|id| NodeUpsert {
                node_key: id,
                type_id: type_id.clone(),
                name: None,
                payload: json!({ super::store::DELETED_FIELD: true }),
                expected_version: None,
            })
            .collect();
        for chunk in nodes.chunks(TRUSTED_BATCH) {
            self.store.upsert_nodes_keeping_vectors(ctx, chunk).await?;
        }
        let ids: Vec<String> = nodes.iter().map(|n| n.node_key.clone()).collect();
        self.notify.objects_changed(ctx, &entity_id, &ids, "delete");
        Ok(nodes.len())
    }

    /// Relate objects a gear wrote, by a relation the model declares on
    /// `source` — `(source entity, relation name, from id, to id)` — in one
    /// graph write per few hundred edges. The pair is not read back: the
    /// gear wrote both ends. A batch the graph refuses (an end that is not
    /// there) is retried edge by edge, and what still fails is skipped and
    /// counted, not fatal.
    pub async fn link_objects_trusted(
        &self,
        ctx: &SecurityContext,
        links: Vec<(String, String, String, String)>,
    ) -> anyhow::Result<(usize, usize)> {
        if links.is_empty() {
            return Ok((0, 0));
        }
        let ontology = self.model(ctx).await?;
        let mut edges = Vec::with_capacity(links.len());
        for (source, name, from, to) in links {
            let declared = ontology.declared_relation(&source, &name).ok_or_else(|| {
                anyhow::anyhow!("the model declares no relation `{source}.{name}`")
            })?;
            edges.push(EdgeUpsert {
                type_id: gts::edge_type_id(&declared.verb),
                from,
                to,
                discriminator: Some(declared.name.clone()),
                payload: Some(json!({
                    "name": declared.name,
                    "verb": declared.verb,
                    "source": declared.source,
                    "target": declared.target_entity,
                })),
            });
        }
        self.ensure_types(ctx).await?;
        let (mut written, mut skipped) = (0, 0);
        for chunk in edges.chunks(TRUSTED_BATCH) {
            if self.store.upsert_edges(ctx, chunk).await.is_ok() {
                written += chunk.len();
                continue;
            }
            for e in chunk {
                match self.store.upsert_edges(ctx, std::slice::from_ref(e)).await {
                    Ok(_) => written += 1,
                    Err(_) => skipped += 1,
                }
            }
        }
        Ok((written, skipped))
    }

    /// A gear's read of its own objects: the query language without the
    /// screen's page bound, up to [`super::query::BULK_LIMIT`] rows, answered
    /// by the read model once the tenant's is filled.
    pub async fn query_bulk(
        &self,
        ctx: &SecurityContext,
        q: &super::query::Query,
    ) -> Result<super::query::Outcome, super::query::QueryError> {
        let ontology = self.model(ctx).await?;
        self.ensure_types(ctx).await?;
        let read = self
            .policy
            .access(ctx, access::READ, Some(&q.type_ref))
            .await
            .map_err(|e| super::query::QueryError::Failed(e.into()))?;
        super::query::run_bulk(self.store.as_ref(), &ontology, ctx, q, &read).await
    }

    /// The relations of `names` between objects of the tenant, as
    /// `(relation, from, to)`.
    pub async fn relations_named(
        &self,
        ctx: &SecurityContext,
        names: &[&str],
    ) -> anyhow::Result<Vec<(String, String, String)>> {
        let ontology = self.model(ctx).await?;
        if let Some(mirror) = self.store.read_model(ctx, &ontology).await {
            return mirror.edges_named(ctx.subject_tenant_id(), names).await;
        }
        let ids: Vec<String> = self
            .store
            .list_objects(
                ctx,
                &ontology
                    .node_types()
                    .into_iter()
                    .map(|n| n.type_id)
                    .collect::<Vec<_>>(),
                None,
                None,
            )
            .await?
            .into_iter()
            .map(|n| n.instance_id)
            .collect();
        Ok(self
            .store
            .read_edges(ctx, &ids)
            .await?
            .into_iter()
            .filter_map(|e| {
                let r = e.relation?;
                names.contains(&r.as_str()).then_some((r, e.from, e.to))
            })
            .collect())
    }

    /// Objects of `entities` the text finds, best first (the graph's hybrid
    /// search), that the caller may read.
    pub async fn search_objects(
        &self,
        ctx: &SecurityContext,
        text: &str,
        entities: &[&str],
        limit: u32,
    ) -> anyhow::Result<Vec<ObjectNode>> {
        let type_ids: Vec<String> = entities.iter().map(|e| gts::node_type_id(e)).collect();
        let read = self.policy.access(ctx, access::READ, None).await?;
        let found = self.store.search(ctx, text, &type_ids, limit).await?;
        Ok(read.retain(ctx, found).await)
    }

    /// What a gear needs of one type, in one model version: the fields it
    /// lacks, the relations it does not declare yet, and the gear's hold on
    /// it and on its fields. Nothing missing writes nothing.
    pub async fn take_in(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        fields: &[FieldSpec],
        relations: &[(String, String, String)],
        hold: Option<(String, Vec<String>, bool)>,
    ) -> anyhow::Result<usize> {
        self.edit_entities(ctx, "take_in", "take in", |next| {
            let mut changed = false;
            let have: Vec<String> = next
                .effective_properties(entity)
                .into_iter()
                .map(|p| p.name)
                .collect();
            for f in fields {
                if !have.contains(&f.name) {
                    next.add_field(entity, f.clone())
                        .map_err(|e| anyhow::anyhow!("{e}"))?;
                    changed = true;
                }
            }
            for (name, target, verb) in relations {
                changed |= next
                    .add_relation(entity, name, target, verb)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
            if let Some((gear, names, searchable)) = &hold {
                changed |= next
                    .hold(entity, gear, names)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                changed |= next
                    .set_searchable(entity, *searchable)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
            Ok(if changed {
                vec![entity.to_owned()]
            } else {
                Vec::new()
            })
        })
        .await
    }

    /// One versioned edit of some entities: `edit` changes a copy of the
    /// model and names the entities it changed; nothing changed writes
    /// nothing. Retried on a version taken concurrently.
    async fn edit_entities(
        &self,
        ctx: &SecurityContext,
        op: &str,
        describe: &str,
        mut edit: impl FnMut(&mut Ontology) -> anyhow::Result<Vec<String>>,
    ) -> anyhow::Result<usize> {
        self.ensure_persisted(ctx).await?;
        for attempt in 0..EDIT_ATTEMPTS {
            let current = self.model_current(ctx).await?;
            let mut next = (*current).clone();
            let touched = edit(&mut next)?;
            if touched.is_empty() {
                return Ok(0);
            }
            let mut patches = Vec::new();
            let mut inverse = Vec::new();
            for entity in &touched {
                let index = next
                    .entity_index(entity)
                    .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity}"))?;
                patches.push(json!({
                    "op": "replace",
                    "path": format!("/entities/{index}"),
                    "value": next.entity(entity).cloned().unwrap_or(Value::Null),
                }));
                inverse.push(json!({
                    "op": "replace",
                    "path": format!("/entities/{index}"),
                    "value": current.entity(entity).cloned().unwrap_or(Value::Null),
                }));
            }
            let version = self.next_version(ctx)?;
            let rev = Revision::new(
                version,
                ctx,
                op,
                &touched.join(","),
                format!("{describe} {}", touched.join(", ")),
            )
            .with_patches(Value::Array(patches), Value::Array(inverse));
            if !self.claim_version(ctx, &rev).await? {
                warn!(
                    attempt,
                    version, "studio-domain-model: model version taken, retrying the edit"
                );
                self.reload(ctx).await?;
                continue;
            }
            let mut nodes = Vec::new();
            for entity in &touched {
                let node = next
                    .object_type_node(entity)
                    .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity}"))?;
                nodes.push(NodeUpsert {
                    type_id: gts::META_OBJECT_TYPE.to_string(),
                    node_key: gts::instance_id(gts::META_OBJECT_TYPE, entity),
                    name: Some(node.name.clone()),
                    payload: node.payload.clone(),
                    expected_version: None,
                });
            }
            nodes.push(self.model_node(&next, version));
            self.store.upsert_nodes(ctx, &nodes).await?;
            if let Some(m) = self.tenants_lock()?.get_mut(&ctx.subject_tenant_id()) {
                m.ontology = Arc::new(next);
                m.version = version;
                m.registered = false;
            }
            return Ok(touched.len());
        }
        Err(anyhow::anyhow!(
            "the model is being edited concurrently — no version could be claimed in {EDIT_ATTEMPTS} attempts"
        ))
    }

    /// The declared relation `relation_ref` names between two existing
    /// objects, once the caller is shown to write the source and read the
    /// target.
    async fn checked_relation(
        &self,
        ctx: &SecurityContext,
        relation_ref: &str,
        from: &str,
        to: &str,
    ) -> anyhow::Result<DeclaredRelation> {
        let ontology = self.model(ctx).await?;
        let relation_ref = relation_ref.trim();

        // The endpoints' own types are what the pair is checked against, so
        // both objects have to exist. They would have to anyway — an edge
        // endpoint that is not there is a caller relating before creating.
        let (src, src_node) = self.endpoint_entity(ctx, &ontology, from, "from").await?;
        let (dst, dst_node) = self.endpoint_entity(ctx, &ontology, to, "to").await?;
        // A gear's record is changed by its gear, its relations included; a
        // member's own object may still point at one.
        if let Some(gear) = ontology.held_by(&src) {
            return Err(AccessError::Held(format!("{src} is kept by {gear}")).into());
        }
        // Relating is writing the source; it also reveals the target, so the
        // caller must be able to read it. Otherwise relating a person to a
        // project you cannot see would test whether it exists (ADR-0035 §5).
        let write = self.policy.access(ctx, access::WRITE, Some(&src)).await?;
        let read = self.policy.access(ctx, access::READ, Some(&dst)).await?;
        if !write.admits(ctx, &src_node).await || !read.admits(ctx, &dst_node).await {
            return Err(AccessError::Denied.into());
        }

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
        Ok(declared)
    }

    /// The entity an endpoint object is of, or a message naming what is wrong.
    async fn endpoint_entity(
        &self,
        ctx: &SecurityContext,
        ontology: &Ontology,
        instance_id: &str,
        which: &str,
    ) -> anyhow::Result<(String, ObjectNode)> {
        let node = self
            .store
            .get_object(ctx, instance_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("no such object: {which}={instance_id}"))?;
        let entity = ontology.resolve_entity_id(&node.type_id).ok_or_else(|| {
            anyhow::anyhow!(
                "the {which} object is a `{}`, which this model has no entity for",
                node.type_id
            )
        })?;
        Ok((entity, node))
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

    /// Does the caller's model have this type?
    /// Every type of the tenant's model, and whether it is abstract.
    pub async fn entity_kinds(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<(String, bool)>> {
        Ok(self
            .model(ctx)
            .await?
            .entities()
            .iter()
            .filter_map(|e| {
                let id = e.get("id").and_then(Value::as_str)?.to_owned();
                Some((
                    id,
                    e.get("abstract").and_then(Value::as_bool).unwrap_or(false),
                ))
            })
            .collect())
    }

    pub async fn knows_type(&self, ctx: &SecurityContext, type_ref: &str) -> anyhow::Result<bool> {
        Ok(self.model(ctx).await?.resolve_entity_id(type_ref).is_some())
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
        let read = self.policy.access(ctx, access::READ, type_ref).await?;
        let found = self.store.list_objects(ctx, &type_ids, scope, None).await?;
        Ok(read.retain(ctx, found).await)
    }

    /// Answer a query (see [`super::query`]): a type's objects filtered,
    /// ordered, projected, with declared relations followed. Experimental,
    /// beside `list_objects` and `objects_graph` rather than in place of them.
    pub async fn query(
        &self,
        ctx: &SecurityContext,
        q: &super::query::Query,
    ) -> Result<super::query::Outcome, super::query::QueryError> {
        let ontology = self.model(ctx).await?;
        self.ensure_types(ctx).await?;
        let read = self
            .policy
            .access(ctx, access::READ, Some(&q.type_ref))
            .await
            .map_err(|e| super::query::QueryError::Failed(e.into()))?;
        super::query::run(self.store.as_ref(), &ontology, ctx, q, &read).await
    }

    /// Objects whose `_scope` is set but is not a tenant id (ADR-0035 §3).
    ///
    /// They were written before `project_id` existed, with a free-form scope,
    /// and authorization treats them as organization-wide: they keep what they
    /// had and no project grant reaches them. This lists them so whoever owns
    /// the data can see what is there. Moving one into a project is a new
    /// object, since the scope is part of its key.
    ///
    /// One bounded read across every domain type, like conformance.
    pub async fn legacy_scopes(
        &self,
        ctx: &SecurityContext,
        limit: usize,
    ) -> anyhow::Result<LegacyScopes> {
        let ontology = self.model(ctx).await?;
        self.ensure_types(ctx).await?;
        let type_ids: Vec<String> = ontology
            .node_types()
            .into_iter()
            .map(|n| n.type_id)
            .collect();
        let mut objects = self
            .store
            .list_objects(ctx, &type_ids, None, Some(limit + 1))
            .await?;
        let complete = objects.len() <= limit;
        objects.truncate(limit);
        let scanned = objects.len();
        let read = self.policy.access(ctx, access::READ, None).await?;
        let mut items: Vec<LegacyScoped> = read
            .retain(ctx, objects)
            .await
            .into_iter()
            .filter_map(|o| {
                let scope = o.value.get("_scope")?.as_str()?.trim().to_string();
                if scope.is_empty() || Uuid::parse_str(&scope).is_ok() {
                    return None;
                }
                Some(LegacyScoped {
                    entity: ontology
                        .resolve_entity_id(&o.type_id)
                        .unwrap_or_else(|| gts::type_leaf(&o.type_id).to_string()),
                    name: o
                        .value
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    instance_id: o.instance_id,
                    scope,
                })
            })
            .collect();
        items.sort_by(|a, b| {
            (&a.scope, &a.entity, &a.instance_id).cmp(&(&b.scope, &b.entity, &b.instance_id))
        });
        Ok(LegacyScopes {
            items,
            scanned,
            complete,
        })
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
        let read = self.policy.access(ctx, access::READ, type_ref).await?;
        let mut objs = read.retain(ctx, std::mem::take(&mut objs)).await;
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
    /// Give a level's type a tab (a `shows` relation): see
    /// [`Ontology::add_tab`]. Answers the level's type and the new version.
    pub async fn add_tab(
        &self,
        ctx: &SecurityContext,
        level: &str,
        name: &str,
        label: &str,
        target: &str,
    ) -> anyhow::Result<(Value, u64)> {
        let (level, name, label, target) = (level.trim(), name.trim(), label.trim(), target.trim());
        let well_formed = !name.is_empty()
            && name.len() <= 64
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
        if !well_formed {
            anyhow::bail!("a tab's name is lowercase letters, digits, - and _: {name:?}");
        }
        let label = if label.is_empty() { name } else { label };
        let mut taken = false;
        self.edit_entities(ctx, "tab", "add tab", |next| {
            if next
                .add_tab(level, name, label, target)
                .map_err(|e| anyhow::anyhow!("{e}"))?
            {
                Ok(vec![level.to_string()])
            } else {
                taken = true;
                Ok(Vec::new())
            }
        })
        .await?;
        if taken {
            anyhow::bail!("{level} already has a field or tab named {name}");
        }
        let model = self.model(ctx).await?;
        let entity = model
            .entity(level)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown domain type: {level}"))?;
        Ok((entity, self.cached_version(ctx)?))
    }

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

            let version = self.next_version(ctx)?;
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

    /// Add a type to the model, versioned like a field edit: a numbered
    /// revision with its inverse, the new `object_type` node and the model
    /// head written in one batch. The type is registered with graph-storage
    /// before the next object write, which is when it is first needed.
    pub async fn add_type(
        &self,
        ctx: &SecurityContext,
        spec: EntitySpec,
    ) -> anyhow::Result<(Value, u64)> {
        self.ensure_persisted(ctx).await?;
        for attempt in 0..EDIT_ATTEMPTS {
            let current = self.model_current(ctx).await?;
            let mut next = (*current).clone();
            let entity = next
                .add_entity(spec.clone())
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            let entity_id = entity["id"].as_str().unwrap_or_default().to_string();
            let index = next
                .entity_index(&entity_id)
                .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity_id}"))?;

            let version = self.next_version(ctx)?;
            let rev = Revision::new(
                version,
                ctx,
                "add_type",
                &entity_id,
                format!("add type {entity_id}"),
            )
            .with_patches(
                json!([{ "op": "add", "path": "/entities/-", "value": entity }]),
                json!([{ "op": "remove", "path": format!("/entities/{index}") }]),
            );
            if !self.claim_version(ctx, &rev).await? {
                warn!(
                    attempt,
                    version, "studio-domain-model: model version taken, retrying the edit"
                );
                self.reload(ctx).await?;
                continue;
            }
            let node = next
                .object_type_node(&entity_id)
                .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity_id}"))?;
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
            if let Some(m) = self.tenants_lock()?.get_mut(&ctx.subject_tenant_id()) {
                m.ontology = Arc::new(next);
                m.version = version;
                // A new node type: graph-storage has to know it before an
                // object of it can be written.
                m.registered = false;
            }
            return Ok((entity, version));
        }
        Err(anyhow::anyhow!(
            "the model is being edited concurrently — no version could be claimed in {EDIT_ATTEMPTS} attempts"
        ))
    }

    /// Change a field a type declares — rename, retype, require — and, for a
    /// rename, move the stored objects onto the new key.
    ///
    /// The model edit lands first and the migration follows, in that order and
    /// both idempotent, so a run that dies half way through is fixed by running
    /// it again: the model edit sees the field already renamed and does
    /// nothing, and the migration picks up the objects that were not reached.
    /// The alternative — migrate first — leaves objects on a key the model does
    /// not know, which reads as data loss.
    pub async fn edit_field(
        &self,
        ctx: &SecurityContext,
        entity_ref: &str,
        name: &str,
        edit: FieldEdit,
        migrate: bool,
    ) -> anyhow::Result<FieldEdited> {
        if edit.is_empty() {
            return Err(anyhow::anyhow!("nothing to change"));
        }
        let (entity, entity_id, version, already) = self
            .apply_to_type(
                ctx,
                entity_ref,
                |o, id| o.edit_field(id, name, &edit),
                "edit_field",
                &format!("edit field {name}"),
            )
            .await?;

        // A rename leaves every stored object holding the old key. Nothing else
        // touches the objects: retyping or requiring a field changes what they
        // are measured against, not what they hold.
        let migrated = match (&edit.rename_to, migrate) {
            (Some(to), true) if to != name => {
                Some(self.migrate_key(ctx, &entity_id, name, to).await?)
            }
            _ => None,
        };
        let _ = already;
        Ok(FieldEdited {
            entity,
            version,
            migrated,
        })
    }

    /// Drop a field from a type. The stored objects keep what they hold under
    /// that key — a model edit is not permission to delete data — so it starts
    /// being reported as undeclared instead.
    pub async fn remove_field(
        &self,
        ctx: &SecurityContext,
        entity_ref: &str,
        name: &str,
    ) -> anyhow::Result<FieldEdited> {
        let (entity, _, version, _) = self
            .apply_to_type(
                ctx,
                entity_ref,
                |o, id| o.remove_field(id, name),
                "remove_field",
                &format!("remove field {name}"),
            )
            .await?;
        Ok(FieldEdited {
            entity,
            version,
            migrated: None,
        })
    }

    /// The shared body of every field-level edit: reload, apply, claim a
    /// version with the patch the change makes, store the one type it touched.
    ///
    /// Returns `(entity, entity id, version, already applied)`. "Already
    /// applied" is not an error: it is what a retried rename looks like, and
    /// the caller goes on to finish the migration.
    async fn apply_to_type<F>(
        &self,
        ctx: &SecurityContext,
        entity_ref: &str,
        change: F,
        op: &str,
        summary: &str,
    ) -> anyhow::Result<(Value, String, u64, bool)>
    where
        F: Fn(&mut Ontology, &str) -> Result<FieldChange, super::ontology::OntologyError>,
    {
        self.ensure_persisted(ctx).await?;
        for attempt in 0..EDIT_ATTEMPTS {
            let current = self.model_current(ctx).await?;
            let entity_id = current
                .resolve_entity_id(entity_ref)
                .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity_ref}"))?;

            let mut next = (*current).clone();
            let changed = match change(&mut next, &entity_id) {
                Ok(changed) => changed,
                // Already in the model. A retried rename lands here, and its
                // migration may still have work to do — unlike a mistyped
                // field name, which falls through as an error.
                Err(super::ontology::OntologyError::AlreadyApplied) => {
                    let entity = current.entity(&entity_id).cloned().unwrap_or(Value::Null);
                    return Ok((entity, entity_id, self.cached_version(ctx)?, true));
                }
                Err(e) => return Err(anyhow::anyhow!("{e}")),
            };

            let index = next
                .entity_index(&entity_id)
                .ok_or_else(|| anyhow::anyhow!("unknown domain type: {entity_ref}"))?;
            let path = format!("/entities/{index}/properties/{}", changed.index);
            let (patch, undo) = if changed.after.is_null() {
                (
                    json!([{ "op": "remove", "path": path }]),
                    json!([{ "op": "add", "path": path, "value": changed.before }]),
                )
            } else {
                (
                    json!([{ "op": "replace", "path": path, "value": changed.after }]),
                    json!([{ "op": "replace", "path": path, "value": changed.before }]),
                )
            };

            let version = self.next_version(ctx)?;
            let rev = Revision::new(
                version,
                ctx,
                op,
                &entity_id,
                format!("{entity_id}: {summary}"),
            )
            .with_patches(patch, undo);
            if !self.claim_version(ctx, &rev).await? {
                warn!(
                    attempt,
                    version, "studio-domain-model: model version taken, retrying the edit"
                );
                self.reload(ctx).await?;
                continue;
            }

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
            if let Some(m) = self.tenants_lock()?.get_mut(&ctx.subject_tenant_id()) {
                m.ontology = Arc::new(next);
                m.version = version;
            }
            return Ok((changed.entity, entity_id, version, false));
        }
        Err(anyhow::anyhow!(
            "the model is being edited concurrently — no version could be claimed in \
             {EDIT_ATTEMPTS} attempts"
        ))
    }

    /// Move one payload key on every stored object of a type.
    ///
    /// Idempotent: an object that has already moved carries no `from` key and
    /// is left alone, so a partial run is finished by running it again. The
    /// rewrite keeps the stored vectors — a key rename touches none of the
    /// paths that are embedded, and re-embedding ten thousand objects for it
    /// would be the expensive way to change nothing.
    async fn migrate_key(
        &self,
        ctx: &SecurityContext,
        entity_id: &str,
        from: &str,
        to: &str,
    ) -> anyhow::Result<u64> {
        let type_id = gts::node_type_id(entity_id);
        let objects = self
            .store
            .list_objects(ctx, std::slice::from_ref(&type_id), None, None)
            .await?;
        let mut batch: Vec<NodeUpsert> = Vec::new();
        for object in objects {
            let Some(map) = object.value.as_object() else {
                continue;
            };
            if !map.contains_key(from) {
                continue;
            }
            let mut payload = object.value.clone();
            let holder = payload.as_object_mut().expect("object by construction");
            if let Some(value) = holder.remove(from) {
                holder.insert(to.to_string(), value);
            }
            batch.push(NodeUpsert {
                type_id: type_id.clone(),
                node_key: object.instance_id,
                name: payload
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                payload,
                expected_version: None,
            });
        }
        if batch.is_empty() {
            return Ok(0);
        }
        let mut moved = 0u64;
        for chunk in batch.chunks(MIGRATE_BATCH) {
            self.store.upsert_nodes_keeping_vectors(ctx, chunk).await?;
            moved += chunk.len() as u64;
        }
        info!(%entity_id, from, to, moved, "studio-domain-model: payload key migrated");
        Ok(moved)
    }

    /// How the stored objects of one type measure up against the type as it is
    /// now — the question a model edit otherwise leaves unanswerable.
    ///
    /// Validation runs on the way in, so before this the only way to know what
    /// an edit had broken was to rewrite every object and watch.
    pub async fn conformance(
        &self,
        ctx: &SecurityContext,
        type_ref: &str,
        scope: Option<&str>,
        limit: usize,
    ) -> anyhow::Result<Conformance> {
        let ontology = self.model_current(ctx).await?;
        let entity_id = ontology
            .resolve_entity_id(type_ref)
            .ok_or_else(|| anyhow::anyhow!("unknown domain type: {type_ref}"))?;
        let properties = ontology.effective_properties(&entity_id);

        // One over the bound: if it comes back, there was more to check.
        let mut objects = self
            .store
            .list_objects(
                ctx,
                &[gts::node_type_id(&entity_id)],
                scope,
                Some(limit + 1),
            )
            .await?;
        let truncated = objects.len() > limit;
        objects.truncate(limit);
        // It reports payload samples, so it reads what the caller may read and
        // nothing else (ADR-0035 §5).
        let read = self
            .policy
            .access(ctx, access::READ, Some(&entity_id))
            .await?;
        let objects = read.retain(ctx, objects).await;

        let mut report = Conformance {
            checked: objects.len() as u64,
            truncated,
            entity_id,
            ..Default::default()
        };
        let mut violations: HashMap<(String, String), u64> = HashMap::new();
        let mut undeclared: HashMap<String, u64> = HashMap::new();
        for object in &objects {
            let found = super::validate::check(&properties, &object.value);
            if found.is_clean() {
                report.conforming += 1;
            } else if report.sample.len() < CONFORMANCE_SAMPLE {
                report.sample.push((
                    object.instance_id.clone(),
                    found
                        .violations
                        .iter()
                        .map(|v| format!("{}: {}", v.field, v.detail))
                        .collect(),
                ));
            }
            for v in found.violations {
                *violations.entry((v.field, v.kind.to_string())).or_default() += 1;
            }
            for u in found.undeclared {
                *undeclared.entry(u).or_default() += 1;
            }
        }
        report.violations = violations
            .into_iter()
            .map(|((field, kind), count)| (field, kind, count))
            .collect();
        // Most frequent first, then by name, so the answer is stable.
        report
            .violations
            .sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
        report.undeclared = undeclared.into_iter().collect();
        report
            .undeclared
            .sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Ok(report)
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
            let mut next = Ontology::from_value(doc).map_err(|e| anyhow::anyhow!("{e}"))?;
            // What gears keep stays, whatever the revert undoes.
            let kept = next.keep_held_from(&current);
            if !kept.is_empty() {
                info!(kept = ?kept, "studio-domain-model: a revert kept what gears hold");
            }

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

        async fn upsert_nodes_keeping_vectors(
            &self,
            ctx: &SecurityContext,
            nodes: &[NodeUpsert],
        ) -> anyhow::Result<u64> {
            self.upsert_nodes(ctx, nodes).await
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
    async fn an_edit_numbers_past_a_claim_whose_write_never_landed() {
        let store = Arc::new(TenantScopedStore::default());
        let ctx = ctx_for(9);
        let service = DomainModelService::new(store.clone());
        service.prepare_model(&ctx).await.unwrap();
        let head = service.cached_version(&ctx).unwrap();
        // A writer claimed the next version and died before writing the model.
        assert!(
            service
                .claim_version(
                    &ctx,
                    &Revision::new(head + 1, &ctx, "add_field", "project", "died".to_string()),
                )
                .await
                .unwrap()
        );
        // Another process (no memory of that claim) still edits the model.
        let other = DomainModelService::new(store);
        let (_, version) = other
            .add_field(
                &ctx,
                "project",
                FieldSpec {
                    name: "cost_center".into(),
                    type_name: "string".into(),
                    description: None,
                    required: false,
                },
            )
            .await
            .expect("not stuck on the abandoned number");
        assert_eq!(version, head + 2);
    }

    #[tokio::test]
    async fn a_new_organization_starts_on_studio_s_own_model_and_an_upload_extends_it() {
        let store = Arc::new(TenantScopedStore::default());
        let ctx = ctx_for(7);
        let service = DomainModelService::new(store.clone());

        // Created: Studio's own model is stored at once, version 0.
        service.prepare_model(&ctx).await.unwrap();
        let studio = Ontology::load();
        let stored = DomainModelService::new(store.clone());
        let first = stored.ontology_document(&ctx).await.unwrap();
        assert_eq!(first["model"], "studio");
        assert_eq!(
            first["entities"].as_array().unwrap().len(),
            studio.entities().len()
        );
        assert!(
            !first["entities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["id"] == "requirement")
        );

        // The administrator uploads the product team's model: every type it
        // brings is there, and so is every one of Studio's.
        let product: Value =
            serde_json::from_str(super::super::ontology::PRODUCT_MODEL_JSON).unwrap();
        service.import_model(&ctx, product.clone()).await.unwrap();
        let after = DomainModelService::new(store)
            .ontology_document(&ctx)
            .await
            .unwrap();
        let ids: std::collections::HashSet<&str> = after["entities"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["id"].as_str())
            .collect();
        for e in product["entities"].as_array().unwrap() {
            assert!(ids.contains(e["id"].as_str().unwrap()), "{}", e["id"]);
        }
        for e in studio.entities() {
            assert!(ids.contains(e["id"].as_str().unwrap()), "{}", e["id"]);
        }
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
        // The imported type first, then Studio's own model, which an import
        // extends and never replaces.
        let ids: Vec<&str> = doc["entities"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["id"].as_str())
            .collect();
        let studio = Ontology::load();
        assert_eq!(ids[0], "widget");
        assert_eq!(ids.len(), 1 + studio.entities().len());
        assert!(ids.contains(&"workspace") && ids.contains(&"project"));
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

    /// The four edits a model owner actually makes, on a type that has stored
    /// objects. `project` stands in for the scenario's `Requirement`: it has
    /// an enum (`status`) and takes a field of our own.
    async fn with_priorities(
        store: Arc<TenantScopedStore>,
        ctx: &SecurityContext,
    ) -> DomainModelService {
        let service = DomainModelService::new(store);
        service
            .add_field(ctx, "project", field("priority"))
            .await
            .unwrap();
        for key in ["apollo", "gemini", "mercury"] {
            service
                .create_object(
                    ctx,
                    "project",
                    key,
                    WriteOptions::default(),
                    json!({ "name": key, "priority": "high" }),
                )
                .await
                .unwrap();
        }
        service
    }

    #[tokio::test]
    async fn renaming_a_field_moves_the_stored_objects() {
        let ctx = ctx_for(1);
        let service = with_priorities(Arc::new(TenantScopedStore::default()), &ctx).await;

        let edited = service
            .edit_field(
                &ctx,
                "project",
                "priority",
                FieldEdit {
                    rename_to: Some("urgency".into()),
                    ..Default::default()
                },
                true,
            )
            .await
            .unwrap();
        assert_eq!(edited.migrated, Some(3));

        // The model knows the new name…
        let props = service
            .effective_type(&ctx, "project")
            .await
            .unwrap()
            .properties;
        assert!(props.iter().any(|p| p.name == "urgency"));
        assert!(!props.iter().any(|p| p.name == "priority"));
        // …and so do the objects, which is the half a model edit does not do
        // by itself.
        for object in service
            .list_objects(&ctx, Some("project"), None)
            .await
            .unwrap()
        {
            assert_eq!(object.value["urgency"], "high");
            assert!(object.value.get("priority").is_none());
        }
    }

    #[tokio::test]
    async fn a_half_finished_rename_is_fixed_by_running_it_again() {
        let ctx = ctx_for(1);
        let service = with_priorities(Arc::new(TenantScopedStore::default()), &ctx).await;
        service
            .edit_field(
                &ctx,
                "project",
                "priority",
                FieldEdit {
                    rename_to: Some("urgency".into()),
                    ..Default::default()
                },
                true,
            )
            .await
            .unwrap();

        // The model edit is already applied, so the second run does not fail on
        // it — it just finds nothing left to migrate.
        let again = service
            .edit_field(
                &ctx,
                "project",
                "priority",
                FieldEdit {
                    rename_to: Some("urgency".into()),
                    ..Default::default()
                },
                true,
            )
            .await
            .expect("a retry is not an error");
        assert_eq!(again.migrated, Some(0));
    }

    #[tokio::test]
    async fn widening_an_enum_is_a_patch_that_can_be_reverted() {
        let ctx = ctx_for(1);
        let service = DomainModelService::new(Arc::new(TenantScopedStore::default()));
        let before = service.effective_type(&ctx, "project").await.unwrap();
        let status = before
            .properties
            .iter()
            .find(|p| p.name == "status")
            .unwrap();
        let widened = format!("{} | blocked", status.type_expr);

        let edited = service
            .edit_field(
                &ctx,
                "project",
                "status",
                FieldEdit {
                    type_name: Some(widened.clone()),
                    ..Default::default()
                },
                false,
            )
            .await
            .unwrap();
        assert_eq!(edited.migrated, None, "retyping moves no data");

        // `blocked` now validates where it did not before.
        let created = service
            .create_object(
                &ctx,
                "project",
                "apollo",
                WriteOptions::default(),
                json!({ "name": "Apollo", "status": "blocked" }),
            )
            .await
            .unwrap();
        assert!(
            !created
                .report
                .violations
                .iter()
                .any(|v| v.field == "status")
        );

        // And unlike an import, it records an inverse.
        service.revert(&ctx, edited.version - 1).await.unwrap();
        let after = service.effective_type(&ctx, "project").await.unwrap();
        let status = after
            .properties
            .iter()
            .find(|p| p.name == "status")
            .unwrap();
        assert_eq!(
            status.type_expr,
            before
                .properties
                .iter()
                .find(|p| p.name == "status")
                .unwrap()
                .type_expr
        );
    }

    #[tokio::test]
    async fn requiring_a_field_shows_the_objects_it_leaves_behind() {
        let ctx = ctx_for(1);
        let service = with_priorities(Arc::new(TenantScopedStore::default()), &ctx).await;
        service
            .add_field(&ctx, "project", field("owner"))
            .await
            .unwrap();

        // Optional: nothing to say about it.
        let before = service
            .conformance(&ctx, "project", None, 100)
            .await
            .unwrap();
        assert_eq!(before.checked, 3);
        assert!(!before.violations.iter().any(|(f, _, _)| f == "owner"));

        service
            .edit_field(
                &ctx,
                "project",
                "owner",
                FieldEdit {
                    required: Some(true),
                    ..Default::default()
                },
                false,
            )
            .await
            .unwrap();

        // Required: every stored object is now short of it, and the count says
        // so without anyone rewriting an object to find out.
        let after = service
            .conformance(&ctx, "project", None, 100)
            .await
            .unwrap();
        assert_eq!(
            after
                .violations
                .iter()
                .find(|(f, k, _)| f == "owner" && k == "missing")
                .map(|(_, _, n)| *n),
            Some(3)
        );
    }

    #[tokio::test]
    async fn removing_a_field_keeps_the_data_and_reports_it() {
        let ctx = ctx_for(1);
        let service = with_priorities(Arc::new(TenantScopedStore::default()), &ctx).await;
        service
            .remove_field(&ctx, "project", "priority")
            .await
            .unwrap();

        let report = service
            .conformance(&ctx, "project", None, 100)
            .await
            .unwrap();
        // The model dropped it; the objects did not.
        assert_eq!(
            report
                .undeclared
                .iter()
                .find(|(f, _)| f == "priority")
                .map(|(_, n)| *n),
            Some(3)
        );
        assert!(!report.sample.is_empty());
    }

    #[tokio::test]
    async fn a_mistyped_field_name_is_an_error_not_a_no_op() {
        let ctx = ctx_for(1);
        let service = DomainModelService::new(Arc::new(TenantScopedStore::default()));
        let e = service
            .edit_field(
                &ctx,
                "project",
                "priorty",
                FieldEdit {
                    rename_to: Some("urgency".into()),
                    ..Default::default()
                },
                false,
            )
            .await
            .expect_err("no such field");
        assert!(e.to_string().contains("no such field: priorty"), "{e}");
    }

    #[tokio::test]
    async fn a_field_that_is_not_the_types_own_is_refused_where_it_is_not_declared() {
        let ctx = ctx_for(1);
        let service = DomainModelService::new(Arc::new(TenantScopedStore::default()));

        // `tenant_id` comes from `system-object`; editing it on `project` would
        // change it for everything that extends the root.
        let e = service
            .edit_field(
                &ctx,
                "project",
                "tenant_id",
                FieldEdit {
                    required: Some(false),
                    ..Default::default()
                },
                false,
            )
            .await
            .expect_err("inherited");
        assert!(e.to_string().contains("declared by `system-object`"), "{e}");

        // A relation is an edge as well as a property, and removing the edge
        // is not implemented here.
        let e = service
            .edit_field(
                &ctx,
                "project",
                "uses",
                FieldEdit {
                    rename_to: Some("consumes".into()),
                    ..Default::default()
                },
                false,
            )
            .await
            .expect_err("relation");
        assert!(e.to_string().contains("is a relation"), "{e}");
    }

    #[tokio::test]
    async fn conformance_bounds_what_it_reads_and_says_so() {
        let ctx = ctx_for(1);
        let service = with_priorities(Arc::new(TenantScopedStore::default()), &ctx).await;
        let bounded = service.conformance(&ctx, "project", None, 2).await.unwrap();
        assert_eq!(bounded.checked, 2);
        assert!(bounded.truncated);
        let whole = service
            .conformance(&ctx, "project", None, 100)
            .await
            .unwrap();
        assert_eq!(whole.checked, 3);
        assert!(!whole.truncated);
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
