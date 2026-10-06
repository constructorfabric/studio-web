# studio-artifact-ingest

Pulls issues, pull requests and files out of a connector source and puts them
into the knowledge graph as typed GTS nodes, so the rest of Studio can ask
questions about a repository instead of fetching it again.

The design — where the files come from, why the graph keeps no file text, why
listings read a Postgres mirror of the graph, how relations are read within
graph-storage's caps, the REST surface and the tables — is
[`docs/design/studio-artifact-ingest.md`](../../../docs/design/studio-artifact-ingest.md).
The rules for reading and writing the graph through the index are in
[`../../AGENTS.md`](../../AGENTS.md). This README is what you need to work in
the directory.

## In the assembly

- Gear `studio-artifact-ingest`, capabilities `[db, rest]`, deps
  `types_registry`, `credstore`.
- Config section `gears.studio-artifact-ingest`. Its `database:` block
  (`studio_artifact_index`) is optional: without it there is no index and
  every listing walks the graph, slower but otherwise the same.
- `traversal_max_nodes: 10000` must stay in every config profile's
  graph-storage block; the default 1,000 truncates a 400-seed traversal and
  drops relations without saying so.
- Sources and credentials come from [`../connectors`](../connectors); a sync is
  an `artifact.ingest` run on [`../tasks`](../tasks). Built without the
  `graph` feature, the gear falls back to an in-memory store so the portal
  still reads something back.

| variable | default | |
|---|---|---|
| `STUDIO_WORKSPACES_ROOT` | `~/.cf-studio-workspaces` | session checkouts, the first file channel |
| `STUDIO_ARTIFACT_WORKDIR` | unset | the gear's own shallow clones; unset turns that channel off |
| `STUDIO_ARTIFACT_LIST_CACHE_TTL_SECS` | `60` | graph-listing cache; `0` turns it off |
| `STUDIO_ARTIFACT_LIST_CACHE_MAX_NODES` | `40000` | cache budget across all tenants |

The `projection walked` log line carries the node count, the page count and
the elapsed time, so a cache budget is measured rather than guessed.

## Tests

- `cargo test -- artifact_ingest::index` checks the index against the
  in-process listing over a query matrix. It needs Docker: the suite starts its
  own Postgres. A new listing rule goes into `graph::page_of_nodes` and
  `ArtifactIndex::page` together, and into that matrix.
- `comment_threads.rs` tests pin the thread fold to the same answers as the
  IDE's `comment-log.js`; change the two together.
