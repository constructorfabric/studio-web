# Graph Storage — API reference for consumers

From: Studio backend integration (`studio-web/studio-backend`) · Updated: 2026-09-03

The graph-storage gear (`cf-gears-graph-storage`, gears-rust
`gears/graph-storage`) is linked into the Studio assembly as a crate behind the
`graph` feature and pointed at the PostgreSQL 19 + pgvector server. This
document is what another developer needs to build on it from inside this
assembly: the surface, the semantics that are not obvious from the shapes, and
what is still missing. The normative description is the gear's own
`docs/DESIGN.md`; the exact request and response schemas are in the OpenAPI
document at `/cf/docs`.

---

## 1. The model in five sentences

Everything is a typed **node** or **edge**, addressed by a producer-chosen
`node_key` (unique per tenant) or a derived `edge_key`. A type is a GTS JSON
Schema that **derives from one of the gear's families** — `owned_node`,
`reference_node`, `phantom_node` for nodes; `static_edge`, `analysis_edge` for
edges — and its identifier carries that ancestry:
`gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~cf.studio.artifact.file.v1~`.
A type declares, as traits, **which payload paths are searched** (`full_text_search`)
**and embedded** (`vector_search`); the gear composes both texts from the node's
name plus those paths on every write, so a producer never supplies a search
string or a vector. Every write moves a per-tenant **revision** that every read
reports back. Ingest is one atomic batch that **converges**: a byte-identical
re-run changes nothing and says so.

## 2. REST

Base path `/graph-storage/v1`, under the gateway prefix (`/cf`). Every
operation is authenticated and scoped to the caller's tenant; a row the caller
may not see reads like an absent one.

### Types

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `POST` | `/types` | `{ types: [{ type_id, schema }] }` | `[TypeRecord]` |
| `GET` | `/types` | `?kind=node\|edge&pattern=…&top=&cursor=` | `{ items: [TypeRecord], next_cursor, revision }` |
| `GET` | `/types/{type_id}` | — | `TypeRecord` |

`TypeRecord` = `{ type_id, type_uuid, kind, is_abstract, schema, effective_traits: { family, index, full_text_search, vector_search, src_types, dst_types, … } }`.

Registration is atomic over the batch and idempotent on identical bytes; a
different schema under a registered id is a `409` conflict. The nine base
schemas are published by the gear itself on a tenant's first registration. A
type that does not derive from a family is refused.

### Write

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `POST` | `/ingest` | `IngestRequest` | `IngestOutcome` |
| `DELETE` | `/nodes/{node_key}` | — | `{ revision, tombstoned_nodes, tombstoned_edges }` |
| `DELETE` | `/edges/{edge_key}` | — | same |

```jsonc
// IngestRequest
{
  "nodes": [{ "node_key": "file:o/r:src/main.rs", "type_id": "…file.v1~",
              "name": "main.rs", "payload": { "path": "src/main.rs" },
              "expected_version": null }],
  "edges": [{ "type_id": "…contains.v1~", "src_node_key": "dir:o/r:src",
              "dst_node_key": "file:o/r:src/main.rs", "discriminator": null, "payload": null }],
  "options": { "create_phantoms": false, "report_per_item": false, "embed": true },
  "replace_scope": null,
  "idempotency_key": null
}
// IngestOutcome
{ "revision": { "source_epoch": 1, "revision": 42 }, "replayed": false,
  "counts": { "nodes_inserted", "nodes_updated", "nodes_unchanged",
              "edges_inserted", "edges_updated", "edges_unchanged",
              "phantoms_created", "phantoms_materialized", … },
  "per_item_nodes": null, "per_item_edges": null }
```

- **Payload is replace, not merge.** `payload: null` clears it. Send the whole
  object every time.
- **Endpoints must exist** — in storage or in the same batch — unless
  `create_phantoms` is on, in which case a `phantom_node` is created and later
  *materialised* when the real node arrives. The Studio consumers turn phantoms
  off: a dangling endpoint is a pipeline bug, and a phantom would hide it.
- **`embed`** decides whether this batch's nodes get vectors. `false` keeps the
  existing vector when the text is unchanged (*preserved*) and marks it *stale*
  when the text changed — the node then stops ranking in the vector arm but is
  otherwise untouched.
- **Failure is per item and total**: a violation anywhere rolls the whole batch
  back, and the error names every failing item by index and JSON pointer.
- Bounds (configurable): 10k nodes / 20k edges per batch, 64 KiB per payload.

### Read

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `GET` | `/nodes/{node_key}` | `?adjacency_limit=` | `NodeView` |
| `GET` | `/nodes` | `?type_pattern=…` + OData `$filter`, `$orderby`, `$top`, `$skiptoken` | `{ items: [NodeRow], page_info: { next_cursor } }` |
| `GET` | `/revision` | — | `{ source_epoch, revision }` |

`NodeView` = `{ node_key, type_id, name, payload, has_embedding, adjacency:
[{ edge_key, edge_type_id, direction, neighbor_key, neighbor_type_id }],
adjacency_truncated, envelope }`. The **envelope** carries `tenant_id`, `key`,
`created_at/by`, `updated_at/by`, `deleted_at/by` and the `graph_revision` the
read observed.

The projection's `$filter`/`$orderby` accept `node_key`, `name`, `created_at`,
`updated_at`. **Payload attributes are not filterable** yet (see § 6).

### Search and traversal

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `POST` | `/search` | `{ mode: "lexical"\|"vector"\|"hybrid", query, arm_limit?, limit?, type_patterns: [] }` | `{ hits: [{ node_key, type_id, name, score, arms: [{ arm, rank, score }], snippet }], revision }` |
| `POST` | `/graph/traverse` | `{ seeds: [node_key], depth, edge_type_patterns: [], node_type_patterns: [], max_nodes? }` | `TraversalResponse` |
| `POST` | `/graph/neighborhood` | `{ root, depth, node_budget?, include_phantoms }` | `TraversalResponse` |

