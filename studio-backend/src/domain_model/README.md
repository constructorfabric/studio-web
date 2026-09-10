# studio-domain-model

Stores the Studio **domain model** as GTS types in Graph Storage, so you can
create objects of those types, extend the types with new fields, and regenerate
the frontend from the stored model.

The gear mirrors `artifact_ingest`: it registers GTS types derived from the
graph-storage families and ingests instances as typed nodes/edges.

## The model

The domain model's structured source of truth lives in a **separate repo**,
`studio-internal/domain-model-ui` (`core/entities.json` etc.) in the
domain-entity shape its `app.js` renders from. This gear embeds the full core
model plus the system base types (`ontology.core.json`, 11 buckets / 140
entities) as its **bootstrap seed**, so `extends` resolves to modeled bases.

### Where the model lives

**Graph Storage is the model's system of record; `ontology.core.json` is only
the seed.** On a tenant's first touch the gear reads the model back out of the
graph — the `model` node (the document's `model`/`source`/`buckets`) plus one
entity document per `object_type` node. A tenant the graph holds no model for
runs the seed, and nothing is written until something asks for it, so a read
stays a read. The first *edit* stores the whole model, and every edit after
that is written through as the one node it changes.

That makes the model **per tenant**: the graph is tenant-scoped, so two tenants
can run different models, and one tenant's added field is not another's.

The `model` node names the entity ids **in order**, and that list is the model:
which entities it has and what order they go in. `object_type` nodes it does
not name belong to a model the tenant used to run and are not read back. They
are deliberately left in place — graph-storage cannot re-ingest a tombstoned
node key before a purge, so deleting them would make *re-adding* an entity
fail, which is the opposite of what a reconfigurable model needs. An entity
that comes back is adopted again for free.

### Every change is a version

Each edit is recorded as a `model_version` node, chained by `revises` edges,
carrying who made it, when, a one-line summary, and the RFC-6902 patch that
made it **plus its inverse**. Patches are emitted by the edit that knows what
it did, never diffed after the fact. Version 0 is the model as first stored.

| Method + path | Does |
|---|---|
| `GET /model/versions` | the history, newest first, with patches |
| `POST /model/revert` | `{"to": N}` — undo back to N, recorded as a new version |

History is appended to, never rewritten: reverting to v3 from v7 produces v8
whose content is v3's, and that revert is itself reversible. An import replaces
the whole document, so it records no inverse and nothing can be reverted past
it — refused with the version that blocks it.

**What conditional writes are available.** `expected_version: Some(0)` — "this
node must not exist", since a live node's version is 1 or more — is the only one
graph-storage can express for us: it takes an expected version on write but
reports none on any read, so a read-then-update has no version to pass back
(`docs/gears-rust-issues.md` §5). `POST /objects` exposes it as `if_absent`;
an *update* is last-writer-wins until that gap closes.

**How concurrent edits stay safe.** Claiming version N is an insert at a node
key derived from N, under a compare-and-set that says *the node must not
exist*: `expected_version: Some(0)`, since a live node's version is 1 or more.
Two writers racing the same number both try to create the same key and exactly
one gets through; the loser reloads and recomputes its edit on top of the
winner's rather than overwriting it. This works across replicas, which an
in-process lock would not, and needs no read — graph-storage takes an expected
version on write but reports none on read, so a read-then-write CAS cannot be
formed at all.

A second replica's cache would otherwise never notice an edit made elsewhere,
so the endpoints that show or change the model (`GET /types`, `GET /relations`,
`GET /model/graph`, every edit) read the stored head version — one node — and
reload when it has moved. The object endpoints answer from cache: they run per
request and being a version behind is not visible in them.

### A type is mostly its bases

The model puts most of a type's fields on the types it extends. `team` declares
6 and *has* 24 — one from `system-object`, two from `node`, fifteen from
`managed-object`. Reading an entity straight out of `GET /types` therefore shows
a fraction of the type, and every consumer had to walk `extends` itself.

`GET /types/{id}` answers with the type as it actually is: every field, own and
inherited, each marked with the entity that `declared_by` it, base-first and
with the nearest declaration winning where a type overrides one. Relations
declared on a base come with it (`typed_by` is on `managed-object`, so a
`project` has it).

### An object is checked against its type

The registered graph type is open, so nothing downstream enforces the model's
`required`, its declared types or its enums — the model *described* objects
without saying anything about them. `POST /objects` now checks the payload
against the effective type and reports what it finds:

| `validate` | |
|---|---|
| `off` | do not check |
| `warn` (default) | check, report, write anyway |
| `strict` | check, and refuse the write if anything is violated |

```jsonc
// POST /objects  {"type":"project","key":"apollo","value":{"name":"Apollo","status":"started","portfolio":"platform"}}
{ "validate": "warn",
  "violations": [ { "kind": "enum", "field": "status",
                    "detail": "expected one of planned | active | paused | archived" },
                  { "kind": "missing", "field": "node_type",
                    "detail": "required by node (string)" } ],
  "undeclared": ["portfolio"] }
```

Three things are deliberate:

- **`warn` is the default.** The model has 560 required fields, and a bare
  `project` violates 13 of them — it asks for `node_type`, `properties`, `scope`
  and more that no caller supplies today. Refusing by default would reject
  nearly every object; reporting says exactly how far the modelled domain is
  from what is stored, which is the more useful answer. `tenant_id`, `id` and
  the timestamps are exempt: the graph supplies those on the node row, not in
  the payload.
- **An undeclared field is never a violation.** The payload is open by design.
  It is reported instead, because "this object carries a field the model has not
  caught up with" is the question that decides whether to extend the type — and
  after `POST /types/{id}/fields` the same write reports nothing.
- **A type expression is checked only where it is unambiguous.** `string`,
  `timestamp`, the numeric and boolean names, the `Id`/`Ref` suffix convention,
  `T[]`, `T?` and `a | b | c` are checked. The model's ~100 one-off domain names
  (`Money`, `RetryPolicy`, `WorkflowGraph`) are carried, not guessed at.

## Mapping to GTS

| Domain concept | GTS |
|---|---|
| entity (`team`) | node type `gts.cf.studio.domain.team.v1~`, derived from `owned_node` |
| relation kind (`member`, `owns`, `references`, `composes`) | edge type `gts.cf.studio.domainrel.<kind>.v1~`, derived from `static_edge` |
| declared relation (`team.has_members`) | the edge's discriminator + payload on that type |
| entity fields | node **payload** (open — see below) |

### Why `owned_node` and not the tenant-metadata envelope

A domain type must carry fields you can extend. The tenant-metadata (AM)
envelope is closed by OP#12 narrowing (gears issue #4 — a derived schema cannot
add payload fields), so types derive from the graph-storage `owned_node` /
`static_edge` families instead. Those keep the payload **open**, which is what
makes *extending a type a pure ontology edit* — no schema migration, no
re-registration. The registered graph type carries only the family derivation;
the field-level definitions live in the ontology document, which is the source
the frontend is regenerated from.

