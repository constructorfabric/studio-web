//! The real graph store: the graph-storage gear, through its published SDK.
//!
//! Adapts our [`GraphStore`] contract onto `GraphStorageClientV1` (in-process,
//! tenant-scoped). Artifact nodes become graph-storage nodes keyed on their
//! deterministic instance id, so a re-sync converges. File *content* never goes
//! into the graph as such — the graph is not a blob store, and a payload is
//! capped at 64 KiB — only the metadata, and beside it a content node holding
//! a bounded excerpt of the text, which is what lexical and vector search
//! index.
//!
//! Only compiled with the `graph` feature (the gear itself is behind it).

use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use std::collections::{HashMap, HashSet};

use toolkit_odata::ODataQuery;

use super::graph::{
    GraphStore, GtsEdge, GtsEdgeView, GtsNode, files_behind_content, fold_content_hits,
};
use super::gts;
use graph_storage_sdk::GraphStorageClientV1;
use graph_storage_sdk::models::{
    EdgeRef, EdgeSpec, IngestOptions, IngestRequest, NodeSpec, SearchMode, SearchRequest,
    TraversalResponse, TraverseRequest, TypeRegistration,
};

/// Nodes per ingest batch.
///
/// The graph-storage gear embeds nodes in-process.  A repository may contain
/// file excerpts close to the embedding input limit, so its protocol limit of
/// 10k nodes is not a safe memory limit: a large ONNX tokenization batch can
/// exceed the backend pod's memory limit before inference begins.  Keep the
/// working set small and let a sync progress through many idempotent writes.
const NODE_INGEST_CHUNK: usize = 32;
/// Edges do not have embeddable text.  This only bounds request/transaction
/// size; it deliberately need not be as small as a node embedding batch.
const EDGE_INGEST_CHUNK: usize = 256;
/// Page size when reading nodes back for the portal. At the gear's
/// `projection_max_page` (200): a larger `$top` is refused, not clamped.
const LIST_PAGE: u32 = 200;
/// Seeds per traversal when reading the relation graph back.
///
/// `/edges` used to read one node per seed to get its adjacency. On studio-dev
/// that is 8,825 reads for one request, and it was also WRONG: a node read is
/// capped at the gear's `node_read_max_adjacency`, so the six nodes whose
/// degree exceeds it came back clipped and 27,852 of the graph's 79,184
/// relations — 35% — were dropped with nothing in the response to say so.
///
/// A seeded traversal reads many seeds at once and returns `EdgeRef`s with
/// explicit endpoints. The chunk exists because the gear budgets a traversal
/// by TOTAL NODES, seeds included: `seeds.len()` must fit inside `max_nodes`,
/// and whatever is left is the room the expansion has. 400 seeds against a
/// 10,000-node budget leaves 24 neighbours per seed, against a measured mean
/// of 9 and a 99th percentile of 86.
const TRAVERSE_SEED_CHUNK: usize = 400;

/// Node budget for one traversal, seeds included.
///
/// The ceiling the gear's own validation allows (`traversal_max_nodes` is
/// range-checked to 1..=10,000), and our deployment config raises the limit to
/// match — the default is 1,000. It is set to the ceiling because the budget is
/// what bounds correctness here, not speed: an exhausted budget truncates, and
/// a truncated traversal silently omits relations.
const TRAVERSE_NODE_BUDGET: u32 = 10_000;
/// Keep a node payload comfortably under the gear's 64 KiB ceiling; an oversized
/// one would fail the whole atomic batch.
const MAX_PAYLOAD_BYTES: usize = 60_000;
/// How much of a file's text travels into the graph as `text_excerpt`, on the
/// file's content node. It is what search — lexical and semantic — sees of a
/// file's *content*; the whole file stays in file storage. The gear itself caps the embedding input at its
/// `embedding_input_max_bytes` (8 KiB by default), so more than this would
/// bloat the lexical index without reaching the vector.
const MAX_TEXT_EXCERPT_CHARS: usize = 8_000;
/// Per-arm candidate count for hybrid search, before fusion.
const SEARCH_ARM_LIMIT: u32 = 50;
/// How long a tenant's type registration is taken as still true.
///
/// The types themselves are compile-time constants, so this is not about them
/// changing — it is a backstop for the registry changing underneath us. A
/// graph-storage database restored from a backup, or wiped, drops the rows
/// this process believes it wrote; without an expiry it would keep skipping
/// the registration and every read would fail on an unknown type until
/// somebody restarted the backend. Ten minutes bounds that to ten minutes,
/// and still removes the call from ~99.9% of operations.
///
/// The same shape as the PDP's membership cache: an age that is only a
/// backstop, not the mechanism.
const TYPE_REGISTRATION_TTL: Duration = Duration::from_secs(600);

/// How long a tenant's node projection is served from memory.
///
/// THE READ THIS AVOIDS IS NOT A QUERY, IT IS A WALK. `/v1/nodes` narrows by
/// `scope`, `repo` and an `updated_at` order, and all three live in the node
/// payload, which graph-storage's projection cannot filter or order on. So
/// [`GraphStorageBackend::list`] does the only thing it can: it pages the whole
/// typed node set into this process and narrows it here. Measured on studio-dev
/// (28,717 nodes across the four listable types, 31 MB of payload): one request
/// is 144 SEQUENTIAL round trips, and a client walking the pages of its own
/// result repeats them for every page.
///
/// Sixty seconds is chosen against the one thing this cache cannot see: a
/// second replica's ingest. A local ingest drops the entry exactly (see
/// [`GraphStorageBackend::invalidate_listings`]), so the TTL is only the bound
/// on how long THIS process can serve a listing that ANOTHER process changed.
/// A minute of that is acceptable for an artifact listing after a sync; it is
/// deliberately not longer, because nothing else detects the drift.
///
/// `STUDIO_ARTIFACT_LIST_CACHE_TTL_SECS=0` turns the cache off.
const LIST_CACHE_TTL_DEFAULT: Duration = Duration::from_secs(60);

