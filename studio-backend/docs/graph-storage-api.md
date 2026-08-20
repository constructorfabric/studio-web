# Graph Storage — API reference for consumers

From: Studio backend integration (`studio-web/studio-backend`, branch
`feature/graph-storage-gear`) · Updated: 2026-08-20

The graph-storage gear is vendored into the Studio assembly
(`src/graph_storage`, copied from `gears-rust/gears/graph-storage`) and pointed
at a dedicated PostgreSQL 19 + pgvector server. This document is what another
developer needs to build on it: the whole surface, the semantics that are not
obvious from the shapes, and what is still missing.

Everything here was checked against the running integration. Reference import:
`constructorfabric/insight` @ `main` → 824 nodes, 823 edges (622 files, 178
directories, 23 contributors) in 2.4 s, traversal served by the SQL/PGQ
`GRAPH_TABLE` backend with no fallback.

---

## 1. REST

Base path `/graph-storage/v1`, under the gateway prefix (`/cf` in this
assembly). Every operation is authenticated and scoped to the caller's tenant.

### Counters

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/stats` | `{ nodes, edges, graph_revision }` |

`graph_revision` is a real per-tenant counter, bumped inside the same
transaction as the write it describes. **This is the change-detection
mechanism** — poll it to learn that the graph moved. The upsert counts are not a
change feed (see § 3).

### Types

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `GET` | `/types` | — | `{ items: [{ id, type_id, kind, json_schema }] }` |
| `POST` | `/types` | `{ type_id, kind, json_schema? }` | `{ id }` |

`kind` is `node`, `edge` or `attribute`. Registration is idempotent: an
already-registered type keeps its interned id. Sending a `json_schema` for an
existing type replaces it, which is how a type gains a schema after the fact. A
schema that is not compilable is refused at registration rather than at the
first ingest, where it would read as the producer's fault.

`json_schema` comes back `null` for a type that declares no constraints — which
is the difference between "your payloads are checked" and "they are not".

### Write

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `POST` | `/ingest` | see below | `{ nodes_upserted, edges_upserted, graph_revision }` |

```jsonc
{
  "nodes": [{
    "node_key": "file:owner/repo:src/main.rs",  // stable, unique in the tenant
    "type_id":  "cf.studio.kg.file.v1~",        // a registered node type
    "name":     "main.rs",
    "search_text": "src/main.rs main.rs rs owner/repo",  // optional
    "payload":  { "path": "src/main.rs" },      // optional, object only
    "embedding": [0.01, -0.2]                   // optional, exact dimension
  }],
  "edges": [{
    "type_id": "cf.studio.kg.contains.v1~",
    "from":    "dir:owner/repo:src",            // endpoints are node KEYS
    "to":      "file:owner/repo:src/main.rs",
    "payload": { "since": "2026-01-01" }        // optional
  }]
}
```

**Atomic.** The whole batch commits or nothing does — types, nodes, edges and
the revision bump are one transaction.

**Convergent.** Nodes conflict on `(tenant, node_key)`, edges on a derived key
of `(type, from, to)`. Repeating a batch does not duplicate.

**Endpoints resolve within the batch.** An edge may name a node that arrives in
the same call or already exists; anything else is a 400 naming the key.

### Delete

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `DELETE` | `/nodes?key=…` | — | `{ nodes_deleted, edges_deleted, graph_revision }` |
| `DELETE` | `/edges/{id}` | — | same |
| `POST` | `/prune` | `{ type_id?, node_key_prefix?, not_seen_since? }` | same |

Nodes are addressed by key, as a query parameter rather than a path segment,
because keys carry slashes and colons — `file:owner/repo:src/main.rs` is a
normal one.

Deleting a node detaches its incident edges first, in the same transaction: the
endpoint foreign keys are `RESTRICT` by design, because removing a static node
must not silently destroy analysis edges attached to it.

`prune` is the sweep an importer runs after a re-import. Filters are ANDed and
**at least one is required** — a prune with none would take the tenant's whole
graph, which is not an operation offered by accident. The idiomatic use:

```jsonc
{ "node_key_prefix": "file:owner/repo:", "not_seen_since": "2026-08-20T10:00:00Z" }
```

Re-import, then prune everything under your own prefix that the import did not
refresh. `updated_at` is stamped on every touched row, so this removes exactly
what disappeared upstream.

### Read

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/nodes?type_id=&key=&cursor=&limit=&include_payload=` | `{ items: [node], next_cursor }` |
| `GET` | `/nodes/{id}?include_payload=` | one node, or 404 |
| `GET` | `/nodes/{id}/edges?direction=&cursor=&limit=&include_payload=` | `{ items: [edge], next_cursor }` |