### Nothing model-derived is in the registered schema

A node type's schema carries the payload paths it is searched and embedded on
(`x-gts-traits`). These used to be gathered from each entity's own fields —
which made the registered schema a function of the model, while graph-storage
treats a registered schema as immutable. Adding a field to `project` therefore
made its type unregistrable, and because one refusal aborted the whole
registration batch, it took down *every* object write in the model.

So the traits are now the same for every domain node type and are not derived
from anything:

| trait | paths |
|---|---|
| `full_text_search` | `/name`, `/payload` |
| `vector_search` | a fixed list of conventional prose fields (`description`, `summary`, `content`, …) |

`/payload` is the whole payload object — the gear resolves the pointer and
stringifies what it finds, so every value in a payload reaches the search text.
That costs precision (field *names* become tokens too) and buys the thing that
matters more: **a field edit cannot change a type's schema**, so extending a
type is a pure ontology edit for indexing as well as for storage. A field added
long after the type was registered is searchable — which under the old scheme
it could never be.

Registration still tolerates an immutable-schema refusal rather than failing on
it — the batch is retried type by type and the drifted ones are reported as
`pinned_types` on `POST /model/sync` and logged. It is now for a real type
migration rather than for an accident. **Upgrading an existing graph is one:**
its 140 types were registered with the old per-entity traits, keep them, and
are reported as pinned until the types are migrated. A fresh graph registers
the fixed traits from the start.

## HTTP surface (`/cf/studio-domain-model/v1`)

