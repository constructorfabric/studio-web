---
type: adr
status: proposed
date: 2026-10-29
---

# ADR-0053: A product's description is kept by Studio, versioned, and built with the code of a branch the build chooses; publishing it to the repository is optional

**ID**: `cpt-studio-adr-product-description-in-studio`

Status: **proposed** · Date: 2026-10-29 · Changes where the product description ADR-0045 builds from lives (`cpt-studio-adr-project-builds`) · Keeps the image and chart contract of ADR-0048 (`cpt-studio-adr-product-images`) · Uses the gear repositories of ADR-0046 (`cpt-studio-adr-gear-repositories`)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. Studio keeps the working description, by revision](#1-studio-keeps-the-working-description-by-revision)
  - [2. A build is code at a ref plus a description revision](#2-a-build-is-code-at-a-ref-plus-a-description-revision)
  - [3. Publishing to the repository is optional, and has one branch](#3-publishing-to-the-repository-is-optional-and-has-one-branch)
  - [4. Until then: a product branch lends only its description](#4-until-then-a-product-branch-lends-only-its-description)
  - [5. The existing `product/*` branches](#5-the-existing-product-branches)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

A project's product is described by one `product.gdl`. Today Studio keeps
that file only in the project's repository, and it gets there on a branch:

- **A branch per version.** Saving the product from the portal
  (`studio-backend/src/product/rest.rs`, the `write` path) writes the file
  onto a branch named after its content, `product/<id>-<first 4 bytes of its
  sha256>`, unless the repository is the product's own (`onto_base`). Each
  change of the description is a new branch, and with "open a PR" a new pull
  request (#924 is one).
- **A branch is a snapshot of the whole repository.** The branch starts from
  the base branch when it is saved and is never brought forward. Whatever
  builds the product from it builds the code as it was then: the desktop
  opens the product on that branch (`gearbox.product.openAt` with the
  branch), and a Build in Studio clones `--ref` that branch
  (`environments/build.rs`). On 2026-10-29 a desktop **Build images** of
  studio-web compiled `studio-backend` from `product/studio-web-e49ada0d`, a
  day behind `main`, and failed on a fix that was already merged.

So the description and the code travel together where they should not. The
description changes when someone recomposes the product; the code changes
with every merge. Tying them to one branch leaves either the description or
the code stale, and fills the repository with branches nobody merges.

The question is where the description should live so that a build gets the
current code and the current description, and so that a project does not
need write access, review or a branch to change which gears it uses.

## Considered Options

1. **Keep it on branches** (today). Nothing to build; the problems above stay.
2. **Keep it only in the repository, on the base branch, by pull request.**
   One file on `main`, every change a PR. History and review for free, and
   builds from `main` are current. But every recomposition waits for a
   review, needs write access to a repository Studio may only read, and a
   protected `main` turns the portal's "save" into a queue.
3. **Keep it only in Studio.** No branches, no PRs, instant saves. But the
   description leaves git: no review, no history next to the code, and the
   `gearbox` CLI and a repository's own CI cannot see it without Studio.
4. **Studio keeps the working description; publishing it to the repository
   is optional** (hybrid). Saves are instant and versioned in Studio; a team
   that wants the description in git publishes it as one PR from one branch.

## Decision Outcome

Chosen option: **4**. Option 3 is the same for a project that never
publishes; option 2 stays available to one that always does.

### 1. Studio keeps the working description, by revision

Each project has a product description in Studio: the latest text and its
revisions, each with its author, time and a content digest. The text is the
same `product.gdl` the engine reads; nothing about GDL changes. It is stored
by the product gear, small text beside the product record it already keeps
for the project (the preview and "where it was saved" that `rest.rs` records
on every run), not as a file in object storage: it is read on every build and
every open, and it is kilobytes.

The portal's Components and Product tabs save there. The desktop reads it
when it opens a product from Studio and saves there when the description
changes (Apply in Gearbox writes the file into the checkout, as now, and the
desktop hands the new text to Studio). A conflict -- the revision the editor
started from is no longer the latest -- is answered with both texts, the way
a document save is.

### 2. A build is code at a ref plus a description revision

Every build names two things, and records both: the **code** (the project's
repository at a branch, tag or commit; the repository's default branch when
none is chosen) and the **description revision**. The build lays the
description into the checkout at its path (`products/<id>/product.gdl`, or
the root `product.gdl` when the project keeps it there) before `gearbox
generate`, so every relative `path(...)` source resolves as today.

- **Build in Studio**: the Job's `prepare` gets the revision's text from the
  server alongside `--ref`, and the build record carries `description_revision`
  beside `commit`.
- **Desktop**: Generate, Build and Build images take the project's checkout
  as it is (Sync brings it forward, #923) and the description from Studio;
  the build it reports names the revision.
- **CI**: the proposed workflow fetches the revision with the token the CI
  build already uses to report itself, or reads the published file when the
  project publishes (§3).

A build of the same commit and revision is the same build. Nothing builds
"whatever is on the product branch" any more.

### 3. Publishing to the repository is optional, and has one branch

A project may publish its description: Studio writes the current revision to
the file's path on one branch per product, `product/<id>`, recreated from the
base branch each time, and opens or updates one pull request. Merged, the
file on the base branch is the published description; Studio records which
revision that was. The CLI (`gearbox resolve --product product.gdl`) and a
repository's own CI read it there.

A description edited in the repository (a merged change to the file) is read
back into Studio as a new revision, so the two do not drift silently; when
both changed, Studio shows the difference and asks which wins.

### 4. Until then: a product branch lends only its description

Before §1–§3 land, a build from a `product/*` branch takes the code from the
repository's base branch and only `product.gdl` from the product branch: the
Job's `prepare` checks out the base branch and the file from the product
branch's commit; the desktop does the same when it opens a product on a
branch (the file, not a worktree of the whole branch). This alone removes the
failure of 2026-10-29.

### 5. The existing `product/*` branches

On the first read of a project after §1 ships, Studio takes the description
from where the project's record says it was last saved (its branch and
commit) as revision 1. The branches are left alone; Studio offers to delete
the ones whose description it now holds, listing them with their PRs, and
does not delete anything itself.

## Consequences

- (+) A recomposition is instant and needs neither write access nor a review.
- (+) Builds are reproducible from two recorded coordinates, and always get
  current code unless a ref is chosen.
- (+) No branch per save; at most one per product, and only for a project that
  publishes.
- (−) For a project that does not publish, the description's history is in
  Studio, not in git; a change of code that needs a change of the product is
  two steps (merge, then recompose).
- (−) The CLI and an unmodified CI need either Studio or a published file.
- (−) Two sources can disagree for a project that publishes and also edits
  the file in the repository; §3 surfaces it instead of choosing silently.

## More Information

**Work, in order** (each one can merge alone):

1. §4: the build's `prepare` and the desktop take only `product.gdl` from a
   product branch.
2. Description revisions in the product gear; the portal saves there; the
   build record gains `description_revision`.
3. Builds (Studio, desktop) take the description from Studio (§2).
4. The desktop reads and saves the description through Studio.
5. Publish (§3) and read-back of a merged change; migration (§5).

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-adr-project-builds`
* `cpt-studio-adr-product-images`
* `cpt-studio-adr-gear-repositories`