`GET /nodes` with `key=` answers in the listing shape with zero or one item, so
a client that renders pages needs no second code path for one node.

Listings are **keyset-paginated on the surrogate id**, not `OFFSET`, so a page
boundary cannot drift under concurrent writes. `next_cursor` is absent on the
last page. A cursor this gear did not issue is a 400, never a silent reset.

A node addressed directly and not visible is **404, not 403**: telling a caller
that a node exists but is not theirs is itself a disclosure.

### Traverse and search

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/neighbours?seeds=&depth=&direction=&edge_types=` | `{ nodes: [i64], truncated }` |
| `GET` | `/subgraph?seeds=&depth=&direction=&edge_types=&include_payload=` | `{ nodes, edges, truncated }` |
| `GET` | `/search?q=&limit=&include_payload=` | `{ nodes: [node] }` |
| `POST` | `/hybrid` | `{ nodes: [{ id, distance }] }` |

`direction` is `out`, `in` or `both` (default). An unrecognised value is a 400,
not a silent `both` — a typo that widens a traversal is the kind of bug that
looks like data.

`edge_types` is a comma-separated list of GTS edge types the walk may follow;
absent means any.

`depth` is clamped to `traversal_max_depth` and the result to
`traversal_max_nodes`; `truncated` says the budget cut it.

`subgraph` returns the same node set as `neighbours`, resolved into names and
types, plus the edges between them. An edge is included only when **both** its
endpoints are authorised — one visible endpoint would draw a line to a node the
caller cannot see and disclose that it exists.

`POST /hybrid` takes `{ query_vector, text, seed_limit, limit }`: vector
similarity picks the seeds, the graph expands around them, and a full-text
predicate filters what is reached, in one SQL/PGQ statement. It needs ingested
nodes to carry embeddings. This copy computes none — the provider is ADR-0005's
pluggable one and is not implemented here — so both the stored vectors and the
query vector are the caller's.

### Payloads are opt-in everywhere

`include_payload` defaults to **false** on every read. The drawing path fetches
hundreds of nodes to render names and types and should not pay to transfer
attributes it will not display.

---

## 2. In-process client

`GraphStorageClientV1`, published to `ClientHub`, mirrors the REST surface
method for method — fifteen operations: `stats`, `register_type`, `types`,
`ingest`, `delete_node`, `delete_edge`, `prune`, `node_by_key`, `node_by_id`,
`list_nodes`, `list_edges`, `neighbours`, `subgraph`, `search`, `hybrid`.

```rust
use crate::graph_storage::sdk::{GraphStorageClientV1, TraversalQuery, Direction};

