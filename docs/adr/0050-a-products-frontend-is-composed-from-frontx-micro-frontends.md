---
type: adr
status: proposed
date: 2026-10-23
---

# ADR-0050: A product's frontend is composed from FrontX micro-frontends, the way its backend is composed from gears

**ID**: `cpt-studio-adr-frontend-from-micro-frontends`

Status: **proposed** · Date: 2026-10-23 · Issue #874 · Extends ADR-0041 (an organization's registry of its components), ADR-0046 (gears come from connected gear repositories) and ADR-0048 (a product ships as images and a chart) · Answers PRD §13 "how a product's FrontX micro-frontends are composed with its gears"

Amended by ADR-0061 (2026-11-04): every component passport may name its documents (`docs = [...]`); `service.gdl` and `kit.gdl` join `gear.gdl` and `frontx.gdl`.

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. A micro-frontend is a component a product picks](#1-a-micro-frontend-is-a-component-a-product-picks)
  - [2. It says which gears it calls](#2-it-says-which-gears-it-calls)
  - [3. The UI sits beside the gears, not inside a gear](#3-the-ui-sits-beside-the-gears-not-inside-a-gear)
  - [4. The shell is an application of the product](#4-the-shell-is-an-application-of-the-product)
  - [5. The constructor](#5-the-constructor)
  - [6. A gear's TypeScript SDK comes from its OpenAPI](#6-a-gears-typescript-sdk-comes-from-its-openapi)
  - [7. From specs to screens](#7-from-specs-to-screens)
- [Phases](#phases)
- [Consequences](#consequences)
- [More Information](#more-information)

<!-- /toc -->

## Context and Problem Statement

A product built from specs gets a backend: its gears are picked in
`product.gdl`, the Gearbox engine resolves them, and `gearbox generate` writes
a Cargo workspace, Dockerfiles, a Helm chart and `product.lock`. It gets no
frontend: nothing in that output serves a page.

FrontX (`constructorfabric/gears-frontx`) is how Studio's own portal is built:
a shell from the `template-shell` template and micro-frontends mounted in it
at runtime. Each micro-frontend publishes an `mfe.json`, GTS-typed like the
gears: its entries, and its **extensions** — the shell domain each mounts in
(`screen`, `sidebar`, `overlay`, `popup`) with a label, an icon, a route, an
order and a level. The shell reads the manifests at runtime
(`/generated-mfe-manifests.json`, "the shape the future backend API will
return").

The catalogue already scans FrontX repositories and classifies a package with
module federation as a `micro-frontend`. It cannot be picked: spec mapping,
the catalogue port and the Product tab all refuse it, because "a product is
composed of gears". And nothing records which gears a micro-frontend needs:
its API services name their base URLs by hand (`/cf/studio-documents/v1`).

## Considered Options

1. **A gear carries its UI** — `gear.gdl` names the micro-frontend it ships,
   and picking the gear brings the screens.
2. **Micro-frontends are their own components** that a product picks beside
   its gears, each saying which gears it calls; the product's frontend is a
   shell application that mounts them.
3. **No composition** — each product hand-writes its frontend in its own
   repository, as today.

## Decision Outcome

Chosen option: **2**, with a gear allowed to name a default micro-frontend.
One screen often calls several gears (a project page reads documents, tasks
and the artifact graph), and one gear can have several UIs (an admin page, a
member page), so a one-to-one "gear carries its UI" cannot describe Studio's
own portal. Option 3 leaves the generated product with no frontend at all.

### 1. A micro-frontend is a component a product picks

A catalogue entry of kind `micro-frontend` is pickable for a product's
frontend. Its scan records its `mfe.json` extensions (`mfe_extensions`: id,
domain, label, icon, route, order, level). A FrontX library
(`frontend-library`) is not picked: it is a dependency of a micro-frontend.

### 2. It says which gears it calls

A micro-frontend states the gears it calls, so the product can be checked:
a screen that calls a gear the product lacks is a diagnostic, not an error in
a browser. Until `mfe.json` has a field for it (a proposal to FrontX), the
scan reads it from the package's API services — every `/cf/<gear>/v<N>` they
spell (`mfe_calls`). That is evidence, the way spec mapping's word matches
are; the declared field replaces it.

The declaration now exists outside `mfe.json`: a package may describe itself
in a `frontx.gdl` beside its `package.json` (GDL 1.5, `mfe(requires = [...])`,
`shell(signs_in = …, runtime_env = …)` or `library()`). When it has one that
reads, the scan takes `mfe_calls`, `shell_signin` and `shell_runtime_env` from
it instead of the source, files a `library()` as a library rather than a
screen, and records `frontx_described`; when it has none, or it does not read
(`frontx_gdl_error`), the guesses here and in "Take the shell" stand. Studio's
own `studio-frontend` and each of its `mfe_packages` carry one.

`frontx.gdl` is now the package's **passport**: one file with everything a
tool needs about the package, including what `package.json` and `mfe.json`
already say (name, version, description; a micro-frontend's screens, mounts
and `@gears-frontx/react` pin as `frontx`; a shell's `carries`), plus what they
cannot (a shell's `api_prefix`, `base`, `build`, `output`, `node`,
`package_manager`, runtime `env` keys, `build_env`, `sign_in_redirect`; a
micro-frontend's `roles`, `preview`, `fixtures`). Every field but `signs_in` is
optional and falls back to the manifests. A restated fact that disagrees is
Gearbox's GBX0722 (identity, pins, screens) or GBX0723 (softer facts) at
generation, and a `frontx_passport_drift` warning in the catalogue here; the
passport still reads. The Frontend section shows a shell's API prefix, runtime
env keys, build and node, and a micro-frontend's roles.

### 3. The UI sits beside the gears, not inside a gear

A gear may name its default micro-frontend in `gear.gdl` (the engine's
descriptor already has `sdks` in any ecosystem, `npm` included). Picking the
gear then offers that micro-frontend, the way a host offers its plugins.
Nothing forces it: the frontend is composed separately.

### 4. The shell is an application of the product

The FrontX shell is not a gear. `product.gdl` gains a `frontend` block —
the shell template and the picked micro-frontends — and the engine treats it
as one more application of the product beside its host and worker
applications. `gearbox generate` then also assembles the frontend (the
`frontx` CLI over the shell template and the picked packages), builds it into
a static image, and adds it to the umbrella chart; ADR-0048 ships it like any
image. Later the backend serves the manifests the shell reads, so a
micro-frontend can join a running product without a rebuild.

### 5. The constructor

A project's **Frontend** tab composes the UI the way its Product tab composes
the gears: the micro-frontends one can add on the left; the shell in the
middle — navigation made of the picked screens, the page of the chosen one,
the sidebar, overlays and popups — filled by drag or Add; the selected
package on the right with where it shows and the gears it calls, ✓ in the
product or ✗ not. The product's gears that no screen calls are listed with
the packages that could show them. The pick is kept with the product (its
record's `frontend`) and written into its `product.gdl` as
`frontend = frontx_product(...)` (GDL 1.5): the shell and each package by
repository and directory, each repository a `source`, the product's gears a
screen calls as its `requires`, and the libraries the screens share that the
shell lacks as `libraries`. A project that picked before keeps
`project.config.frontend`, read until the next save. Studio writes the block
only when its engine reads GDL 1.5 (`STUDIO_GEARBOX_FRONTX=1`); Gearbox's
`frontx_product` is on the `feat/frontx-frontend` branch of a fork until it
is proposed upstream.

Above it, the steps a build of the frontend takes, each marked with what the
constructor found, because assembling one by hand showed where each goes
wrong:

1. **Take the shell.** A shell is a workspace that carries FrontX packages
   of its own (`template-shell/packages/framework`, …). The scan records
   their versions (`carries`), whether the shell signs users in
   (`src-app/app/auth/`, `shell_signin`), and whether it reads the
   product's addresses at start (`public/env.js`, `shell_runtime_env`).
   The shell is chosen here and kept with the product's frontend.
2. **Mount the micro-frontends.**
3. **Align FrontX versions.** A mounted micro-frontend gets the shell's
   versions whatever it pinned (`deps_versions`). A pin that differs builds
   only if the package uses nothing the shell's version lacks. Studio's own
   screens fail on the stock template for exactly this reason: they import
   names that exist only in Studio's portal.
4. **Sign users in.** A product with a sign-in gear needs a shell that signs
   in.
5. **Reach the backend.** `/cf` goes to the product's gateway.
6. **Gears behind the screens.** A screen that calls a gear the product
   lacks gets 404.
7. **Build.** `gearbox generate` writes `frontend/`: the shell's workspace
   with the picked micro-frontends and libraries mounted, their FrontX pins
   aligned and recorded in `frontx.lock.json`, and a Dockerfile.
8. **Ship.** The image `gbx-<product>-frontend` is nginx serving the build
   and proxying `/cf/` to the gateway, deployed by the product's chart.

### 6. A gear's TypeScript SDK comes from its OpenAPI

The gateway already serves one OpenAPI document that Studio groups by gear.
A TypeScript client per gear is generated from it and published as the
gear's `npm` SDK; a micro-frontend depends on a version of it instead of
hand-written base URLs, and the version check replaces the evidence of §2.

### 7. From specs to screens

Spec mapping maps requirements to gears; its scenarios and screens map to
micro-frontends the same way. A screen no micro-frontend offers is a gap,
closed by "Create a micro-frontend": the FrontX AI kit (`frontx add`)
scaffolds one from the gear's SDK and the domain model's entities, as "Create
a gear" does for the backend.

## Phases

| Phase | What | Owner |
|---|---|---|
| 1 | The scan records `mfe_extensions` and `mfe_calls` (every `src-app/mfe_packages/*`, at any depth); Product › Frontend composes and checks, and is optional ("Add a frontend" from `gears-frontx-templates`' `template-shell`); the pick in `project.config` | Studio |
| 2 | `frontend` block in GDL, the shell as an application, generate builds and charts the frontend; the pick kept with the product and written into `product.gdl` | Gearbox, Studio |
| 3 | Per-gear npm SDKs from OpenAPI, `mfe.json` declares the gears it calls | Studio, FrontX |
| 4 | Screens from specs, "Create a micro-frontend"; the backend serves the manifests | Studio, FrontX |

## Consequences

- Good: a product built from specs can have a UI composed from parts the
  organization already has, checked against its backend before it builds.
- Good: Studio's own portal is the first example — its micro-frontends are
  the catalogue's first entries.
- Bad: until §2's field exists, which gears a screen calls is read from source
  text and misses a call written another way.
- Bad: phase 2 needs a GDL and engine change outside this repository.

## More Information

- FrontX: `constructorfabric/gears-frontx`, ADR-0013 (manifest-driven
  discovery), ADR-0018 (template manifest), ADR-0009 (extension domains).
- The scan: `studio-backend/src/components_catalog/repo_enrich.rs`
  (`frontx_component`, `mfe_extensions`, `gears_called`).
- The constructor: `studio-frontend-prototype/src/frontend-constructor.ts`,
  `frontend-constructor-view.tsx`, inside the Product tab's sections
  (`product-sections.ts`, `product-sections-view.tsx`).
- The first source of micro-frontends: `constructorfabric/gears-frontx-templates`
  (`template-mfe/src-app/mfe_packages/*`), which the constructor offers to add
  to the organization's catalogue when it lists none.
