# studio-artifact-ingest

Pulls issues, pull requests and files out of a connector source and puts them
into the knowledge graph as typed GTS nodes, so the rest of Studio can ask
questions about a repository instead of fetching it again.

## Why it exists

A repository's meaning is spread across three places that answer different
questions: the provider's API knows the issues and pull requests, the checkout
knows the files, and neither knows how they relate. This gear normalizes all
three into one typed shape — `gts.cf.studio.artifact.*` instances with
deterministic ids — so a re-sync upserts rather than duplicates, and so a
consumer traverses one graph instead of three APIs.

## Where the files come from

Three channels, tried in order, because cloning a repository twice is a waste
of the disk that already holds it:

1. **The studio-session workspace checkout** — the IDE has already cloned it
   (`STUDIO_WORKSPACES_ROOT`), so the files are on disk.
2. **Our own shallow clone** — opt-in (`STUDIO_ARTIFACT_WORKDIR`), for when no
   session has run.
3. **The connector tree API** — metadata only, when there is no disk to use.

## Reading nodes back is a walk, not a query

`GET /nodes` narrows by `scope`, by `repo`, and orders by the artifact's own
`updated_at`. All three live in the node payload, and graph-storage's
projection can filter and order on `node_key`, `name`, `created_at` and
`updated_at` only — never on a payload path. So this gear pages the whole typed
node set into the process and narrows it here.

On studio-dev that is **28,717 nodes, 31 MB of payload, 144 sequential round
trips** for one request, and the endpoint's p95 is **8.06 s** — the slowest
surface in the product by a factor of five. The cost is linear in the size of
the project and has no ceiling.

A per-tenant cache of the projection makes a client's walk through its own
pages cost one graph walk instead of one per page. It is dropped the moment an
ingest is accepted, and expires after 60 s so that another replica's ingest
cannot be served stale for longer than that.

| variable | default | |
|---|---|---|
| `STUDIO_ARTIFACT_LIST_CACHE_TTL_SECS` | `60` | `0` turns the cache off |
| `STUDIO_ARTIFACT_LIST_CACHE_MAX_NODES` | `40000` | budget across all tenants |

The budget is in nodes rather than entries because entries differ by three
orders of magnitude, and it is deliberately about one default listing: the pod
has a 1 GiB limit against a ~500 MiB working set, and a cached node is a parsed
`serde_json::Value`, several times the 1.1 KB its payload measures on disk. The
`projection walked` log line carries the node count, the page count and the
elapsed time, so the number to set is measured rather than guessed.

**This is a cache of a query we should have been able to write.** The real fix
is `$filter`/`$orderby` over the payload paths a type already declares in its
`index` trait — request 5 in [`../../docs/graph-storage-requests.md`](../../docs/graph-storage-requests.md),
which also records where in the platform that change lives.

## The artifact index: the query, written against our own table

Measured again on studio-dev on 2026-09-25, the cache was not enough: a walk
was 24–33 thousand nodes and **12–20 s**, and `/spec-rows` passed 10 s on half
its requests. The node listing and the file listing together are over the
cache budget, so each evicted the other and the Artifacts and Specs screens
paid for a walk nearly every time.

So the fields those reads narrow by are now columns of our own table
(`studio_artifact_index`, [`index.rs`](index.rs)): scope, repo, type, path and
`updated_at`, plus the payload a graph read would return. `/nodes` with a
`scope` is one `SELECT … LIMIT` with a `COUNT`; `/source-activity`,
`/activity`, `/edges?scope=`, the portfolio counts and the documents gear's
file list (`/spec-rows`, `/specs-per-source`) are one indexed query each. The
graph is still the source of truth and still serves search, relations and
unscoped listings.

- **Written** after every node upsert the graph accepts, in the same call, and
  **deleted** after every node a re-sync forgets (`delete_nodes`).
- **Filled** per tenant on its first read, in the background, from one walk of
  the graph; until `studio_artifact_index_fill` has the tenant's row, reads go
  to the graph exactly as before.
- **Withdrawn** when an index write fails after the graph took the batch:
  readers fall back to the graph and the next read refills.
- **Optional**: without the gear's `database:` section there is no index and
  nothing changes but speed.
- **Not file content.** A file's searchable excerpt is a `file_content` node of
  its own, joined to the file by `content_of`; search folds a hit on it back
  into the file. Nothing lists it (`gts::is_listed`), so it has no row here,
  and a file row is metadata only.

When request 5 lands in graph-storage this table becomes redundant, and the
thing to do is delete it rather than keep two mirrors in step.

## Reading relations back is bounded, and the bound is not a speed limit

`GET /edges` used to read one node per seed for its adjacency: **8,825 reads**
for one request on studio-dev. It was also wrong. A node read is capped at the
gear's `node_read_max_adjacency`, so every node whose degree exceeded it came
back clipped — **27,852 of 79,184 relations, 35%, dropped** with nothing in the
response to say so.

It is now one seeded traversal per 400 seeds — about **twenty calls** — with
`EdgeRef`s carrying explicit endpoints. The gear budgets a traversal by *total
nodes, seeds included*, so a batch that exhausts its budget is **halved and
re-read**, which finds the node that filled it in about `log2(400) ≈ 9` steps
and hands it the whole budget when it gets there. Retrying seed-by-seed instead
would cost 400 calls per fat node, and this graph has three.

| | relations unreachable |
|---|---|
| per-node read, adjacency 100 | 27,852 |
| traversal, budget 10,000 | 5,944 — three nodes |

The residual is **not ours to fix**. Neither call pages: `node_read_max_adjacency`
is validated to 1,000 and `traversal_max_nodes` to 10,000, and a node past that
has relations no sequence of calls will return. Request 6 in the same document
asks for a cursor over edges.

`traversal_max_nodes: 10000` is set in every config profile for this reason —
the default of 1,000 would truncate a 400-seed chunk immediately.

## What it owns

Nothing durable of its own. Nodes and edges belong to graph-storage; the sync's
progress belongs to `studio-tasks`. A build without the `graph` feature falls
back to an in-memory store so the portal still reads something back.

## REST

| Method + path | Does |
|---|---|
| `POST /sync` | queue an ingest run; returns a task id that is also a `studio-tasks` run id |
| `GET /tasks/{id}` | that run's state and counts |
| `GET /nodes`, `GET /edges` | read back what was ingested, optionally by type |
| `GET /repo-files` | the file side of the graph |
| `POST /search` | retrieval over the ingested artifacts |
| `POST /files`, `POST /quality` | ingest a file set directly; quality signals |

## In the assembly

- Gear `studio-artifact-ingest`, capabilities `[rest]`, deps `types_registry`,
  `credstore`.
- Config section `gears.studio-artifact-ingest`.
- Sources and credentials come from [`../connectors`](../connectors); long runs
  come from [`../tasks`](../tasks).

The module documentation in `mod.rs` is the authoritative description of the
normalization; this file is the orientation.
