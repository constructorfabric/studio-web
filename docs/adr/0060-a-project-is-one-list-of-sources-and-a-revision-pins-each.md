---
type: adr
status: proposed
date: 2026-11-04
---

# ADR-0060: A project is one list of source repositories, and each description revision pins the commit of every source it uses

**ID**: `cpt-studio-adr-project-sources-and-versions`

Status: **proposed** · Date: 2026-11-04 · Amends `cpt-studio-adr-gear-repositories` (ADR-0046: a project's own gear repository) · Amends `cpt-studio-adr-product-description-in-studio` (ADR-0053: where a description is published, and its lock) · Uses `cpt-studio-adr-profile-per-environment` (ADR-0057)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. One list of sources, no hidden main repository](#1-one-list-of-sources-no-hidden-main-repository)
  - [2. One repository is one source](#2-one-repository-is-one-source)
  - [3. Versions: dev builds branches, protected environments build the lock](#3-versions-dev-builds-branches-protected-environments-build-the-lock)
  - [4. A save never strips the product](#4-a-save-never-strips-the-product)
  - [5. A dev environment is not held to prod rules](#5-a-dev-environment-is-not-held-to-prod-rules)
  - [6. The server's check reads the sources as a build does](#6-the-servers-check-reads-the-sources-as-a-build-does)
  - [7. Platform gear versions come from the code's Cargo.lock](#7-platform-gear-versions-come-from-the-codes-cargolock)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

On 2026-11-04 the project Studioweb (Studio rebuilt on gears, inside Studio) was built and deployed from the local stand. Five problems came from how Studio modelled a project's repositories:

- **Two "project repositories".** A project had its `sources[]` (`project.config`), and beside them a separate gear repository (`project_gear_repo`, `/studio-product/v1/projects/{id}/gear-repo`). Every write to "the project's repository" (`ProductService::write_target`) took the gear repository first and the sources second. A build cloned constructorfabric/studio-web through someone's personal connection, not the source AndrejK666/studio-web the project named. Changing the source did nothing, and nothing on screen said why.
- **One repository named twice.** Revision 5 of the description named studio-web as `git(...)` at a commit and again as `path("../..")`. The engine read every Studio gear twice and refused it (GBX0105).
- **One version for everything.** A build took each source at whatever the description or the branch said, and recorded one commit. Nothing said which commit of each source a release was, and nothing stopped a production deploy from building a branch that moved since the description was saved.
- **A save that strips.** A save through `/product/preview` with `write` and only `gears` and `config` wrote revisions without the frontend block, and dropped the record's configuration with it.
- **The server's check could not see `path(...)`.** With `studio-web` = `path("../..")`, the server-side engine check laid the description in an empty directory. All 42 Studio gears were `not_described`, and every micro-frontend `requires` gave GBX0720.

There was also a sixth, smaller one: a dev environment ran the `prod` profile and was checked by prod rules (static sign-in refused, a tenant resolver plugin required) while it was being set up.

## Considered Options

1. **Keep the gear repository and make its precedence visible.** This still leaves two answers to "which repository is the project's", and moving the gear repository still changes what is built.
2. **One list of sources with explicit roles, and a per-revision lock.** The gear repository becomes a flag on a source. Publishing becomes a flag on a source. A build takes every source the description uses, and the revision records each source's commit.
3. **A lock file in the repository** (`product.lock` committed next to `product.gdl`). This needs write access and a branch for every save, which is what ADR-0053 moved away from.

## Decision Outcome

Chosen option: **2.**

### 1. One list of sources, no hidden main repository

- A project's repositories are `project.config` `sources[]`, and nothing else. Two flags say what a source is for besides being cloned, one source each:
  - `gears_here`: "Create a gear" puts new gears here.
  - `publish_here`: a published `product.gdl` goes here. With none marked, publishing is refused, and Studio keeps the revisions only (ADR-0053 §1).
- The old gear repository is folded into the list. The first time Studio reads it, the `project_gear_repo` node becomes the source marked `gears_here`. It is added to `sources[]` when it is not already one, with `folded_from: "project_gear_repo"`. The fold is idempotent. Where the config cannot be written, the old node is still read, for one release.
- `/studio-product/v1/projects/{id}/gear-repo` keeps its shape. GET answers the source marked `gears_here`, POST marks one.
- The description travels with its **home** source: the one marked `publish_here`, else the first read through a connection, else the first. Its `path(...)` sources resolve in the home source, and a build lays the description in that checkout. The home source is not chosen by where new gears go.
- "Create a gear" goes to the `gears_here` source, else the organization's gear repository (ADR-0042 §2), else the home source.
- A build no longer clones one "write target". It clones the home source for the description's `path(...)` sources and fetches every `git(...)` source. A `git(...)` source that is one of the project's repositories is fetched at the ref Studio chooses (§3), with the repository's credentials (`--source-ref id=ref` on `build-prepare`).

### 2. One repository is one source

- A save is refused when the description names one repository twice, with a message that names both source ids:
  - two `git(...)` sources of one repository;
  - a `git(...)` source of the home repository beside a `path(...)` inside it;
  - two `path(...)` sources one of which holds the other.
- Two directories side by side in one repository (`studio-backend`, `docs`) stay allowed.
- The check runs on every save: the composer's (`/product/preview` with `write`) and a raw save (`POST /studio-product/v1/product-description-revisions`).
- Studio's composer writes the home repository as one source at its root. Its frontend packages name that source too, not a second `frontx-…` one. Corpus roots inside the home repository (a project root such as `studio-backend`) give way to it.

### 3. Versions: dev builds branches, protected environments build the lock

- **The lock.** When a revision is saved, Studio records the commit of each source the description uses, next to the revision (`studio_product_descriptions.sources_lock`).
  - For each project source, Studio reads the head of its branch through the source's connection.
  - For another `git(...)` source, it records the `rev` when that is a commit.
  - Each entry records its id, kind, repository, URL, branch and commit. The lock is on the revision DTO as `sources_lock`, and on the product record's `description`.
  - This is ADR-0053's lock: kept by Studio, not committed to the repository.
- **Dev** (an environment that is not `protected`): each project source is built from its branch head. The build records the commit it actually got for each source (`source_commits` on the build record, from `build-prepare`'s manifest).
- **Protected** (`env.protected`): the build takes only what the latest revision pinned. The home source is cloned at its pinned commit (`--ref`), and each project `git(...)` source at its own (`--source-ref`). A revision without a lock, or one with a source left unpinned, is refused as `REVISION_NOT_PINNED`, and the message says to save the description again. A build is also refused when there is no revision at all.
- A pin is never moved after save. Building newer code in a protected environment takes a new revision.

### 4. A save never strips the product

- A save composes from the whole product record, and the request's fields only override:
  - an empty `gears` means the record's picks;
  - an absent `config` means the record's configuration;
  - the frontend is always the record's, changed with `PUT …/product`.
- A save is also refused when the new text would still drop something the latest revision had:
  - a gear the record still picks, which the engine no longer describes;
  - the frontend, while the record still has one.

### 5. A dev environment is not held to prod rules

- An environment has `strictness: dev | prod`. When it is not set, it is `prod` for a protected environment and `dev` for any other.
- Gearbox has no strictness flag: `gearbox generate --help` and `check` take none. Its own switch is the profile's `development = True`, which reports the production rules' findings as warnings (`gearbox-engine/src/resolve/production.rs`).
- So for `dev`, Studio marks the profile being checked or built `development = True` in the text the engine reads, and leaves the revision unchanged:
  - `build-prepare --strictness dev` rewrites the laid-out description;
  - `/product/preview` takes `strictness: dev`.

### 6. The server's check reads the sources as a build does

- For a preview, Studio checks the home source out at its branch, in the same clone the corpus reads project roots from, fetched at most once a refresh period.
- It reads the home repository's catalogue on its own, once per commit, and lays it over the organization's corpus (§2).
- The engine runs on the description laid in an overlay of that checkout, so `path("../..")` from the file reaches the repository as it does in a build.
- A first clone or catalogue read that takes longer than the request can wait answers 503 with "still being read", and the read carries on.

### 7. Platform gear versions come from the code's Cargo.lock

- Gearbox, since snapshot 5f5a29a, takes every platform crate at the version the product code's `Cargo.lock` pins. `build-prepare` already passes it (`--cargo-lock`, `product_lock`), whether the lock's entries come from crates.io or from git.
- Studio passes nothing more for this.
- An organization "platform release", a pinned set of gear versions, may come later on top.

## Consequences

- A project shows one list on its Sources tab, with the connection, "gears here", "publish product.gdl here", the commit the latest revision pins and the components found in each source.
- The Product page and the Release step show which sources the product uses: the branch a dev build takes, and the commit a protected one takes.
- Moving the gear repository no longer changes builds or publishing. A project that published to its old gear repository publishes nowhere until a source is marked `publish_here`.
- A protected environment refuses a revision saved before locks were kept. Saving it again pins it.
- Several sources fetched by `git(...)` share the home source's credentials. Sources reached through different connections need per-source credentials, which are not there yet.
- The first preview of a large home repository waits for its clone and catalogue. Later previews use the cache.

## More Information

- ADR-0046 §1: where an organization's and the platform's gears come from. Unchanged, except that a project no longer has a gear repository of its own.
- ADR-0053: Studio keeps the description by revision. This ADR adds the per-source lock and makes publishing explicit.
- ADR-0057: a profile per environment. Strictness is per environment too.
- ADR-0059: a build names its cause before it starts. `REVISION_NOT_PINNED` is one of those causes.

## Traceability

- `studio-backend/src/project_sources.rs`: `gears_here`, `publish_here`, `description_home`, `publish_source`, `gears_source`, `fold_gear_repo`, `mark_only`, `set_gears_here` and `update_config`.
- `studio-backend/src/product/service.rs`:
  - `home_target`, `publish_target` and `gears_target`, which replace `write_target`;
  - `fold_legacy_gear_repo`, plus `get_project_repo` and `set_project_repo` working on the sources.
- `studio-backend/src/product/sources_lock.rs`: `sources`, `duplicates`, `plan`, `build_refs`, `SourcesLock` and `OneRepositoryTwice`.
- `studio-backend/src/product/description_service.rs`: `save_description`, which refuses duplicates and keeps the lock; `lock_sources`.
- `studio-backend/src/product/descriptions.rs` and `migrations.rs` (m0002): the `sources_lock` column and `set_lock`.
- `studio-backend/src/product/save_guard.rs`: `compose_request` and `stripped`. `rest.rs`: `preview_product` uses them.
- `studio-backend/src/product/gearbox.rs`:
  - `HomeCheckout`, `with_home`, `overlay`, `development_profile`, and `evaluate` with `home`;
  - `describe` writes the home repository as one source.
- `studio-backend/src/product/project_roots.rs`: `home_checkout`.
- `studio-backend/src/environments/model.rs`: `Strictness`, `Environment::strictness`. `service.rs`: `request_build` with `build_refs`.
- `studio-backend/src/environments/build.rs`: `source_refs`, `strictness`, `SourceOptions`, and `Manifest.sources`. `artifact_ingest/port.rs`: `BuildPlace::source_commits`.
- `studio-frontend-prototype/src/source-roles.ts`, `source-roles-view.tsx`: the Sources tab's role columns and `ProductSources` on the Product page and in the Release step.
- `studio-frontend-prototype/src/environments.ts` (`strictnessOf`, and the form keeping `strictness`) and `environments-screen.tsx`: the environment form says how strictly the environment checks a product, unset following protection, and the ladder marks one that differs from what its protection implies (§5).
