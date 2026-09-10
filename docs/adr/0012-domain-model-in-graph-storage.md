---
status: proposed
---
# ADR-0012 — The Studio domain model lives in Graph Storage and the type registry

## Status

proposed · 2026-09-08 · Builds on ADR-0009 and ADR-0011

## Context

Studio has a large, deliberately authored domain model — 11 buckets and roughly
140 entities (`team`, `project`, `repository`, `requirement`, …) joined by typed
relations (`member`, `owns`, `references`, `composes`, and so on). Until now its
structured source of truth was a static artifact: `core/entities.json` in the
separate `studio-internal/domain-model-ui` repo, in the entity shape the model-UI
`app.js` renders from. The running backend knew nothing about it. It could not
create objects of those types, could not answer "which relations may connect a
`project` to a `repository`", could not extend a type, and could not hand the
frontend a model to regenerate itself from. The model and the product drifted
apart because nothing but a human kept them aligned.

We want three concrete capabilities:

1. **create** objects of a domain type through the backend;
2. **extend** a type with a new field without a schema migration;
3. **regenerate** the model-UI file set from what the backend has stored.

Two registries already exist and pull in different directions. The platform
**types-registry** catalogs every GTS type with a free-form `type: object`
schema; it is the platform's authoritative list of what types exist. **Graph
Storage** holds an ontology plus node/edge instances, keeps an *open* payload,
and carries full-text and vector-search traits — it is where "what we visualise
and find paths through" lives (the storage split established when identity
records were kept relational: instances that are operational, private, and
heavily mutated stay in a relational store; the model of types-and-relations we
traverse and draw belongs in the graph).

One hard constraint shapes the answer. The tenant-metadata (AM) envelope is
closed by OP#12 narrowing (gears-rust issue #4): a schema derived from it cannot
add payload fields. A domain type whose entire purpose is to carry extensible
fields therefore cannot derive from that envelope — doing so would turn goal (2),
extending a type, back into a schema migration.

Finally, the domain model is not a bag of entities; it is itself a graph. The
relations are first-class, and we want the model *with its relations* to be
queryable in the same store, endpoint-typed so the graph and the registry both
know which object types a relation is allowed to connect.

## Decision

The domain model is materialised as **GTS types in Graph Storage**, mirroring the
`artifact_ingest` producer, and cataloged in parallel in the platform
types-registry. Concretely:

**Types derive from the graph-storage families, not the AM envelope.** Each
entity becomes a node type `gts.cf.studio.domain.<entity>.v1~` derived from the
`owned_node` family; each relation kind becomes an edge type
`gts.cf.studio.domainrel.<kind>.v1~` derived from the `static_edge` family;
entity fields live in the node **payload**. Because the families keep the payload
open, **extending a type is a pure ontology edit** — no migration, no
re-registration. The registered graph type carries only the family derivation;
the field-level definitions live in the ontology document, which is the source
the frontend is regenerated from.

**Registration is two-phase.** At gear `init`, every domain type — entities,
relation kinds, and the meta layer — is cataloged in the types-registry with a
free-form schema, the same shape Studio's other types use, so registration never
trips the closed-envelope narrowing check. The graph-storage registration (the
derived-family schemas) and instance ingest happen in the REST phase, where the
graph-storage client is available. Both phases are idempotent — the same
documents every boot.

