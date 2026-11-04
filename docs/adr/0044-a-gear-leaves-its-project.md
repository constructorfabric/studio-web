---
type: adr
status: proposed
date: 2026-10-14
---

# ADR-0044: A gear leaves its project, serves the organization's projects, and can be given to another organization

**ID**: `cpt-studio-adr-gear-extraction`

Status: **proposed** · Date: 2026-10-14 · Extends `cpt-studio-adr-component-registry` (a state between `registered` and `published`) · Extends `cpt-studio-adr-component-tiers` (a third tier, `imported`)

Amended by ADR-0061 (2026-11-04): beside extraction, a project may publish one of its components into the organization's catalogue at a version (a ref and the passport's version), which an organization administrator approves.

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. Extract: the gear moves into the organization's gear repository](#1-extract-the-gear-moves-into-the-organizations-gear-repository)
  - [2. Use: a project depends on the gear at a version](#2-use-a-project-depends-on-the-gear-at-a-version)
  - [3. Export: a gear package](#3-export-a-gear-package)
  - [4. Import: the receiving organization's `imported` tier](#4-import-the-receiving-organizations-imported-tier)
  - [5. Publish starts from `extracted`](#5-publish-starts-from-extracted)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

ADR-0041 gave an organization a registry of the components its projects build,
with a lifecycle: `candidate → declared → registered → published`. ADR-0042
split components into the platform's and the organization's, and gave the
organization a gear repository.

A registered gear is still a module inside one project's code. On Dev, the
organization that holds Insight and Studio Web has 48 components: 43 are
declared in a project and 2 are registered. The `analytics` gear lives at
`src/backend/services/analytics` in the Insight repository. Three things follow:

- **No other project can use it.** A project cannot depend on a module inside
  another project's repository. The only way to reuse it is to copy it, and
  the registry already counts copies as a signal of a missing gear.
- **It has no version.** It changes whenever its project changes. A product
  that used it could not say which `analytics` it was built with.
- **No other organization can use it** short of publishing it to the platform.
  Publishing gives it to every organization through a curator's review. There
  is no way to give one gear to one partner organization, or to a Studio
  installation that is not this one.

## Considered Options

1. **Extract, then share.** A registered gear first moves into the
   organization's gear repository as its own crate with tagged versions. Only
   an extracted gear can be used by other projects, exported to another
   organization, or published to the platform.
2. **Depend on the project in place.** Other projects take a git dependency on
   the source project's repository, at a path and a commit.
3. **Publish only.** Reuse beyond one project goes through the platform tier.

## Decision Outcome

Chosen option: **1, extract, then share.**

Option 2 ties every consumer to the whole source project: its other code, its
branches, its access rights. The gear has no owner apart from that project and
no version of its own. Option 3 makes every shared gear everyone's, and puts a
platform curator in the path of two organizations that only want to work
together.

The lifecycle becomes:

```
candidate ──► declared ──► registered ──► extracted ──► published
   │             │              │             │
   └─► rejected  └──────────────┴─────────────┴──► deprecated
```

| State | Means | Who sets it |
|---|---|---|
| `extracted` | The gear is its own crate in the organization's gear repository, with at least one tagged version. The project it came from depends on it at that version | an organization administrator; the state follows the merge of both pull requests |

### 1. Extract: the gear moves into the organization's gear repository

**The readiness check.** Before anything is written, Studio checks the module.
The check is mechanical and needs no model. It uses the signals discovery
already reads (ADR-0041 §3):

- the module has its own `port` and `sdk`;
- its tables and migrations are its own;
- nothing inside it names `crate::…` outside the module;
- its dependencies can be listed, so the new crate's `Cargo.toml` can be
  written from them;
- nothing outside the module reaches into it other than through `sdk`.

Each failed check is shown with the file and line that fails it. Studio does
not extract a gear that would not build.

**Two pull requests, linked:**

1. Into the **organization's gear repository** (ADR-0042 §2): the crate, its
   tests, `gear.toml` and `gear.gdl`, as a member of the repository's cargo
   workspace. Once it merges, Studio tags the version: `<gear>/v0.1.0`.
2. Into the **source project**: the module is removed, and the project depends
   on the gear at that tag.

The entry is `extracted` when both have merged. From then on, the project the
gear came from is one of its consumers.

**The owner** is recorded on the entry (a person or a team), not the project.

**Defaults.**

| Question | Default | Why |
|---|---|---|
| Where extracted gears live | One gear repository per organization, a cargo workspace | ADR-0042 §2 already gives an organization one |
| Versions | git tags `<gear>/vX.Y.Z` | needs no infrastructure; a private cargo registry can come later and record the same versions |
| First scope | Rust gears | FrontX packages and kits follow the same path later |

An organization with no gear repository is told to name one before it can
extract.

### 2. Use: a project depends on the gear at a version

- A project's candidates and coverage offer the gear with the tier
  `organization`. When the organization's gear and the platform's answer
  equally well, the organization's is offered first (ADR-0042 §3).
- **Add to product** names the gear and its version in `product.gdl`
  (`analytics@0.1.0`), and adds the git dependency at the tag to `Cargo.toml`.
- When a newer version is tagged, every consumer still on an older one is
  shown as **behind**. Moving up is a pull request a member opens. Nothing
  moves by itself.
- The entry lists its consumers and the version each one uses.

### 3. Export: a gear package

An extracted gear, at one of its versions, can be given to another
organization. An organization administrator of the owning organization decides
it. No platform curator is involved.

**The package** is the extracted crate at its tag, packed with what a
receiver needs to trust it and build it:

| Part | What it is for |
|---|---|
| `gear.gdl` | The gear's passport and the package's manifest: contracts, capabilities, config schema, dependencies |
| The crate's sources, `sdk`, migrations, tests | To build the gear |
| `gear.lock` | The exact version of each dependency: platform gears, and gears carried in the same package |
| `provenance` | Where it comes from: organization, repository, commit, version, who exported it and when |
| A digest, and for a file a signature | So the receiver can tell the package was not changed |

**Dependencies.** An exported gear may depend on:

- **platform gears**, by version: every organization has them;
- **its own organization's gears**: they go into the same package, or the
  export is refused with the list of what is missing;
- **gears its organization imported**: only when their own export allows
  passing them on.

**Two ways to deliver it:**

- **To an organization in the same Studio.** The owner names the receiving
  organization. No file changes hands: an entry appears in the receiver's
  registry, and a newer version shows up there as one.
- **As a `.gear` file**, for another Studio installation or a closed network.
  The receiver uploads it into its registry. A newer version is a newer file.

The first is built first: Studio already knows both organizations, so it
needs no signature.

### 4. Import: the receiving organization's `imported` tier

ADR-0042 has two tiers. Imported gears are a third:

| Tier | Meaning |
|---|---|
| `platform` | from the shared set |
| `imported` | given to this organization by another one, at a version |
| `organization` | from the organization's registry |
| `project` | declared in this project's own repositories |

- An imported gear is read-only, like a platform gear. A product can use it;
  nobody in the receiving organization edits it.
- It can be **forked**, as a platform gear can (ADR-0042 §1). The fork
  replaces the import inside the receiving organization, and is shown as
  behind when the giver tags a newer version.
- `product.gdl` pins it by version and digest. A new version changes no
  product until a member moves it up.
- Importing is a decision of a receiving organization's administrator,
  recorded like every registry decision: who, when, from where. The gear is
  another organization's code, and it will run in this organization's
  products.

### 5. Publish starts from `extracted`

ADR-0042 §4 publishes a `registered` gear by opening a pull request into
`gears-rust`. It now starts from `extracted`: what reaches the platform is a
crate that already builds alone, with versions, not a directory cut out of a
project.

## Consequences

- Good: a gear an organization wrote once is used by all its projects, at a
  version each one chooses.
- Good: two organizations can share a gear without making it everyone's.
- Good: what reaches the platform has already been used on its own.
- Good: "which `analytics` was this product built with" has an answer: the
  version in `product.gdl`.
- Bad: extraction is two pull requests that must both merge. Until both do,
  the gear is in two places. Studio shows the entry as extracting, with both
  links.
- Bad: an organization must name a gear repository before it can extract.
- Bad: the readiness check will refuse many modules today. Most declared
  components share code with their project. The check says why, which is the
  work to do.
- Bad: a receiving organization runs another organization's code. The import
  decision, the digest and the provenance are what it has to judge it by.

## More Information

**What the Gearbox engine needs.** `gear.gdl` is Gearbox's format, so the
package format belongs there too; Studio packs and reads it. The engine also
needs to compose a product from more than one corpus (the platform's, the
organization's gear repository, imported packages), each at a version. This
is the gap ADR-0042's "More Information" already names. Both go to Gearbox as
one proposal, beside gearbox#4 (the gear passport).

Until the engine composes from several corpora, an extracted or imported gear
reaches a product through `Cargo.toml`, and Studio says the engine cannot
compose it yet.

**Phases in Studio:**

1. **The readiness check**, run over every declared and registered component,
   and shown on the registry: what is ready to extract and what blocks the
   rest. *Built: the catalogue design's Readiness to leave the project.*
2. **Extract**: the two pull requests, the tag, the `extracted` state and the
   consumers list. *Built: the catalogue design's Extract
   (`registry_extract.rs`); Publish now starts from `extracted` too (§5).
   The consumers are the registry's existing ones (P4), by Cargo dependency
   and product picks, without their versions yet.*
3. **Use**: Add to product with a version, and behind.
4. **Export within one Studio**, and the `imported` tier.
5. **The `.gear` file**, with a signature.
6. **Composition from packages and several corpora**, once Gearbox supports
   them.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/studio-components-catalog.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-fr-gear-catalogue`
* `cpt-studio-component-components-catalog`
* `cpt-studio-adr-component-registry`
* `cpt-studio-adr-component-tiers`