| Method + path | Goal | Does |
|---|---|---|
| `GET  /types` | 3 | the stored ontology (frontend-regen source) |
| `GET  /relations` | — | the relation catalog with endpoint typing + cross-bucket gaps |
| `POST /model/sync` | — | store the model itself as a graph (see below); reports `version` + `pinned_types` |
| `GET  /model/versions` | — | the model's change history, newest first |
| `POST /model/revert` | — | restore the model to an earlier version |
| `GET  /model/graph` | — | read that model graph back out of Graph Storage (nodes + edges) |
| `GET  /types/{id}` | — | one type with everything it inherits, and its relations |
| `POST /objects` | 1 | create/upsert an object (`validate` checks it, `if_absent` refuses to replace) |
| `GET  /objects?type=` | — | read objects back |
| `POST /relations` | — | relate two objects (member/owns/references/composes) |
| `POST /types/{id}/fields` | 2 | extend a type with a new field |

### The model itself, as a graph

`POST /model/sync` stores the ontology's **structure** as a graph: one
`object_type` node per entity, joined by `inherits` edges (an entity to the base
it extends) and `declares` edges (an entity to each related entity, carrying the
relation's verb / cardinality / label), plus one `model` node for the
document's non-entity part. So the domain model — with its relations — is
itself queryable in Graph Storage, matching the model's own
ObjectType / RelationType / KnowledgeGraph notion.

The sync is **lossless**: each `object_type` node carries the whole entity
document under `entity` alongside the flat keys a query or a visualization
reads. That is what lets the model be read back rather than only written. Endpoints that name no
modeled entity (a non-core base, a cross-model target) are skipped and counted,
never turned into dangling edges.

### A relation has to be one the model declares

`POST /relations` names a relation either by a declared name — `team.has_members`,
or a bare `has_members` — or by a bare verb (`member`, `owns`, …). Either way
the gear reads both endpoint objects, resolves their entity types, and requires
the pair to be one of the model's 339 declared relations. A relation declared
on a base counts for everything that extends it (`typed_by` is declared on
`managed-object`, so a `project` has it).

A bare token is resolved **against the endpoints**, not before them: `owns` is a
verb and also a property name on `project` and `membership`, and only the pair
being related says which is meant. An undeclared pair is refused with what the
model does allow from that source.

The edge is written with the declared relation's name as its discriminator and
its verb / label / cardinality in the payload, so two relations of one verb
between the same pair — `tenant owns team` and `tenant contains team` — stay
distinct edges instead of collapsing into one.

Letting an undeclared pair through would mean the model describes the graph
without constraining it, and there would be nothing to reconfigure.

### Relations are endpoint-typed

A relation is not synced as a bare verb: each relation kind is registered with
`x-gts-traits.src_types` / `dst_types` gathered from the ontology, so the graph
and the type-registry know which object types a relation may connect. Targets
that name an entity outside the current slice (another bucket) are **reported**
by `GET /relations` (`unresolved`) rather than silently dropped — they resolve
as those buckets are added.

## Run the loop

```bash
# 1. start the backend (real graph store on the `graph` feature, default)
cargo run -- --config config/dev.yaml run

# 2. exercise create -> relate -> extend -> read
demo/domain-model.sh

# 3. regenerate the model-UI file set from what is stored
curl -s -H "Authorization: Bearer studio-admin-token" \
  http://127.0.0.1:8090/cf/studio-domain-model/v1/types > /tmp/types.json
node scripts/regen-domain-frontend.mjs /tmp/types.json --out regen-out \
  --validate ../../studio-internal/domain-model-ui/schema-validator.js
```

Without the `graph` feature (`--no-default-features`) the gear falls back to an
in-memory store, so the create/read loop still runs.

## Layout

- `ontology.core.json` — the bootstrap seed: the regeneration-complete core model
- `ontology.rs` — loads the model; derives node/edge types; **extends** a type;
  resolves what a type inherits (`effective_properties`); reassembles a model
  from what the graph stores (`from_parts`)
- `validate.rs` — checks an object against the type the model says it is
- `gts.rs` — GTS id derivation (node/edge ids, family derivation, instance ids)
  including the meta layer: `model`, `model_version`, `object_type` and the
  `revises` / `inherits` / `declares` edges
- `store.rs` — `DomainStore` over the graph-storage SDK + in-memory fallback
- `service.rs` / `rest.rs` / `mod.rs` — orchestration, HTTP surface, gear wiring
- `../../scripts/regen-domain-frontend.mjs` — model → model-UI file set (goal 3)
