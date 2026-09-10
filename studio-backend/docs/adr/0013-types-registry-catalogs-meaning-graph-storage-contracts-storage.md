# ADR-0013: The types-registry catalogs meaning, graph-storage contracts storage

Status: **proposed** · Date: 2026-09-08

## Context

Studio registers every GTS type twice — once in the platform **types-registry**
and once in the **graph-storage** ontology — and until now nothing said which
one owns what. The result was drift nobody could see: on 2026-09-08 an audit of
a live deployment (273 registered entities, 173 of them `cf.studio.*`) against
an offline inventory of what the code registers found

- **no duplicate ids** and no type the code registers missing from the
  deployment — the two agreed on everything they both knew about, but
- **21 types existed in graph-storage with no catalog entry at all**: every
  artifact relation (`rel.*`, 8), the whole repository knowledge graph
  (`kg.*`, 8), the domain model's own meta layer (`domainmeta.*`, 3),
  `catalog.has_version`, and `artifact.user`.

The pattern was not random. Gears registered their *nodes* in the catalog and
their *edges* only in the graph, because nothing had ever said the catalog was
supposed to be complete. Meanwhile `config/postgres.yaml` had silently lost one
tenant-metadata type, and a missing tenant-metadata type is not a boot error —
the gear that reads it simply finds nothing.

Two facts about the platform make the division of labour non-negotiable, and
both were verified against gears-rust rather than assumed:

1. **The types-registry is not tenant-scoped.** Its SDK says so in as many
   words: *"Type-schema operations (internal — no tenant scoping)"* and the same
   for instances. It is one namespace per deployment, with a full read API
   (`get_type_schema`, `get_type_schemas`, `list_type_schemas`, the same for
   instances, plus `GET /types-registry/v1/entities`), a deterministic UUIDv5
   per id, and parent-before-child registration ordering.
2. **Graph-storage is tenant-scoped and its types carry storage semantics.**
   Types are registered per tenant (*"published on a tenant's first type
   registration"*), must derive from a family (`owned_node` or `reference_node`
   for a node, `static_edge` or `analysis_edge` for an edge), and that family is
   what the ingest pipeline reads to decide behaviour — owned vs reference, static vs
   analysis — *"rather than from per-request flags"*. The schema additionally
   declares which payload paths are indexed and which are vectorized, and a
   node's concrete type is immutable under upsert.

A registry that cannot hold per-tenant knowledge cannot be the system of record
for a per-tenant model. A store whose types encode indexing and family
semantics cannot be the place where a type's *meaning* is published. So the two
are not redundant — they answer different questions — and the reason they
drifted is that we never wrote down which question belongs to which.

## Decision

### 1. One sentence each

**The types-registry is the deployment-wide catalog of *meaning*: what a type
is, what it is called, who ships it, and that it exists at all. Graph-storage is
the tenant-scoped contract of *storage*: how instances of that type are kept,
found, and constrained.**

| | types-registry | graph-storage |
| --- | --- | --- |
| Scope | one namespace per deployment | per tenant |
| Owns | id, title, description, kind, owning package, deprecation | family, indexed/vectorized paths, endpoint constraints, payload ceiling |
| Holds instances? | yes — deployment-level *configuration* instances (plugins) | yes — tenant *data* (nodes, edges) |
| Read by | consoles, the generated frontend, other gears' discovery | the data-access layer, search, traversal |
| Type document | free-form (`type: object`) — narrowing a closed envelope trips the GTS inclusion check | derived (`allOf: [{$ref: <family>}]`) — a free-form type has no chain to validate against |

### 2. The completeness invariant

**Every type that can appear in graph-storage has a catalog entry.** Nodes and
edges alike, with a human title and description, because a label a UI renders
cannot be derived from an identifier — in the live model `domain.skill` is
displayed as "Competency", `domain.code_review` as "Review",
`domain.role_assignment` as "Role Grant". The catalog is where that mapping
lives.

The reverse is deliberately *not* equality: a type may be cataloged without
existing in the graph. Today that is exactly `gts.cf.studio.doc.*` — document
types live in the gear's own PostgreSQL tables. Those exceptions are an explicit
list in code, so a new one is a decision somebody wrote down rather than an
accident.

Both directions are asserted offline by `crate::gts_inventory`
(`every_graph_type_is_also_in_the_platform_catalog`,
`catalog_only_types_are_the_documented_exceptions`), so a gear that adds a graph
type without cataloging it fails `cargo test`, not a pod.

### 3. One declaration per type, both documents derived from it

A type is declared **once** — in a gear's `NODE_TYPE_DOCS` / `EDGE_TYPE_DOCS`
table, or, for the domain model, in the ontology document — and both
registration documents are generated from that declaration. No gear hand-writes
the same title twice, and the two registries cannot disagree about a type's
identity by construction rather than by discipline.

`studio-backend gts-types` prints the whole set offline (no config, no database,
no registry, no listener); `docs/gts-types.json` is the committed snapshot and
the diff is the review. Nine tests guard the set: snapshot drift, per-profile
declaration of the types the code reads, profile parity, family derivation,
free-form catalog documents, GTS segment grammar, id uniqueness, and the two
completeness invariants above.

### 4. What may be registered where, by origin

