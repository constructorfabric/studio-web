# ADR-0020: One contract with the frontend, enforced rather than agreed

Status: **proposed** · Date: 2026-09-14 · Builds on ADR-0013 · Relates to ADR-0006

## Context

This assembly exposes about 170 REST operations across 18 domains, and every one
of them was designed inside the gear that owns it. That is the right way to
build a gear and the wrong way to build an API: the gear boundary is an
implementation fact, and the portal does not consume gears, it consumes the
Studio. What the portal actually got is eighteen small APIs that agree on the
transport and on nothing else.

Five axes have measurably diverged.

**The domain segment.** `spec-quality` carries no `studio-` prefix at all.
`studio-connector`, `studio-user` and `studio-session` are singular;
`studio-documents`, `studio-organizations`, `studio-kits` and `studio-tasks` are
plural. Nothing decides which a new gear picks except which file its author had
open.

**Scope.** There are five ways to say where an operation applies. In the path
(`/studio-documents/v1/workspaces/{id}/…`, `/studio-kits/v1/projects/{id}/…`),
in the query (`studio-artifact-ingest` takes `workspace_id`, `project_id` and
`organization_id`), and from the security context (`studio-events`,
`studio-tasks`). The names disagree — `org_id` beside `organization_id`,
`tenant_id` beside `workspace_id` — and so do the types, `String` in some DTOs
and `Uuid` in others. The cost is not cosmetic: because the scope is in the
path, `studio-documents` carries `list_workspace_documents` and
`list_project_documents` and `list_organization_types` and `list_types`, four
operations for one thought, each of which the frontend learns separately.

**The list envelope.** Usually `{ items, total }`. Also `{ nodes, total,
next_cursor }`, `{ edges, total }`, `{ aliases }`, `{ events, latest_seq }`,
`{ materializations }`. `total` is present on fewer than a fifth of the
collections, and it is `u32` in six places and `u64` in one.
`studio-backend/src/pagination.rs` already states the single contract; most
endpoints predate it and none is obliged to follow it.

**Waiting for work.** `studio-tasks` owns every background run in the assembly,
with state, attempts, cancel and retry, and since ADR-0013 it announces every
transition on the one push channel. And yet four gears still expose a private
status endpoint — `studio-artifact-ingest`, `studio-components-catalog`,
`studio-connector` and `spec-quality` each have their own `/tasks/{id}` with
their own progress shape. A client that starts work in two different gears has
to learn two ways to find out how it went.

**The frontend half.** The portal's API services are written by hand.
`StudioEvent`, `StudioRunEvent` and `StudioEventPage` exist twice — in
`studio_events/dto.rs` and in `StudioEventsApiService.ts` — and nothing connects
the two. There is no OpenAPI snapshot in the repository and no CI check over it;
`.github/workflows/studio-delivery.yml` builds and tests both sides and compares
nothing. We have already paid for exactly this class of drift from the outside:
`studio-backend/docs/pr-openapi-drift.md` is the fix we sent upstream for
committed OpenAPI artifacts whose paths no code had ever registered.

Three things are worth stating in the other direction, because this ADR is not a
rewrite and they are what it builds on. `studio-events` is already the shape we
want everywhere: domain-neutral, one channel, producer states what happened and
to what. `pagination.rs` already contains the paging contract. And
`operation_id` is already `<gear>.<verb>_<noun>` in roughly four out of five
operations — the convention exists, it is just not binding.

The trigger for doing this now is ADR-0006: the portal is being rebuilt on
FrontX, screen by screen. Every screen written against a one-off shape is a
screen that gets rewritten when the shape is unified, so the cheapest moment to
fix the contract is before those screens exist.

## Decision

### 1. The contract is written down, in one place

`docs/api-conventions.md` is the normative text: path and name, response shape,
scope, long-running work, events, documentation, versioning. Every rule carries
a code. `docs/events-catalog.md` is the event vocabulary — the registry a
`subject_type` and a `kind` must appear in before a consumer may rely on them.

### 2. It is enforced by a ratchet, not by review

`studio-backend/src/api_contract.rs` reads the crate's sources — no database, no
assembly boot, milliseconds — and reports one violation per broken rule. It runs
inside the existing `cargo test` step, so it is on for every PR from today.

Because ~170 operations predate the rules, failing on all of them would mean
either a long migration before the check can land or a check nobody enables.
Instead every violation that exists today is listed in
`studio-backend/docs/api-contract-baseline.txt`, and the test asserts the
violation set equals that file **exactly**. A new violation fails the build. A
violation that has been *fixed* also fails the build, until its line is deleted.
So the baseline only shrinks, adding to it is a visible and reviewable act, and
the remaining debt is a number anyone can read.

This is the same shape as `gts_inventory`: prove offline what the code declares,
on every PR, without a running deployment.

### 3. The unit of the contract is the resource, not the gear

