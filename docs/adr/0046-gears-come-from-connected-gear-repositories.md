---
type: adr
status: proposed
date: 2026-10-15
---

# ADR-0046: Gears come from gear repositories, connected like any other connection, several per tier

**ID**: `cpt-studio-adr-gear-repositories`

Status: **proposed** · Date: 2026-10-15 · Refines `cpt-studio-adr-component-tiers` (ADR-0042: where each tier's gears come from, and its phase 4) · Uses `cpt-studio-adr-gear-extraction` (ADR-0044: an organization's gear repository)


Amended by ADR-0060 (2026-11-04): a project has no gear repository of its own
any more. The old `project_gear_repo` record is folded into the project's
`sources[]` as the source marked `gears_here`, and it no longer decides where
`product.gdl` is written or what a build clones — see
[ADR-0060](0060-a-project-is-one-list-of-sources-and-a-revision-pins-each.md).

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. A gear repository is a connection](#1-a-gear-repository-is-a-connection)
  - [2. Each tier has its list, on its Sources tab](#2-each-tier-has-its-list-on-its-sources-tab)
  - [3. The engine reads a tier's repositories together](#3-the-engine-reads-a-tiers-repositories-together)
  - [4. A product names the repository of each gear](#4-a-product-names-the-repository-of-each-gear)
  - [5. A gear is known by its id, not by its repository](#5-a-gear-is-known-by-its-id-not-by-its-repository)
  - [6. Publishing names the repository it goes to](#6-publishing-names-the-repository-it-goes-to)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

`gears-rust` is to be split into several repositories. Studio assumes there
is one:

- **The Gearbox engine's corpus is one repository, set in the deployment**
  (`STUDIO_GEARBOX_CORPUS_URL` / `_REF`, `product/gearbox.rs`), read with no
  token, under the fixed source id `gears-rust`. On Dev it is still a fork
  (`MikeFalcon77/gears-rust@feature/gearbox`), and changing it needs a
  deployment.
- **`product.gdl` has one source** and points every `use_gear` at it.
- **The IDE relays one corpus** (`/gearbox/corpus/…`).
- **Publishing writes into "the first `gears` source"** of the platform
  (ADR-0042 §4).
- **Gear repositories are configured in three places that do not know of
  each other:** the deployment's corpus, the catalogue's `gears` sources
  (platform and organization), and the organization's gear repository setting
  (ADR-0042 §2). Each of them names a repository and the connection that reads
  it in its own way.

The engine is not the obstacle. Run over `gears-rust` split in two
(`gears/system` in one root and the other gears in a second root), the
engine finds the same 47 gears the whole repository has under `gears/`, with
no diagnostics. Gears in one root that depend on gears in the other resolve,
and each gear is attributed to its root (`gearbox catalogue --root a --root
b`, engine `ea964f9`, checked 2026-10-15).

## Considered Options

1. **A gear repository is a kind of connection.** A new connector type,
   `gear-repository`, connects one repository at a ref. A tier's gear
   repositories are its connections of that type, listed on its Sources tab.
2. **A list of repositories in the deployment** (`STUDIO_GEARBOX_CORPORA`).
   Each change is a deployment, the list is for the whole portal, and
   organizations get no repositories of their own.
3. **Keep the catalogue's `gears` sources, and feed the engine from them.**
   Each source is a row that borrows "the first GitHub connection". It is
   not a thing a person can test, see the state of, or reuse elsewhere.

## Decision Outcome

Chosen option: **1, a gear repository is a connection.** People already know
how to add, test, scope and remove connections. A connection already keeps
its credential in credstore, out of every response. The connectors gear is
already Studio's one way into a repository host.

### 1. A gear repository is a connection

- **A new connector type, `gear-repository`**, in a new category `gears`
  (beside `source_code`, `ai`, `notification` and `cluster`).
- **One connection is one repository at one ref:**

| Field | Meaning |
|---|---|
| `base_url` | the repository, `https://github.com/<owner>/<repo>` (GitHub first, then GitLab and Bitbucket) |
| `ref` | branch or tag to read, default the repository's default branch |
| `source_id` | the name the engine and `product.gdl` know it by, kebab-case, unique in its tier, default the repository's name (`gears-rust`, `gears-bss`) |
| token | optional: none for a public repository, a read token for a private one; Create a gear and Publish need write access |

  The connection gains an `options` object for `ref` and `source_id`.
  Connections have no free-form options today.
- **Test** reads the ref and lists the repository's `gear.gdl` files. It
  answers "reachable at `<commit>`, `<n>` gears", or what is missing.
- **Scope:** organization. A connection owned by the platform's (root)
  tenant is a platform gear repository. A connection owned by an organization
  is that organization's.

### 2. Each tier has its list, on its Sources tab

- **Platform › Sources** and **Organization › Sources** list the tier's gear
  repositories, in order. Each row shows the source id, the repository and
  ref, the commit last read, the number of gears, and the engine's
  diagnostics. Adding a row creates a `gear-repository` connection.
  The platform's list is edited by a platform administrator only; every
  organization sees it, read-only.
- **The order is the engine's order:** where two repositories declare the
  same gear, the earlier one wins (and the engine reports GBX0105).
- **One of the organization's repositories is its default for Create a gear.**
  This replaces ADR-0042 §2's gear repository setting.
- **FrontX and kits sources stay catalogue sources** for now. The same move
  can come later, with their own connector types.

### 3. The engine reads a tier's repositories together

- **An organization's corpus** is the platform's gear repositories, then the
  organization's, each checked out under a directory named by its source id
  and passed as its own `--root`. The repositories are always read together,
  because a gear in one may need a gear in another.
- **Checkouts are shared:** they are keyed by URL and commit, so ten
  organizations on the platform's repositories hold one copy of each.
- **Each repository is read with its own connection's token.** The platform's
  repositories are read with the platform's connections only, never with one
  an organization could name. An organization's repositories are read with
  its own connections.
- **The deployment's corpus setting becomes a fallback.** While the platform
  has no gear repository, `STUDIO_GEARBOX_CORPUS_URL` / `_REF` is the one
  root. Once it has one, the setting is not read. Nothing is written for the
  platform at start: the server has no one to act as there. The catalogue's
  existing `gears` sources become gear repositories in phase 3.

### 4. A product names the repository of each gear

- **`product.gdl` has one `source` per repository it uses**, at the commit it
  was composed against: `source(id = "gears-bss", at = git(url = …, rev = …))`.
  Each `use_gear` names its repository: `use_gear("ledger", source = "gears-bss")`.
  The engine's `product.lock` records the commit of each.
- **The IDE brings in each repository** the product names, through one relay
  route per source id (`/gearbox/corpus/{source_id}/…`), with the server's
  token. The per-machine corpus cache already keys by repository and commit.

### 5. A gear is known by its id, not by its repository

A split moves gears between repositories. A gear's catalogue entry, registry
entry, annotations and product picks are keyed by its id, so they survive
the move. The sync records the new repository and commit on the entry, and
its history says "moved from `gears-rust` to `gears-bss`". It never drops an
entry because the repository it came from no longer has it, while another of
the tier's repositories does.

An organization gear with the id of a platform gear is a fork only when it is
recorded as one (ADR-0042 §1). Otherwise it is a conflict, and the
Sources tab shows it.

### 6. Publishing names the repository it goes to

The platform curator picks the platform gear repository a published gear goes
into (ADR-0042 §4). The default is the repository holding most of the gears
in the gear's category. With no platform gear repository, Publish is refused,
as today.

## Consequences

- Good: when the split lands, the split is a list of connections, not a
  deployment. Moving Dev off the fork is the same step.
- Good: one place says where a tier's gears come from, and the place shows
  whether each repository can be read and what the engine found in it.
- Good: an organization's own gears compose into its products, which
  ADR-0042 left waiting on several corpora.
- Good: private gear repositories work: the token is the connection's, and
  the IDE reaches the repository through the server.
- Bad: each organization's catalogue and previews run the engine over more
  roots. A shared checkout keeps disk flat, but the engine's time grows with
  the repositories.
- Bad: a connection now carries options (`ref`, `source_id`) that only one
  connector type reads.
- Bad: until the engine honours `use_gear(source = …)`, a gear id declared in
  two repositories resolves by order, not by the product's choice.

## More Information

**From the engine (constructorfabric/gearbox):**

- Honour `use_gear(source = …)`. It is parsed today and not read.
- GBX0105 (a gear declared twice) should name both roots, so Studio can say
  which two repositories conflict.

**Phases:**

1. **The connector type, the Sources tab and the platform's corpus.** Add the
   `gear-repository` connector, `options`, and Platform › Sources. Build the
   engine's corpus from the platform's repositories (N roots), with the
   deployment's setting as the fallback while there are none. Show status per
   repository. *Built: see studio-product's design, and the connector's.*
2. **`product.gdl` with a source per repository**, pinned commits, and the IDE
   relay per source id. *Built: `product.gdl` names a pinned source per
   repository (phase 1); the catalogue answers every root (`roots`), the
   relay serves each by source id, and the IDE brings all of them in, all or
   none, each under its source id.*
3. **The organization's gear repositories:** Organization › Sources, the
   organization's corpus (platform then organization), the default for
   Create a gear. Migrate the catalogue's `gears` sources and ADR-0042 §2's
   setting, once. *Built: an organization holds gear-repository connections;
   its corpus is the platform's roots then its own (one clash of source ids
   leaves its repository out, and says so); the one marked `create_target`,
   else the first, is its gear repository for Create a gear and the registry
   walk. ADR-0042 §2's setting is still read while an organization has no
   gear repository of its own -- that is the migration path, and nothing is
   rewritten. The catalogue's `gears` sources stay what the catalogue sync
   reads.*
4. **Publishing picks its repository.** *Built: the curator picks one of the
   platform's gear repositories (`target`); the default is the one holding
   most gears of the entry's category.*

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/studio-components-catalog.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-adr-component-tiers`
* `cpt-studio-adr-gear-extraction`
