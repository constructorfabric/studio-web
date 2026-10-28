---
type: adr
status: proposed
date: 2026-10-26
---

# ADR-0051: Domain objects are read from a Postgres mirror of the graph, and the domain query compiles to SQL over it

**ID**: `cpt-studio-adr-domain-read-model`

Status: **proposed** · Date: 2026-10-26 · Extends ADR-0024 (the domain model lives in Graph Storage), ADR-0035 (domain object access) and ADR-0037 (one node type and one owner per concept) · Follows `docs/domain-query-migration.md`

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. The gear gets two tables](#1-the-gear-gets-two-tables)
  - [2. One write path keeps them in step](#2-one-write-path-keeps-them-in-step)
  - [3. The query compiles to SQL](#3-the-query-compiles-to-sql)
  - [4. Access becomes a predicate](#4-access-becomes-a-predicate)
  - [5. What the query language gains](#5-what-the-query-language-gains)
  - [6. Objects arrive in batches, and connectors write model types](#6-objects-arrive-in-batches-and-connectors-write-model-types)
  - [7. Screens move to the query](#7-screens-move-to-the-query)
  - [8. Documents and process move into the model](#8-documents-and-process-move-into-the-model)
  - [8a. Where a gear keeps a kind of data is a setting](#8a-where-a-gear-keeps-a-kind-of-data-is-a-setting)
  - [9. Graph-storage requests stay open](#9-graph-storage-requests-stay-open)
- [What changes compared with today](#what-changes-compared-with-today)
- [Phases](#phases)
- [Consequences](#consequences)
- [Confirmation](#confirmation)
- [More Information](#more-information)

<!-- /toc -->

## Context and Problem Statement

The target is a Studio that starts with only its core (organizations,
workspaces and projects in account-management; people and memberships in
studio-user; roles in `access.config` and the PDP; secrets in credstore) and
gets everything else from a domain model that is loaded, not coded: types,
fields and relations in the model, objects in Graph Storage, and one query the
frontend writes the way it would write a Hasura query.

Half of it exists. ADR-0024 put the model and its objects in Graph Storage
(140 `domain.*` types, 5 `domainrel.*` edge types, 1,314 properties of which
339 are relations). `POST /studio-domain-model/v1/query` (#641) takes
Hasura-style `where`, `order_by`, `fields`, `limit`/`offset` and nested
`include`, checks every name against the model, and asks the PDP before it
counts. The portal has generated types for it (`domain-model.gen.ts`).

What it runs on does not scale:

- `query.rs` reads at most `SCAN_LIMIT` = 5,000 objects of a type through
  `project_nodes` in pages of 200, then filters, orders, counts and pages in
  the gear's memory. Past 5,000 the answer says `complete: false`.
- Domain types declare no payload index, because graph-storage fixes a type's
  indexes at its first registration and the in-process client cannot update a
  type (`docs/upstream/graph-storage-requests.md`, item 8). On the 2026-09-27
  load stand, a payload filter answered at p50 733 ms with 32 clients; the
  same filter with an index, 68 ms.
- The projection has no count and no offset (item 5); adjacency is capped at
  1,000 and traversal at 10,000 without paging (item 6); a traversal has no
  direction (item 9) and an edge does not say which declared relation it is
  (item 10). So a relation is read forwards only, and two relations of one
  verb come back mixed, reported in `warnings`.
- Writes are last-writer-wins (item 2), deletes leave a permanent tombstone
  (item 4), and concurrent writers on overlapping keys deadlock under load
  (`docs/inbox/graph-storage-integration-3/03-load.md` §5.3).
- Objects arrive one at a time through `POST /objects`; the only writers are
  saved views, the reports mirror and studio-user.

Artifacts hit the same wall first: a scoped listing walked 28,717 nodes in
12–20 s on studio-dev, and `studio_artifact_index`, a Postgres mirror written
in the same call as the graph, fixed it (`studio-backend/AGENTS.md`).

How should the domain query answer at any size, follow relations both ways,
count and group, and keep the frontend's contract unchanged?

## Considered Options

1. **The graph stays the source of truth; a Postgres mirror answers reads.**
   The domain gear writes the graph and the mirror in one call, as
   `IndexedGraphStore` does for artifacts, and the query compiles to SQL over
   the mirror.
2. **Postgres becomes the source of truth; the graph becomes a projection.**
   Objects live in Postgres rows with a jsonb payload, and the graph receives
   what search and deep traversal need.
3. **Wait for graph-storage** to close items 2, 4, 5, 6, 8, 9 and 10, and
   keep the in-memory query until then.
4. **Put a GraphQL engine in front** (Hasura itself, or a GraphQL server
   generated from the model).

## Decision Outcome

Chosen option: **1**, with the mirror shaped so that option 2 stays one
decision away.

Option 1 changes no earlier decision and repeats a mechanism already proven on
artifacts. Option 2 would give transactions, versions, real deletes and
row-level access, but it reverses ADR-0024 and should be decided on
measurements this ADR produces. Option 3 has no date. Option 4 changes the
syntax, not the executor: a GraphQL layer over the same graph has the same
limits, and a model that changes at runtime per organization means a schema
regenerated per change. A GraphQL adapter can be added later over the same
planner if an external consumer needs one.

### 1. The gear gets two tables

`studio-domain-model` gets a database (a `database:` section in every profile,
`pool.max_conns: 2`) and two tables:

- `studio_domain_objects`: tenant, owner tenant (the project when the object
  has one, the organization otherwise), type id, key, `payload jsonb`,
  `version`, `updated_at`. Indexes: `(tenant, type, owner)`, a GIN index on
  `payload`.
- `studio_domain_edges`: tenant, `src`, `dst`, edge type id and the **declared
  relation name** (`project.tracks`). Indexes on `(tenant, src, relation)` and
  `(tenant, dst, relation)`.

The payload is open, so a field added to a type needs no migration. The
relation name answers item 10 here, and the `dst` index answers item 9.

### 2. One write path keeps them in step

Every domain write goes through `DomainStore`: `POST /objects`, the reports
mirror, saved views and studio-user. An `IndexedDomainStore` writes the mirror
in the same call. When it cannot follow a change it withdraws the tenant's
mirror: reads fall back to the graph and a fill task refills it, exactly as
`studio_artifact_index` does. A new write path on `DomainStore` needs an
override in `IndexedDomainStore`, the same rule `studio-backend/AGENTS.md`
states for artifacts.

### 3. The query compiles to SQL

`query.rs` keeps its request, its validation against the model and its
response, and gets a second executor:

- `where` becomes jsonb predicates, cast by the field's type in the model
  (number, timestamp, enum, text);
- `order_by`, `total` and `offset` run in Postgres;
- each `include` is one statement per relation and level
  (`src = ANY($1) AND relation = $2`, joined to the objects);
- `SCAN_LIMIT` goes, and `complete` is always true on this path.

While a tenant's mirror is filling, the in-memory executor answers. A test
runs a query matrix through both executors over the same seed and compares
the answers, as `index_tests.rs` does for artifacts.

### 4. Access becomes a predicate

`access.rs` already turns the PDP's answer into constraints on
`owner_tenant_id`. On the SQL path the few owners that have objects of the
type are asked once each, and the admitted ones become `owner_id IN (…)` in
the root statement before `count(*)`; every `include` level still drops what
the caller may not read, so a relation cannot carry a caller to an object
they may not read (ADR-0035 §5). Evaluation still fails closed.

### 5. What the query language gains

Cheap on SQL, and kept in the graph executor too so the two answer alike:

- **Reverse relations**: `include: { "~tracks": { … } }` reads the edges by
  `dst`. Every edge carries its declared relation's name as its
  discriminator, so a relation never answers for another of the same verb.
- **Aggregates**: `aggregate: { group_by: ["status"] }`, so a summary screen
  is a query, not a new route.
- **Optimistic writes**: `if_version`, answering 409 when the object moved on,
  instead of the graph's silent last-writer-wins.

### 6. Objects arrive in batches, and connectors write model types

- `POST /mutate` takes up to 500 upserts, patches, deletes, links and
  unlinks, applied in order, an object created in the batch named with `as`
  and referred to as `$name`. A delete marks the object (`_deleted`), because
  graph-storage never lets a deleted node's key be written again.
- Connectors write model types (`repository`, `commit`, `pull-request`)
  instead of `artifact.*`, which is ADR-0037's one-type-per-concept step.
  When the last `artifact.*` writer has moved, `studio_artifact_index` is
  retired into this mirror.

### 7. Screens move to the query

The portal still reads `GET /objects`, `/objects/graph` and `/model/graph`
(`api.ts`, `App.tsx`, `domain-model-graph.tsx`). Screens move one at a time;
the old routes are marked deprecated and removed after the last caller.

### 8. Documents and process move into the model

The `documents` gear keeps 18 tables. They move one concept at a time with a
dual read, per `docs/domain-query-migration.md`: first those the model already
has a type for (Review Request, Approval, Decision), then document types and
stages. Each move is its own decision; this ADR only makes it possible.

### 8a. Where a gear keeps a kind of data is a setting

A gear whose records can live in the model chooses per kind of data, in its
own configuration: `model` keeps them as domain objects, `tables` in its
database. The first is `studio-documents`' process catalogue
(`gears.studio-documents.config.storage.process`, `documents/process_store.rs`):
stages are `lifecycle-stage` objects and capabilities `capability` objects,
scoped to the organization or workspace that owns them, and the gear makes sure
the model has both types and their fields (`port::DomainObjects::ensure_type`,
additive only). Switching a kind to `model` moves it: the first read of an
owner copies its rows into the model and then deletes them, so an interrupted
move re-copies rather than loses or doubles anything. The overlay of built-ins,
organization and workspace stays in the gear, which reads the same row shapes
from either strategy. Each further kind follows the same pattern.

The kinds that follow it, each a setting of its own gear:

| Setting | What moves | Model types |
|---|---|---|
| `studio-documents … storage.reviews` | Review requests, verdicts, decisions | `review-request`, `approval`, `decision` |
| `studio-documents … storage.documents` | Documents, repository-file bindings, detector verdicts, the spec model's readings and members' decisions on them, application parts, delivery scopes and their limits and history, document types | `studio-document`, `document-binding`, `document-analysis`, `spec-extraction`, `spec-judgement`, `fact-review`, `finding-decision`, `glossary-decision`, `application-part`, `delivery-scope`, `delivery-limit`, `delivery-scope-version`, `document-type` |
| `studio-artifact-ingest … storage.artifacts` | Synced repositories, files, issues, pull requests, commits, CI runs, builds, releases and their relations | `repository`, `repository-file`, `work-item`, `pull-request`, `commit`, `ci-run`, … |
| `studio-components-catalog … storage.publication_requests` | The platform's gear-publication queue | `approval-request` |
| `studio-components-catalog … storage.catalog` | Gears, versions, profiles, kits, FrontX packages, field schemas, snapshots, roadmap items, sources, the registry (entries, occurrences, reads, settings, decisions) | `gear`, `gear-version`, `gear-profile`, `registry-entry`, … (`catalog_graph/model_sink.rs`) |
| `studio-product … storage.catalog` | A project's gear repository and product | `project-gear-repository`, `project-product` |
| `studio-environments … storage.metadata` | Environments, a project's bindings and config secrets (values stay in credstore), deployments | `deployment-environment`, `environment-binding`, `environment-config-secret`, `deployment` |
| `studio-usage … storage.metadata` | Prices, budgets | `model-price`, `budget` |
| `studio-kits … storage.metadata` | A project's kit installations | `kit-installation` |
| `studio-product … storage.metadata` | Gear explanations | `gear-explanation` |
| `studio-connector … storage.metadata` | Connections (tokens stay in credstore) | `connector-connection` |
| `studio-organizations … storage.metadata` | Project types, now behind `/studio-organizations/v1/project-types` instead of the portal writing account-management | `project-type` |
| `studio-reports … storage.sources` | Report sources (plans kept compressed) | `report-source` |

Documents a gear kept as one account-management metadata row per tenant go
through one client in front of account-management (`model_metadata.rs`):
each record of the row's list is an object of its own, the row's settings and
version sit on a `tenant-document`, `expected_version` is still answered with
409, `resolve_metadata` still walks the ancestors, and the first read of a
tenant copies the row in. The gear's code is unchanged.

**Kept by the gear.** Every type above is `held_by` the gear that writes it
(`meta.held_by` on the type, set through `TypeNeed::held_by`): `/objects`,
`/mutate` and relating from such an object answer 403
`DOMAIN_OBJECT_HELD_BY_GEAR`, so a record changes only through its gear's rules.
Members' own kinds that a gear also writes (work items, comments, findings,
decisions, capabilities, stages) stay open. A gear acting as itself (a
`service` subject minted in the process, with no bearer token) is tenant-scoped
only, as when it alone wrote the account-management rows; people are asked of
the PDP (`domain.view`, `domain.edit`).

**Nothing is kept twice.** Every move drops what it moved from: the documents
gear's rows, the reviews' rows, a tenant document's account-management row
(marked `legacy` on its `tenant-document` until a writer who may drop it
does), the catalogue's graph nodes (retired behind the call), the artifact
graph's nodes and their index rows. Report sources stay: one graph node per
report, and graph-storage has no delete.

**The model can change, and the screens follow.**

- *Live.* Every object write publishes `domain.objects_changed` (the type,
  the ids) and every model version `domain.model_changed` on studio-events
  (`domain_model/events.rs`). The portal holds one subscription
  (`domain-live.ts`): it re-reads the model on a model change, and every
  screen whose data lives in a type — the gears' screens included — reads
  again when that type changes (`useDomainRefresh`). A sync, another
  person's edit or an administrator's new field shows without a reload.
- *Extensible.* A gear's type takes fields beside the gear's own: the gear's
  fields are marked `held_by` on the type and cannot be renamed, retyped or
  dropped, nor set through `/objects` or `/mutate`; the added ones can, and a
  gear's next write of the record keeps them (the trusted write merges over
  the stored payload). The gears' screens show them (`ModelFields`: an
  environment, a gear, a document), and the model editor marks the gear's
  fields 🔒.

**Found on the stand, and settled.**

- A gear takes a type in as one model version (`take_in`: fields, relations,
  hold), not one per field — the first touch of a tenant had recorded 156
  versions and taken 15 s.
- Gear writes are embedded by graph-storage in process; they go in batches of
  32, as the catalogue sink did, not 500.
- A revert or an import never removes a held type or field
  (`Ontology::keep_held_from`).
- The portal holds ONE studio-events connection per tab, shared by every
  subscriber: a stream per widget had used all six HTTP/1.1 connections a
  browser keeps per host. And when the stream (re)opens, every screen reads
  once more, so a change made before it was open is not missed.

**Settled before the first deploy.**

- *Never one-way.* Setting a kind back (`tables`, `metadata`, `graph`) moves
  what the model holds back where it came from on first touch — documents,
  reviews and process entries into their tables, tenant documents into
  account-management, the catalogue, artifacts and report sources into the
  graph store — and the model keeps no copy. Setting it to `model` again
  moves them in again. Round-tripped on the stand.
- *Moved at start.* `model_sweep.rs`: 20 s after start every replica walks
  the tenant tree once, as the gears themselves, and makes each tenant ready,
  so the first person in an organization does not wait for its move.
- *The organization's model.* A gear's records live in the model of the
  organization that owns them (`org_scope::in_org_of`), not of the caller's
  home tenant: a platform administrator or a member of two organizations
  reads and writes the same records as everyone else. The domain-model routes
  and the event stream take `?organization_id=`, and the portal sends it.
- *Rights.* A role that may see or change any gear's records carries
  `domain.view` or `domain.edit` by implication (`access_config::carries`),
  so a custom role written before the move does not meet empty screens; the
  gear and the scope still decide which records.
- *Concurrent writers.* A tenant document's next version is claimed as a node
  that can be created once: of two writers on any replica one gets it, the
  other gets 409 and retries. A claim left by a failed or dead writer is
  skipped, never reused. Merging upserts of one row take turns in-process.
- *Events name no object.* `domain.objects_changed` carries the type and a
  count, not ids.
- *Embeddings where they are searched.* A held type is embedded only when it
  says it is searched (documents, gears, kits, registry entries, artifacts);
  deployments, budgets, prices and the like are written without vectors.
- *Report sources* are deleted from the graph store once moved.
- *Replicas.* An object path rechecks the stored model head at most every
  10 s, so another replica's edit is seen without a restart.

**What stays where it is.** The core: organizations, workspaces and projects
as account-management tenants with their own settings (`project.config`,
`workspace.settings`), people, roles and the access config, secrets in
credstore, the organization's logo. Durable runs (`studio-tasks`), schedules,
the event log, the read model's own tables, and the in-memory presence. The
repository import into graph-storage (`studio-connector`'s `graph_sync`) is a
search index over files, not records; repositories and files are already
model objects through the artifact sync.

Two rules come with the documents gear's tables (`documents/model_table.rs`):

- **Size.** Graph-storage refuses a payload over 64 KiB. A row larger than
  that has its longest fields cut into `text-chunk` objects and joined on
  read, so a long document is still one object to the gear. Artifact payloads
  are bounded the way the graph always bounded them: file content becomes an
  excerpt.
- **Moving leaves no copy.** An owner moves whole (every table at once, so no
  cascade removes a row before it is moved), a `sync-state` marker records it,
  and its rows are dropped from the tables. A caller who may read but not write (or not add a type) reads
  the table until someone who may has moved it; after the move a failure is
  an error, never a quiet read of the stale table. Dates are written with all
  nine fractional digits, so the query's string order is time order.

### 9. Graph-storage requests stay open

Items 2, 4, 5, 6, 8, 9 and 10 stay filed. When one closes, the part of the
mirror it replaces is deleted, not kept in step. One consumer list of what
the mirror waits for is constructorfabric/gears-rust#5529; offset pages are
not among them (the platform pages by cursor), so `/query` moves to cursors.

## What changes compared with today

| Concern | Today | After this ADR |
|---|---|---|
| Where a read is answered | The gear reads the graph and filters in memory | Postgres answers by index; the graph answers search and deep traversal |
| Size | 5,000 objects of a type, then `complete: false` | No cap; `complete` always true |
| Filter and order | In memory, over what was read | SQL with casts from the model |
| Count, pages | Over the first 5,000 | `count(*)`; pages by cursor (`OFFSET` while screens move) |
| Relations | Forwards only; one verb mixes relations (`warnings`) | Both directions; the relation name separates them |
| Aggregates | None | `count` and `group_by` |
| Access | PDP answer applied to rows in memory | PDP answer as a SQL predicate, at every level |
| Concurrent writes | Last writer wins, silently | `if_version`, 409 on conflict |
| Loading | One object per call | Batches of up to 1,000; connectors write model types |
| Mirrors | `studio_artifact_index` for artifacts only | One mirror for every graph-backed object |
| Frontend contract | `POST /query`, generated types | Unchanged, plus `~relation` and `aggregate` |

## Phases

| Phase | What | Sections |
|---|---|---|
| 0 | Measure: objects per type on Dev; `/query` latency and the share of `complete: false` | — |
| 1 | Tables, `IndexedDomainStore`, the fill task, the SQL executor, the comparison test | 1, 2, 3 |
| 2 | Access as a predicate; reverse relations, aggregates, `if_version` | 4, 5 |
| 3 | `POST /objects:batch`; connectors write model types; the artifact mirror retires | 6 |
| 4 | Screens move to the query; old routes removed | 7 |
| 5 | Documents and process, one concept per decision | 8 |

What is built (2026-10-26, branch `AndrejK666/domain-read-model`):

- Phase 1: the tables, `IndexedDomainStore`, the fill, the SQL executor
  (`query/sql.rs`) and `mirror_tests.rs`, which asks both executors the same
  questions over the same objects.
- Phase 2 without `if_version`: access as a predicate, reverse relations
  (`~name`, in both executors), aggregates (`group_by`, in both).
- Phase 3's batch write as `POST /mutate`, and the portal's saved views write
  through it. Connectors still write `artifact.*`.
- Phase 4: the views editor offers reverse relations. The deprecated
  `GET /objects` stays until its removal date.
- The model is edited from the portal: Administration › Domain model adds
  types (`POST /types`) and adds, renames, retypes and drops fields, and the
  portal reads the live model (`domain-runtime.ts`) instead of the build's
  generated tables, so an added field shows at once. Projects and workspaces
  show an Attributes card drawn from their model type (`object-attributes.tsx`:
  the type's object keyed `self` in the tenant's scope), and Project ›
  Timeline is built on `milestone` objects alone.
- Phase 5 by §8a: the process catalogue, reviews, the documents gear's
  records, synced artifacts and the publication queue move into the model by
  configuration, and every shipped configuration sets `model`.
- The catalogue, a project's product, environments and deployments, prices
  and budgets, kit installations, explanations, connections, project types
  and report sources follow (§8a), every type kept by its gear.
- Cursors (§9, 2026-10-28): an answer with more rows carries `next_cursor`,
  the last row's sort values and id bound to the query's type, scope, `where`
  and `order_by`; `cursor` reads on from it in both executors, as a keyset
  condition in SQL. A cursor from one executor reads on in the other.
  `offset` stays while screens move; saved views ask the next page by cursor
  and jump by offset only to a page not read yet (`PageCursors`).
- Not built: phase 0's measurement, `if_version`; the version check of a
  tenant document is two steps, not one transaction.

## Consequences

- Good: the domain query answers at any size with the contract the frontend
  already has, and a new list or summary screen needs no backend change.
- Good: reverse relations, aggregates and conflict-safe writes become
  possible.
- Good: one mirror instead of one per gear once artifacts move.
- Bad: every domain write costs a second write, and the mirror can fall
  behind; withdraw-and-refill bounds the damage but does not remove it.
- Bad: one more gear database against the `max_connections` budget.
- Bad: two executors live side by side until every tenant's mirror is filled.

## Confirmation

- The comparison test passes over the query matrix, both executors.
- On Dev after phase 1, `/query` p95 stays under 300 ms for a type of 40,000
  objects, and `complete: false` no longer occurs.
- `cargo test -- domain_model` with Docker; the gate in `studio-backend/AGENTS.md`.

## More Information

- The query today: `studio-backend/src/domain_model/query.rs`, `rest.rs`,
  `store.rs`, `access.rs`; the portal side: `domain-query.ts`,
  `domain-model.gen.ts`, `views.tsx`.
- The artifact mirror this repeats: `studio-backend/src/artifact_ingest/index.rs`,
  `docs/design/studio-artifact-ingest.md`.
- Graph-storage limits and measurements: `docs/upstream/graph-storage-requests.md`,
  `docs/inbox/graph-storage-integration-3/`.
