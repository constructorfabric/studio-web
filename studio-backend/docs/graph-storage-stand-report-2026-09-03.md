# Graph Storage — integration as a dependency, and what the stand found

Date: 2026-09-03 · Branches: studio-web `feature/graph-storage-gear-dependency`,
gears-rust fork `feature/graph-storage-v2` (tag `cf-gears-graph-storage-v0.1.0`)

## What changed

**The gear is a dependency, not a copy.** `src/graph_storage` (vendored v1), the
vendoring script and the ONNX shim are gone. `cf-gears-graph-storage` and its SDK
are git dependencies linked in `registered_gears.rs` like every other gear;
consumers reach it through `graph_storage_sdk::GraphStorageClientV1` from the
ClientHub. Until the gear is on gears-rust `main` (it needs PR #4639's SQL/PGQ
layer) it comes from the fork at a release tag, and a `[patch]` block moves every
other gears-rust crate to the same tag so one toolkit is linked. `Cargo.toml`
says how to undo that.

**The gear got its second embedding provider.** Beside the in-process ONNX
default there is now `remote-embedding-plugin` (OpenAI-compatible `/embeddings`);
`fake` stays for tests. One provider per deployment, selected by
`STUDIO_EMBEDDING_PROVIDER` (`onnx` default). The ONNX runtime library ships in
the backend images; the MiniLM model is deployment data fetched by the compose
`embedding-model` service and the Helm init container, pinned by SHA-256.

**Consumers moved to the v2 API.** artifact-ingest, the gears catalogue and the
repository importer declare family-derived types with `full_text_search` /
`vector_search` traits, send payloads only (the gear composes search text and
computes vectors), and use `project_nodes` / `search(mode)` / `traverse` /
`neighborhood`. The producer-side embedder (`artifact_ingest/embed.rs`) is
removed; file content reaches search through a bounded `text_excerpt`.

## What the stand proved (compose, ONNX provider inside the container)

| Check | Result |
| --- | --- |
| Boot | `loaded the in-process ONNX embedding provider model=model.onnx@sha256:6fd5d72f…`, `embedding space active epoch=1`, `pgq_available=true`; artifact-ingest and gears-catalog attach to the gear |
| Import `constructorfabric/insight` (800 entries) | 824 nodes (616 files, 184 directories, 23 persons, 1 repository), 823 edges (800 contains, 23 contributed_to) |
| Integrity (SQL) | 0 dangling edges, 0 files without an incoming edge, 824/824 nodes with a current vector, 17 types (9 base + 8 producer) |
| Convergence | third sync: `nodes_upserted 0, edges_upserted 0`, revision unchanged |
| Traversal | depth 1: 48 nodes / 47 edges; depth 2: 77 / 76; edge-pattern filter returns the 23 contributors; 0 two-query fallbacks — every hop ran as SQL/PGQ |
| Direct SQL/PGQ | `GRAPH_TABLE (kb MATCH …)` one hop from the repository: 24 rows |
| Semantic search | "how the service is deployed to kubernetes" → `service.yaml`, `deployment.yaml`; "license terms" → `LICENSE`; "unit tests for the parser" → `tests` |
| Second consumer | artifact-ingest stored 845 issues and answers hybrid search over them semantically |
| Third consumer | gears-catalog: 75 gears, 754 versions, 754 `has_version` edges from crates.io |
| Provider switch guard | see the last section |

## Problems found

### Blocking or fixed on the way

1. **gears-rust `main` refuses studio-web's own GTS types.** Since the gts 0.12
   upgrade (2026-08-28) a derived Type Schema must be *included in* its base, and
   account-management's `tenant_type` / `tenant_metadata` envelopes became closed
   roots with an open `payload`. All ten studio types registered as free-form
   `type: object` failed at boot: *"Ready commit failed with 10 errors"*. This is
   independent of graph-storage — any move of studio-web past gears-rust
   `f8f446e` hits it. **Fixed** by composing each derived type with
   `allOf: [{$ref: base}]` in every config profile (the shape gears-rust's own e2e
   config uses). The YAML comments still cite "gears issue #4"; that upstream fix
   has landed and the comments are stale.
2. **`gts` crate version split.** studio-web pinned `gts = 0.11`, gears-rust
   `main` 0.12 → two `gts` crates, trait-bound errors inside the toolkit. Bumped.
3. **A `[patch]` to another git URL does not replace already-locked entries.**
   37 `cf-gears-*` packages stayed on upstream `main` in `Cargo.lock` until each
   was `cargo update -p name@version`; two toolkits in one binary do not build.
