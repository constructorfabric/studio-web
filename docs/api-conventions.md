# Studio API conventions

The rules every REST operation and every published event in this assembly
follows, and how a screen is documented against them. The reasoning behind them
is [ADR-0020](adr/0020-one-contract-with-the-frontend.md); this page is the
normative text.

Each rule carries a **code** in brackets. Codes that are checked mechanically
name the rule in `studio-backend/src/api_contract.rs`, and a build fails with
that code in the message. Codes marked *(by review)* are not machine-checkable
yet and are the reviewer's job.

- [A. Path and name](#a-path-and-name)
- [B. The shape of an answer](#b-the-shape-of-an-answer)
- [C. Scope](#c-scope)
- [D. Long-running work](#d-long-running-work)
- [E. Events](#e-events)
- [F. Documentation](#f-documentation)
- [G. Versioning](#g-versioning)
- [H. Status codes](#h-status-codes)
- [I. Idempotency](#i-idempotency)
- [J. Batches](#j-batches)
- [How this is enforced](#how-this-is-enforced)

---

## A. Path and name

**A1 `[domain-prefix]` `[domain-registered]` `[path-version]` — a path is
`/<domain>/v1/<resource>`.** The domain is the gear that owns the resource,
`studio-` prefixed, lower-kebab, and listed in `api_contract::DOMAINS`. A new
domain is added to that list in the PR that registers its first operation, so a
typo cannot quietly become a second API.

**A2 `[op-id]` `[op-id-verb]` `[op-id-unique]` — `operation_id` is
`<domain_snake>.<verb>_<noun>`, unique across the assembly.** The verb comes
from the closed list in `api_contract::VERBS`: `list get create update patch
delete upsert` for the resource lifecycle, plus a small set of actions. This is
the name a generated client's method will carry, which is why it is not free
text and why two words for one act (`save` and `update`, `set` and `put`) is a
break rather than a preference.

**A3 `[path-literal]` — the path is a string literal.** A path assembled from a
variable cannot be read out of the source, so it cannot be checked and it cannot
be generated from.

**A4 `[tag]` `[tag-per-domain]` — one tag per domain, PascalCase**, the same for
every operation in it. The tag is what groups the domain in `/cf/docs` and what
a generator turns into a client class.

**A5 *(by review)* — the operation set is designed from the resource, not from
the screen.** A resource has a collection, an element, sub-collections and
actions; a screen is assembled from resources. When a screen needs five round
trips, the answer is `?expand=` on the resource, never an endpoint shaped like
that screen — a per-screen endpoint outlives the screen and then nobody dares
delete it.

## B. The shape of an answer

**B1 `[list-envelope]` — a collection is `{ "items": [...], "total": <u32> }`.**
The field is `items`, never `nodes`, `edges`, `aliases` or `events`. `total`
counts matches across every page with filters applied and pagination not, so a
caller renders "N of M" and knows another page exists exactly when
`offset + items.length < total`.

**B2 *(by review)* — paging is `?offset=&limit=`, through
`studio-backend/src/pagination.rs`.** Default 50, ceiling 200, an over-large
`limit` is clamped rather than refused. No cursors: these collections sort by a
stable key and an offset survives a reload in a way an opaque cursor does not.

**B3 `[typed-response]` — every response is registered with a schema.**
`json_response_with_schema::<T>` or `sse_json::<T>`, or `no_content_response`
for a deliberate `204`. A response without a schema is invisible to client
generation, which means the frontend hand-writes the type and nothing ever
tells it when the type changed.

**B4 *(by review)* — an element is a flat object, never wrapped.** No
`{ "data": … }`, no `{ "result": … }`.

**B5 *(by review)* — errors use the canonical taxonomy only.**
`CanonicalError::…::create()`, or `#[resource_error(gts_id!(…))]` where the
failure is attributable to a resource. A gear does not invent an error body.

**B6 *(by review)* — field names are `snake_case` on the wire, everywhere.**
Identifiers are JSON strings even where they are `Uuid` inside. A timestamp is
either `<name>_at` in RFC 3339 or `<name>_ms` in epoch milliseconds, and the DTO
doc comment says which and why.

**B7 `[auth]` `[error-401]` — every operation declares `.authenticated()` or
`.anonymous()`**, and an authenticated one declares `.error_401(…)`. The
gateway derives its route policy from these, so leaving it to a default is
leaving authentication to a default.

**B8 `[error-404]` — an operation addressed by id declares `.error_404(…)`.**
A path with a `{param}` can be asked for something that is not there, or that is
there and not this caller's to see — `not_found` is the answer to both. An
undeclared error is absent from the generated client and from
`api-contract.json`, so the portal writes that path from memory or not at all.

**B9 `[error-500]` — every operation declares `.error_500(…)`.** Nothing is
exempt from failing, and a client that was never told so is a client whose only
500 handler is a blank screen.

**B10 *(by review)* — the failure body is the canonical problem, and its
vocabulary is [`errors-catalog.md`](errors-catalog.md).** Every failing response
is RFC 9457 `application/problem+json` in one of sixteen categories. A client
branches on `type`, never on `status`: `400` is `invalid_argument` or
`failed_precondition` or `out_of_range`, `409` is `already_exists` or `aborted`,
and `500` is three more. A gear that needs to say something new says it in
`context`, and a `context` field a screen is expected to read lands in the
catalogue in the same PR.

## C. Scope

**C1 `[scope-in-path]` — the tenant never appears in the API.** It comes from
the security context (`ctx.subject_tenant_id()`) and it is never read from a
path segment or a query parameter. A tenant a caller can type is not a scope,
it is a hole.

**C2 `[scope-in-path]` — a scope inside the tenant is `?project_id=`**, one
spelling, always a string. Not `{workspace_id}` in the path, not `org_id`
beside `organization_id`.

The cost of breaking this is visible in `studio-documents`, which carries
`list_workspace_documents` and `list_organization_types` and their
`{workspace_id}` / `{organization_id}` twins — one thought, four operations, and
every one of them a separate thing for the frontend to learn.

## D. Long-running work

**D1 *(by review)* — starting work answers `202` with `{ "run_id": … }`.**

**D2 `[local-task-endpoint]` — work is observed through `studio-tasks` and
`task.*` events, and nowhere else.** No gear grows a private `/tasks/{id}`. The
central run carries state, attempts, cancel and retry; a private status endpoint
carries a subset of that and a second vocabulary for the frontend.

**D3 *(by review)* — a client reads the cursor before it starts the job.** A run
can finish before the stream is open; `GET /studio-events/v1/events?limit=1`
first, then start, then resume from that `latest_seq`. See
[`studio-frontend/docs/studio-events.md`](../studio-frontend/docs/studio-events.md).

## E. Events

**E1 *(by review)* — one channel.** `studio-events` is the assembly's only push
surface (ADR-0026). A new kind of announcement is a `publish` call, never a new
endpoint and never a second stream.

**E2 *(by review)* — `kind` is `<subject>.<past-tense verb>`, lower-snake.**
The first segment is stable because clients filter on it.

**E3 *(by review)* — `subject_type` comes from the registry in
[`events-catalog.md`](events-catalog.md).** A new subject type is a PR against
that file, which is what keeps the vocabulary a contract rather than a habit.

**E4 *(by review)* — an event about a resource carries the fields that
resource's `GET` answers with**, so one view can be fed by either without a
second mapping. `StudioRunEvent` and `GET /studio-tasks/v1/runs/{id}` are the
worked example.

**E5 *(by review)* — an event is a prompt, not a source of truth.** The replay
window is bounded (500 per tenant) and delivery is at-least-once. A screen that
cannot be rebuilt from REST after a missed event is a screen that breaks on a
reconnect.

## F. Documentation

**F1 `[summary]` — every operation has a one-line `summary`**, at most 120
characters. It is the line a person reads in `/cf/docs`.

**F2 `[description]` — every operation has a `description` of at least 40
characters that says when to call it and what bites.** Restating the name is not
a description. What belongs here: the precondition a caller must meet, the
follow-up call, the error that is expected rather than exceptional, the
idempotency story.

**F3 *(by review)* — every resource the portal touches has one page under
`studio-frontend/docs/<resource>.md`**, in the shape of
[`studio-events.md`](../studio-frontend/docs/studio-events.md): the service and
how to get it, a table of its members, working `tsx` examples, and a **Traps**
section. That last section is the point of the page — the rest is in the
OpenAPI.

**F4 *(by review)* — a DTO field is documented where it is declared**, in the
Rust doc comment, because that is what reaches `/cf/docs` and the generated
types.

## G. Versioning

**G1 *(by review)* — `v1` does not break.** A breaking change is a new path; the
old operation gains `deprecated` and a removal date in its `description`, and it
keeps working until that date.

**G2 *(by review)* — a removed operation is removed from the baseline file too**,
so debt that is deleted stops being counted as debt.

**G3 `[api-usage]` — a wire change lands with its consumers, in the same PR.**
A path, an `operation_id` or a DTO that moves moves in all three trees at once:
`studio-backend`, `studio-frontend` and `studio-frontend-prototype`. The
prototype is not exempt — it is the tree with the most calls in it, and a
prototype that 404s is worse than no prototype, because it is where a question
about the product gets answered.

`node scripts/check-api-usage.mjs` proves the URL half of this: every path
either portal calls has to exist in `studio-backend/docs/api-contract.json`. It
runs in CI on every push with no component filter, because the drift it looks
for is exactly the drift a per-component filter hides.

## H. Status codes

**H1 *(by review)* — the success code says what happened, and the method
decides it.**

| The operation | Answers |
| --- | --- |
| `GET` | `200` with the element or the list (B1) |
| `POST` that creates a resource a caller can then `GET` | `201` with the created element |
| `POST` that is an action finished within the request — compute, validate, report | `200` with its result, or `204` |
| `POST` that starts work | `202` with `{ "run_id": … }` (D1) |
| `PUT`, `PATCH` | `200` with the element as it now is |
| `DELETE` | `204`, no body |

A client branches on the code before it reads the body, so the code has to mean
the same thing on every route: `201` is "there is a new thing, here it is",
`202` is "nothing has happened yet, watch this run", `204` is "done, there is
nothing to read". Two routes that create something and answer `200` and `201`
make every caller check for both, and a `DELETE` that answers a body invites a
screen to depend on it.

An action whose work is done within the request — artifact-ingest's
`reconcile`, the domain model's `sync` and `import`, `memberships/backfill` —
is an action, not started work, and answers `200`. An operation that offers to
wait for its run (`"wait": true` on `graph-sync`) answers `200` with the outcome
when the run finished within the request, and the same `202` as without waiting
when it did not; both are declared.

**H2 *(by review)* — a `DELETE` answers `204` even when the screen wants to know
what is left.** It reads that with the `GET` it already has. A deletion that
can partly fail is not a success with a report in its body: it is a failure in
the canonical taxonomy (B10), with what did not happen in `context`.

**H3 *(by review)* — a retried `DELETE` that finds nothing answers `404`, and a
client treats that as done.** `DELETE` is idempotent in its effect, not in its
answer: B8 makes "not there" a `404`, and a client that retries after a lost
response will meet it.

**H4 — the failure codes are the error contract's.** Which status a failure
carries, and what a client branches on instead, is
[`errors-catalog.md`](errors-catalog.md) and B7–B10. Nothing in this section
adds a failure code.

## I. Idempotency

**I1 *(by review)* — a `POST` that starts work accepts an `Idempotency-Key`
header.** The same key in the same tenant gives the same run: a repeat answers
the same `202` with the same `run_id`, and nothing is enqueued twice. The key is
stored on the run in the transaction that creates it (`studio-tasks`,
`idempotency_key`), so it holds across a restart and across replicas, for as
long as the run row is kept. A key is 1–255
visible ASCII characters; anything else is `400` `invalid_argument`.

**I2 *(by review)* — a client makes one key per intent and reuses it only to
retry that intent.** `crypto.randomUUID()` when the person presses the button,
the same value on the automatic retry after a timeout or a lost response, a new
one when the person presses it again. A key derived from the payload would make
two deliberate identical requests one.

**I3 *(by review)* — only a success is remembered.** A request refused with a
`4xx` enqueues nothing, so its retry is validated and authorized again rather
than answered from a cache. That is what lets a caller fix the input and resend
with the same key.

**I4 *(by review)* — work whose result depends only on when it runs coalesces
instead.** A sync asked for twice while the first is still queued is one run
(`coalesce_queued`), with or without a key; asked for again after it started,
it is a second run, because the source may have changed meanwhile.

**I5 *(by review)* — a `POST` that creates a resource does not take
`Idempotency-Key` yet.** Replaying a `201` needs the created element's id kept
against the key, per resource, and no gear does that today. Until one does, a
create that must not happen twice is guarded by a natural unique key in its
table — a name, a slug — and answers `409` `already_exists` on the repeat.

## J. Batches

**J1 *(by review)* — a batch is one operation over a set, and its body is
`{ "items": [...] }`.** The same field B1 lists answer with. Each item carries
the caller's own `id` for it, echoed back untouched, so the caller can join
results to what it sent without relying on order.

**J2 *(by review)* — a batch declares its limit, and refuses a larger set
whole.** The limit is a named constant, quoted in the operation's
`description`; a request over it is `400` `invalid_argument` and nothing in it
runs. Not truncated: a caller that sent 250 items and got 200 results has lost
50 without being told. `analyze-batch` (`spec_quality::batch_task::MAX_ITEMS`,
200) is the worked example.

**J3 *(by review)* — a batch that takes longer than a request is one run.** It
answers `202` with the run (D1, I1), and the run's `result` holds one outcome per
item: the caller's `id`, a `status`, and an `error` when it did not succeed.
Per-item progress reaches the portal as `task.*` events of that one run, not as a
run per item.

**J4 *(by review)* — a batch that finishes within the request answers `200`
with `{ "items": [...] }` in the order of the request**, one outcome per item in
the shape of J3. One item failing does not fail the response; the request fails
only when it could not be attempted at all, with one canonical problem (B10).
There is no `207 Multi-Status`: the error contract has one problem per
response, and a batch's per-item outcomes are its result, not its status.

---

## How this is enforced

Three things, none of which needs a running deployment.

### 1. The rules, as a test

`studio-backend/src/api_contract.rs` scans the crate's sources on every
`cargo test` — no database, no assembly boot — and reports one violation per
broken rule, with its code.

Because the assembly grew ~170 operations before it had conventions, the check
is a **ratchet**, not a gate. Every violation that exists today is listed in
`studio-backend/docs/api-contract-baseline.txt`, and the test asserts the
violation set equals that file exactly:

* a violation that is **not** in the baseline fails the build — so the rules
  bind everything written from now on;
* a baseline entry that **no longer happens** also fails the build, until the
  line is deleted — so the file only ever shrinks, and the debt stays counted.

Adding a line to the baseline is therefore a deliberate, reviewable act: it says
"this break is known and agreed", and the diff shows it.

```
$ cargo test api_contract

These operations break docs/api-conventions.md (1 of them)

  [description] POST /studio-kits/v1/projects/{project_id}/installations
      no description: when to call it and what bites is undocumented
      (src/kit_registry/rest.rs:360)

Fix them, or — if the break is deliberate and agreed — add the
`<rule><TAB><METHOD> <path>` line to studio-backend/docs/api-contract-baseline.txt.
```

The baseline holds **239 entries** today, against 176 operations — the migration
backlog, rule by rule. Nine of the checked rules have no entries at all
(`summary`, `tag`, `tag-per-domain`, `auth`, `error-401`, `op-id`,
`op-id-unique`, `domain-registered`, `path-version`): that part of the
convention the assembly already followed before anyone wrote it down.

### 2. The surface, as a committed file

`studio-backend/docs/api-contract.json` is the API surface the code declares:
every operation's method, path, `operation_id`, tag, summary, request and
response DTOs and declared errors. It is generated from the same scan —

```
cd studio-backend && cargo run --quiet -- api-contract > docs/api-contract.json
```

— and `cargo test` fails when it stops matching the code. It is **not** the
OpenAPI document; that one is built by the api-gateway at boot and served at
`/cf/docs`. This is the half that can be proven offline, and it is the half a
reviewer wants: the diff of that file is the diff of the contract, and it is
what tells a frontend reviewer that something they consume has moved.

### 3. The consumers, as a cross-tree check

```
node scripts/check-api-usage.mjs          # rule G3
node scripts/check-api-usage.mjs --list   # also: what nobody calls
```

It reads every URL literal in `studio-frontend` and
`studio-frontend-prototype` — including the base-URL-plus-relative-path form
the FrontX services use — and matches each against the committed surface.
Unmatched calls fail, with the file that makes them. Known breaks live in
`scripts/api-usage-baseline.txt` under the same shrink-only rule.

A path named in a comment is checked too, and that is deliberate: a doc
comment pointing at an endpoint that moved misleads exactly as effectively as
a call that does.

`--list` answers the other direction, which is not a failure but is worth
knowing: **62 of 137 registered paths are called by neither portal.** That is
what "designed inside the gear that owns it" produces.

### Rules that are not checked yet

B2, B4, B5, B6, D1, D3, E1–E5, F3, F4, G1, G2, H1–H3, I1–I5 and J1–J4 are reviewer's rules today.
The ones worth mechanising next, in order: **H1** (the success code against the
method and the operation's verb, with D1's `202` + `run_id` shape), **B6** (a
DTO field scan catches `camelCase` on the wire), and **E3** (the event
vocabulary against `events-catalog.md`). Each is a scan of the same
sources this module already reads.
