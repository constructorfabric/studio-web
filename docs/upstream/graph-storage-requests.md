# What Studio needs from graph-storage

*From the Studio backend team, 2026-09-10. Against `cf-gears-graph-storage-v0.1.1`
(rev `719ab47`), which is what we run.*

We built the Studio domain model on graph-storage: 140 entity types, their
relations, and the objects people create against them, all in the graph. It
works. Along the way we hit five things that the gear cannot express, and
worked around each one — this is what those workarounds cost and what would
remove them.

*Item 5 was added 2026-09-21, from profiling the artifact listing rather than
from building the model. It is the most expensive of the five at runtime; it is
last because renumbering the others would break every reference to them.*

*Re-checked 2026-10-07 against `cf-gears-graph-storage` 0.1.4 and its SDK
0.1.1 from crates.io, which is what we run now. Items 2, 3 and 5 gained a
status line. Items 8–11 come from the experimental domain-model query
(`POST /studio-domain-model/v1/query`, `studio-backend/src/domain_model/query.rs`): the first read in
Studio that wants the graph to answer a screen's question rather than hand
back a region for us to sift.*

Nothing here is a bug report. Each item is a capability that is *almost* there:
the mechanism exists, and something small keeps us from using it.

Ordered by how much it would help us, most first.

---

## 1. Let one bad type in a batch fail on its own

**Today.** `register_types` takes a batch and commits it whole. If one type in
it is refused, the whole call fails and nothing is registered.

**Why that hurt.** Our model registers 145 types at once. A single type whose
schema had drifted made that call fail — and because we register before every
first write, *every* write in the model stopped. One type nobody was using took
down the other 144.

**What we did instead.** When the batch fails we now retry type by type, 145
separate calls, and collect the ones that were refused. It works and it is
slow, and every other producer that registers more than one type at a time will
write the same fallback.

**What we need.** Per-item outcomes on registration, the way ingest already
does it: the batch reports which types were admitted and which were refused,
with the reason, instead of failing as one. `IngestOptions.report_per_item`
is exactly the shape we mean.

**How we would know it works.** Register two types in one call where one is a
conflict: the other one is registered, and the response names the conflict.

---

## 2. Tell us a node's version when we read it

**Today.** `NodeSpec.expected_version` is a real compare-and-set — ingest
refuses the write when the version disagrees with what is stored. But no read
returns that number. `NodeView` and `NodeRow` carry an `ElementEnvelope` with
`created_at/by`, `updated_at/by` and the graph revision the *read* observed —
not the element's own version.

**Why that matters.** The ordinary safe-update flow cannot be written:

```
read node → change the payload → write with expected_version = <the version I read>
                                                                ^ we have no way to get this
```

So every update in our gear is last-writer-wins. Two people editing the same
object silently overwrite each other.

**What we did instead.** We use the one thing that *is* expressible:
`expected_version: 0` means "this node must not exist", because a live node's
version is 1 or more. That gives us create-if-absent, and we built our model's
version numbering on it — claiming version N is an insert at a key derived from
N, which exactly one writer can win. It works well and it only guards
*creation*.

Faking the missing piece is possible and we decided against it: carry a
revision counter in the payload and, before each write, insert a claim node
keyed on `(node_key, next_rev)`. That costs one extra node **per revision,
forever** — a tombstoned key cannot be re-ingested, so the claims can never be
cleaned up — and doubles the cost of every write. Not a fair price for one
integer on the read path.

**What we need.** The element's own version on the read path — a field on
`ElementEnvelope`, or on `NodeView` / `NodeRow` directly. The value is already
selected; only the mapping to the SDK type drops it.

Edges have no `expected_version` at all, so the same question applies there,
one step further back.

**How we would know it works.** Read a node, change its payload, write it back
with the version that came out of the read: it succeeds. Do the same from two
readers on one version: exactly one succeeds.