4. **The gear could not have been packaged.** `include_str!("../../../docs/schemas/…")`
   reached outside the crate; schemas moved into it (gears-rust D-026).
5. **Five-token type id.** The catalogue's edge type
   `cf.studio.catalog.rel.has_version.v1~` was accepted by the v1 gear (it interned
   strings) and refused by v2 (GTS grammar: four name tokens). Renamed; a unit test
   guards every catalogue leaf.
6. **Page size above the gear's cap.** Both consumers paged the projection with
   `$top=500`; the gear's `projection_max_page` is 200 and it refuses rather than
   clamps → `GET /gears` and `GET /edges` answered a bare 500. Pages are 200 now.
   The consumer's error mapping hid the cause until the log was read.
7. **Stale local `studio-graph-postgres` image** (built before the Dockerfile
   gained its entrypoint): `compose up graph-postgres` ran `bash` and exited 0 with
   no log line. Rebuilt. Compose cannot tell a stale image from a current one.
8. **BusyBox `sha256sum` has no `--status`**: the model fetch failed in
   `curlimages/curl`. Digest string comparison now, in compose and Helm.
9. **The single-PostgreSQL migration left the old data behind.** The PG19 volume
   had every database but no tables in `studio_account_management`; the tenants
   and the GitHub connection with its PAT live in the retired PG16 volume
   `studio_studio_pg_data`. The stand was effectively fresh; a connection was
   recreated through the connector API.

### Found by the real-data run, still open

10. **Synchronous import exceeds the gateway deadline.** The first graph-sync of
    an 800-entry repository answered `504 Deadline Exceeded` after 30 001 ms while
    the gear was still embedding; the handler was cancelled after the node batches
    and before any edge batch, leaving 824 nodes and 0 edges until the next run.
    Options: run graph-sync as a background task with a task id (artifact-ingest
    already works that way), raise the deadline for this route, or embed
    asynchronously.
11. **A no-op re-sync costs ~25 s.** `EmbeddingCoordinator::plan` embeds every
    node before comparing input hashes, so unchanged nodes are re-embedded on every
    sync (ONNX in this container: ~35–40 nodes/s). Gear gap, recorded as D-027.
12. **Lexical search misses identifiers in file names.** PostgreSQL's parser
    emits `README.md` and `rust-watch.Dockerfile` as single `file` tokens:
    `Dockerfile` matches, `README` and `rust` do not. Gear gap, D-028.
13. **artifact-ingest edges are flushed last.** GitHub answered 502 on the
    pull-request page (transient), the task failed, and the 845 stored issues have
    no edges — the relations are written only after every source succeeded.
14. **Remote provider without an egress policy** (gears-rust D-025): selecting
    `remote` sends every tenant's node and query text to the one configured
    endpoint; ADR-0004's per-tenant policy is not built. Prototype posture.
15. **Not verifiable here:** the gear's PostgreSQL conformance lane needs an image
    with the official `docker-entrypoint`; the CNPG-based `studio-graph-postgres`
    is not one (D-003 stays open). The remote provider was tested against a mock
    endpoint only; a live run needs `STUDIO_EMBED_API_KEY` in `.env`.
16. **Stale documentation**: `docs/gear-intelligence-sync.md` says the Kubernetes
    release runs without graph-storage — `release.yml` builds `--features graph`
    and Deploy Infra provisions the graph PostgreSQL.

## Provider switch guard

Restarted the backend with `STUDIO_EMBEDDING_PROVIDER=fake` over the graph the
ONNX provider had embedded, then back.

- Boot logged `stored vectors belong to a different embedding space than the
  configured provider; vector search is blocked until the graph is re-embedded
  recorded_epoch=1 recorded_identity=f6903c4d…` and started normally.
- `mode: vector` and `mode: hybrid` → `400 Failed Precondition` with the
  `embedding_space` violation; `mode: lexical` answered; traversal answered
  (48 nodes); ingest of a probe node succeeded and stored it **without** a vector
  (`has_vector = f`, no epoch) rather than failing the batch.
- Back on `onnx`: the same space (`epoch=1`, identity `f6903c4d…`) became active
  again and vector search answered as before (`license terms` → `LICENSE`).

The failure ADR-0004 exists to prevent — ranking across two models — is caught
at boot, confined to the vector arm, and reversible.

## Still to do

- Live `remote` run once a key is in `.env` (`STUDIO_EMBEDDING_PROVIDER=remote`).
- Upstream: gears-rust PR for the gear once #4639 merges (remove `publish = false`,
  release-plz publishes); then studio-web drops the `[patch]` block.
- Make graph-sync asynchronous or long-deadline (finding 10).
- Push the studio-web branch and open the PR.
