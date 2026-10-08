---
type: adr
status: proposed
date: 2026-10-08
---

# ADR-0037: One model for a project: every fact has one owner, and the graph holds the links

**ID**: `cpt-studio-adr-one-model-for-a-project`

Status: proposed · 2026-10-08 · Builds on ADR-0013, ADR-0014 and ADR-0024 · Keeps the line [the domain-query migration](../domain-query-migration.md) draws between graph and relational data

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

A project is a set of documents, the repositories and files they live in, the
capabilities the documents ask for, the gears that provide them and the product
those gears are put together into. Every one of these is stored today. They are
stored by five gears, in two kinds of store, under different keys, and the only
thing that connects most of them is a string somebody copied.

### What is stored where

| Store | What it holds | Owning gear (code) | Who reads it |
|---|---|---|---|
| PostgreSQL database `studio_documents` | `studio_documents` (authored documents, with their text), `studio_document_bindings` (a repository file bound to a type), `studio_document_analyses` (a detector's gate verdict), and the vocabulary: `studio_document_types`, `studio_process_stages`, `studio_process_capabilities` | `studio-documents` (`studio-backend/src/documents/migrations.rs`) | its own REST; `studio-spec-mapping` through `documents::port::SpecNeeds`; `studio-spec-quality` writes verdicts through `documents::port::AnalysisRecorder` |
| graph-storage, `gts.cf.studio.artifact.*` | ten node types (`repo`, `issue`, `pull_request`, `file`, `user`, `spec_finding`, `comment`, `commit`, `file_content`, `mapping_decision`) and twelve edge types | `studio-artifact-ingest` (`src/artifact_ingest/gts.rs`) | its own REST; `studio-spec-quality` writes findings through `port::SpecFindingWriter`; `studio-spec-mapping` writes and reads decisions through `port::MappingDecisionStore`; the projects table through `port::ProjectSignalSource` |
| PostgreSQL database `studio_artifact_index` | `studio_artifact_index`, a mirror of the artifact nodes with their whole payload, and `studio_artifact_index_fill` | `studio-artifact-ingest` (`src/artifact_ingest/index.rs`) | every scoped artifact listing. It exists because graph-storage cannot filter, count or page on a payload field (`studio-backend/AGENTS.md`) |
| graph-storage, `gts.cf.studio.domain.*` and `domainrel.*` | the organization's model (139 entities in the seed, `src/domain_model/ontology.core.json`) and objects of those types | `studio-domain-model` (`src/domain_model/store.rs`) | the prototype's model screens and saved views; `studio-reports` writes `org-unit`, `team`, `person` and `membership` objects into it (`src/reports/mirror.rs`) |
| graph-storage, `gts.cf.studio.catalog.*` | `gear`, `crate_version`, `gear_profile`, `frontx`, `kit`, `roadmap_item`, `field_schema`, `component_snapshot`, and per project `project_gear_repo` and `project_product` | `studio-components-catalog`, through `CatalogSink` / `GraphSink` (`src/components_catalog/service.rs`) | its own REST; `studio-spec-mapping` through `components_catalog::port::ComponentCatalog` |
| graph-storage, `cf.studio.kg.*` | `project`, `repository`, `directory`, `file`, `person` | `studio-connector`, the `connector.graph_sync` task (`src/connectors/graph_sync.rs`) | nothing in either portal starts it; the prototype names the task type only in comments and a sample notification |

Two more records belong to the same project and are outside the five gears: the
project itself is an account-management tenant (ADR-0010), and its repositories
are the `sources[]` of its `project.config` setting (`src/project_sources.rs`).
The person behind a login is `identity_user` in `studio-user` (ADR-0025).

`studio-spec-mapping` (`src/spec_mapping/`) is the first gear that needs all of
this at once. It owns no data. It reads the documents' needs from
`studio-documents`, the gears from the catalogue, and keeps a member's decisions
as `mapping_decision` nodes in the artifact graph. That is the chain the product
is built on, document section → capability → gear, and it is the best place to
see what is missing.

### What that costs

**One thing, several types, no edge between them.**

| Concept | Where it is stored today |
|---|---|
| repository | `project.config` `sources[]`; `artifact.repo`; `kg.repository`; the domain entity `repository`; `catalog.project_gear_repo` |
| file | `artifact.file`; `kg.file` (with `kg.directory`); the domain entity `repository-file` |
| person | `identity_user`; `artifact.user`, one per scope, connection and login (`artifact_ingest/gts.rs`, `user_node`); `kg.person`; the domain `person` the reports mirror keys on `github:<login>` |
| project | the account-management tenant; `kg.project`; the domain entity `project` |
| document | a `studio_documents` row; a `studio_document_bindings` row plus its `artifact.file`; the domain entities `document` and `markdown-document` |
| gear | `catalog.gear`; the domain entity `gears` |

The domain model's entities for repositories, files, commits, pull requests,
documents and gears hold no objects that we know of: the only writers of domain
objects are the reports mirror and the saved views. So the domain query, which
is where [the migration](../domain-query-migration.md) is moving the portal's
reads, cannot see any of the data those entities describe. That data is in the
graph already, under other types.

**An authored document is not in the graph.** Only a bound file has a node. The
Spec Quality batch drops a duplicate pair unless both ends are graph nodes,
because "a Studio document has none" (`src/spec_quality/batch_task.rs`).
`MappingDecision::document_node` is optional for the same reason
(`src/artifact_ingest/service.rs`). Every graph question about a project's
specification is answered for the repository's files and silently not for the
documents written in Studio.

**References across stores are strings, and some are two kinds of string.**
- `studio_document_bindings.node_id` names an `artifact.file` node from
  PostgreSQL. Nothing notices when the node is retired.
- `MappingDecision.document` is a binding id *or* a Studio document id, two id
  spaces in one field.
- `MappingDecision.gear` is a catalogue name, and a project's product lists its
  gears as "crate names or engine ids" (`SaveProjectProductRequest` in
  `src/components_catalog/rest.rs`). Neither is an edge to the `catalog.gear`
  node, although `gear_instance_id(name)` (`src/components_catalog/gts.rs`)
  would give its id without a read.
- `studio_document_analyses.task_id` names a run in `studio-tasks`.

**The same fact is written twice, and each write may fail alone.** A Spec Quality
run writes a `spec_finding` node, then the gate verdict row; a failure of either
is logged and the run goes on (`batch_task.rs`). The documents service calls the
row "the INDEX a stage gate reads" and the full finding the graph's
(`record_binding_analysis` in `src/documents/service.rs`), but nothing rebuilds
the index from the graph. A saved roadmap plan is mirrored into the domain model
by a `tokio::spawn` whose failure is a log line (`mirror_in_background` in
`src/reports/rest.rs`).

**A projection that was decided was never built.** ADR-0014 §6 made the
vocabulary's graph projection (`rel.requires`, `rel.realizes`) derived state over
PostgreSQL. Its own status table says §6 is not started, and the edges are
fields that every caller joins by hand.

**Five gears hold a graph client and register their own types**:
`artifact_ingest`, `components_catalog`, `connectors`, `domain_model` and
`reports` each take `GraphStorageClientV1` from the ClientHub. The rule that a
write goes through one store so its mirror follows (`studio-backend/AGENTS.md`)
covers the artifact types only.

### What any answer has to live with

- **No write spans two stores.** Each gear has its own database (on Dev every
  one is a separate `dbname` on `pg_main`, `config/k8s.yaml`), and graph-storage
  has its own. A link between a row and a node is two writes, always.
- **graph-storage is not a relational store yet.** It authorizes by tenant only
  (ADR-0035), reports no version on read, cannot reuse a deleted key, and cannot
  count or page on a payload field (items 2, 4 and 5 in
  [the graph-storage asks](../upstream/graph-storage-requests.md)). A node
  payload is capped near 64 KiB ([studio-artifact-ingest](../design/studio-artifact-ingest.md)).
- **The line is already drawn.** What is traversed, drawn and searched goes into
  the graph; what is operational, private, heavily mutated or an authorization
  surface stays relational ([domain-query migration](../domain-query-migration.md)).

The question is which one model ties document, artifact, domain object, gear and
product together, which store owns which part of it, how a link across stores is
made and kept true, and what stops being stored twice.

## Considered Options

- **The graph is the single model, PostgreSQL holds only projections.**
  Documents, bindings, verdicts and the vocabulary move into graph nodes; the
  tables become indexes of them. One query reaches everything. But the
  documents gear is exactly what the line keeps relational: a status ladder two
  people edit, verdicts rewritten by every run, and authored text that does not
  fit a 64 KiB payload. With no version on read, every write becomes
  last-writer-wins, and a deleted document's key could never be used again.
  Rejected while items 2 and 4 are open; nothing here prevents it later.
- **PostgreSQL is the truth, the graph is an index.** The artifact index already
  holds every artifact's whole payload, so the artifact half is close to this
  now. But it reverses ADR-0024 and the work on it (ADR-0035, the query, saved
  views), the catalogue and the domain model have no database to be true in, and
  traversal is the one thing the graph does that the tables do not. It would
  double every write and keep the graph as a copy nobody may trust.
- **Keep each gear's store, add a link registry.** A table of
  `(from, to, kind)` references. Smallest to start. It is also a graph without
  traversal, kept in step with two ends it owns neither of, beside a graph that
  already has typed edges with endpoint constraints (ADR-0024). It would be a
  sixth store.
- **Keep each gear's store, and make the graph the link layer.** Every fact keeps
  one owner and one store. Every *thing* a project is made of has exactly one
  node type in the graph, written only by its owner, and a link between two
  things is an edge between their nodes. A row that has to be linked is
  projected as a node by its owner. PostgreSQL copies of graph data are allowed,
  and are declared projections that can be rebuilt. Chosen.

## Decision Outcome

### 1. One concept, one node type, one owner

| Concept | Truth | Its node in the graph | Owner | Stops being stored as |
|---|---|---|---|---|
| project | the account-management tenant | none; its id is the `project_id` every node carries (ADR-0035 §3) | account-management | `kg.project` |
| repository | `project.config` `sources[]` | `artifact.repo` | `studio-artifact-ingest` | `kg.repository`; a separate domain `repository` |
| file | the checkout | `artifact.file` | `studio-artifact-ingest` | `kg.file`, `kg.directory`; a separate domain `repository-file` |
| document | `studio_documents` (authored) or the checkout (bound) | `artifact.file` for a bound file; **`doc.document` for an authored one (new)** | `studio-documents` | separate domain `document` and `markdown-document` |
| capability | `studio_process_capabilities` | **`process.capability` (new)**, ADR-0014 §6 | `studio-documents` | a string in a decision |
| gear | crates.io and the gear repositories, read by `catalog.sync` | `catalog.gear` | `studio-components-catalog` | a separate domain `gears`; a name in a decision or a product |
| product | open question 2 | `catalog.project_product` | `studio-components-catalog` | |
| person | `identity_user` (ADR-0025) | the domain `person`, one per Studio person | `studio-user` truth, `studio-domain-model` node | `kg.person`; a `person` keyed on a login |
| finding | the detector's run | `artifact.spec_finding` | `studio-artifact-ingest`, written for `studio-spec-quality` | a second verdict written beside it (§4) |
| decision | the member | `artifact.mapping_decision` | `studio-artifact-ingest`, written for `studio-spec-mapping` | |

`doc.document` and `process.capability` are already cataloged in the
types-registry ([studio-documents](../design/studio-documents.md), §3.1); they
are not yet graph types.

### 2. A link is an edge, and a reference across stores is a graph address

- **Between two things, an edge.** A finding is `finding_on` its document, a
  decision is `decision_on` its document and gains `decides_for` its gear and
  `about` its capability, a capability is `realized_by` a gear, a product
  `includes` its gears. Each edge is written by the gear that owns the fact the
  edge states: a decision's edges with the decision.
- **From a row to a node, the node's id.** A PostgreSQL row that refers to the
  graph stores the node's type and instance id, as `studio_document_bindings.node_id`
  does today.
- **From a node to a row, a derived id.** A node that stands for a row has an
  instance id derived from the row's id (uuid5, as every instance id in Studio
  already is), so either side computes the other without a lookup. One field
  never holds ids from two spaces: a decision names its document by node.