let graph = ctx.client_hub().get::<dyn GraphStorageClientV1>()?;
let sub = graph.subgraph(&ctx, &TraversalQuery {
    seeds: &[repo_id],
    depth: 2,
    direction: Direction::Outgoing,
    edge_types: &["cf.studio.kg.contains.v1~".to_owned()],
    include_payload: false,
}).await?;
```

Every method is a straight delegation to the same domain service the REST
handlers call, so the two surfaces cannot diverge in behaviour or in what they
enforce. Resolve the client in the REST phase or later, not in `init` — that way
it does not depend on gear initialisation order.

---

## 3. Semantics worth knowing before you build

**Node ids are surrogate and per-tenant.** They are not stable across tenants
and are not your key. Address nodes by `node_key` on write; ids come back from
reads. Keep your key derivation deterministic and you never need an id table.

**`nodes_upserted` / `edges_upserted` count what the statement wrote**, not the
batch size — but for nodes the conflict action is `DO UPDATE` and fires on every
conflicting row, so a re-ingest of unchanged nodes still counts them. For edges
the action is `DO NOTHING`, so only genuinely new edges are counted. **Use
`graph_revision` for change detection**, not the counts.

**Payload semantics.** Absent means "no opinion — leave what is stored";
`{}` means "clear the attributes". A supplied payload **replaces** the stored
one rather than merging into it. Merging looks friendlier and is the wrong
default: ADR-0003 requires that nothing is stored without passing validation,
and under a merge the *result* is what would have to validate — so an ingest
could fail because of data a different producer wrote earlier. Replace keeps a
clean invariant: the stored payload is always exactly one producer's validated
document. Genuine multi-producer merging belongs in a namespaced payload
(`payload.<producer> = {...}`), which is a modelling decision for those types,
not a default for all of them.

**Payload limits.** Objects only; a scalar or array is refused. Size is capped
by `ingest_max_payload_bytes` (64 KiB by default), measured on the serialized
form, and the error names the offending node key so a large batch tells you
which row was refused. Long-form content belongs in the file-storage gear,
referenced from the payload by identifier — the ceiling is what stops the graph
becoming the platform's accidental blob store.

**Payload validation.** When a node's type declares a `json_schema`, payloads
are validated against it and violations are reported with the JSON pointer of
the offending location. Types without a schema accept anything, so this is
additive.

**Embeddings.** Optional on ingest, dimension-checked against the column
(`embedding_dimensions`, 384) with a clear error rather than a database failure.
This copy does not compute them; see "The embedding provider" in § 5.

**Scoping is by construction.** Every query goes through the secure ORM.
Element keys are composite `(tenant_id, id)`, so an edge structurally cannot
join a node of another tenant even before a scope predicate is applied.

**Traversal backend selection.** `traversal_hop` picks `two_query`, `cte` or
`pgq`. A request whose scope cannot be reduced to a set of tenants is served by
`two_query` rather than refused, and the substitution is logged at `warn` — a
deployment configured for `pgq` and silently served by `two_query` would make
any measurement taken from it meaningless.

---

## 4. Configuration

```yaml
graph-storage:
  database:
    server: "pg_graph"          # PostgreSQL 19 + pgvector; the gear cannot run elsewhere
    dbname: "graph_storage"
  config:
    ingest_max_nodes: 10000
    ingest_max_edges: 20000
    ingest_max_payload_bytes: 65536
    embedding_dimensions: 384
    default_page_size: 50
    max_page_size: 500
    traversal_max_depth: 5
    traversal_max_nodes: 1000
    traversal_hop: pgq
```

The gear needs `CREATE EXTENSION vector`, `CREATE PROPERTY GRAPH` (SQL/PGQ,
PostgreSQL 19+) and an HNSW index, none of which the assembly's main 16-alpine
server has. `docker-compose.yml` provides `graph-postgres` for it; nothing else
in the assembly is exposed to a beta PostgreSQL.

---

## 5. What is still missing

**ADR-0003 annotations and the index lifecycle.** The accepted design has GTS
schemas annotate attributes as `x-gts-indexed` and `x-gts-vectorized`, with a
versioned annotation vocabulary published as a meta-schema, and a durable index
activation lifecycle (`requested → building → active`, `retiring → removed`)
running `CREATE INDEX CONCURRENTLY` in a background worker — with filters
admitted only while the supporting index is `active`. None of that exists. Until
it does:

- payload attributes are stored and returned but **not indexed**, so filtering
  on them is not offered rather than offered slowly;
- validation walks the **leaf type only**, not the full GTS derivation chain, so
  a derived type does not yet inherit its ancestors' constraints;
- `search_text` is producer-supplied. ADR-0003 has the gear composing it from
  the vectorized annotations, which will retire the field.

**Tabular projection.** `cpt-cf-graph-storage-fr-tabular-projection` — OData
filters over annotated attributes — depends on the above.

**The embedding provider.** This vendored copy computes no embeddings, so the
hybrid endpoint currently works only for callers that bring their own vectors on
both sides. That is a gap in the copy, not an open question: ADR-0005
(`cpt-cf-graph-storage-adr-embedding-provider`) settles it — a pluggable
embedding provider behind the plugin contract, with an in-process ONNX default,
a remote plugin, and a deterministic fake for CI. DESIGN's Embedding Coordinator
also owns composing search text from the vectorized attributes and preserving
stored vectors on non-embedding upserts, which is why `search_text` here is a
stopgap.

**Prune is bounded.** One call removes at most `ingest_max_nodes` nodes; a
larger sweep needs repeating until it reports zero. It reports what it removed,
so the loop is easy, but it is not a single-shot operation on a large graph.