**The model itself is stored as a graph.** `POST /model/sync` materialises the
ontology's *structure*: one `object_type` node per entity, joined by `inherits`
edges (an entity to the base it extends) and `declares` edges (an entity to each
related entity, carrying the relation's verb, cardinality, and label). So the
model's own ObjectType / RelationType / KnowledgeGraph notion is itself queryable
in Graph Storage, and `GET /model/graph` reads it back. Endpoints that name no
modeled entity — a non-core base, a target in a bucket not yet loaded — are
skipped and counted, never turned into dangling edges.

**Relations are endpoint-typed.** A relation kind is registered with
`x-gts-traits.src_types` / `dst_types` gathered from the ontology, so both the
graph and the type-registry know which object types a relation may connect.
Targets naming an entity outside the current slice are **reported** by
`GET /relations` as `unresolved` rather than silently dropped; they resolve as
those buckets are added.

**The stored model is the frontend-regeneration source.** `GET /types` returns
the stored ontology, which `scripts/regen-domain-frontend.mjs` turns back into
the model-UI file set — closing the loop so the model in the graph, not a static
checkout, drives the UI.

**Graceful degradation.** The store prefers the real graph-storage gear (on the
default `graph` feature); when that feature is off or the client is unpublished
it falls back to an in-memory store so the create → relate → extend → read loop
still runs in development.

This sits inside the boundaries of ADR-0009 and ADR-0011: the model is ontology
and object data, not an authorization surface. Tenant isolation and role
enforcement continue to govern *access* to domain objects; storing the model in
the graph does not widen any scope.

## Consequences

- The domain model becomes **one source of truth** that the backend, the graph,
  the type-registry, and the frontend all derive from, instead of a static JSON
  file that drifts from the running system.
- **Extending a type is an ontology edit, not a migration** — the open payload on
  the `owned_node`/`static_edge` families is what buys this, and it is the direct
  reason those families were chosen over the AM envelope.
- The model *and its relations* are **queryable as a graph**, matching the model's
  own KnowledgeGraph notion; relations are endpoint-typed, so illegal
  connections are visible rather than latent.
- The **type-registry stays the authoritative catalog** of every type the gear can
  put in the graph, while Graph Storage holds the ontology and the instances —
  the two-phase registration keeps them consistent without the catalog ever
  hitting the closed-envelope check.
- We take on **coupling to the graph-storage families and the gts-0.12 grammar**.
  A change to the family ids or the 5-token type grammar reaches this gear, as it
  reaches `artifact_ingest` and `components_catalog`.
- **Cross-bucket relations stay `unresolved`** until every referenced bucket is
  loaded. This is reported, not fatal, but a fully-connected model requires the
  full slice.
- The **in-memory fallback does not persist and can diverge** from the graph
  store; it exists for the dev loop and CI without the `graph` feature, and is not
  a production path.
- The decision **depends on OP#12 narrowing remaining as-is**. If the AM envelope
  is later opened to derived payload fields, the "why not the envelope" premise
  weakens and the storage choice is worth revisiting — though the graph's
  traversal and search traits would still argue for the graph.

## Alternatives Considered

- **Derive domain types from the tenant-metadata (AM) envelope.** Rejected: OP#12
  narrowing closes that envelope (gears-rust issue #4), so a derived schema cannot
  add payload fields. Extending a type would become a schema migration, defeating
  goal (2). The graph-storage families are open, which is exactly the property we
  need.
- **Leave the model as the static `entities.json` in `domain-model-ui`.**
  Rejected: the backend then cannot create, validate, extend, or serve domain
  objects, and the model and product keep drifting because only a person keeps
  them aligned. This is the status quo the ADR is replacing.
- **Store the domain model in a relational (SeaORM) store**, as we did for
  identity/user records. Rejected for the *model*: entities-and-relations that we
  traverse and visualise are precisely "what we put in the graph". The relational
  choice was made for user *instances* — operational, private, heavily mutated
  records — and that reasoning does not transfer to an ontology of types and their
  relations. Keeping the two in different stores is deliberate, not inconsistent.
- **Ingest object instances but not the model's own structure.** Rejected: goal is
  the model *with its relations* queryable (for validation, for the model-UI, for
  future generation), and frontend regeneration needs the ontology read back from
  the store — so the `object_type` / `inherits` / `declares` meta layer has to be
  materialised too.
- **Register everything only in the types-registry, skip Graph Storage.**
  Rejected: the registry is a flat catalog with closed free-form schemas; it gives
  neither the open extensible payload nor traversal/search over instances and
  relations. The two-phase approach uses each registry for what it is good at.