- **The project is a key, not an edge.** Every node keeps carrying
  `workspace_id` and `project_id` in its payload, which is what the artifact index
  and the domain query already filter on.

### 3. Only the owner writes its types

A gear writes graph nodes and edges of its own types and nobody else's. Another
gear that needs one written asks through the owner's port, as `SpecFindingWriter`
and `MappingDecisionStore` already do. The `studio-backend/AGENTS.md` rule for
artifacts ("write only through `GraphStore`") becomes the rule for every type.

### 4. Truth first, the projection after it, and a reconcile run behind both

No write in this design claims to be atomic across stores, because none can be.

- The owner commits its truth, then writes the projection in the same request,
  best-effort.
- Every projection has a reconcile task type, `<gear>.reproject`, that rebuilds
  it from the truth for one tenant. It runs on a platform schedule and on demand,
  and a run says what it changed. The artifact index's fill and withdraw
  (`src/artifact_ingest/index.rs`) is the model to follow.
- Readers of a projection accept lag and never treat absence as "none", the rule
  `ArtifactFiles::list_files` already states for its `Err`.
- Where one fact has two stores today, one is named the truth and the other is
  derived from it by its owner. For a detector's verdict the truth is the
  `spec_finding` node; `studio_document_analyses` becomes its declared index,
  refilled by `documents.reproject`.