/// How many cached nodes this process will hold across all tenants.
///
/// A budget in NODES rather than entries, because entries differ by three
/// orders of magnitude — a `?type=repo` listing is tens of nodes and the
/// default one is tens of thousands. The backend's memory limit is 1 GiB
/// against a ~500 MiB working set, and a node here is a parsed
/// `serde_json::Value`, several times the 1.1 KB its payload measures on disk.
/// 40,000 is about one default listing at today's size: enough that paging
/// through a result costs one walk instead of one per page, and small enough
/// that the cache cannot be what fills the pod.
///
/// Tune it with `STUDIO_ARTIFACT_LIST_CACHE_MAX_NODES` — the fill log line
/// carries the node count, so the number to set is measured rather than
/// guessed.
const LIST_CACHE_MAX_NODES_DEFAULT: usize = 40_000;

/// The payload of an artifact node whose source no longer has it.
///
/// Forgetting a node cannot be a graph-storage delete, for the reason the
/// components catalogue found first (see its `RETIRED_MARKER`): the gear's
/// delete is a tombstone, "a tombstoned `node_key` is not reusable before
/// purge" (graph-storage DESIGN § Soft Delete Contract, rule 4), and v1 has
/// neither purge nor undelete. A file's key is a uuid5 of its scope,
/// repository and path, so a file deleted and later restored — a revert, or
/// the IDE's checkout switched to a branch that still has it — needs the key
/// it had. After a tombstone that key could never be written again, and the
/// ingest chunk that tried would abort with every other file in it.
///
/// So a forgotten node is retired: its payload is overwritten with this
/// marker, which keeps the key live, and every read on this backend skips it.
/// The next ingest of the key is an ordinary upsert that replaces the marker.
const RETIRED_MARKER: &str = "studio_artifact_retired";

fn retired_payload() -> Value {
    json!({ RETIRED_MARKER: true })
}

