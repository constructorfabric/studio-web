---
type: adr
status: proposed
date: 2026-10-09
---

# ADR-0042: Components come in two tiers, the platform's and the organization's

**ID**: `cpt-studio-adr-component-tiers`

Status: **proposed** · Date: 2026-10-09 · Refines `cpt-studio-adr-component-registry` (what `published` means) · Extends `cpt-studio-component-components-catalog`

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

Studio exists to build products from their specifications out of gears, and to
create the gears that are missing. Constructor Fabric is one organization that
makes gears. Its `gears-rust` repository is, in practice, the set every
organization builds on.

The code does not say so:

- **Every organization keeps its own copy of the shared gears.** The catalogue
  is synced per organization. Each organization names its own sources
  (`gears-rust`, the crates.io keyword, FrontX, kits), and holds its own copy of
  the same nodes.
- **The Gearbox engine composes from one corpus**, set in the deployment's
  configuration. A gear an organization writes itself is in its registry
  (ADR-0041) but cannot be composed into a product.
- **A new gear is written into one project's repository.** Nothing says where an
  organization keeps the gears it makes.
- **Nothing describes how a gear becomes everyone's.** ADR-0041's `published`
  says only "a released version".
- **A product names the shared gears by path** (`path("../gears-rust")`) and at
  no version. A change to the shared set changes every organization's product
  at once.

## Considered Options

1. **Two tiers.** The platform's components are synced once, in the platform's
   tenant, and are read-only to every organization. Each organization has its
   own components: its registry and its gear repository. A product draws on
   both.
2. **One tier per organization, as today.** Every organization syncs
   `gears-rust` itself.
3. **One global tier.** Every gear any organization writes is visible to all.

## Decision Outcome

Chosen option: **1, two tiers.**

Option 2 duplicates the shared set in every organization, and leaves "which
gears are everyone's" to each organization's settings. Option 3 publishes an
organization's work without its say.

### 1. The platform tier

- **Content:** the components every organization may use, read from the
  platform's sources (`gears-rust`, FrontX, kits, the crates.io keyword).
- **Where it lives:** the platform's (root) tenant. Its sync runs there once,
  under a platform administrator's settings.
- **Who reads it:** every organization, read-only. An organization does not
  configure the platform's sources, and cannot edit their facts.
- **What an organization keeps of its own about a platform component:** its
  annotations (the profile's `values` layer). They are kept per organization,
  as overrides of the platform's facts, never as a copy.

### 2. The organization tier

- **What it is:** the registry (ADR-0041). It holds what the organization's
  projects declare, plus the gears it creates.
- **The gear repository:** an organization may name one repository as its gear
  repository. "Create a gear" writes into it by default. A project's own gear
  repository still wins for that project.
- **Who sees it:** the organization's members, and nobody else.

### 3. A product draws on both, and says which

A project's candidates, its coverage and its product read the platform tier and
its organization's tier together. Every component carries its tier:

| Tier | Meaning |
|---|---|
| `platform` | from the shared set |
| `organization` | from the organization's registry |
| `project` | declared in this project's own repositories |

When the two tiers offer equally strong answers, the organization's own gear is
offered first: it was written for this organization.

### 4. Publishing is giving a gear to the platform

ADR-0041's `published` now means **contributed to the platform tier**:

1. An organization administrator publishes a `registered` component.
2. Studio opens a pull request into the platform's repository (`gears-rust`),
   bringing the gear's crate, `gear.toml` and `gear.gdl`.
3. The platform's maintainers review and merge it in that repository, as for
   any contribution.
4. The entry is `published` once the platform's sync finds it.

A released version (crates.io, or a git tag) is recorded on the entry as it
is found. It is a fact about the entry, not a state.

### 5. A product pins what it uses from the platform

`product.gdl` names each platform gear at the version it was composed with, so
a change to the platform does not change an organization's product unasked.
How the engine resolves versioned and multi-source gears is left to Gearbox:
see "More Information".

## Consequences

- Good: one copy of the shared gears, kept in one place.
- Good: "is this ours or everyone's" is a fact on every component and every
  candidate.
- Good: a gear an organization writes reaches its products. Once given, it
  also reaches every other organization's products, through one reviewed path.
- Bad: the catalogue's reads now join two tenants. Organizations that
  configured `gears-rust` as their own source see it twice until those
  sources are removed. They are marked shadowed by the platform, and the
  Sources panel offers to remove them.
- Bad: composing an organization's own gears needs the Gearbox engine to read
  more than one corpus (below). Until it can, Studio offers them in coverage
  and candidates, and says the engine cannot compose them yet.

## More Information

**Several corpora in the Gearbox engine.** This is not decided here: it is the
engine's design, in its own repository. What Studio needs from the engine:

- Resolve a product from an ordered list of corpora (the platform's, then the
  organization's gear repositories), each a git repository at a ref.
- Name a gear's corpus in `product.gdl`, and its version where the corpus is
  versioned.
- A lock that records the commit each corpus was resolved at.

Studio's side follows once the engine answers this.

**Phases in Studio:**

1. **The platform tier:** sync in the root tenant, reads join the two tiers, the
   tier on every component, and the two tiers as two levels of the portal:
   the platform at the top of the path (Platform › organization › workspace ›
   project), its components shared by every organization, and the
   organization's own components one level down. *Built: see the catalogue design's Tiers component.*
2. **The organization's gear repository** as the default target of "Create a
   gear". *Built: see the catalogue design's Tiers component.*
3. **Publish as contribution:** a pull request into `gears-rust` (ADR-0041's
   P4). *Built: see the catalogue design's Registry component, Publishing.*
4. **Several corpora and pinned versions**, once the engine supports them.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/studio-components-catalog.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-fr-gear-catalogue`
* `cpt-studio-component-components-catalog`
* `cpt-studio-adr-component-registry`