**Status, weftgraph 0.3.0-rc.2 (#966): landed.** `ElementEnvelope.version`
carries the node's stored version on every read (absent on an edge). The
domain query's write path can now form a read-then-write CAS; it has not been
moved onto it yet.

**Status, 0.1.4.** Still open: `ElementEnvelope` carries `graph_revision`, the
revision the read observed, and not the element's own version. The domain
query's write path (step 5 of the migration plan in
[`../domain-query-migration.md`](../domain-query-migration.md)) waits on this.

---

## 3. Let a published schema change

**Today.** graph-storage stores one schema per type, as a column on `gts_type`,
and re-registering the same type with any different schema is a conflict. There
is no update path at all: not through registration, which refuses, and not from
the platform types-registry, because graph-storage does not read it.

That last part is worth being precise about, because the code says otherwise.
`gts_type`'s own doc comment reads:

> Per-tenant projection of the platform types-registry … The registry stays
> authoritative — this is a cache with a foreign identity, never a second
> source of truth.

But the gear does not depend on `types-registry` — not in `Cargo.toml`, not one
reference in `src/`. DESIGN states the boundary deliberately: the Ontology
Registry *"does not publish the gear's own base types to the platform
types-registry (the gear lifecycle does, once, at startup)"*. Publication is
one-way and one-time. So the row is not a projection of anything; it is filled
by whatever a producer posted and is authoritative in practice while documented
as a cache. Either the comment or the behaviour should change.

Meanwhile the platform registry has all of this: `type_schema` with a
current-revision pointer, immutable `type_schema_revision` snapshots,
`version_family`, cross-minor compatibility and a deliberate `force` waiver.
graph-storage flattens it away.

**Why that matters.** A type's schema is not a constant. Ours carried the
payload paths each type is searched and embedded on, derived from the modelled
entity's fields — so adding a field to a type made its schema unregistrable.
Combined with item 1, one added field stopped every write in the model.

**What we did instead.** We removed everything model-derived from our schemas:
the search paths are now the same fixed set for all 140 types. That was the
right call on its own — a schema that cannot change should not be a function of
data that can — but it also means the indexing a type gets can no longer follow
what the type actually holds. That capability is given up purely to work around
this.

**What we need**, smallest first:

- item 1 above, so a refusal is survivable;
- the revision on `TypeRecord` — whatever `type_schema` holds is *some*
  revision, and a reader cannot name it;
- graph-storage reading the registry's `type_schema.revision_no` and refreshing
  `gts_type` when it moves. Compatibility, forcing and history stay upstream
  where they are already implemented; this gear follows the pointer.

**Timing.** `constructorfabric/gears-rust#4619` (Types Registry P0) is building
the durable registry, immutable revisions, version families, compatibility
verdicts and a **new SDK trait that deletes `TypesRegistryClient` outright**,
with ~50 call sites across 20+ gears migrating inside P0. graph-storage is not
mentioned in that epic — not in scope, not out of scope. It fits: the gear is
not a consumer today. But it means P0 will build exactly the machinery this
item asks for and graph-storage will still not read it. Adding a consumer to a
contract being designed now is cheaper than adding one to a shipped one.

**How we would know it works.** Register a type, change its schema in the
registry, read it back through `get_type`: graph-storage serves the new one.

**Status, 0.1.4: landed over REST, not on the client.** A registered type can
now change in place. `options.on_existing: "update"` admits a change the
schemas prove backward compatible. `revalidate` admits one the stored rows
satisfy. `migrations` (rename, default, drop) rewrites the rows first.
`TypeRecord.revision` counts the updates, and a dry run reports every verdict
with its schema locations and trait changes. That is everything this item
asked for except reading the platform registry, and we no longer need that.
It is reachable only through `POST /graph-storage/v1/types`, though: the
in-process `GraphStorageClientV1::register_types` takes no options, and the
local client passes the defaults (`Reject`). Studio links the gear in-process,
so for us the update does not exist yet. That is item 8.

