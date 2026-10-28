---
type: adr
status: proposed
date: 2026-10-27
---

# ADR-0052: A domain object says what happened to it, workflows react to that, and a kit brings the rest

**ID**: `cpt-studio-adr-domain-events-workflows-kits`

Status: **proposed** · Date: 2026-10-27 · Builds on ADR-0051 (domain objects, Studio's own model, gear-held types), ADR-0038 (a run does the work, an event says it happened), ADR-0035 (domain objects are authorized through the PDP), ADR-0050 (FrontX micro-frontends) · Extends the kits of `docs/design/studio-kits.md`

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. Every write of an object is an event](#1-every-write-of-an-object-is-an-event)
  - [2. The events are kept in a journal, and the journal is the truth](#2-the-events-are-kept-in-a-journal-and-the-journal-is-the-truth)
  - [3. A type declares more than fields](#3-a-type-declares-more-than-fields)
  - [4. Workflows are lifecycles and rules](#4-workflows-are-lifecycles-and-rules)
  - [5. A function is a named piece of work with three ways to run](#5-a-function-is-a-named-piece-of-work-with-three-ways-to-run)
  - [6. Studio keeps a small core; a kit brings the rest](#6-studio-keeps-a-small-core-a-kit-brings-the-rest)
  - [7. Screens come from the model](#7-screens-come-from-the-model)
- [What changes compared with today](#what-changes-compared-with-today)
- [Phases](#phases)
- [Consequences](#consequences)
- [Confirmation](#confirmation)
- [Open questions](#open-questions)
- [More Information](#more-information)

<!-- /toc -->

## Context and Problem Statement

After ADR-0051 every record a gear keeps is an object of the organization's
domain model. An organization starts on Studio's own model (the types its gears
and screens read and write), uploads a model that extends it, and edits it in
Administration › Domain model. The tabs of an organization, a workspace and a
project are relations of kind `shows` on their types.

What the model does not have yet is **behaviour**:

- **No one hears what happened to an object.** A write publishes
  `domain.objects_changed` with a type and a count, and nothing else
  (ADR-0051, events without ids). It is a hint on `studio-events`, lossy by
  design (ADR-0026 §2, ADR-0038 §2): a screen re-reads, nothing can act on it.
- **No history.** Who changed a field, from what, when, is nowhere.
- **No rules.** A type has fields and relations. Nothing says which values are
  allowed, which status may follow which, or what must happen when an object
  reaches a state. The model already names `workflow`, `transition`,
  `automation-rule` and `action` as types, but they are inert: data, not
  behaviour.
- **Kits are files.** A kit today is working material (templates, prompts,
  checklists) that `cfs` writes into a checkout. It cannot bring a type, a
  rule or a screen.

The goal, as the product owner put it: an event model for every entity
(created, changed, deleted, and more); types that can be extended; typical
workflows; and everything else done in kits, each kit bringing its entities,
processes, types, events, functions, workflows and UI.

## Considered Options

### Where an object's events live

1. **On `studio-events` only.** Already there; lossy and best-effort by
   decision, with no replay past its own short log. A workflow that misses an
   event misses work it owed.
2. **A journal in the domain model's own database, written on the write path
   that already keeps the read model.** Durable, ordered per organization,
   readable by cursor; the same path and the same "a missed write withdraws
   and refills" rule as the mirror (ADR-0051 §2).
3. **graph-storage change events** (gears-rust `fr-change-events`, #5133).
   Not built; when it is, it can go underneath option 2 as the mirror's source.

**Chosen: 2**, with 3 underneath when it lands; `studio-events` keeps carrying
the hint.

### Where a function's code runs

1. **Declarative expressions only.** Safe, analysable, no code to ship; cannot
   call anything.
2. **An agent function**: a prompt with tools, run through the LLM proxy
   (ADR-0039) on the organization's budget.
3. **A gear function**: a named handler a linked gear registers, as a gear
   registers a task type today.
4. **Code in a sandbox (WASM).** The most open; a runtime, limits and a
   supply-chain review Studio does not have.

**Chosen: 1, 2 and 3** for the first version; 4 stays open (see
[Open questions](#open-questions)).

### What a subscriber learns

1. Type and count, as now: nothing can act on it.
2. The object's id and what changed, to everyone in the organization: leaks
   the existence of objects a member may not read.
3. **The object's id and what changed, to whoever may read that object**: the
   journal is read through the PDP (ADR-0035) like any object, and the push
   channel stays a count.

**Chosen: 3.**

## Decision Outcome

### 1. Every write of an object is an event

Every write of a domain object, by a person (`/mutate`, the object routes) or
by a gear (`put_objects`, trusted writes), records one event:

| Event | When |
|---|---|
| `<type>.created` | the object did not exist |
| `<type>.updated` | a field changed; carries each changed field `{from, to}` |
| `<type>.deleted` | the object was marked deleted |
| `<type>.related` / `<type>.unrelated` | a relation from it was added or removed |
| `<type>.<transition>` | its lifecycle moved (§4), named by the transition |

Each event carries: the organization, the object id, its type, its scope (the
project or workspace it belongs to), the actor (person, gear, workflow or
function, with the subject id), the time, the model version it was written
under, and the change. A field declared `sensitive` (§3) appears as changed,
without its values. A write that changes nothing records nothing.

A type can declare events of its own (§3) — `document.published`,
`deployment.approved` — which a gear, a workflow or a function raises with a
payload the declaration types.

### 2. The events are kept in a journal, and the journal is the truth

The journal is one table in the domain model's database, next to the read
model: `studio_domain_events (tenant_id, seq, type_id, object_id, event, actor,
at, change)`, `seq` increasing per organization. It is written by the same
store wrapper that writes the mirror, after the graph accepted the write. If
the journal write fails, the tenant's journal is marked incomplete from that
`seq`, as a mirror is withdrawn, and the event is rebuilt from the graph's
revision when graph-storage can say it; until then the gap is visible, never
silent.

- **Reading.** `GET /studio-domain-model/v1/events?type=&object=&after=&limit=`
  pages by `seq`, filtered by the PDP: a member sees the events of the objects
  they may read. An object's history is the same read with `object=`.
- **Push.** `domain.objects_changed` on `studio-events` stays the hint it is
  (type and count), so open screens refresh as today. A subscriber that wants
  the change reads the journal from its last `seq`.
- **Reacting.** Workflows do not listen to the push channel. A
  `domain.react` run in `studio-tasks` (ADR-0038) reads the journal from the
  organization's cursor, so a reaction survives a restart and is not lost.
- **Keeping.** Events are kept 180 days by default, per organization; an
  organization can keep them longer. Older events go; an object's current
  state never depends on them.
- **Catalogue.** Every event kind is registered in the types-registry as a
  GTS event type, so a kit or another platform can name it (`docs/events-catalog.md`).

### 3. A type declares more than fields

A type in the model gains, all optional and all editable in
Administration › Domain model:

- **Rules on fields**: required, allowed values, range, pattern, unique within
  scope. Checked on every write; a write that breaks one is refused with the
  rule it broke. A gear's own fields (`held_by`) are checked by the gear.
- **Computed fields**: an expression over the object's fields and its related
  objects (`count(tasks where status = "open")`), read-only, computed on read.
- **Sensitive fields**: kept out of event values and of search.
- **Events**: the type's own events and the payload each carries.
- **A lifecycle** (§4).

Expressions are one small, declarative language shared by rules, computed
fields, workflow conditions and expression functions: field access, comparisons,
boolean logic, arithmetic, the related objects of a relation and aggregates over
them. No loops, no calls out; evaluated in the backend, with a cost limit.

### 4. Workflows are lifecycles and rules

**A lifecycle** belongs to a type and names its status field, its states and
its transitions. A transition has a name, its `from` and `to` states, who may
take it (a role or a permission, through the PDP), a guard (an expression that
must hold), and what it requires (fields that must be filled). `/mutate` and
the type's screens move an object only along a declared transition; a status
written any other way is refused. Taking a transition records the
`<type>.<transition>` event.

**A rule** is an object of the `automation-rule` type: *on* an event pattern
(`deployment.created`, `document.*`), *when* a condition holds, *do* a list of
actions. The `domain.react` run evaluates the rules of the organization for
each journal event, in `seq` order, and runs the actions of the ones that
match. Actions:

| Action | Does |
|---|---|
| `set` | set fields of the object, or of a related one |
| `create` | create an object, and relate it |
| `transition` | take a transition of the object |
| `notify` | a `notify.deliver` run to people or a channel (ADR-0038 §3) |
| `run` | enqueue a task type of a gear, with a payload |
| `call` | call a function (§5) |
| `raise` | raise an event of a type |

A rule's actions are written as the rule (actor `workflow:<rule>`), each once
per `(rule, event seq)`, so a re-run after a crash does not repeat them. A
rule does not react to the events its own actions produced, and a chain of
rules stops at a depth of 8, recorded as an event the administrator sees.

Studio ships the typical workflows as rules and lifecycles in its own model,
turned off until an organization turns them on: document review and approval,
deploy approval for protected environments, a stuck pull request reminder.

### 5. A function is a named piece of work with three ways to run

A function is an object of a `function` type: a name, its inputs and output
(typed like fields), who may call it, and how it runs:

- **expression**: the language of §3; computes a value.
- **agent**: a prompt with the tools it may use (the domain query, the domain
  mutate within the caller's rights, the gears' read routes), run through the
  LLM proxy on the organization's budget (ADR-0039, the costs gear).
- **gear**: a handler a linked gear registers by name, as it registers a task
  type; Studio's own gears and a kit's gear (a kit can ship one, built and
  deployed as any gear, ADR-0042/0044) provide them.

A function is called by a rule (`call`), by a button on a screen, or over
`POST /studio-domain-model/v1/functions/{id}/call`. It runs as the caller,
never above them; an agent or gear function that writes, writes through the
same checks as a person.

### 6. Studio keeps a small core; a kit brings the rest

Studio's own model stays what ADR-0051 made it: the types its gears and screens
need. Everything else comes in a kit. A kit's manifest gains a `model`
section next to its working material:

| A kit brings | As |
|---|---|
| types, fields, relations, tabs | a model overlay (the shape an upload has) |
| events | event declarations on its types |
| lifecycles and rules | lifecycles on its types; `automation-rule` objects |
| functions | `function` objects; gear functions name the kit's gear |
| screens | a FrontX micro-frontend (ADR-0050) a `shows` relation names, or nothing, and the generic screens of §7 |
| working material | as today: files `cfs` writes into a checkout |

**Installing** a kit into an organization imports its overlay as an upload
does, marked `meta.origin = "kit"` with the kit and its version, and writes its
rules and functions as objects with the same origin. **A kit extends; it does
not take away**: it may add fields and relations to Studio's types and other
kits' types, never remove or retype them, and it never holds a type (`held_by`
is a gear's). **Uninstalling** removes what carries its origin; a type that
still has objects is kept, marked as left by the kit, until an administrator
removes it. **Upgrading** applies the difference between the two versions'
overlays, with the same rule.

A project still chooses which kits' working material it pulls (today's
installation record); the model part of a kit is the organization's, because
the model is.

### 7. Screens come from the model

For any type, without code: a **list** (the generic tab, filtered, sorted,
with saved views), a **card** (fields grouped as the type declares, related
objects, computed fields), a **form** (fields with their rules), a **history**
(the type's events from the journal), and the **transitions** the person may
take as buttons. A kit that needs more brings a micro-frontend, mounted where
its `shows` relation puts it.

## What changes compared with today

| Concern | Today | After this ADR |
|---|---|---|
| What happened to an object | A count per type on `studio-events` | An event per write, with the change, in a durable journal |
| History of an object | None | The journal, as a tab on every object |
| Field rules | Type only | Required, values, range, pattern, unique, computed |
| Status | Any value | Declared transitions, with who, guard and requirements |
| Reactions | Hand-written in gears | Rules on events, run durably in `studio-tasks` |
| Functions | Gear code only | Expression, agent and gear functions, callable from rules, screens and the API |
| Kits | Files into a checkout | Plus model, events, workflows, functions and screens into the organization |
| Screens for a new type | A list (the generic tab) | List, card, form, history, transitions |

## Phases

| Phase | Delivers | Depends on |
|---|---|---|
| 1 | The journal and the write-path events (§1, §2); the events route; the object History tab | ADR-0051 |
| 2 | Field rules, computed fields, sensitive fields and the expression language (§3) | 1 for nothing; can run beside 1 |
| 3 | Lifecycles: declared transitions, enforced on write, transition buttons (§4) | 2 |
| 4 | Rules and actions, the `domain.react` run, the shipped typical workflows (§4) | 1, 3 |
| 5 | Functions: expression, agent, gear (§5) | 2, 4 |
| 6 | Kit model packages: install, uninstall, upgrade (§6) | 1–5 for what a kit may bring |
| 7 | Generic card, form and history screens; kit screens (§7) | 1, 3 |

## Consequences

- The model becomes the place behaviour is defined, not only data. Gear code
  that reacts to another gear's records (a review that moves a document, a
  deploy that waits for an approval) can move to rules over time, and the gear
  keeps what only code can do.
- Every write costs one more row. The journal sits beside the mirror and is
  written on the same path; its size is bounded by retention.
- An organization can break its own process with a rule. The depth limit, the
  "no reaction to its own actions" rule and the visible history of what a rule
  did are the guard; turning a rule off is one field.
- A kit becomes a real extension point, which makes its review matter: a kit's
  rules and functions run as the people who trigger them, never above them,
  and an agent function spends the organization's budget.

## Confirmation

- A test writes, changes and deletes an object through `/mutate` and through a
  gear's trusted write, and reads the three events with their changes from the
  journal; a member without read access to the object reads none of them.
- A test breaks the journal write and sees the gap reported, not hidden.
- A lifecycle test refuses a status written outside its transitions and records
  the transition's event when one is taken.
- A rule test creates an object, sees the rule's action applied once, kills the
  run mid-way and sees it applied once still.
- A kit test installs a kit, uses its type, uninstalls it, and finds the type
  kept because it has objects.

## Open questions

1. **A sandbox for kit code.** WASM functions would let a kit bring code
   without a gear. Worth it once kits from outside the organization exist;
   until then a kit that needs code ships a gear.
2. **Retention and audit.** 180 days covers the history tab and the reactions.
   An organization that needs an audit trail for years needs the journal
   exported (to the organization's own store) rather than kept in Studio.
3. **Ids on the push channel.** Pushing each event's id to the members who may
   read it would spare a re-read, at the cost of a PDP check per event per
   subscriber. The journal read covers it for now.
4. **Rules across organizations.** A platform-level rule (Studio's own, for
   every organization) is a rule in Studio's model, copied into each; a rule
   that spans organizations is out of scope.

## More Information

- Today's event: `domain.objects_changed` in `docs/events-catalog.md`; the write
  path that would carry the journal: `studio-backend/src/domain_model/mirror.rs`.
- Studio's own model: `studio-backend/src/domain_model/ontology.studio.json`;
  the `workflow`, `transition`, `automation-rule`, `action` types it names.
- Kits today: `docs/design/studio-kits.md`.
- graph-storage change events: gears-rust #5133; the consumer list of what
  Studio needs from graph-storage: gears-rust #5529.
