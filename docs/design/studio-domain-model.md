---
type: design
status: accepted
owner: studio-team
---

# Technical Design — studio-domain-model

- [x] `p3` - **ID**: `cpt-studio-design-domain-model`

The gear-level design of `cpt-studio-component-domain-model`. The
product-level view, and how this gear sits among the others, is in
[Constructor Studio's design](constructor-studio.md). The code is
[`studio-backend/src/domain_model/`](../../studio-backend/src/domain_model/).

## Table of Contents

- [1. Architecture Overview](#1-architecture-overview)
- [2. Principles & Constraints](#2-principles--constraints)
- [3. Technical Architecture](#3-technical-architecture)
- [4. Additional context](#4-additional-context)
- [5. Traceability](#5-traceability)

## 1. Architecture Overview

### 1.1 Architectural Vision

The Studio domain model is authored data: a set of entities with fields and
relations, from which the model UI is regenerated. This gear stores it as GTS
types in graph-storage, lets a member create objects of those types and relate
them, extend and change the types, and reads the model back so the frontend
can be regenerated from what is stored.

The structured source lives in a separate repository,
`studio-internal/domain-model-ui` (`core/entities.json` and its neighbours).
The gear embeds the full core model plus the system base types
(`ontology.core.json`, 11 buckets, 140 entities) as its **bootstrap seed**, so
`extends` resolves to modelled bases. Graph-storage is the model's system of
record; the seed is only what a tenant runs until the graph holds a model of
its own.

Every edit is a numbered version carrying the RFC-6902 patch that made it and
its inverse, so the model has a history that can be read, audited and
reverted. An object is checked against its type, bases included, on the way in.

### 1.2 Architecture Drivers

#### Functional Drivers

| Requirement | Design Response |
|-------------|------------------|
| `cpt-studio-fr-domain-model` | Entities are node types and relation kinds are edge types derived from the graph-storage families; objects and relations are typed nodes and edges; field edits, import, sync and revert are model versions stored in the graph. |
| `cpt-studio-fr-gts-consistency` | Every domain, relation and meta type is cataloged in the types-registry at init, the same documents every boot. |

#### NFR Allocation

| NFR ID | NFR Summary | Allocated To | Design Response | Verification Approach |
|--------|-------------|--------------|-----------------|----------------------|
| `cpt-studio-nfr-tenant-isolation` | Every allow stays in the caller's tenant subtree | `store.rs` | The model and its objects are graph-storage nodes, tenant-scoped by the graph; two tenants can run different models | `service.rs` unit tests over the in-memory store |

#### Key ADRs

| ADR ID | Decision Summary |
|--------|------------------|
| `cpt-studio-adr-domain-model-in-graph-storage` | The domain model is GTS types in graph-storage, derived from `owned_node` and `static_edge`, cataloged in the types-registry, and the frontend is regenerated from it. |
| `cpt-studio-adr-types-registry-catalogs-meaning-graph-storage-contracts-storage` | The types-registry catalogs the meaning; graph-storage contracts the storage. |

### 1.3 Architecture Layers

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| REST | Types, objects, relations, model sync, import, history | `OperationBuilder` routes in `rest.rs` |
| Service | Edits as versions, object validation, migrations, conformance | `service.rs`, `validate.rs` |
| Ontology | Load, extend, resolve what a type inherits, reassemble from the graph | `ontology.rs` over `ontology.core.json` |
| Identity | Node, edge and meta type ids; instance ids | `gts.rs` |
| Store | Graph-storage or in-memory | `store.rs` |

## 2. Principles & Constraints

### 2.1 Design Principles

#### Extending a type is a pure ontology edit

- [x] `p2` - **ID**: `cpt-studio-principle-domain-model-open-types`

A domain type must carry fields that can be added later. The tenant-metadata
envelope is closed by OP#12 narrowing (a derived schema cannot add payload
fields; `gears-rust-issues.md` §4), so types derive from graph-storage's
`owned_node` and `static_edge`, whose payload is open. The registered graph
type carries only the family derivation; field definitions live in the
ontology document.

Nothing model-derived is in the registered schema either. A node type's
`x-gts-traits` used to be gathered from each entity's fields, which made the
schema a function of the model while graph-storage treats a registered schema
as immutable: adding a field to `project` made its type unregistrable, and one
refusal aborted the whole batch. The traits are now the same for every domain
node type: full-text search over `/name` and `/payload` (the whole payload,
stringified), vector search over a fixed list of conventional prose fields.
Field names become tokens too; the gain is that a field edit cannot change a
schema, and a field added long after registration is searchable.

**ADRs**: `cpt-studio-adr-domain-model-in-graph-storage`

#### Every change is a version, and history is only appended to

- [x] `p2` - **ID**: `cpt-studio-principle-domain-model-versions`

Each edit is a `model_version` node chained by `revises` edges, carrying who
made it, when, a one-line summary, and the patch plus its inverse. Patches are
emitted by the edit that knows what it did, never diffed afterwards. Version 0
is the model as first stored. Reverting to v3 from v7 produces v8 with v3's
content, itself reversible. An import replaces the whole document and records
no inverse, so a revert past it is refused, naming the version that blocks it.

#### Concurrent edits are a create race, not a lock

- [x] `p2` - **ID**: `cpt-studio-principle-domain-model-claim-version`

Claiming version N inserts a node at a key derived from N with
`expected_version: Some(0)`, "this node must not exist". Two writers racing for
N both try to create the same key and exactly one succeeds; the loser reloads
and recomputes its edit on top of the winner's, up to four attempts. This
works across replicas, which an in-process lock would not, and needs no read:
graph-storage takes an expected version on write but reports none on read, so
a read-then-write compare-and-set cannot be formed. Endpoints that show or
change the model read the stored head version, one node, and reload when it
moved; object endpoints answer from cache, where a version behind is not
visible.

#### Report how far the data is from the model, rather than refuse it

- [x] `p2` - **ID**: `cpt-studio-principle-domain-model-warn-by-default`

`POST /objects` checks the payload against the effective type with `validate`
`off`, `warn` (default) or `strict`. The model has 560 required fields and a
bare `project` violates 13 of them, so refusing by default would reject nearly
every object; reporting says how far the stored domain is from the model.
`tenant_id`, `id`, `created_at` and `updated_at` are exempt, since the graph
supplies them. An undeclared field is reported, never a violation, because it
is the question that decides whether to extend the type. A type expression is
checked only where unambiguous (`string`, `timestamp`, numeric and boolean
names, the `Id`/`Ref` suffixes, `T[]`, `T?`, `a | b | c`); the model's
roughly 100 one-off domain names are carried, not guessed at.

### 2.2 Constraints

#### What field edits may not do

- [x] `p2` - **ID**: `cpt-studio-constraint-domain-model-field-edits`

A field a type declares itself can be added, renamed, retyped, required or
dropped. Editing an inherited field is refused: it belongs to the base that
declares it, and changing it there changes everything that extends the base.
Editing a relation property is refused: it is stored as a `declares` edge, and
that second write path is not built yet. Dropping a field leaves the data;
the objects keep what they hold and it is reported as undeclared.

#### Updates are last-writer-wins

- [x] `p2` - **ID**: `cpt-studio-constraint-domain-model-lww`

`expected_version: Some(0)` is the only conditional write graph-storage lets
this gear express, because no read reports a version
(`gears-rust-issues.md` §5). `POST /objects` exposes it as `if_absent`; an
update of an existing object is last-writer-wins until that gap closes.

#### Objects of a dropped entity stay in the graph

- [x] `p2` - **ID**: `cpt-studio-constraint-domain-model-no-tombstones`

`object_type` nodes the `model` node no longer names belong to a model the
tenant used to run and are not read back, but they are left in place:
graph-storage cannot re-ingest a tombstoned key before a purge, so deleting
them would make re-adding the entity fail. An entity that comes back is adopted
again.

## 3. Technical Architecture

### 3.1 Domain Model

- [x] `p2` - **ID**: `cpt-studio-entity-domain-model-graph`

| Domain concept | GTS |
|---|---|
| entity (`team`) | node type `gts.cf.studio.domain.team.v1~`, derived from `owned_node` |
| relation kind (`member`, `owns`, `references`, `composes`) | edge type `gts.cf.studio.domainrel.<kind>.v1~`, derived from `static_edge`, with `x-gts-traits.src_types`/`dst_types` from the ontology |
| declared relation (`team.has_members`) | the edge's discriminator, with its verb, label and cardinality in the payload |
| entity fields | node payload, open |
| the model | one `model` node (the document's `model`, `source`, `buckets` and the ordered entity ids) and one `object_type` node per entity, joined by `inherits` and `declares` edges |
| an edit | a `model_version` node, chained by `revises` |

The meta types are `gts.cf.studio.domainmeta.{object_type,model,model_version,revises,inherits,declares}.v1~`.
Entity ids are sanitized into GTS tokens (`role-assignment` becomes
`role_assignment`). Objects are nodes keyed on a deterministic instance id, so
creating the same object twice upserts. Each `object_type` node carries the
whole entity document under `entity`, which is what makes the stored model
lossless and readable back.

A type is mostly its bases: `team` declares 6 fields and has 24. `GET
/types/{id}` answers with every field, own and inherited, each marked with the
entity that `declared_by` it, nearest declaration winning, and with the
relations declared on its bases.

### 3.2 Component Model

#### Model store

- [x] `p2` - **ID**: `cpt-studio-component-domain-model-store`

##### Why this component exists

The model is per tenant and must survive the process that changed it.

##### Responsibility scope

`store.rs` and `service.rs`: on a tenant's first touch, read the `model` node
and one entity document per named `object_type` node; a tenant with none runs
the seed and writes nothing until something asks for it. The first edit stores
the whole model; every later edit writes the one node it changes, plus its
version.

##### Responsibility boundaries

Does not authorize; the gateway and the graph's tenant scope do.

##### Related components (by ID)

- `cpt-studio-component-graph-storage` — owns data in

#### Relation check

- [x] `p2` - **ID**: `cpt-studio-component-domain-model-relations`

##### Why this component exists

Letting an undeclared pair through would make the model describe the graph
without constraining it, and there would be nothing to reconfigure.

##### Responsibility scope

`POST /relations` takes a declared name (`team.has_members` or bare
`has_members`) or a bare verb, reads both endpoint objects, resolves their
types, and requires the pair to be one of the model's 339 declared relations,
a relation declared on a base counting for everything that extends it. A bare
token is resolved against the endpoints, because `owns` is both a verb and a
property name. An undeclared pair is refused with what the model allows from
that source. Two relations of one verb between one pair stay distinct edges.

##### Responsibility boundaries

Targets naming an entity outside the loaded buckets are reported by `GET
/relations` as `unresolved`, not dropped.

##### Related components (by ID)

- `cpt-studio-component-graph-storage` — writes edges to

#### Field migration and conformance

- [x] `p2` - **ID**: `cpt-studio-component-domain-model-migration`

##### Why this component exists

A model edit does not move the stored objects: renaming `priority` to
`urgency` leaves ten thousand objects holding `priority`, which reads as data
loss dressed as a model edit. And without a read-back, an edit's effect on
stored objects was invisible.

##### Responsibility scope

`PATCH …/fields/{name}` with `rename_to` rewrites stored payloads in batches of
100 and reports how many moved (`migrate: false` leaves it to the caller). The
model edit lands first and the migration follows; both are idempotent, so a run
that died half way is fixed by running it again. The rewrite keeps the stored
vectors (no embedded path changes) and rebuilds the lexical index.
`GET …/conformance` checks up to `limit` stored objects (5,000 by default)
against the type, returning counts per field and kind, the undeclared fields,
up to five offending objects, and whether it saw everything.

##### Responsibility boundaries

A retried rename is told apart from a mistyped field name, which is still an
error.

##### Related components (by ID)

- `cpt-studio-component-graph-storage` — rewrites nodes in

### 3.3 API Contracts

- [x] `p2` - **ID**: `cpt-studio-interface-domain-model-rest`

- **Contracts**: `cpt-studio-interface-rest-api`
- **Technology**: REST/OpenAPI through `api_gateway`
- **Location**: [`studio-backend/docs/api-contract.json`](../../studio-backend/docs/api-contract.json)

**Endpoints Overview** (prefix `/studio-domain-model/v1`):

| Method | Path | Description | Stability |
|--------|------|-------------|-----------|
| `GET` | `/types` | The stored ontology, the frontend-regeneration source | unstable |
| `GET` | `/types/{id}` | One type with everything it inherits, and its relations | unstable |
| `POST` | `/types/{id}/fields` | Add a field | unstable |
| `PATCH` `DELETE` | `/types/{id}/fields/{name}` | Rename (with migration), retype, require; drop | unstable |
| `GET` | `/types/{id}/conformance` | How stored objects measure up against the type | unstable |
| `POST` `GET` | `/objects` | Create or upsert an object (`validate`, `if_absent`); list by `type` | unstable |
| `GET` | `/objects/graph` | Objects and their relations, `limit` 500 by default and at most 5,000, with `truncated` | unstable |
| `GET` `POST` | `/relations` | The relation catalogue with endpoint typing and `unresolved`; relate two objects | unstable |
| `POST` | `/model/sync` | Store the model's structure as a graph; reports `version` and `pinned_types` | unstable |
| `POST` | `/model/import` | Replace the active ontology with an uploaded document and register its types | unstable |
| `GET` | `/model/graph` | The model graph read back from graph-storage | unstable |
| `GET` | `/model/versions` | The history, newest first, with patches | unstable |
| `POST` | `/model/revert` | `{"to": N}`, recorded as a new version | unstable |

### 3.4 Internal Dependencies

| Dependency Gear | Interface Used | Purpose |
|-------------------|----------------|----------|
| `types_registry` | SDK client | Catalog every domain, relation and meta type at init |
| `cpt-studio-component-graph-storage` | `GraphStorageClientV1` (feature `graph`), resolved in the REST phase | Register the derived types; store the model, versions, objects and relations; an in-memory store without it |

### 3.5 External Dependencies

None at run time. The seed is embedded at build time from
`studio-internal/domain-model-ui`.

### 3.6 Interactions & Sequences

#### Edit the model

**ID**: `cpt-studio-seq-domain-model-edit`

**Actors**: `cpt-studio-actor-member`

```mermaid
sequenceDiagram
    participant M as Member
    participant S as studio-domain-model
    participant G as graph-storage
    M->>S: POST /types/{id}/fields
    S->>G: read head model_version
    S->>S: reload if it moved; apply the edit, emit patch + inverse
    S->>G: create model_version N+1 (expected_version 0)
    alt key already taken
        S->>S: reload, recompute on the winner's model (up to 4 attempts)
    end
    S->>G: write the changed object_type node and the model node (moves the head)
    S-->>M: the new version
```

**Description**: The version node is the claim; the changed entity and the
head are written after it, so a writer that loses the race has changed
nothing. A failure after the claim leaves the head where it was: the model
reads back unchanged and the claimed number is burned, which a re-run steps
past.

### 3.7 Database schemas & tables

None. The model, its versions, its objects and their relations are
graph-storage nodes and edges (§3.1), owned by
`cpt-studio-component-graph-storage`.

### 3.8 Deployment Topology

In-process in the one `studio-backend` binary: gear `studio-domain-model`,
capabilities `[rest]`, no config section.

## 4. Additional context

Registration tolerates an immutable-schema refusal: the batch is retried type
by type and the drifted ones are reported as `pinned_types` on `POST
/model/sync`. An existing graph whose 140 types were registered with the old
per-entity traits keeps them and reports them as pinned until they are
migrated; a fresh graph registers the fixed traits from the start.
[`gears-rust-issues.md`](../../studio-backend/docs/gears-rust-issues.md) §4 and
§5 record the platform gaps behind the open types and the missing conditional
update.

## 5. Traceability

- **PRD**: [Constructor Studio](../prd/constructor-studio.md)
- **Design**: [Constructor Studio](constructor-studio.md)
- **ADRs**: [ADR index](../adr/README.md)
- **Code**: [`studio-backend/src/domain_model/`](../../studio-backend/src/domain_model/)