---

## 4. Make removing something possible

Three smaller limits that add up to the same thing: our model can grow but not
shrink.

**A tombstoned node key cannot be reused.** `delete_node` soft-deletes the node
and its incident edges in one transaction, which is good. But the key is then
unusable until a purge, and the SDK exposes no purge. For a model that is meant
to be reconfigured this inverts the cost: deleting an entity is easy and
*re-adding* it later is impossible.

We therefore never delete. When a model shrinks — an import that drops an
entity — we leave the old `object_type` nodes in place and keep an authoritative
list of entity ids on the model node, so the dropped ones are simply not read
back. An entity that returns is adopted again for free. This works, and it
means the graph accumulates rows nothing will ever collect.

The components catalogue learned the same lesson the hard way. Its sync pruned
a component that left its source with `delete_node`; the keys are a uuid5 of
the name, so when the component came back every later sync aborted on
`node key … is tombstoned and cannot be re-ingested before purge`, and nothing
else in that run was stored either. The catalogue now retires instead of
deleting: it overwrites the payload with a `studio_catalog_retired` marker and
its reads skip it, and the next ingest of the key brings the component back.
Keys tombstoned before that change stay dead; the sync skips them (and their
edges) with a warning rather than failing, which it can only do by reading the
key out of the error's detail — the refusal is a plain `CAS_CONFLICT` abort.
A distinct reason (say `NODE_KEY_TOMBSTONED`) carrying the key would make that
mechanical.

Two smaller findings from the same investigation: edges *are* revived by a
re-ingest (`upsert_edge` clears `deleted_at`), unlike nodes, and an edge's
endpoint lookup does not filter tombstoned nodes, so a batch can attach a live
edge to a deleted node — which Soft Delete rule 2 says cannot happen.

*Need:* either a purge on the SDK, or a documented way to reuse a tombstoned
key. Even "tombstones are purged after N days" would let us plan.

**Declarative scope replacement does not remove anything.** `replace_scope` is
in the request shape and takes the fence and the generation, but
`fence_and_clear_scope` removes no rows — the code says so, and DEVIATIONS
records it as a scope cut. So the one API that would let a producer say "this
batch is the complete contents of this scope" cannot yet do it. We would use it
for exactly the case above.

*Need:* the removal half of scope replacement, or its removal from the request
shape until it exists — right now it reads as available.

**Adjacency cannot be paged.** A node read returns each incident edge's key
(good — that is what makes `delete_edge` usable at all), but bounded by
`node_read_max_adjacency` (100 by default, 1000 maximum) with a truncation flag
and no cursor. A node with more edges than the ceiling can never have all of
them enumerated, so "remove every edge of this kind on this node" is not
expressible in general.

*Need:* a cursor on adjacency, or an edge listing by endpoint.

---

## 5. Let the projection filter and order on payload attributes

Every read of the artifact listing pulls the whole graph for a tenant, because
the three things it narrows by all live in the payload.

`GET /studio-artifact-ingest/v1/nodes` filters by `scope` (a node's
`workspace_id` or `project_id`), optionally by `repo`, and orders either by the
artifact's own `updated_at` or by key. The projection's `$filter`/`$orderby`
accept `node_key`, `name`, `created_at` and `updated_at`; a `$filter` on
`payload/...` is refused, and the `index` trait that names the indexable paths
is stored but not wired to the filter surface.

So the adapter does the only thing it can: it walks `project_nodes` by cursor to
exhaustion, then filters, sorts and slices one page in our process. Every page
request re-reads the entire typed node set.

**What that costs, re-measured on studio-dev on 2026-09-22** against the graph
as it now stands, at the gear's `projection_max_page` of 200:

| | `project_nodes` calls | node rows materialised |
|---|---|---|
| one page request | 144 | 28,717 (31 MB of payload) |
| a client walking all 144 pages | **20,736** | **~4.1 M** |