/// Whether a payload read back is a retired node rather than an artifact.
fn is_retired(payload: Option<&Value>) -> bool {
    payload
        .and_then(|p| p.get(RETIRED_MARKER))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// One tenant's projection for one type set, and when it was read.
struct CachedListing {
    nodes: Arc<Vec<GtsNode>>,
    read_at: Instant,
}

pub struct GraphStorageBackend {
    client: Arc<dyn GraphStorageClientV1>,
    /// When this process last registered our types for a tenant.
    ///
    /// Keyed by tenant because the registry is: graph-storage scopes every
    /// operation to the caller's tenant and publishes the base ontology on a
    /// tenant's first registration, so one tenant's registration says nothing
    /// about another's.
    registered: Mutex<HashMap<Uuid, Instant>>,
    /// Node projections, keyed by tenant and the type set that was asked for.
    ///
    /// KEYED BY TENANT AND NOT BY CALLER, which is only correct because the
    /// projection is not narrowed per caller. `project_nodes` in graph-storage
    /// authorizes once — `READ` on the node resource — and then scopes the
    /// store context to the tenant; `resolve_patterns` resolves the requested
    /// patterns against the registered types and does NOT intersect them with
    /// anything the caller holds. Two authorized callers in one tenant
    /// therefore see identical rows, and one filling this cache for the other
    /// discloses nothing.
    ///
    /// If graph-storage ever gains row-level or per-principal authorization,
    /// THIS KEY BECOMES A LEAK and has to grow the principal. That is the one
    /// assumption worth re-checking when the gear's authz changes.
    listings: Mutex<HashMap<(Uuid, String), CachedListing>>,
    /// See [`LIST_CACHE_TTL_DEFAULT`]. Zero disables the cache entirely.
    cache_ttl: Duration,
    /// See [`LIST_CACHE_MAX_NODES_DEFAULT`].
    cache_max_nodes: usize,
}

impl GraphStorageBackend {
    pub fn new(client: Arc<dyn GraphStorageClientV1>) -> Self {
        Self {
            client,
            registered: Mutex::new(HashMap::new()),
            listings: Mutex::new(HashMap::new()),
            cache_ttl: env_duration_secs("STUDIO_ARTIFACT_LIST_CACHE_TTL_SECS")
                .unwrap_or(LIST_CACHE_TTL_DEFAULT),
            cache_max_nodes: env_usize("STUDIO_ARTIFACT_LIST_CACHE_MAX_NODES")
                .unwrap_or(LIST_CACHE_MAX_NODES_DEFAULT),
        }
    }

    /// A cached projection for this tenant and type set, if one is fresh.
    ///
    /// A poisoned lock is treated as a miss rather than an error: the cache is
    /// an optimisation, and failing a listing because a previous thread
    /// panicked while holding it would turn a performance feature into an
    /// availability one.
    fn cached_listing(&self, key: &(Uuid, String)) -> Option<Arc<Vec<GtsNode>>> {
        if self.cache_ttl.is_zero() {
            return None;
        }
        let mut listings = self.listings.lock().ok()?;
        cached_listing_in(&mut listings, key, self.cache_ttl)
    }

    /// Remember a projection, evicting oldest-first until the node budget holds.
    ///
    /// Eviction is by read time, not by use: an entry's value is bounded by the
    /// TTL anyway, so the oldest is always the one closest to being useless.
    fn remember_listing(&self, key: (Uuid, String), nodes: &Arc<Vec<GtsNode>>) {
        if self.cache_ttl.is_zero() || nodes.len() > self.cache_max_nodes {
            // A single listing over budget is never cached: admitting it would
            // evict everything else to hold one entry that the next listing
            // evicts again.
            return;
        }
        let Ok(mut listings) = self.listings.lock() else {
            return;
        };
        remember_listing_in(&mut listings, key, nodes, self.cache_max_nodes);
    }

    /// One depth-1 traversal over a set of seeds.
    ///
    /// Depth 1 because the relations the portal draws are the seeds' own edges;
    /// a deeper walk would spend the node budget on nodes nobody asked for. The
    /// node-type filter is left empty deliberately — it narrows the OUTPUT node
    /// set, and narrowing it would discard the far endpoints whose keys are the
    /// only thing we take from the response.
    async fn traverse_from(
        &self,
        ctx: &SecurityContext,
        seeds: &[String],
        edge_patterns: &[String],
    ) -> anyhow::Result<TraversalResponse> {
        self.client
            .traverse(
                ctx,
                TraverseRequest {
                    seeds: seeds.to_vec(),
                    depth: 1,
                    edge_type_patterns: edge_patterns.to_vec(),
                    node_type_patterns: Vec::new(),
                    max_nodes: Some(TRAVERSE_NODE_BUDGET),
                },
            )
            .await
            .map_err(|e| anyhow::anyhow!("graph-storage traversal: {e}"))
    }

    /// The relations touching `keys`, from either end, once each.
    ///
    /// The seeded depth-1 traversal the relation read uses, and halved on a
    /// truncated batch for the same reason (see `list_relations`): a truncated
    /// walk is missing edges anywhere, and an edge missed here is one that
    /// stays live pointing at a node nobody can read any more.
    async fn incident_edges(
        &self,
        ctx: &SecurityContext,
        keys: &[String],
    ) -> anyhow::Result<Vec<EdgeRef>> {
        let edge_patterns: Vec<String> = gts::ALL_EDGE_TYPES
            .into_iter()
            .map(gts::graph_type_id)
            .collect();
        let wanted: HashSet<&str> = keys.iter().map(String::as_str).collect();
        let mut seen: HashSet<String> = HashSet::new();
        let mut out: Vec<EdgeRef> = Vec::new();
        let mut batches: Vec<&[String]> = keys.chunks(TRAVERSE_SEED_CHUNK).collect();
        while let Some(batch) = batches.pop() {
            let response = self.traverse_from(ctx, batch, &edge_patterns).await?;
            if response.truncated.is_some() {
                if batch.len() > 1 {
                    let (left, right) = batch.split_at(batch.len() / 2);
                    batches.push(left);
                    batches.push(right);
                    continue;
                }
                tracing::warn!(
                    seed = %batch[0],
                    budget = TRAVERSE_NODE_BUDGET,
                    "studio-artifact-ingest: node degree exceeds the traversal budget; \
                     some of its relations stay live after it is forgotten"
                );
            }
            for edge in response.edges {
                let touches =
                    wanted.contains(edge.src.as_str()) || wanted.contains(edge.dst.as_str());
                if touches && seen.insert(edge.edge_key.clone()) {
                    out.push(edge);
                }
            }
        }
        Ok(out)
    }

    /// Drop every cached projection for a tenant.
    ///
    /// Called after an ingest the moment graph-storage has accepted it, so a
    /// sync is visible to the next listing on THIS process immediately. It is
    /// deliberately the whole tenant and not the type sets the batch touched:
    /// an ingest that adds the first node of a type would otherwise leave a
    /// cached listing that is correct for every type it knows about and silently
    /// missing the new one.
    fn invalidate_listings(&self, tenant: Uuid) {
        if let Ok(mut listings) = self.listings.lock() {
            listings.retain(|(t, _), _| *t != tenant);
        }
    }

    /// Register our artifact node and relation types, once per tenant.
    ///
    /// One atomic batch, idempotent: a byte-identical re-registration
    /// converges. Each type derives from a graph-storage family — a free-form
    /// type has no chain to validate against and is refused.
    ///
    /// IDEMPOTENT IS NOT FREE, which is what this used to assume. Every public
    /// operation on this backend calls it first — list, search, node read,
    /// every ingest chunk — so a listing that walks a large repository paid a
    /// round trip per inner page to re-register eight node types and their
    /// relations, all of which are `const` in this binary and cannot have
    /// changed since the last call a millisecond earlier.
    ///
    /// Now it is remembered per tenant, with [`TYPE_REGISTRATION_TTL`] as the
    /// backstop. A failed registration is NOT remembered: the entry is written
    /// only after the gear has accepted the batch, so a transient failure is
    /// retried by the next caller rather than being cached as success.
    async fn register_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        let tenant = ctx.subject_tenant_id();
        if self.registration_is_fresh(tenant) {
            return Ok(());
        }
        self.register_types_now(ctx).await?;
        if let Ok(mut registered) = self.registered.lock() {
            registered.insert(tenant, Instant::now());
        }
        Ok(())
    }

    /// Has this process registered for `tenant` recently enough to skip it?
    ///
    /// The lock is taken and released around a map lookup and is never held
    /// across an await — two callers racing the first registration both
    /// perform it, which the gear absorbs (the batch is idempotent) and which
    /// is cheaper than serialising every caller behind one in-flight request.
    fn registration_is_fresh(&self, tenant: Uuid) -> bool {
        let Ok(mut registered) = self.registered.lock() else {
            // A poisoned lock means some caller panicked mid-update. Registering
            // again is always safe; skipping wrongly is not.
            return false;
        };
        registration_is_fresh_in(&mut registered, tenant)
    }

    /// The registration itself, unconditional.
    async fn register_types_now(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        let batch: Vec<TypeRegistration> = gts::graph_node_type_schemas()
            .into_iter()
            .chain(gts::graph_edge_type_schemas())
            .map(|schema| TypeRegistration {
                type_id: schema
                    .get("$id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim_start_matches("gts://")
                    .to_string(),
                schema,
            })
            .collect();
        self.client
            .register_types(ctx, batch)
            .await
            .map_err(|e| anyhow::anyhow!("register artifact types: {e}"))?;
        Ok(())
    }

    /// A node with its payload, by key. The search surface returns keys and
    /// names only; the portal wants the normalized value too.
    async fn node_by_key(
        &self,
        ctx: &SecurityContext,
        key: &str,
        type_id: &str,
    ) -> anyhow::Result<Option<GtsNode>> {
        let Some(our_type) = gts::our_type_from_graph(type_id) else {
            return Ok(None);
        };
        let view = self
            .client
            .get_node(ctx, &key.to_owned(), Some(1))
            .await
            .map_err(|e| anyhow::anyhow!("graph-storage node read: {e}"))?;
        if is_retired(view.payload.as_ref()) {
            return Ok(None);
        }
        Ok(Some(GtsNode {
            type_id: our_type,
            instance_id: view.node_key,
            value: view.payload.unwrap_or_else(|| json!({})),
        }))
    }
}

/// A human name for the node, from the fields we normalize.
fn node_name(value: &Value) -> String {
    if let Some(t) = value.get("title").and_then(Value::as_str) {
        return t.to_string();
    }
    if let Some(p) = value.get("path").and_then(Value::as_str) {
        return p.to_string();
    }
    if let Some(f) = value.get("full_path").and_then(Value::as_str) {
        return f.to_string();
    }
    String::new()
}

/// Truncate `s` to at most `max_chars` characters.
fn excerpt(s: &str, max_chars: usize) -> String {
    let end = s
        .char_indices()
        .map(|(i, _)| i)
        .nth(max_chars)
        .unwrap_or(s.len());
    s[..end].to_string()
}

/// `value` with every U+0000 removed from its strings and object keys.
///
/// graph-storage keeps the payload in a `jsonb` column and the name and search
/// text in `text` columns, and PostgreSQL can hold a NUL in neither: the
/// insert fails with `unsupported Unicode escape sequence`, which the gear
/// reports as `unknown`, and the whole batch is lost. A NUL is valid UTF-8, so
/// a source file can carry one — `scripts/check-api-usage.mjs` in this very
/// repository does — and one such file dead-lettered every repository sync.
/// Dropping the character changes nothing a reader can see; refusing the file
/// would lose the rest of it.
pub(crate) fn without_nul(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(str_without_nul(s)),
        Value::Array(items) => Value::Array(items.into_iter().map(without_nul).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (str_without_nul(k), without_nul(v)))
                .collect(),
        ),
        other => other,
    }
}