| Origin | Catalog | Graph ontology |
| --- | --- | --- |
| Platform/product types (our gears, our domain model) | at gear `init` | at first use / package activation |
| Kit- or package-declared types | at package publication (pre-flight: the package's documents must pass the nine invariants **before** anybody installs it) | when a tenant activates the package |
| A tenant's additive field on an existing type | nothing to register — the `owned_node` payload is open, the field definition lives in that tenant's model document | nothing to register |
| A tenant's genuinely new type | only under a GTS vendor segment that names the tenant, never in the shared `cf.studio.*` namespace | per that tenant |

The last row is the load-bearing consequence of the registry being global: a
per-customer type registered as `cf.studio.*` pollutes every other customer's
catalog. GTS already provides the escape hatch — the first segment token is the
vendor — so a tenant-authored type is `gts.<vendor>.<package>.<ns>.<type>.vN~`
or it does not go in the catalog at all.

### 5. Evolution: three kinds of change, three different costs

- **Additive field.** Free. The graph type stays as registered, the payload
  carries the field, the ontology document defines it. **But** the search
  contract does not follow: `full_text_search` / `vector_search` payload paths
  are part of the registered schema, so a field added this way is readable and
  writable yet neither searchable nor embeddable until the type is versioned.
  That price is documented here rather than discovered later.
- **Breaking change** (a field's type changes, a field is removed, semantics
  shift). A new type id — `…v2~` — registered in both registries, with `v1`
  kept until its instances drain. A concrete node's type is immutable under
  upsert, so instances do not migrate in place; a migration writes new nodes.
- **Retirement.** Deprecate in the catalog (the catalog is where meaning lives,
  so that is where "do not use this" belongs); keep the graph type as long as
  instances exist.

### 6. Consistency is checked in three places, not one

1. **CI, offline** — the nine invariants over the inventory built from code.
2. **Boot** — each registry validates what it is handed: GTS grammar and
   derivation chains in the catalog, family derivation and endpoint constraints
   in graph-storage. A refusal must fail the boot uniformly; today
   `studio-documents` warns and continues where every other gear aborts, and
   that inconsistency is a follow-up, not a design choice.
3. **A live deployment** — a `gts-audit` command (follow-up) reads both
   registries through their list APIs and reports the three-way diff against the
   committed snapshot: what the code declares, what the catalog holds, what the
   tenant's graph ontology holds. This is the only check that catches a
   deployment which booted an older image or lost a config entry, and both
   registries already expose the reads it needs.

## What was rejected

**Collapsing the two into one.** Neither can absorb the other: the catalog
cannot hold per-tenant types (no tenant scoping), and graph-storage cannot hold
the types that never reach the graph (document types, permissions, tenant
metadata envelopes) nor be the discovery API for a console that must list every
type in the deployment.

**Registering only the types we currently query.** That is what produced the 21
orphans. The cost of a catalog entry is one free-form document; the cost of a
missing one is a type that exists in the data and not in the registry the rest
of the platform reads.

**Deriving UI labels from identifiers.** Six of the live domain types would
render wrong (`new_content_knowledge_element` → "File"), and a generated
frontend has no other place to look.

**Changing the family of existing artifact types in this ADR.** Repositories,
files and people mirrored from a provider are arguably `reference_node` (the
system of record is GitHub, not us), and `rel.duplicates` / `rel.traces_to` /
`rel.finding_on` are analysis results that belong on `analysis_edge` with a
provenance attribute — as `static_edge` they carry no provenance and a scope
re-sync would delete them. Both are real modelling errors, and both change the
type id (the family is part of it), so they belong with the vocabulary decision
below rather than as a silent side effect of writing down the division of
labour.

## Consequences

- 21 previously graph-only types are now cataloged; the next boot registers
  them, bringing the deployment from 173 to 194 `cf.studio.*` entities. Only
  additions — no existing document changed, because a re-registration with
  different content risks a refused ready-commit and, in graph-storage, a
  registered type's schema is not ours to rewrite.
- `studio-connector` gained `deps = [types_registry]` and registers the
  knowledge-graph types before it resolves drivers, so a deployment with no
  driver still describes the types a previous sync wrote.
- The catalog becomes a product surface: titles and descriptions are read by
  consoles and by the generated frontend, so they are written for people.
- A per-tenant type must carry a tenant vendor segment. Any design that assumed
  customers extend `cf.studio.*` at runtime needs revisiting.
- The three-way audit is what makes "the registries agree" a checkable claim in
  a running cluster rather than a property of our CI only.

## Follow-ups

1. `gts-audit` — the live three-way diff (§6.3).
2. One registration-failure policy: `studio-documents` must abort like the rest,
   or the exception needs a reason in code.
3. The vocabulary decision this ADR deliberately does not make: `kg.*` versus
   `artifact.*` for repository, file, person and their relations — four types
   describe "a file" today (`domain.repository_file`, `artifact.file`, `kg.file`,
   and `domain.new_content_knowledge_element`, labelled "File"). Whichever wins,
   the family question in *What was rejected* is settled at the same time,
   because the family is part of the id.
4. Reusable **attribute** types (a schema fragment derived from the attribute
   base, neither a graph element nor a family) are unused; shared field groups
   in the domain model are what they are for.
5. Payload validation against the ontology's field definitions. The graph type
   is open by design, so today nothing validates an instance against the model
   the frontend is generated from.