The p95 of `GET /studio-artifact-ingest/v1/nodes` is **8.06 s**, measured at the
backend over 24 hours; the next-slowest endpoint in the product is 1.67 s. The
walk is sequential — a cursor cannot be split — so those 144 round trips are
144 latencies in series, and that is the whole of the 8 seconds.

The earlier figures in this document were 29 calls and 5,785 rows on one
project. Nothing regressed; the graph grew. **That is the point worth taking
from the re-measurement: the cost is linear in the size of the project, and
nothing about the shape of this read has a ceiling.**

The portal has twice been optimised to make fewer requests against this
endpoint; both times the multiplier inside it stayed. (A thirtieth call per
request, to re-register our types, is no longer among them — this process now
remembers that per tenant. The projection calls are what is left, and they are
yours.)

**Ordering cannot even be approximated.** We considered pushing `$orderby` down
for the `sort=updated` case and cannot: the projection's `updated_at` is when
the row was last written to the graph, and `NodeSpec` carries no `updated_at`
for us to set, so on a re-sync it means "when the sync touched this" — which is
unrelated to when the issue was updated on the forge. Pushing it down would
silently reorder the screen rather than speed it up.

*Need:* `$filter` and `$orderby` over the payload paths a type declares — the
`index` trait already names them, so the declaration exists and only the
binding is missing. Failing that, `updated_at` as a caller-supplied field on
`NodeSpec` would fix ordering alone, which is the smaller half.

### Where this change lives, as far as we can see it

This is not a one-line addition in graph-storage, and it is worth saying where
the weight actually is before anyone scopes it as one. Read on 2026-09-22
against `gears-rust` at `719ab47`:

1. **`libs/toolkit-db/src/odata/sea_orm_filter.rs` — the real blocker, and it
   is platform-wide rather than graph-storage's.** `FieldToColumn::map_field`
   is typed `fn(F) -> Self::Column` where `Column: ColumnTrait + Iden +
   IntoSimpleExpr`. A filter field IS a table column, by construction. A
   payload path is an expression — `payload #>> '{repo}'` — and there is no
   way to return one through that signature. Until this trait can carry an
   expression-backed field, no gear in the platform can filter on a JSON path.

2. **`libs/toolkit-odata-macros/src/odata_filterable.rs`.** The filterable set
   is generated at compile time from `#[odata(filter(kind = "..."))]`
   attributes on the row DTO. Payload index paths are declared per type, at
   runtime, by whoever registers the type — so the generated field enum needs
   a dynamic variant (`Payload(String)`) alongside its static ones. This is
   the part that makes the request a design change rather than a mapping.

3. **`gears/graph-storage/graph-storage-sdk/src/models.rs`** — the row DTO
   carrying those attributes, from which `NodeQueryFilterField` (re-exported as
   `NodeFilterField`) is generated. The wire contract.

4. **`gears/graph-storage/graph-storage/src/infra/storage/odata_mapper.rs`** —
   41 lines, four arms, one per filterable field. This is where a payload path
   would become a JSONB expression, and where `extract_cursor_value` would have
   to learn to read one back out for the continuation token.

5. **`gears/graph-storage/graph-storage/src/domain/ontology.rs:192`** —
   `index: string_array(merged.get("index"))`. The trait is already parsed into
   `EffectiveTraits`, stored in `gts_type.effective_traits`, and echoed back by
   `api/rest/dto.rs`. It is read by nothing else. This is where "is this path
   declared indexable for this type?" belongs, and it is the reason we keep
   saying the declaration exists and only the binding is missing.

6. **`infra/storage/migrations/`** — `payload` is `JSONB` with **no index**.
   The schema creates indexes for edge src/dst/type, node type, the lexical
   `search` vector and the embedding, and nothing on payload. So a `$filter` on
   a payload path would be correct and still be a sequential scan; making it
   fast needs either a GIN index on `payload` or an expression index per
   declared path, created when the type is registered.

