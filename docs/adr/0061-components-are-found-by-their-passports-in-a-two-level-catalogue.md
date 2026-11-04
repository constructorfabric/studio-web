---
type: adr
status: proposed
date: 2026-11-04
---

# ADR-0061: Components are found by their passports, in a catalogue with an organization level and a project level

**ID**: `cpt-studio-adr-component-passports`

Status: **proposed** · Date: 2026-11-04 · Amends `cpt-studio-adr-component-registry` (ADR-0041) §1 and §3, `cpt-studio-adr-component-tiers` (ADR-0042) §3, `cpt-studio-adr-gear-extraction` (ADR-0044), and `cpt-studio-adr-frontend-from-micro-frontends` (ADR-0050) on what a passport carries

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. One passport per component, found in every source](#1-one-passport-per-component-found-in-every-source)
  - [2. `service.gdl`: an own service that is not a gear](#2-servicegdl-an-own-service-that-is-not-a-gear)
  - [3. `kit.gdl`: a kit](#3-kitgdl-a-kit)
  - [4. Every passport may name its documents](#4-every-passport-may-name-its-documents)
  - [5. A read is keyed by the repository's address, not by the connection](#5-a-read-is-keyed-by-the-repositorys-address-not-by-the-connection)
  - [6. Two levels: the organization's catalogue and a project's](#6-two-levels-the-organizations-catalogue-and-a-projects)
  - [7. The organization's platform release](#7-the-organizations-platform-release)
  - [8. A project publishes a component at a version](#8-a-project-publishes-a-component-at-a-version)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

On 2026-11-04 the project Studioweb (Studio rebuilt on its own gears) lost
the screen previews on its product map, and every Studio gear read as
`not_described`. Three things were wrong at once:

- **The catalogue followed the connection.** The registry keyed each read of
  a repository on the tenant, the connection, the repository and the ref.
  When the project's gear repository moved from one connection to another,
  the old key looked gone and its 42 gears and micro-frontends lost their
  occurrences. Nothing came back until a sync ran with that exact pairing
  again.
- **A project's own components had no home.** The registry reads a
  project's repositories for gears declared in Rust, but not for its FrontX
  packages. The map matches a preview to a catalogue component by package
  name or by repository and path, so Studio's micro-frontends, which live in
  the project's repository and in no catalogue source, could not be matched.
- **Some components had no description at all.** A service with its own
  Dockerfile (the IDE image, Keycloak, the graph database) and a kit were
  either guessed from build files or listed from a hard-coded catalogue
  (`STUDIO_KIT_CATALOGUE`).

The decisions of 2026-11-04 settle this: a component is described by one GDL
passport beside it, Studio finds components by those passports in every
source, and the catalogue has two levels.

## Considered Options

1. **One passport per component, two catalogue levels, publication by
   version** (this ADR).
2. **Keep scraping build files** (`package.json`, `Dockerfile`, Cargo
   attributes) and add a project filter to the organization's catalogue.
3. **Put a project's components straight into the organization's catalogue**
   and mark them with the project.

## Decision Outcome

Chosen option: **1**. Option 2 keeps guessing what a file means, and a guess
is what showed Studio's shell as "no sign-in" until `frontx.gdl` said so.
Option 3 publishes work in progress to every other project of the
organization, which the user ruled out: a project's components are its own
until it proposes one.

### 1. One passport per component, found in every source

A component is one directory with one passport in it:

| File | Declares | Vocabulary |
|---|---|---|
| `gear.gdl` | a gear or a plugin | GDL, Gearbox's |
| `frontx.gdl` | a FrontX shell, micro-frontend or library (ADR-0050) | GDL 1.5 |
| `service.gdl` | an own service that is not a gear | GDL 1.6, below |
| `kit.gdl` | a kit | GDL 1.6, below |

Every catalogue source and every project source is read for all four,
whatever mode the source names: a FrontX source still yields the services
and kits in it. Studio reads them without evaluating
(`components_catalog/frontx_gdl.rs`, `gdl_literal.rs`, `service_gdl.rs`,
`kit_gdl.rs`). A passport is `gdl_version = "1.x"` and one call with named
literal arguments: `True`, `False`, `None`, strings, whole numbers, lists of
strings, and dicts of strings to strings or numbers. A name, an operator,
`if`, `def` or `load()` is refused with its line. Gearbox evaluates the same
files as Starlark, and this subset reads the same either way.

### 2. `service.gdl`: an own service that is not a gear

```text
gdl_version = "1.6"

service(
    name = "studio-keycloak",                 # required: kebab-case id
    version = "26.7.0",                       # its own version
    description = "Keycloak with Studio's authentication provider",
    image = "ghcr.io/org/studio-keycloak",    # without a tag or a digest
    dockerfile = "Dockerfile",                # relative to this file
    context = ".",                            # relative to this file; may be ".."
    ports = {"http": 8080, "management": 9000},
    health = "/health/ready",                 # a route
    env = {"KC_DB": "postgres"},              # variable -> what fills it
    requires = ["account-management"],        # platform gears it calls
    provides = ["oidc-identity-provider"],    # capability keys
    docs = ["README.md"],                     # relative to this file
)
```

- Only `name` is required. A path may climb with `..` but never out of the
  repository; the catalogue stores each path from the repository root.
- `ports` values are 1 to 65535 (a digit string is read too). `env` keys are
  `UPPER_CASE`; each value says what fills it at run time
  (`gateway.url`, `secret.database_password`), never a secret.
- **For Gearbox.** When Gearbox generates a product that names an own
  service, it reads this vocabulary: `image` and `dockerfile`/`context` to
  build or pull it, `ports` and `health` for the Service and the probes, `env`
  for the variables the deployment fills, `requires` checked against the
  product's gears like a micro-frontend's (GBX0720). Gearbox is not changed by
  this ADR; this section is the contract it follows.
- The node type is `gts.cf.studio.catalog.service.v1~`, a component type of
  its own with its own field schema.

This repository carries three: `theia/service.gdl`, `keycloak/service.gdl`,
`studio-backend/docker/graph-postgres/service.gdl`.

### 3. `kit.gdl`: a kit

```text
gdl_version = "1.6"

kit(
    name = "sdlc",                            # required: the slug cfs installs it by
    title = "Software Delivery Lifecycle",
    version = "1.4.0",
    description = "Product-to-code traceability with PRD, ADR and DESIGN workflows",
    publisher = "Constructor Fabric",
    visibility = "public",                    # or "private"
    manifest = ".cf-studio-kit.toml",         # the installer's manifest, relative
    kinds = ["PRD", "ADR", "DESIGN", "FEATURE"],
    docs = ["README.md"],
)
```

- One passport per kit, beside the installer's manifest. The fields carry
  over what the kit registry's `KitDescriptor` and the manifest's `[[kits]]`
  blocks say (slug, name, description, publisher, visibility, manifest path)
  and add what neither had: the kit's own version, the artifact kinds it
  brings, its documents.
- The installer (`cfs`) still reads `.cf-studio-kit.toml`; the passport is
  what the catalogue lists and versions. A kit both describe is one kit, the
  passport's. A repository with only the manifest is read as before.
- The kit repositories (`constructorfabric/studio-kit-sdlc`,
  `constructorfabric/studio-kits-pm`) add their `kit.gdl` in their own
  repositories; until then the built-in catalogue stays.

### 4. Every passport may name its documents

`docs = ["README.md", ...]` is part of every vocabulary: relative to the
passport, kept inside the repository. The catalogue stores them from the
repository root on the component (`docs`), the Components page links each,
and `GET /studio-components-catalog/v1/components/{name}/docs?path=` reads one
from the component's source at the ref it was read at (only a path the
component lists; cut at 200 KiB). A passport that lists none gets the README
beside it.

For `gear.gdl` and `frontx.gdl` Studio's reader takes `docs`, but **Gearbox's
vocabulary refuses it today** (GBX0106 "extra named parameter"), so files
Gearbox also evaluates (Studio's own `studio-frontend/**/frontx.gdl`) leave it
out and get the README rule. Gearbox adding `docs` to `gear()`, `shell()`,
`mfe()` and `library()` is the follow-up; nothing else changes then.

### 5. A read is keyed by the repository's address, not by the connection

The registry's read key is `owner/name@ref`, the name lower-cased
(`repo_enrich::address_key`). The connection is how a repository is read,
not which repository it is: re-pointing a source to another connection keeps
its occurrences, and an unchanged fingerprint keeps the read. Keys written in
the old form (`<tenant>/<Some(connection)>/owner/name@ref`) are moved once, at
the start of the next walk (`registry::migrate_repo_keys`): occurrences are
rewritten in place, reads move to their address's id, and two reads of one
repository through two connections become one, the latest kept. The
in-memory caches still key on the reading tenant, so no tenant is answered
from another's read.

A project's repositories are its sources and its recorded gear repository
together, one read per address.

### 6. Two levels: the organization's catalogue and a project's

- **The organization's catalogue** is what its administrator's sources hold,
  joined with the platform's (ADR-0042). `GET /components` as before.
- **A project's catalogue** is the organization's plus what the project's
  own repositories hold, read by the passports above (gears and FrontX
  packages alike) into **the project's own tenant**: graph storage keeps
  tenants apart, so no other project and not the organization sees them.
  `GET /components?project_id=` and `GET /profiles?project_id=` answer it; a
  project node is `tier: project` and wins over an organization node of the
  same type and id. The caller must reach the project.
- **It stays current by itself.** A `catalog.sync` naming `project` reads the
  project's repositories (only through connections the organization owns,
  ADR-0042). The hourly registry walk queues one for every walked project
  whose repositories' fingerprints moved (`project_catalogues` in the
  organization's registry settings); a push or a change of sources that
  queues a walk of the project reaches it the same way, and
  `POST /project-catalogue/sync?project_id=` reads it now.

### 7. The organization's platform release

The platform's sources are every organization's to see, and none may hide
one. An organization may hold any of them at a version of its own: a **pin**
(repository, tag or commit, who, when). `GET`/`PUT /platform/pins`; only an
organization administrator changes them, and a pin must name a platform
source. A platform component from a pinned source says `pinned_ref`.

Today the pin is recorded and shown. Building against it (a product of the
organization taking a pinned gear at that version) is the next step and
belongs with the product lock (ADR-0053), which already decides a gear's
version from the product code's `Cargo.lock`.

### 8. A project publishes a component at a version

A project proposes one of its own components to the organization
(`POST /publications?project_id=`), and an organization administrator
answers (`POST /publications/{id}/decisions`, `approve` or `decline` with a
reason). What is published is **a version**: a tag or commit and the
passport's version. A new version is a new publication. Approved, a copy of
the component at that version joins the organization's catalogue, saying
where it came from (`published_from`); no sync of the organization's sources
prunes it. A **published artifact** (a crate, an npm package, an image) is a
field of the request (`artifact`) for when builds publish one; nothing builds
it yet.

This is ADR-0044's flow one level down: ADR-0044 moves a gear from a project
into the organization's gear repository, and ADR-0042 §4 gives an
organization's gear to the platform. A publication puts a project's
component into the organization's catalogue without moving its code.

## Consequences

- Good: re-pointing a connection no longer empties the catalogue, and the
  stored data moves to the new key without a manual re-sync.
- Good: Studioweb's map finds Studio's micro-frontends in the project's
  catalogue and shows their previews again.
- Good: a service and a kit are described, not guessed, and Gearbox has the
  `service(...)` contract to generate from.
- Bad: a project's repositories are read twice (gears and FrontX) per
  project sync. Bounded by the fingerprint: an unchanged project is not
  synced again.
- Bad: `docs` in `gear.gdl`/`frontx.gdl` waits for Gearbox.
- Neutral: a pin changes what the organization sees, not yet what it builds.

## More Information

- `studio-backend/src/components_catalog/`: `gdl_literal.rs`,
  `service_gdl.rs`, `kit_gdl.rs`, `catalogue_levels.rs`,
  `catalogue_levels_rest.rs`; `repo_enrich::{passport_component, docs_of,
  address_key, canonical_repo_key}`; `registry::migrate_repo_keys`.
- Prototype: Components › Organization and projects
  (`catalogue-levels-view.tsx`). Attaching or detaching a source, and
  creating a project with one, asks for the project's sync (`saveSources`
  in `App.tsx`, ADR-0063 §3). The product map describes a gear the
  engine's corpus does not hold from its passport in the project's
  catalogue (`product-map.ts`, `components`).
- Memory of the findings: issues 11 and 14 of the 2026-11-04 build of
  Studioweb.

## Traceability

- Amends ADR-0041 §1 (a project's repositories are read for every passport,
  into its own catalogue) and §3 (an occurrence's read is keyed by address).
- Amends ADR-0042 §3 (an organization pins platform sources; it never hides
  one).
- Extends ADR-0044 (a project publishes a component at a version).
- Amends ADR-0050 (a passport may name its documents).

> Amended by ADR-0064 ([a product's infra services are catalogue components, deployed with it](0064-a-products-infra-services-are-catalogue-components-deployed-with-it.md)): `service.gdl` takes `kind = "infra"` for a third-party service a product runs beside its gears, with `args`, `config`, `secrets`, `provides` as a dict of capability to template, `stateful`/`storage`/`data_path` and a ready `chart`/`chart_version`. The catalogue keeps them under `infra` on the service node, with `service_kind`.
