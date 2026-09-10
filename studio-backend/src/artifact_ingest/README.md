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
