# studio-backend — notes for agents

Rules that live nowhere in the type system, each learned from a real
regression. Read them before changing a gear.

## Reading the artifact graph: never `list()` and then filter

graph-storage's projection cannot filter or order on payload fields
(`docs/graph-storage-requests.md` §5), and `scope`, `repo` and `updated_at` are
all payload fields. So `GraphStore::list()` walks the tenant's **whole** typed
node set in pages of 200, one after another. On studio-dev (2026-09-25) that
was 24–33 thousand nodes and **12–20 s per call**, which put `/nodes`,
`/source-activity`, `/spec-rows` and `/specs-per-source` over 10 s on the
product dashboard.

The fix is `studio_artifact_index`, a Postgres mirror of the graph
(`src/artifact_ingest/index.rs`, explained in `src/artifact_ingest/README.md`).
For it to work, every artifact read and write has to go through its API:

- **Read by scope** with `GraphStore::list_in_scope`, `count_in_scope`,
  `files_in_scope` or `page` (on the service: `list_in_scope` / `page_nodes`).
  Each is one indexed query. `list()` followed by `node_in_scope` is exactly
  the walk this replaced; use it only for a genuinely unscoped read, and say
  why in a comment.
- **Write only through `GraphStore`** (`upsert_nodes`, `delete_nodes`), never
  with `GraphStorageClientV1` directly. `IndexedGraphStore` updates the index
  in the same call, so a write that skips it leaves the index behind the
  graph, and the listings then show stale or missing artifacts.
- **A new write or delete path on `GraphStore`** also needs an override in
  `IndexedGraphStore`. When the index cannot follow a change, call `withdraw`
  (the tenant falls back to the graph and refills) rather than leaving it
  quietly wrong.
- **A new listing rule** (another filter, another sort) goes into
  `graph::page_of_nodes` and `ArtifactIndex::page` together. `index_tests.rs`
  checks the two against each other over a query matrix, so extend the matrix
  too.
- **The test to run** is `cargo test -- artifact_ingest::index`. It needs
  Docker, because the suite starts its own Postgres.

When graph-storage gains payload `$filter`/`$orderby`, delete the index rather
than keep two mirrors in step.

## Gear databases

- A gear with a `database:` section in one profile needs it in every profile,
  or an entry in `DATABASE_OMISSIONS` saying why not
  (`gts_inventory::tests::every_profile_gives_the_same_gears_a_database_or_records_why_not`).
- **PostgreSQL only.** No SQLite dialect and no SQLite-backed tests. Tests take
  a server from `crate::test_pg`. A suite that runs migrations uses
  `fresh_database`, not the shared DSN: two suites migrating the shared
  database at once collide on the `_test` history table.
- **Connection budget.** Each gear pool counts against `max_connections: 150`
  on pg_main, and two replicas must fit. Give a new gear `pool.max_conns: 2`
  unless it needs more, and update the arithmetic in `config/k8s.yaml` and
  `deploy/k8s/cloudnative-pg/README.md`.

## Gates that pass when they should not

- A build through the Windows bind mount can reuse a stale binary. Run
  `touch` on the changed sources inside the container, and confirm the log
  says `Compiling cf-studio-backend` (clippy says `Checking`).
- Never pipe a gate through `tail` or `head`, because the exit code you see is
  theirs, not the gate's. Redirect to a file and grep it.
- `scripts/backend-check.sh` exits 0 even on failure. Judge it by its output.
- After adding or renaming a route, `cargo test api_contract` is the gate.
  `studio-backend api-contract --violations` exits 0 either way.

## Finding what is slow

The product dashboard is `monitoring.cfabric.org/d/studio-product` (Grafana,
behind a login). The same numbers come straight from VictoriaMetrics:

```
kubectl --context webstudio -n studio-monitoring port-forward svc/vm-victoria-metrics-single-server 18428:8428
# p95 per route over 24h
histogram_quantile(0.95, sum by (http_route, le) (rate(http_server_request_duration_seconds_bucket{env="dev"}[24h])))
```

The highest bucket is 10 s, so a p95 of `10` means "10 s or more". To find
out why a route is slow, read the backend log:
`kubectl --context webstudio -n studio-dev logs deploy/studio-studio-web-backend`.
For example, `projection walked nodes=… pages=… elapsed_ms=…` is a graph walk.