- A cross-store copy started from a request is a task run, never a bare
  `tokio::spawn`, so a failure is a failed run somebody can see and retry
  ([ADR-0038](0038-one-story-for-async-work.md)).

### 5. The domain model describes these things; it does not store a second copy

An entity of the domain model whose instances another gear already writes reads
them where they are. `repository` reads `artifact.repo`, `repository-file` reads
`artifact.file`, `pull-request` and `commit` read theirs, `document` reads the
two document nodes, `gears` reads `catalog.gear`. The ontology says which graph
type stores an entity; an entity with no other owner keeps its own
`gts.cf.studio.domain.*` type, as `view`, `team` and `membership` do today. The
domain query then reaches the project's real data with no copy, and ADR-0035's
authorization applies to it unchanged.

### 6. What is deleted

- `connector.graph_sync` and the `cf.studio.kg.*` types: the route, the task
  type and the type registrations. Existing nodes are retired, not deleted,
  because a deleted key cannot be written again.
- The domain model's empty duplicate types, once §5 maps their entities.
- `studio_artifact_index` is **not** on this list. It stays until graph-storage
  can count and page on a payload field, and is then deleted rather than kept in
  step, as `studio-backend/AGENTS.md` already says.

### Consequences

- A question that crosses gears is one traversal: "which gears were confirmed
  for the capabilities this project's documents ask for, and which of them are
  in its product" follows `about`, `decides_for` and `includes` instead of
  joining three ports by name.