We would rather be wrong about any of this than have it scoped from the API
surface alone.

### What we did in the meantime

The workaround named above is now implemented on our side: a per-tenant cache
of the projection in the backend process, dropped the moment an ingest is
accepted and expiring after 60 s so a second replica's ingest cannot be served
stale for longer than that. It turns a client's walk through its own pages from
one graph walk per page into one in total.

It is still a cache of a query we should have been able to write, it is bounded
by a node budget because it holds parsed payloads in a pod with a 1 GiB limit,
and it does nothing for the first request after any write. None of that is
fixed by making the cache better.

The cache was then replaced by `studio_artifact_index`, our own Postgres
mirror of the listed fields (`src/artifact_ingest/index.rs`).

### Status, weftgraph 0.1.1 (checked 2026-09-29)

**The binding landed.** `$filter`/`$orderby` accept `payload/<path>` for the
paths the selected types declare in their `index` trait. Equality on a string,
boolean or date-time is served by one GIN over the payload; `contains` and
`startswith` work too. The cursor is bound to its `$filter` (G-1), and m0009
adds `(tenant, type, node_key)` for filtered listings (G-6).

**It still does not replace the index.** Everything the index serves in one
query today, and what the projection gives instead:

| the index does | the projection in 0.1.1 |
|---|---|
| `total` for the pager and the portfolio counts (`COUNT`) | no count: `Page` carries `next_cursor` and `limit` only, so a count means walking every page |
| offset pages (`?offset=`) and "just after this id" | cursor only; an offset is a walk |
| order by the artifact's own `updated_at`, indexed | allowed, but ordering on a payload path is not indexed: a scan of the type's rows |
| `q` substring over title, author, path and number (one lower-cased column) | `contains` on one payload path per term, no index; four paths means an `or` of four scans |
| scope = `workspace_id` OR `project_id` | expressible as an `or` of two equalities |
| the file list reads three columns, no payload | every row carries its payload |

And one deployment blocker: our artifact types declare no `index` trait. Adding
one changes a stored schema, which the in-process client cannot update
(`register_types` takes no `on_existing`; see
`scripts/graph-storage-update-edge-types.sh` for the same problem on edges).
Every environment would need a REST update of 18 types before the first ingest.

**Status, 0.1.4.** Unchanged from 0.1.1 for this item: the payload `$filter`
and `$orderby` are there, with the GIN behind equality, and there is still no
count and no offset. The deployment blocker is now item 8.

