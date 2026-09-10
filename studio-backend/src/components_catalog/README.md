# studio-components-catalog

Catalogues *our own gears* — every crate published under the
`constructorfabric` keyword on crates.io — in the knowledge graph, and
scaffolds new ones into a project's repository.

## Why it exists

The platform is a set of gears, and the question "what gears are there, at what
versions" had no answer inside Studio: it lived on crates.io and in people's
heads. This gear makes it data. It lists every crate under the keyword, pulls
each crate's detail and version history from the public crates.io API, and
stores them as typed `gear` and `crate_version` nodes joined by `has_version`,
which the portal reads back.

Cataloguing led to the second half: once Studio knows what a gear looks like,
it can create one. `POST /projects/{id}/scaffold` writes a gear skeleton into
the project's repository on a branch, optionally opening a pull request.

## What it owns

Graph nodes, and per-project metadata pointing at the repository gears are
scaffolded into. Sync progress is a `studio-tasks` run. Without the `graph`
feature it falls back to an in-memory store, so the catalogue still works.

## REST

| Method + path | Does |
|---|---|
| `POST /sync` → `GET /tasks/{id}` | refresh the catalogue from crates.io, then poll |
| `GET /components`, `GET /versions` | the catalogue itself |
| `GET /types`, `GET /types/counts` | graph types and how many objects each holds |
| `GET`/`PUT`/`DELETE /field-schemas[/{describes}]` | the shapes describing catalogue fields |
| `GET`/`POST /projects/{id}/gear-repo` | which repository a project's gears live in |
| `POST /projects/{id}/create-repo` | create that repository through the connector |
| `POST /projects/{id}/scaffold` | write a gear skeleton, optionally as a PR |

## In the assembly

- Gear `studio-components-catalog`, capabilities `[rest]`, deps
  `types_registry`, `account_management`, `credstore`.
- Config section `gears.studio-components-catalog`.
- Repository access is a connection from [`../connectors`](../connectors); the
  graph is the same one [`../artifact_ingest`](../artifact_ingest) writes to.