- Authored and bound documents answer the same graph questions. The
  "a Studio document has none" branch goes.
- **More writes.** An authored document or a capability is now also a node
  write. They are small, and they are what makes the documents linkable.
- **Lag is visible.** A projection can be behind its truth until the request's
  own write or the next reconcile. Readers already tolerate this for the
  artifact index.
- **Domain-model work.** §5 needs the ontology to name a stored type per entity,
  and the query to read it. That is a change to `ontology.rs` and `query.rs`,
  and the generated client follows.
- Nothing moves out of PostgreSQL. The line in the domain-query migration holds,
  and the "graph is the single model" option stays open for when items 2 and 4
  close.

## More Information

### Migration, one pull request each

| # | Step | Waits on |
|---|---|---|
| 1 | **The ownership table, enforced.** The table in §1 goes into the [product design](../design/constructor-studio.md). An offline test beside `gts_inventory` fails when a `cf.studio` graph type is registered by two gears, or when `GraphStorageClientV1` is taken outside the owners. | — |
| 2 | **Retire the `kg` graph sync** (§6): route, task type, types, and a retire pass over existing `cf.studio.kg.*` nodes. | open question 4 |
| 3 | **Decisions point at things.** `mapping_decision` gains `decides_for` → `catalog.gear` (id from `gear_instance_id`), and `MappingDecision.document` is split into a node reference. | open question 1 |
| 4 | **Authored documents get a node.** `studio-documents` writes `doc.document` on create, update and delete (retire), and `documents.reproject` rebuilds them. Spec Quality and spec-mapping attach to it; the both-ends-are-nodes filter goes. | — |
| 5 | **Capabilities get a node** (ADR-0014 §6): `process.capability`, with `realized_by` edges from `catalog.gear` where the Gearbox engine reports the contract, and decisions gain `about`. | 4 |
| 6 | **One truth per verdict.** The batch writes the `spec_finding` only; `studio_document_analyses` is refilled from the findings by `documents.reproject`. | 4 |
| 7 | **The reports mirror becomes a run** (`reports.mirror`), replacing `mirror_in_background`. | — |
| 8 | **The domain model reads the anchors** (§5): first `repository` → `artifact.repo`, then the other entities one at a time, each with the generated client regenerated. | open question 3 |
| 9 | **Products include gears**: `project_product` writes `includes` edges to `catalog.gear`. | 3, open question 2 |
| 10 | **One person**: the domain `person` keyed on the `identity_user` id, with an edge to each `artifact.user` whose login its owner confirmed (ADR-0012). The reports mirror resolves a login to that person. | — |