**Status, weftgraph 0.3.0-rc.2 (#966).** Two of the gaps closed: a count
(`count_nodes`, exact up to `projection_count_max`, 10 000 by default, then
`capped`), and the in-process type update (item 8). Still open: no offset, no
index behind a payload ordering, no field selection, and the artifact types
declare no `index` paths or the typed properties an `index` path needs.

**So: keep the index.** Delete it when the projection has a count (or the
screens stop needing one), a payload ordering can use an index, and the client
can update a stored type. The migration then is: declare `index` on the listed
types (`workspace_id`, `project_id`, `repo`, `path`, `is_dir`, `updated_at`),
update them on each environment, route `IndexedGraphStore`'s five reads to
`project_nodes` with a `$filter`, and drop the two tables and their fill.

---

## 6. Let us read all the relations of a high-degree node

There is no call in this gear that returns the complete adjacency of a node
past ten thousand, and one real repository already has more.

Reading the relation graph back for the portal has two shapes available, and
both are capped:

| call | what bounds it | ceiling its validation allows |
|---|---|---|
| `get_node` | `node_read_max_adjacency` | 1,000 |
| `traverse` | `traversal_max_nodes`, seeds included | 10,000 |

Neither pages. `project_nodes` pages the node set with a cursor; the edge side
has no equivalent, so once a node's degree passes the ceiling the remainder is
not reachable by any sequence of calls.

**Measured on studio-dev**, over the 8,825 nodes whose relations the portal
draws, 79,184 relations between them:

| | relations unreachable |
|---|---|
| `get_node` per seed, adjacency 100 (what we shipped before) | 27,852 — **35%** |
| `get_node` per seed, adjacency at its 1,000 ceiling | 13,288 |
| `traverse`, seeds chunked, budget at its 10,000 ceiling | 5,944 — three nodes |

We have taken the last row: it is also 8,825 calls down to about twenty. But
the remaining three nodes are a repository and its two busiest artifacts, which
are exactly the nodes a graph view is drawn around, and their missing edges are
the `contains` and `artifact_of` relations that give the picture its shape.

Worse, the omission is silent by construction. A truncated traversal sets
`truncated`, and we log it — but the portal is handed a relation set that is
simply incomplete, with no way to ask for the rest. A caller cannot distinguish
"these are the relations" from "these are the first ten thousand".

*Need:* a cursor over edges — the shape `project_nodes` already has. Either an
edge projection bound to the same `OData` options, or a continuation token on
`traverse` so an exhausted budget can be resumed rather than only reported.

Failing that, raising `traversal_max_nodes`' validated ceiling would buy time
and not much else: degree here grows with the repository, so any fixed ceiling
is a date rather than a fix.

---

## 7. Refuse a NUL as a validation error, not as `unknown`

PostgreSQL can store U+0000 in neither `jsonb` nor `text`. A payload string
carrying one — valid UTF-8, and present in real source files (this repository's
`scripts/check-api-usage.mjs` has one) — reaches the insert and fails there
with `unsupported Unicode escape sequence`. The gear maps it to `unknown:
internal error`, the detail never leaves the gear's log, and the batch is lost:
every repository sync of studio-web dead-lettered on that one file. We found
the cause only in the database server's own log.

We now strip NUL from every payload string, key and name before ingest. *Need:*
validate it at the boundary — an `invalid_argument` naming `nodes[i]/payload/…`,
through the per-item report — or normalize it, and say which in the contract.

---

## 8. Let the in-process client update a type

*Filed: already tracked as constructorfabric/gears-rust#5021 (registration options on the contract, planned for Q1); our use case is [a comment there](https://github.com/constructorfabric/gears-rust/issues/5021#issuecomment-6032587024).*

**Today.** 0.1.4 updates a registered type in place (item 3's status), and the
domain service already exposes it as `register_types_with(ctx, batch,
TypeRegistrationOptions)`. The client trait does not. `GraphStorageClientV1::
register_types(ctx, batch)` has no options parameter, and
`GraphStorageLocalClient` calls the service with `TypeRegistrationOptions::
default()`, which is `OnExisting::Reject`. Every Studio gear reaches graph-storage
through that client, so for Studio a registered type is still immutable.

**Why that matters now.** The domain query filters in our process over at most
5,000 objects of a type. Domain types declare no `index`, because adding one
later was impossible. The model knows which fields screens filter and sort on.
Declaring them in `index` would let `project_nodes` do the filtering with the
GIN behind it. That is an update: a trait change plus a typed property per path
(an `index` path needs a typed property at that path, or registration refuses
it). A typed property narrows the valid set, so it is not
schema-proved and needs `revalidate`. The same wall stands in front of the
artifact types (item 5's deployment blocker) and the edge types
(`scripts/graph-storage-update-edge-types.sh` exists only because of it).

**What we need.** `register_types_with(ctx, batch, options) ->
Vec<RegisteredType>` on `GraphStorageClientV1`, forwarding to the service method
that is already there. Returning `RegisteredType` rather than `TypeRecord`
gives the caller the outcome and the verdict, which is also item 1's per-item
report for free.

**Status, weftgraph 0.3.0-rc.2 (#966): landed.**
`GraphStorageClientV1::register_types_with` takes the options and returns
`RegisteredType`. The artifact and catalog registrations pass
`on_existing: Update`, and `scripts/graph-storage-update-edge-types.sh` is
deleted. The batch is still atomic (item 1 stays open).

**How we would know it works.** In process, register a node type with no
`index`. Register it again with `index: ["/payload/status"]`, a string property
at that path, `on_existing: Update` and `revalidate: true`. The outcome is
`Updated` with basis `DataBacked`, and `$filter=payload/status eq 'active'` is
admitted on `project_nodes`.

---

## 9. Let a traversal go one way

*Filed: constructorfabric/gears-rust#5239, spun out of the `direction` line in #5012.*

**Today.** `TraverseRequest` has seeds, depth, edge and node type patterns and
`max_nodes`. The walk always expands `Direction::Either` (`domain/traversal.rs`:
*"Edges are treated as undirected for reachability"*), although the engine's
`ExpandRequest` takes a direction and both directed scans exist.

**Why that matters.** A relation is read from one side. "The projects this team
delivers" is `delivers` outgoing from the team; "the team that delivers this
project" is the same edges incoming. With `Either` the walk returns both halves
and we throw one away by checking `src` against our seeds. Worse, both halves
draw on one budget, so on the hubs item 6 is about, half of `traversal_max_nodes`
is spent on edges the caller already said it does not want. And the reverse read
("which teams deliver this project") cannot be asked at all without receiving the
forward edges too.

**What we need.** `direction: Option<Direction>` on `TraverseRequest`, applied
to every hop. `None` keeps `Either`, so no existing caller changes.

**How we would know it works.** Edge A → B. Traverse from B with `Outgoing`:
no edge. With `Incoming`: A. With `None`: A, as today.

**Status, weftgraph 0.3.0-rc.2 (#966): landed.** `TraverseRequest.direction`
(and on `NeighborhoodRequest`). The domain query walks `Outgoing`.

---

## 10. Say which relation a traversed edge is

*Filed: constructorfabric/gears-rust#5240.*

**Today.** `EdgeSpec` and `EdgeView` carry `discriminator`, the value that keeps
parallel edges of one type between one pair apart. `EdgeRef`, which `traverse`,
`neighborhood` and the topology page return, carries key, type and endpoints
only. The edge key is derived from the discriminator, but it is opaque. The
only way to learn it is `GET /edges/{edge_key}`, one call per edge.

**Why that matters.** The Studio model declares 339 relations, and they are
stored as edges of 5 types: the edge type is the relation's verb (`owns`,
`references`, …), and *which* relation an edge is lives only in the
discriminator. Counted against the model on 2026-10-07: **50 of the 300
relations whose target resolves share a verb with another relation of the same
source, between overlapping types.** Examples:
- `project.uses` (→ repository) and `project.includes_3` (→ managed-object), both
  `references`. A repository is a managed-object, so asking for `includes_3`
  returns every repository the project `uses`.
- `tenant.contains_7` (→ project) and `tenant.owns_shared` (→ managed-object),
  both `owns`.

The query answers these with a warning that says the result may include the
other relation's edges. It cannot do better.

**What we need.** `discriminator: Option<String>` on `EdgeRef`. Better still, a
discriminator filter on `TraverseRequest`, next to `edge_type_patterns`, so the
walk carries only the relation that was asked for.

**How we would know it works.** Two edges of one type from A to B with
discriminators `x` and `y`. A traversal from A returns both, each with its
discriminator. With the filter `x`, only one comes back.

**Status, weftgraph 0.3.0-rc.2 (#966): landed**, both halves:
`EdgeRef.discriminator` and `TraverseRequest.edge_discriminators`. The domain
query filters on the relation's name, so the warning now fires only for two
relations with the same verb and the same name.

---

## 11. Narrow and bound a traversal per seed

*Filed: constructorfabric/gears-rust#5241.*

*Lower priority than 8–10. Each of those removes a wrong answer, and this one
removes wasted work.*

**Today.** A traversal is bounded by `max_nodes` for the whole request, and
`node_type_patterns` is the only filter on what it reaches.

**Why that matters.** The query batches each relation across all parent rows,
the way a federated engine batches a join: one traversal per relation and
level. A screen wants "the first 5 active projects of each team, with how many
there are". Today the walk returns every neighbour of every seed, with full
payloads. We filter, sort, count and cut per parent in our process, and one
team with a thousand projects consumes the budget the other seeds needed.

**What we need**, either of:
- a `$filter` over the reached nodes' declared `index` paths, the same binding
  `project_nodes` has, plus a per-seed limit and a per-seed count; or
- a projection keyed by edge: `project_nodes` restricted to the nodes adjacent
  to a seed set through an edge type, in one direction. That is the
  "objects related to these" read, and it would page, count and filter like any
  other projection. It would also answer item 6.

**How we would know it works.** Two seeds, one with 1,000 neighbours and one
with 3. Per-seed limit 5 and a filter on an indexed path: each seed gets at most
5 filtered neighbours and its own count, and neither starves the other.

---

## What we are not asking for

**GTS major versions of a type** (`requirement.v2~` alongside `v1~`). We looked
at it and stopped, because two things make it unworkable before the API even
matters: without item 3 the two identifiers are unrelated types rather than a
family, and a node's concrete type is immutable under upsert, so the existing
objects cannot move from v1 to v2 in place. Creating them anew under new keys
and tombstoning the old ones runs straight into item 4. This is the right
answer eventually; it is not a small ask, and items 1–3 are worth more to us
sooner.

---

## Summary

| | Ask | Have now | Costing us |
|---|---|---|---|
| 1 | Per-item outcomes on `register_types` | all-or-nothing batch | 145 fallback calls; one bad type stops every write |
| 2 | Node version on the read path | landed in 0.3 (`ElementEnvelope.version`) | updates stay last-writer-wins until the write path uses it |
| 3 | A published schema can change | landed in 0.1.4 over REST (update, revalidate, migrations, revision) | nothing in itself; the in-process half is item 8 |
| 4 | Removing is possible and reversible | tombstones are permanent, scope replacement is inert, adjacency unpaged | the graph only grows |
| 5 | `$filter`/`$orderby` on payload attributes | landed in weftgraph 0.1.1 for `index`-declared paths, without a count or an indexed payload ordering | nothing at runtime now (`studio_artifact_index` serves it); the mirror itself, until the gaps in item 5's status close |
| 6 | A cursor over edges | adjacency capped at 1,000, traversal at 10,000, neither pages | the relation graph comes back incomplete and says it is complete — 5,944 of 79,184 relations unreachable |
| 7 | A NUL in a payload is a validation error | landed in weftgraph 0.1.1 (refused at admission with the JSON path; G-3) | nothing |
| 8 | Type update on the in-process client | landed in 0.3 (`register_types_with`) | nothing; declaring `index` paths on our types is our work now |
| 9 | `direction` on `traverse` | landed in 0.3 | nothing |
| 10 | `discriminator` on traversed edges | landed in 0.3, with a filter | nothing |
| 11 | Per-seed filter, limit and count on a traversal | one `max_nodes` for the request | every neighbour fetched to show five per parent |

Items 1 and 2 are small and independent — a per-item report and one integer.
Item 3 is the structural one and is best decided alongside `#4619`. Item 4 is
three separate small ones that happen to share a consequence. Items 5 and 6 are
the same shape from two directions: the node side pages and cannot be narrowed,
the edge side can be narrowed and does not page.

Items 8–10 are small, and each is a parameter or a field over something that
already exists: a service method, an engine direction, a column. Item 8 is
the one that changes the most for us. Item 11 is the shape we would like the
read to reach eventually, and it is worth deciding alongside item 6.

Happy to open these as individual issues, provide reproductions against a
stand, or test a branch. The Studio domain-model gear
(`studio-web/studio-backend/src/domain_model`) exercises all four paths and can
serve as the integration case.