/// `s` without U+0000 — see [`without_nul`]. Allocates only when there is one.
pub(crate) fn str_without_nul(s: String) -> String {
    if s.contains('\0') {
        s.replace('\0', "")
    } else {
        s
    }
}

/// The payload to store: the node value minus file content, plus a bounded
/// `text_excerpt` of that content, all under the gear's per-node ceiling
/// (drop the free-text `body` if it pushes us over).
fn bounded_payload(value: &Value) -> Value {
    let mut obj = match without_nul(value.clone()) {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    // File content is never stored whole in the graph. What search sees of it
    // is the excerpt, which the content type declares as a searchable and
    // vectorizable path; only a content node carries `text` to excerpt, so a
    // file node's payload stays metadata.
    if let Some(text) = obj.remove("text").as_ref().and_then(Value::as_str)
        && !text.trim().is_empty()
    {
        obj.insert(
            "text_excerpt".to_string(),
            Value::String(excerpt(text, MAX_TEXT_EXCERPT_CHARS)),
        );
    }
    let too_big = |m: &serde_json::Map<String, Value>| {
        serde_json::to_vec(m).map(|v| v.len()).unwrap_or(0) > MAX_PAYLOAD_BYTES
    };
    if too_big(&obj) {
        obj.remove("text_excerpt");
    }
    if too_big(&obj) {
        obj.remove("body");
    }
    // Last resort: if still oversized (a giant title/label set), drop to the
    // identifying fields only so the batch never fails on one row.
    if too_big(&obj) {
        let keep = ["repo", "external_id", "number", "path", "url", "state"];
        obj.retain(|k, _| keep.contains(&k.as_str()));
    }
    Value::Object(obj)
}

/// The searchable text and the embedding input are composed by the gear from
/// the payload paths the type declares, so neither is supplied per node.
fn to_node_spec(n: &GtsNode) -> NodeSpec {
    NodeSpec {
        node_key: n.instance_id.clone(),
        type_id: gts::graph_type_id(n.type_id),
        name: Some(str_without_nul(node_name(&n.value))).filter(|s| !s.is_empty()),
        payload: Some(bounded_payload(&n.value)),
        expected_version: None,
    }
}

fn to_edge_spec(e: &GtsEdge) -> EdgeSpec {
    EdgeSpec {
        type_id: gts::graph_type_id(e.type_id),
        src_node_key: e.from.clone(),
        dst_node_key: e.to.clone(),
        discriminator: None,
        payload: None,
    }
}

/// One ingest batch. Phantom endpoints are disabled: an edge whose endpoint is
/// missing is a bug in the pipeline's ordering, and a phantom would hide it.
/// Nodes are embedded by the gear on write. Edges are structural and must not
/// trigger an otherwise empty embedding pass.
fn batch(nodes: Vec<NodeSpec>, edges: Vec<EdgeSpec>, embed: bool) -> IngestRequest {
    IngestRequest {
        nodes,
        edges,
        options: IngestOptions {
            create_phantoms: Some(false),
            report_per_item: false,
            embed: Some(embed),
        },
        replace_scope: None,
        idempotency_key: None,
    }
}

/// Map a graph-storage edge type id back to our `gts.…` form (reverse of
/// [`gts::graph_type_id`]); fall back to the raw id if it is not one of ours.
fn our_edge_type(graph_type: &str) -> String {
    gts::ALL_EDGE_TYPES
        .into_iter()
        .find(|t| gts::graph_type_id(t) == graph_type)
        .map(str::to_string)
        .unwrap_or_else(|| graph_type.to_string())
}

#[async_trait]
impl GraphStore for GraphStorageBackend {
    fn stored_payload(&self, value: &Value) -> Value {
        bounded_payload(value)
    }

    async fn upsert_nodes(&self, ctx: &SecurityContext, nodes: &[GtsNode]) -> anyhow::Result<()> {
        if nodes.is_empty() {
            return Ok(());
        }
        self.register_types(ctx).await?;

        let specs: Vec<NodeSpec> = nodes.iter().map(to_node_spec).collect();
        let mut upserted = 0u64;
        let mut revision = 0i64;
        for chunk in specs.chunks(NODE_INGEST_CHUNK) {
            let res = self
                .client
                .ingest(ctx, batch(chunk.to_vec(), Vec::new(), true))
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage ingest: {e}"))?;
            upserted += res.counts.nodes_inserted + res.counts.nodes_updated;
            revision = res.revision.revision;
        }
        // After the gear has accepted the batch, never before: an invalidation
        // on a failed ingest would drop a listing that is still correct.
        self.invalidate_listings(ctx.subject_tenant_id());
        tracing::info!(
            batch = nodes.len(),
            nodes_upserted = upserted,
            graph_revision = revision,
            "studio-artifact-ingest: graph-storage upsert"
        );
        Ok(())
    }

    /// Hybrid retrieval: the gear embeds the query with the deployment's
    /// provider, ranks the vector and lexical arms and fuses them. Hits carry
    /// keys and names; the payload comes from a node read per hit.
    ///
    /// A content hit costs one more read, for the file it folds into, and a
    /// file found by both its name and its words is one result — so up to
    /// twice `limit` hits are asked for, within the gear's own ceiling on
    /// `limit` (twice its arm limit), to still have `limit` after the fold.
    async fn search(
        &self,
        ctx: &SecurityContext,
        text: &str,
        limit: u32,
    ) -> anyhow::Result<Vec<GtsNode>> {
        self.register_types(ctx).await?;
        let patterns: Vec<String> = gts::ALL_NODE_TYPES
            .into_iter()
            .map(gts::graph_type_id)
            .collect();
        let asked = limit.saturating_mul(2).min(SEARCH_ARM_LIMIT * 2).max(limit);
        let response = self
            .client
            .search(
                ctx,
                SearchRequest {
                    mode: SearchMode::Hybrid,
                    query: Some(text.to_owned()),
                    arm_limit: SEARCH_ARM_LIMIT.max(limit),
                    limit: asked,
                    type_patterns: patterns,
                },
            )
            .await
            .map_err(|e| anyhow::anyhow!("graph-storage search: {e}"))?;
        let mut hits = Vec::with_capacity(response.hits.len());
        for hit in response.hits {
            if let Some(node) = self.node_by_key(ctx, &hit.node_key, &hit.type_id).await? {
                hits.push(node);
            }
        }
        let file_type = gts::graph_type_id(gts::FILE_TYPE);
        let mut files = HashMap::new();
        for id in files_behind_content(&hits) {
            // A file that cannot be read costs its hit, not the search.
            match self.node_by_key(ctx, &id, &file_type).await {
                Ok(Some(file)) => {
                    files.insert(id, file);
                }
                Ok(None) => {}
                Err(error) => tracing::warn!(
                    %error,
                    file = %id,
                    "studio-artifact-ingest: the file behind a content hit could not be read"
                ),
            }
        }
        Ok(fold_content_hits(
            hits,
            &files,
            usize::try_from(limit).unwrap_or(usize::MAX),
        ))
    }

    async fn upsert_edges(&self, ctx: &SecurityContext, edges: &[GtsEdge]) -> anyhow::Result<()> {
        if edges.is_empty() {
            return Ok(());
        }
        self.register_types(ctx).await?;

        let specs: Vec<EdgeSpec> = edges.iter().map(to_edge_spec).collect();
        let mut upserted = 0u64;
        for chunk in specs.chunks(EDGE_INGEST_CHUNK) {
            let res = self
                .client
                .ingest(ctx, batch(Vec::new(), chunk.to_vec(), false))
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage edge ingest: {e}"))?;
            upserted += res.counts.edges_inserted + res.counts.edges_updated;
        }
        tracing::info!(
            batch = edges.len(),
            edges_upserted = upserted,
            "studio-artifact-ingest: graph-storage edge upsert"
        );
        Ok(())
    }

    /// A retire, not a graph-storage delete — see [`RETIRED_MARKER`] for why a
    /// tombstone would make the key unwritable.
    ///
    /// Relations go first, and they CAN be deleted. graph-storage's own node
    /// delete would tombstone them with the node (DESIGN § Soft Delete
    /// Contract, rule 2), but a retire is an upsert and leaves them live, so a
    /// `contains` edge would go on pointing at a node every read skips. An edge
    /// tombstone, unlike a node's, is undone by the next ingest of the same
    /// relation — the gear's edge upsert clears `deleted_at` — so a file that
    /// comes back gets its edges back from the sync that finds it.
    ///
    /// A node whose relations could not all be removed is left as it is, and
    /// the next sync that finds it stale tries again. Retiring it anyway would
    /// hide it from every read, including the one that would have retried.
    async fn delete_nodes(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
    ) -> anyhow::Result<usize> {
        use toolkit_canonical_errors::CanonicalError;

        if nodes.is_empty() {
            return Ok(0);
        }
        self.register_types(ctx).await?;

        let keys: Vec<String> = nodes.iter().map(|n| n.instance_id.clone()).collect();
        let edges = self.incident_edges(ctx, &keys).await?;
        let mut blocked: HashSet<String> = HashSet::new();
        let mut edges_removed = 0u64;
        for edge in &edges {
            match self.client.delete_edge(ctx, &edge.edge_key).await {
                Ok(outcome) => edges_removed += outcome.tombstoned_edges,
                Err(CanonicalError::NotFound { .. }) => {}
                Err(error) => {
                    tracing::warn!(
                        %error,
                        edge = %edge.edge_key,
                        "studio-artifact-ingest: relation not removed; its nodes are kept for the next sync"
                    );
                    blocked.insert(edge.src.clone());
                    blocked.insert(edge.dst.clone());
                }
            }
        }

        let specs: Vec<NodeSpec> = nodes
            .iter()
            .filter(|n| !blocked.contains(&n.instance_id))
            .map(|n| NodeSpec {
                node_key: n.instance_id.clone(),
                // A same-key ingest may not change the type.
                type_id: gts::graph_type_id(n.type_id),
                name: None,
                payload: Some(retired_payload()),
                expected_version: None,
            })
            .collect();
        let mut retired = 0u64;
        let mut failure = None;
        for chunk in specs.chunks(NODE_INGEST_CHUNK) {
            // Not embedded: the marker has nothing to find, and skipping the
            // embedding leaves the old vector stale, so it no longer ranks.
            match self
                .client
                .ingest(ctx, batch(chunk.to_vec(), Vec::new(), false))
                .await
            {
                // Updated only: a node already retired comes back unchanged,
                // and it was not this call that forgot it.
                Ok(res) => retired += res.counts.nodes_updated,
                Err(e) => {
                    failure = Some(anyhow::anyhow!("graph-storage retire: {e}"));
                    break;
                }
            }
        }
        // Whatever was retired before a failure is retired, so the cached
        // listings are wrong either way.
        if retired > 0 || edges_removed > 0 {
            self.invalidate_listings(ctx.subject_tenant_id());
        }
        if let Some(e) = failure {
            return Err(e);
        }
        tracing::info!(
            batch = nodes.len(),
            nodes_retired = retired,
            edges_removed,
            kept = blocked.len(),
            "studio-artifact-ingest: graph-storage retire"
        );
        Ok(usize::try_from(retired).unwrap_or(usize::MAX))
    }

    async fn list(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Arc<Vec<GtsNode>>> {
        // Ensure our types exist before narrowing by them, so a read before the
        // first ingest returns empty rather than tripping on an unknown type.
        self.register_types(ctx).await?;

        let patterns: Vec<String> = gts::resolve_listable_types(type_filter)
            .into_iter()
            .map(gts::graph_type_id)
            .collect();
        if patterns.is_empty() {
            return Ok(Arc::new(Vec::new()));
        }

        // The type set, not the caller's `type_filter` string: `issue` and the
        // full `gts.cf.studio.artifact.issue.v1~` resolve to the same patterns
        // and must not be two entries for one projection.
        let key = (ctx.subject_tenant_id(), patterns.join(","));
        if let Some(hit) = self.cached_listing(&key) {
            tracing::debug!(
                nodes = hit.len(),
                types = patterns.len(),
                "studio-artifact-ingest: projection served from cache"
            );
            return Ok(hit);
        }

        let started = Instant::now();
        let mut pages = 0u32;
        let mut out: Vec<GtsNode> = Vec::new();
        let mut query = ODataQuery::default().with_limit(u64::from(LIST_PAGE));
        loop {
            let page = self
                .client
                .project_nodes(ctx, &patterns, query.clone())
                .await
                .map_err(|e| anyhow::anyhow!("graph-storage projection: {e}"))?;
            for row in page.items {
                if is_retired(row.payload.as_ref()) {
                    continue;
                }
                let Some(type_id) = gts::our_type_from_graph(&row.type_id) else {
                    continue;
                };
                out.push(GtsNode {
                    type_id,
                    instance_id: row.node_key,
                    value: row.payload.unwrap_or_else(|| json!({})),
                });
            }
            pages += 1;
            let Some(next) = page.page_info.next_cursor else {
                break;
            };
            query = ODataQuery::default()
                .with_limit(u64::from(LIST_PAGE))
                .with_cursor(parse_cursor(&next)?);
        }
        // The node count is the number to set STUDIO_ARTIFACT_LIST_CACHE_MAX_NODES
        // from, and `pages` is the round-trip count this walk actually cost —
        // both are the evidence for whether the cache is sized right.
        tracing::info!(
            nodes = out.len(),
            pages,
            elapsed_ms = started.elapsed().as_millis(),
            "studio-artifact-ingest: projection walked"
        );
        let nodes = Arc::new(out);
        self.remember_listing(key, &nodes);
        Ok(nodes)
    }

    async fn list_relations(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<GtsEdgeView>> {
        self.register_types(ctx).await?;

        // The sources of the cross-relations the portal draws. Users are only
        // edge targets; files are excluded because their edges are reached from
        // the other end anyway (file↔file duplicate links are the one relation
        // this omits — a known follow-up).
        let seeds: Vec<String> = self
            .list(ctx, None)
            .await?
            .iter()
            .filter(|n| n.type_id != gts::USER_TYPE && n.type_id != gts::FILE_TYPE)
            .map(|n| n.instance_id.clone())
            .collect();
        if seeds.is_empty() {
            return Ok(Vec::new());
        }
        let sources: HashSet<&str> = seeds.iter().map(String::as_str).collect();
        let edge_patterns: Vec<String> = gts::ALL_EDGE_TYPES
            .into_iter()
            .map(gts::graph_type_id)
            .collect();

        let mut seen: HashSet<String> = HashSet::new();
        let mut out: Vec<GtsEdgeView> = Vec::new();
        let mut traversals = 0u32;
        let mut clipped = 0u32;

        // A truncated batch is HALVED rather than exploded into one call per
        // seed. Retrying a 400-seed chunk seed-by-seed costs 400 calls to find
        // the one node that exhausted the budget, and this graph has three of
        // them — which would put the call count straight back where it started.
        // Halving finds the same node in about log2(400) ≈ 9 steps, and gives it
        // the whole budget to itself when it gets there. A single seed that
        // still truncates is a node whose own degree exceeds 10,000, and no call
        // this gear offers will return the rest of it.
        let mut batches: Vec<&[String]> = seeds.chunks(TRAVERSE_SEED_CHUNK).collect();
        while let Some(batch) = batches.pop() {
            let response = self.traverse_from(ctx, batch, &edge_patterns).await?;
            traversals += 1;

            if let Some(reason) = response.truncated {
                if batch.len() > 1 {
                    // Drop this response and re-read both halves: a truncated
                    // walk is missing edges anywhere, not only at its tail.
                    let (left, right) = batch.split_at(batch.len() / 2);
                    batches.push(left);
                    batches.push(right);
                    continue;
                }
                clipped += 1;
                tracing::warn!(
                    ?reason,
                    seed = %batch[0],
                    budget = TRAVERSE_NODE_BUDGET,
                    "studio-artifact-ingest: node degree exceeds the traversal budget;                      some of its relations cannot be read at all"
                );
            }

            for edge in response.edges {
                // The walk is undirected, so a batch sees each edge from
                // whichever end it reached first. Keeping only the ones leaving
                // a seed reproduces the outgoing-side view the portal has always
                // been given.
                if !sources.contains(edge.src.as_str()) {
                    continue;
                }
                let type_id = our_edge_type(&edge.edge_type_id);
                if seen.insert(format!("{type_id}|{}|{}", edge.src, edge.dst)) {
                    out.push(GtsEdgeView {
                        type_id,
                        from: edge.src,
                        to: edge.dst,
                    });
                }
            }
        }

        tracing::info!(
            seeds = seeds.len(),
            traversals,
            truncated = clipped,
            edges = out.len(),
            "studio-artifact-ingest: relation graph read"
        );
        Ok(out)
    }
}

/// Decode a `CursorV1` continuation token handed back by the projection.
/// A duration from an environment variable, in whole seconds.
///
/// An unparsable value is ignored rather than fatal — the caller falls back to
/// the compiled default. A cache knob is not worth refusing to boot over, and
/// the alternative (a typo in a Helm value taking the backend down) is worse
/// than the alternative it guards against.
fn env_duration_secs(key: &str) -> Option<Duration> {
    let raw = std::env::var(key).ok()?;
    match raw.trim().parse::<u64>() {
        Ok(secs) => Some(Duration::from_secs(secs)),
        Err(_) => {
            tracing::warn!(%key, value = %raw, "studio-artifact-ingest: not a number; using the default");
            None
        }
    }
}

fn env_usize(key: &str) -> Option<usize> {
    let raw = std::env::var(key).ok()?;
    match raw.trim().parse::<usize>() {
        Ok(n) => Some(n),
        Err(_) => {
            tracing::warn!(%key, value = %raw, "studio-artifact-ingest: not a number; using the default");
            None
        }
    }
}

fn parse_cursor(raw: &str) -> anyhow::Result<toolkit_odata::CursorV1> {
    toolkit_odata::CursorV1::decode(raw)
        .map_err(|e| anyhow::anyhow!("graph-storage returned an undecodable cursor: {e}"))
}

/// The freshness rule, over the map alone.
///
/// A free function rather than a method so it is testable without a
/// `GraphStorageClientV1` double — the same reason the PDP keeps its decision
/// pure. Expiring entries are removed on the way past, which is all the
/// eviction this map needs: it is keyed by tenant, and a deployment has as
/// many tenants as it has organizations.
/// A fresh entry, or `None`. An expired entry is dropped on the way past, so
/// the map cannot accumulate projections for tenants nobody is asking about.
fn cached_listing_in(
    listings: &mut HashMap<(Uuid, String), CachedListing>,
    key: &(Uuid, String),
    ttl: Duration,
) -> Option<Arc<Vec<GtsNode>>> {
    match listings.get(key) {
        Some(hit) if hit.read_at.elapsed() < ttl => Some(Arc::clone(&hit.nodes)),
        Some(_) => {
            listings.remove(key);
            None
        }
        None => None,
    }
}

/// Insert, then evict oldest-first until the node budget holds.
fn remember_listing_in(
    listings: &mut HashMap<(Uuid, String), CachedListing>,
    key: (Uuid, String),
    nodes: &Arc<Vec<GtsNode>>,
    max_nodes: usize,
) {
    listings.insert(
        key,
        CachedListing {
            nodes: Arc::clone(nodes),
            read_at: Instant::now(),
        },
    );
    while listings.values().map(|e| e.nodes.len()).sum::<usize>() > max_nodes {
        let Some(oldest) = listings
            .iter()
            .min_by_key(|(_, e)| e.read_at)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        listings.remove(&oldest);
    }
}

fn registration_is_fresh_in(registered: &mut HashMap<Uuid, Instant>, tenant: Uuid) -> bool {
    match registered.get(&tenant) {
        Some(at) if at.elapsed() < TYPE_REGISTRATION_TTL => true,
        Some(_) => {
            registered.remove(&tenant);
            false
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TENANT: Uuid = Uuid::from_u128(0x7e1a);
    const OTHER: Uuid = Uuid::from_u128(0x7e1b);

    /// An `Instant` far enough in the past to be expired.
    fn stale() -> Instant {
        Instant::now()
            .checked_sub(TYPE_REGISTRATION_TTL + Duration::from_secs(1))
            .expect("the process has not been running long enough to subtract the TTL")
    }

    #[test]
    fn a_tenant_we_have_never_registered_for_is_not_fresh() {
        let mut registered = HashMap::new();
        assert!(!registration_is_fresh_in(&mut registered, TENANT));
    }

    #[test]
    fn a_recent_registration_is_fresh() {
        let mut registered = HashMap::from([(TENANT, Instant::now())]);
        assert!(registration_is_fresh_in(&mut registered, TENANT));
    }

    /// The backstop, and the eviction that goes with it: an expired entry is
    /// not merely ignored, it is dropped, so the map cannot fill with tenants
    /// nobody is asking about any more.
    #[test]
    fn an_expired_registration_is_not_fresh_and_is_forgotten() {
        let mut registered = HashMap::from([(TENANT, stale())]);
        assert!(!registration_is_fresh_in(&mut registered, TENANT));
        assert!(!registered.contains_key(&TENANT));
    }

    /// The registry is per tenant — graph-storage scopes every operation to the
    /// caller's tenant and publishes the base ontology on a tenant's first
    /// registration — so one tenant's entry must never answer for another's.
    #[test]
    fn one_tenants_registration_does_not_answer_for_another() {
        let mut registered = HashMap::from([(TENANT, Instant::now())]);
        assert!(!registration_is_fresh_in(&mut registered, OTHER));
        assert!(registration_is_fresh_in(&mut registered, TENANT));
    }

    // ---- the projection cache ------------------------------------------
    //
    // These exercise the rules, not a graph-storage client: the cache is a
    // HashMap and three decisions over it, and the decisions are what can be
    // wrong.

    fn listing(n: usize) -> Arc<Vec<GtsNode>> {
        Arc::new(
            (0..n)
                .map(|i| GtsNode {
                    type_id: gts::ISSUE_TYPE,
                    instance_id: format!("node-{i}"),
                    value: json!({ "n": i }),
                })
                .collect(),
        )
    }

    fn key(tenant: Uuid, patterns: &str) -> (Uuid, String) {
        (tenant, patterns.to_owned())
    }

    #[test]
    fn a_projection_we_have_never_read_is_a_miss() {
        let mut listings = HashMap::new();
        assert!(
            cached_listing_in(&mut listings, &key(TENANT, "issue"), LIST_CACHE_TTL_DEFAULT)
                .is_none()
        );
    }

    #[test]
    fn a_recent_projection_is_served_without_a_walk() {
        let mut listings = HashMap::new();
        remember_listing_in(&mut listings, key(TENANT, "issue"), &listing(3), 100);
        let hit = cached_listing_in(&mut listings, &key(TENANT, "issue"), LIST_CACHE_TTL_DEFAULT);
        assert_eq!(hit.expect("a fresh entry is a hit").len(), 3);
    }

    /// The TTL is the only thing that bounds how long this process can serve a
    /// listing another replica has already changed, so an expired entry must
    /// be a miss AND must not be left behind.
    #[test]
    fn an_expired_projection_is_a_miss_and_is_forgotten() {
        let mut listings = HashMap::new();
        remember_listing_in(&mut listings, key(TENANT, "issue"), &listing(3), 100);
        assert!(cached_listing_in(&mut listings, &key(TENANT, "issue"), Duration::ZERO).is_none());
        assert!(listings.is_empty());
    }

    /// The key carries the tenant because the projection does: serving one
    /// tenant's nodes to another would be the worst bug this file could have.
    #[test]
    fn one_tenants_projection_never_answers_for_another() {
        let mut listings = HashMap::new();
        remember_listing_in(&mut listings, key(TENANT, "issue"), &listing(3), 100);
        assert!(
            cached_listing_in(&mut listings, &key(OTHER, "issue"), LIST_CACHE_TTL_DEFAULT)
                .is_none()
        );
    }

    /// Two type sets are two projections. `?type=issue` must not be answered
    /// from the unfiltered listing, which holds four types, nor the reverse.
    #[test]
    fn one_type_set_never_answers_for_another() {
        let mut listings = HashMap::new();
        remember_listing_in(&mut listings, key(TENANT, "issue"), &listing(3), 100);
        assert!(
            cached_listing_in(
                &mut listings,
                &key(TENANT, "issue,file"),
                LIST_CACHE_TTL_DEFAULT
            )
            .is_none()
        );
    }

    /// The budget is in nodes, and it is a ceiling on the whole map rather
    /// than on one entry.
    #[test]
    fn the_node_budget_evicts_the_oldest_entry_first() {
        let mut listings = HashMap::new();
        remember_listing_in(&mut listings, key(TENANT, "old"), &listing(6), 10);
        remember_listing_in(&mut listings, key(TENANT, "new"), &listing(6), 10);
        assert!(
            cached_listing_in(&mut listings, &key(TENANT, "old"), LIST_CACHE_TTL_DEFAULT).is_none(),
            "the older entry is the one evicted"
        );
        assert!(
            cached_listing_in(&mut listings, &key(TENANT, "new"), LIST_CACHE_TTL_DEFAULT).is_some(),
            "the entry that caused the eviction survives it"
        );
    }

    /// Invalidation is the whole tenant, because an ingest that adds the first
    /// node of a type leaves every other listing correct and that one wrong.
    #[test]
    fn an_ingest_drops_every_projection_for_its_tenant_and_no_others() {
        let mut listings = HashMap::new();
        remember_listing_in(&mut listings, key(TENANT, "issue"), &listing(2), 100);
        remember_listing_in(&mut listings, key(TENANT, "file"), &listing(2), 100);
        remember_listing_in(&mut listings, key(OTHER, "issue"), &listing(2), 100);

        listings.retain(|(t, _), _| *t != TENANT);

        assert!(
            cached_listing_in(&mut listings, &key(TENANT, "issue"), LIST_CACHE_TTL_DEFAULT)
                .is_none()
        );
        assert!(
            cached_listing_in(&mut listings, &key(TENANT, "file"), LIST_CACHE_TTL_DEFAULT)
                .is_none()
        );
        assert!(
            cached_listing_in(&mut listings, &key(OTHER, "issue"), LIST_CACHE_TTL_DEFAULT)
                .is_some()
        );
    }

    #[test]
    fn file_text_becomes_a_bounded_excerpt() {
        let long = "x".repeat(MAX_TEXT_EXCERPT_CHARS + 100);
        let payload = bounded_payload(&json!({ "path": "a.md", "text": long, "has_text": true }));
        assert!(payload.get("text").is_none());
        assert_eq!(
            payload["text_excerpt"].as_str().map(str::len),
            Some(MAX_TEXT_EXCERPT_CHARS)
        );
        assert_eq!(payload["path"], "a.md");
    }

    #[test]
    fn an_empty_text_leaves_no_excerpt() {
        let payload = bounded_payload(&json!({ "path": "a.bin", "text": "  " }));
        assert!(payload.get("text_excerpt").is_none());
    }

    /// PostgreSQL stores no NUL in `jsonb` or `text`; one in a source file
    /// used to fail the whole batch as `unknown`.
    #[test]
    fn a_nul_in_file_text_never_reaches_the_gear() {
        let node = GtsNode {
            type_id: gts::ALL_NODE_TYPES[0],
            instance_id: "k".into(),
            value: json!({
                "title": "wild\u{0}card.mjs",
                "path": "scripts/wild\u{0}card.mjs",
                "text": "const WILDCARD = '\u{0}';",
                "labels": ["a\u{0}b"],
                "nested": { "k\u{0}ey": "v\u{0}" },
            }),
        };
        let spec = to_node_spec(&node);
        assert_eq!(spec.name.as_deref(), Some("wildcard.mjs"));
        let payload = spec.payload.expect("a payload");
        assert!(!serde_json::to_string(&payload).unwrap().contains("\\u0000"));
        assert_eq!(payload["text_excerpt"], "const WILDCARD = '';");
        assert_eq!(payload["path"], "scripts/wildcard.mjs");
        assert_eq!(payload["labels"][0], "ab");
        assert_eq!(payload["nested"]["key"], "v");
    }

    /// A retired node reads as retired, and nothing an artifact carries does:
    /// a file whose payload merely mentions the marker is still a file.
    #[test]
    fn only_the_retire_marker_reads_as_retired() {
        assert!(is_retired(Some(&retired_payload())));
        assert!(!is_retired(None));
        assert!(!is_retired(Some(&json!({ "path": "a.md" }))));
        assert!(!is_retired(Some(&json!({ RETIRED_MARKER: false }))));
        assert!(!is_retired(Some(
            &json!({ "text_excerpt": RETIRED_MARKER })
        )));
    }

    #[test]
    fn a_payload_without_nul_is_left_as_it_is() {
        let value = json!({ "a": "plain", "n": 3, "b": [true, null, "x"] });
        assert_eq!(without_nul(value.clone()), value);
    }
}