### Open questions

1. **Can an edge join two nodes the gears write in different tenants?** The
   catalogue and the artifact graph both write in the caller's tenant
   ([studio-components-catalog](../design/studio-components-catalog.md),
   [studio-artifact-ingest](../design/studio-artifact-ingest.md)), but whether
   a catalogue synced by one organization is the same tenant as a project's
   artifacts has not been checked. If it is not, `decides_for` and
   `realized_by` need graph-storage support or a per-tenant gear node.
2. **Which is the product's truth**, the `project_product` node or the
   `product.gdl` file committed to the project's repository and edited in the
   IDE's Gearbox? Both are written today.
3. **Can the domain model's query read an entity stored under another gear's
   type?** `query.rs` derives the type from the entity id (`node_type_id` in
   `src/domain_model/gts.rs`). Whether that is a mapping or a deeper change has
   not been measured.
4. **Does anything still run `connector.graph_sync`?** No portal screen starts
   it, but a schedule on a stand could. The platform schedules registered at
   boot do not include it.
5. **One repository in two projects is two sets of artifact nodes**, by design:
   instance ids include the source scope. Should a repository be one node with
   a scope per project? That would change how the index and ADR-0035's project
   narrowing work, and is left out of this decision.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md), [studio-documents](../design/studio-documents.md), [studio-artifact-ingest](../design/studio-artifact-ingest.md), [studio-domain-model](../design/studio-domain-model.md), [studio-components-catalog](../design/studio-components-catalog.md), [studio-spec-mapping](../design/studio-spec-mapping.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-component-documents`
* `cpt-studio-component-artifact-ingest`
* `cpt-studio-component-domain-model`
* `cpt-studio-component-components-catalog`
* `cpt-studio-component-spec-mapping`
* `cpt-studio-component-connector`
* `cpt-studio-component-graph-storage`
* `cpt-studio-fr-spec-gear-mapping`
* `cpt-studio-fr-mapping-decisions`
* `cpt-studio-fr-domain-model`