A gear stays the unit of ownership and shows up as the domain segment. The
operations inside it are designed from the resource: a collection, an element,
its sub-collections, and actions on it. A screen is assembled from resources.
Where that costs round trips, the answer is `?expand=` on the resource, never an
endpoint shaped like a screen — a screen-shaped endpoint outlives its screen and
then nobody dares delete it.

### 4. Scope is said once

The tenant comes from the security context and never appears in a path or a
query — a tenant a caller can type is not a scope, it is a hole. A scope inside
the tenant is `?project_id=`, one spelling, always a string. This is the
expensive rule: it is what removes the duplicated operations in
`studio-documents` and what changes `studio-theia` and `studio-kits` paths.

### 5. One asynchrony

Starting work answers `202` with `{ run_id }`. Observing it is `studio-tasks`
plus `task.*` events, and nothing else. The four private `/tasks/{id}` endpoints
are deprecated and removed. A new kind of announcement is a `publish` call, not
an endpoint — which is what ADR-0013 §2 already decided and what this rule makes
checkable.

### 6. Documentation is part of the declaration, not a follow-up

An operation without a `summary` or with a `description` that restates its own
name does not compile past the check. Beyond the OpenAPI, every resource the
portal touches gets one page under `studio-frontend/docs/`, in the shape of
`studio-events.md`: the service, a table of its members, working examples, and a
**Traps** section. The traps section is the part that is not derivable from the
schema and is therefore the part worth writing by hand.

### 7. The surface is committed, and the consumers are checked against it

`studio-backend/docs/api-contract.json` holds the surface the code declares —
method, path, `operation_id`, tag, summary, request and response DTOs, declared
errors — generated by `studio-backend api-contract` from the same scan and
drift-checked by `cargo test`, exactly as `docs/gts-types.json` already is. It
is not the OpenAPI document, which needs a booted assembly; it is the half that
can be proven offline, and the half whose diff a frontend reviewer needs to see.

`scripts/check-api-usage.mjs` then closes the loop: every URL literal in
`studio-frontend` and `studio-frontend-prototype` must match a path in that
file. It runs in CI **without a component filter**, because a per-component
filter is precisely what lets a backend path move while the portals stay still.

### 8. A wire change lands with its consumers

One PR moves all three trees. The prototype is not exempt: it holds more calls
than any other consumer — the two portals make 115 distinct calls between them
today, most of them from the prototype — and a prototype that 404s is
worse than no prototype, because it is where questions about the product get
answered.

Still to come, and deliberately not here: TypeScript types generated from the
real OpenAPI, so a DTO's *fields* are checked and not only its name.
Hand-written stays what generation cannot express — plugins, `SseAuthPlugin`,
mocks. Until that lands, a hand-written type carries a comment naming the DTO
it mirrors.

## Consequences

* The rules bind every operation written from today, including in branches now
  in flight. Adapting one is usually a `description` and an `operation_id`.
* The baseline file is the migration backlog, and it is honest about its size:
  **174 entries on the day it was written**, over 169 operations.

  | Rule | Entries | What it is |
  | --- | ---: | --- |
  | `scope-in-path` | 60 | the scope is a path segment (rule C) |
  | `list-envelope` | 39 | a collection that is not `{ items, total }` (B1) |
  | `op-id-verb` | 36 | a synonym or a bare noun where a verb belongs (A2) |
  | `typed-response` | 17 | a response with no schema (B3) |
  | `domain-prefix` | 9 | `spec-quality` predates `studio-` (A1) |
  | `description` | 6 | nothing written down (F2) |
  | `local-task-endpoint` | 4 | a private background-status endpoint (D2) |
  | `path-literal` | 3 | a path built from a variable (A3) |

  Nine rules have **no** entries at all — `summary`, `tag`, `tag-per-domain`,
  `auth`, `error-401`, `op-id`, `op-id-unique`, `domain-registered`,
  `path-version` — which is the part of the convention the assembly already
  followed without being told to. Working through the rest is a series of
  breaking changes to `v1`, each of which needs the deprecation window rule G1
  gives it.
* Two PRs that both add operations will conflict in the baseline file. The
  resolution is mechanical: take the union, rerun `cargo test api_contract`, and
  delete whatever the test then reports as no longer happening.
* The check only sees what the source declares. A handler that answers something
  other than its declared schema is still nobody's error — that is what the
  generated types in §8 are for.
* The cross-tree check found the portals essentially honest: **one** unmatched
  call, and it is unmatched because the IDE proxy registers its path from a
  variable and so is absent from the surface file. What it also reported is the
  other half of the diagnosis — **62 of 137 registered paths are called by
  neither portal.** Close to half the endpoints in this assembly were built for
  a consumer that does not exist, which is what designing an API inside the gear
  rather than from the resource produces.
* Nothing here changes the gateway, the prefix, or the `v1` that is deployed. No
  operation moves in this ADR; it establishes what moving means.
