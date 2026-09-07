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
entities) as its ontology, so `extends` resolves to modeled bases.

## Mapping to GTS

| Domain concept | GTS |
|---|---|
| entity (`team`) | node type `gts.cf.studio.domain.team.v1~`, derived from `owned_node` |
| relation kind (`member`, `owns`, `references`, `composes`) | edge type `gts.cf.studio.domainrel.<kind>.v1~`, derived from `static_edge` |
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

## HTTP surface (`/cf/studio-domain-model/v1`)

| Method + path | Goal | Does |
|---|---|---|
| `GET  /types` | 3 | the stored ontology (frontend-regen source) |
| `GET  /relations` | — | the relation catalog with endpoint typing + cross-bucket gaps |
| `POST /model/sync` | — | materialize the model itself as a graph (see below) |
| `GET  /model/graph` | — | read that model graph back out of Graph Storage (nodes + edges) |
| `POST /objects` | 1 | create/upsert an object of a domain type |
| `GET  /objects?type=` | — | read objects back |
| `POST /relations` | — | relate two objects (member/owns/references/composes) |
| `POST /types/{id}/fields` | 2 | extend a type with a new field |

### The model itself, as a graph

`POST /model/sync` stores the ontology's **structure** as a graph: one
`object_type` node per entity, joined by `inherits` edges (an entity to the base
it extends) and `declares` edges (an entity to each related entity, carrying the
relation's verb / cardinality / label). So the domain model — with its relations
— is itself queryable in Graph Storage, matching the model's own
ObjectType / RelationType / KnowledgeGraph notion. Endpoints that name no
modeled entity (a non-core base, a cross-model target) are skipped and counted,
never turned into dangling edges.

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

- `ontology.core.json` — the embedded, regeneration-complete core model (10 buckets)
- `ontology.rs` — loads the model; derives node/edge types; **extends** a type
- `gts.rs` — GTS id derivation (node/edge ids, family derivation, instance ids)
- `store.rs` — `DomainStore` over the graph-storage SDK + in-memory fallback
- `service.rs` / `rest.rs` / `mod.rs` — orchestration, HTTP surface, gear wiring
- `../../scripts/regen-domain-frontend.mjs` — model → model-UI file set (goal 3)
