---
type: adr
status: proposed
date: 2026-10-09
---

# ADR-0041: An organization keeps a registry of the components its projects build

**ID**: `cpt-studio-adr-component-registry`

Status: **proposed** · Date: 2026-10-09 · Extends `cpt-studio-component-components-catalog` · Builds on the project-local gears of `cpt-studio-principle-spec-mapping-own-gears`

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

An organization's projects write gears of their own, and they also write code
that ought to be a gear and is not one yet. Studio could not answer three
plain questions about either:

- **Which components does this organization have?** The catalogue knows what
  its sources list. Those sources live in one browser's localStorage
  (`cf.components.sources`), and the catalogue syncs only when somebody
  presses the button. A gear declared in a project's repository is found only
  while that project's plan is being read (`project_gears`, kept in memory,
  never written down), and nobody walks the organization's other projects.
- **Who is responsible for each one, and is it still alive?** `owner` is a
  free-text field. `lifecycle` is derived from repository activity. Nothing
  says a component was accepted, deprecated or replaced, and an edit to a
  component's facts records no author.
- **What should become a gear?** A module with its own REST surface, its own
  tables and two consumers is a gear in all but its declaration. Nothing looks
  for it.

## Considered Options

1. **A registry inside the components-catalog gear**, filled by a sync phase
   that walks every project of the organization, with a lifecycle and recorded
   decisions on each entry.
2. **A new registry gear** next to the catalogue, owning "the organization's
   components" while the catalogue keeps "what the sources list".
3. **Leave discovery per project.** Keep `project_gears` as an on-demand read,
   and let the catalogue's sources be curated by hand.

## Decision Outcome

Chosen option: **1, the registry is part of the components-catalog gear.**

A component node is one fact with one owner (as ADR-0040 settles for people).
A second gear would keep a second copy of "this crate is a component of this
organization", and the two would disagree on the first rename. Option 3 leaves
all three questions unanswered.

### 1. Every project's repositories are read, and the result is kept

- The catalogue's sources move to the server, per organization: the
  organization's catalogue repositories, as today, plus the repositories of
  every project in it (its `project.config` `sources[]` and its gear
  repository).
- A project can be excluded. It is not opted in one by one: a registry with
  gaps nobody chose is the problem this ADR solves.
- Organizations publish the list through a port (`ProjectsOf`). No other gear
  walks the tenant tree itself.
- A repository is read again only when the fingerprint of the files discovery
  reads has changed, the same rule `project_gears` uses. The fingerprint is
  stored, so the rule holds across restarts.
- Sync runs on a schedule (`studio-scheduler`, at platform level, naming the
  organization in its payload), after a push through the git proxy, and on
  demand.

### 2. An entry has a lifecycle, and only a person moves it past "declared"

```
candidate ──► declared ──► registered ──► published
   │             │              │
   └─► rejected  └──────────────┴──► deprecated
```

| State | Means | Who sets it |
|---|---|---|
| `candidate` | Code that looks like a gear, with the evidence and a score | discovery |
| `declared` | The repository declares it: `gear.toml`, `gear.gdl`, `#[toolkit::gear]`, a FrontX package, a kit manifest | discovery |
| `registered` | Accepted as the organization's component, with an owner, a kind, a category and its capabilities | an organization administrator |
| `published` | Given to the platform tier: a pull request into the platform's repository, merged by its maintainers (ADR-0042) | an organization administrator, as a separate act |
| `rejected` | A candidate the organization decided is not a gear, with the reason | an organization administrator |
| `deprecated` | Still present, no longer to be chosen, with its replacement | an organization administrator |

- `registered` stays inside the organization. Publishing is a separate
  decision, because the shared corpus is not the organization's to fill by
  accident.
- A rejected candidate is not proposed again until the code it was found in
  changes past its fingerprint.
- Every move is a recorded decision (who, when, from which state, why), stored
  the way mapping decisions are.

### 3. Where it is found, and why

An entry carries its occurrences: repository, ref, path, commit and project.
When the same component has two occurrences in different repositories, that is
the signal for a merge, not two entries.

A candidate carries its evidence: which detector fired, on what, and what each
signal is worth. The first detectors are structural and need no model:

- it has its own REST router;
- it has its own tables or migrations;
- it owns GTS types;
- it has `port` and `sdk` modules;
- other crates or projects depend on it;
- the same module is copied into more than one project.

A model may later propose a name, a description and capability keys. That is a
suggestion only and never a state change.

### 4. The registry is what the rest of Studio asks

- `spec-mapping` takes its project candidates from the registry: the
  registered entries, and the entries declared in that project. The on-demand
  read stays as the fallback.
- A candidate in the project's own code is offered as "could become a gear"
  with **Declare it**. That opens a pull request adding `gear.toml` and
  `gear.gdl` beside the module, through the existing scaffold.
- The registry is published on the ClientHub as
  `components_catalog::port::Registry`.

## Consequences

- Good: one answer to "what components do we have", kept between page loads
  and visible to everyone in the organization.
- Good: ownership and deprecation become facts with authors, not free text.
- Good: the Components tab stops recomputing a project's gears on every read.
- Bad: sync now reads every project's repositories. This is bounded by the
  fingerprint, the existing per-repository limits and the schedule. The first
  run for a large organization costs one tree listing per repository plus the
  candidate files.
- Bad: the catalogue's sources stop being a private choice of one browser.
  Their existing contents have to be moved to the server once.
- Neutral: an organization with no projects sees the catalogue it sees today.

## More Information

Phases:

1. **P1:** server-side sources, the organization walk, `declared` entries
   persisted, a read-only registry page, and spec-mapping reading it.
2. **P2:** lifecycle moves with recorded decisions, owners, and permissions
   through the PDP.
3. **P3:** structural candidate detectors and Declare it.
4. **P4:** model suggestions, the consumer graph, and publishing. *Built:
   see the catalogue design's Registry component (Publishing, Consumers,
   Suggestions).*

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/studio-components-catalog.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-fr-gear-catalogue`
* `cpt-studio-component-components-catalog`
* `cpt-studio-component-components-catalog-sync`
* `cpt-studio-principle-spec-mapping-own-gears`