`TraversalResponse` = `{ nodes: [NodeView], edges: [{ edge_key, edge_type_id,
src, dst }], truncated: null | reason, revision }`.

- **The query is embedded by the gear**, with the same provider that embedded
  the nodes, so `vector` and `hybrid` need only text. `hybrid` fuses the two
  arms by reciprocal rank; each hit says which arms ranked it and where.
- A vector or hybrid search while the stored vectors belong to a *different*
  embedding space than the configured provider answers
  `400 EMBEDDING_SPACE_MISMATCH`; lexical search is unaffected.
- Traversal is bounded by depth, node count, frontier and edges scanned; a
  stop reports its reason in `truncated` rather than returning a partial graph
  silently. Each hop runs as one SQL/PGQ `GRAPH_TABLE` statement; a scope the
  pattern cannot carry is served by the two-query hop with a logged reason.
- Type patterns are GTS patterns resolved against the registered types; they
  are never compiled into SQL.

## 3. In-process client

Consumers inside the assembly do not go through REST:

```rust
use graph_storage_sdk::GraphStorageClientV1;
let graph = ctx.client_hub().get::<dyn GraphStorageClientV1>()?;
```

Resolve it in the REST phase, not in `init`: gear initialisation order is not
guaranteed and the client is registered when graph-storage initialises. The
trait mirrors REST one to one — `register_types`, `get_type`, `list_types`,
`ingest`, `delete_node`, `delete_edge`, `get_node`, `project_nodes`, `search`,
`traverse`, `neighborhood`, `revision` — with the same admission limits and the
same `CanonicalError` taxonomy. Types live in `graph_storage_sdk::models`.

Three consumers in this repository show the pattern: `connectors/graph_sync.rs`
(a repository walked into `repository / directory / file / person` nodes, run
as a background task with a poll endpoint because embedding on write takes
longer than the gateway deadline for a few hundred files),
`artifact_ingest/graph_backend.rs` (issues, PRs, files, comments, commits) and
`gears_catalog/service.rs` (crates.io gears and versions). Each registers its
types on every write — cheap, because registration converges — and declares
its searchable and embeddable payload paths in the type schema.

## 4. Embeddings

**One provider per deployment.** The gear computes every vector — for nodes on
write and for queries on search — with the provider selected in configuration,
so all vectors in a graph are comparable by construction:

| `embedding_provider` | Implementation | Identity of the space |
| --- | --- | --- |
| `onnx` | `all-MiniLM-L6-v2` through ONNX Runtime, in-process (plugin `cf-gears-graph-storage-onnx-embedding-plugin`) | SHA-256 of the model and tokenizer bytes loaded |
| `remote` | an OpenAI-compatible `/embeddings` endpoint (plugin `cf-gears-graph-storage-remote-embedding-plugin`) | model name at endpoint host at width |
| `fake` | deterministic hash | fixed |

The space identity is recorded on first use. A later boot with a different
provider **does not** open a new space: it logs the mismatch and blocks the
vector arm until the graph is re-embedded, and every other path keeps working.
Re-embedding today means starting the graph database over; the model-change
lifecycle (backfill, cutover) is not built.

What is embedded for a node: its `name` plus the payload values at the paths
its type declares in `vector_search`, joined, capped at
`embedding_input_max_bytes` (8 KiB). File *content* therefore reaches the
vector only through the bounded `text_excerpt` artifact-ingest stores.

## 5. Configuration (`config/*.yaml`, gear `graph-storage`)

```yaml
graph-storage:
  database: { server: "pg_graph", dbname: "graph_storage" }
  config:
    traversal_hop: pgq                # pgq | two_query
    embedding_dimension: 384          # fixed at migration time
    embedding_provider: "${STUDIO_EMBEDDING_PROVIDER:-onnx}"   # fake | onnx | remote
    embedding_model_path: "/app/models/minilm/model.onnx"
    embedding_tokenizer_path: "/app/models/minilm/tokenizer.json"
    embedding_remote_base_url: "${STUDIO_EMBED_BASE_URL:-https://api.openai.com/v1}"
    embedding_remote_model: "${STUDIO_EMBED_MODEL:-text-embedding-3-small}"
    embedding_remote_api_key_env: "STUDIO_EMBED_API_KEY"   # the NAME of the variable
```

The ONNX runtime library ships in the backend image (`ORT_DYLIB_PATH`); the
model artifacts are deployment data — the compose `embedding-model` service and
the Helm init container fetch them, pinned by SHA-256. The remote credential is
read from the process environment by name and never enters the configuration.

## 6. What is still missing

Recorded in the gear's `dev/DEVIATIONS.md`; the ones a consumer here meets:

- **Payload attributes are not filterable** in the projection: `$filter` on
  `payload/...` is refused. The `index` trait is stored but not wired to the
  filter surface (platform limitation in the OData binding).
- **No egress policy for the remote provider.** Selecting `remote` sends every
  tenant's node text and query text to the one configured endpoint; ADR-0004's
  per-tenant default-deny policy is not built.
- **No re-embedding lifecycle.** A provider or model change blocks the vector
  arm; recovery is manual.
- **Scope replacement removes nothing.** `replace_scope` fences generations but
  does not delete stale rows; re-syncs converge on keys instead.
- **No readiness endpoint** reporting the active embedding space and the SQL/PGQ
  capability; both are in the boot log only.
- **No labels, chunks or change events** yet; the shapes leave room for them.
