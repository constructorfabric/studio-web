---
type: design
status: accepted
owner: studio-team
---

# Technical Design — studio-product

- [x] `p2` - **ID**: `cpt-studio-design-product`

The gear-level design of `cpt-studio-component-product`. The product-level
view, and how this gear sits among the others, is in
[Constructor Studio's design](constructor-studio.md). The code is
[`studio-backend/src/product/`](../../studio-backend/src/product/).

## Table of Contents

- [1. Architecture Overview](#1-architecture-overview)
- [2. Principles & Constraints](#2-principles--constraints)
- [3. Technical Architecture](#3-technical-architecture)
- [4. Additional context](#4-additional-context)
- [5. Traceability](#5-traceability)

## 1. Architecture Overview

### 1.1 Architectural Vision

Keeps what a project builds out of gears — the repository its gears live in,
the gears picked for its product, the deployment profile and what the Gearbox
engine said about them — composes `product.gdl` and resolves it with the
engine, writes a new gear's skeleton into the project's repository, and relays
the gear corpus to IDEs that cannot clone it themselves.

The catalogue says what gears exist; the product says what a project makes of
them. Both lived in `studio-components-catalog` until the second half grew a
store of its own, its own writes to repositories and the engine. They split
because they change for different reasons: a sync source or a grade rule is
the catalogue's business, a project's product and how it is written is this
gear's.

The engine stays with the product because resolving a product is what it is
for. The catalogue still needs it — what each gear's `gear.gdl` declares, the
corpus checkout, the engine's catalogue for the components reference — and
reads it, with a project's gear repository, through this gear's port. Nothing
here reads the catalogue.

### 1.2 Architecture Drivers

#### Functional Drivers

| Requirement | Design Response |
|-------------|------------------|
| `cpt-studio-fr-gear-scaffold` | A `project_gear_repo` node per project; repository creation and a generated skeleton written on a branch through the project's connection, optionally as a pull request. |
| `cpt-studio-fr-gearbox-product` | A `project_product` node per project; a preview writes `product.gdl` and runs the Gearbox CLI over the backend's corpus checkout, optionally committing the file: a new product at `products/<id>/product.gdl`, the layout the IDE's Gearbox finds, and a written one where it already is. |

#### NFR Allocation

| NFR ID | NFR Summary | Allocated To | Design Response | Verification Approach |
|--------|-------------|--------------|-----------------|----------------------|
| `cpt-studio-nfr-credential-isolation` | No secret in a session, a browser or a response | `cpt-studio-component-product-gearbox` | Repository tokens are borrowed from studio-connector per call; the corpus token is held in memory, attached upstream by the Git relay and never returned | `product::gearbox` tests |

#### Key ADRs

| ADR ID | Decision Summary |
|--------|------------------|
| `cpt-studio-adr-a-desktop-session-keeps-the-secrets-on-the-server` | A laptop clones a private gear corpus through the backend, which attaches the token. |
| `cpt-studio-adr-types-registry-catalogs-meaning-graph-storage-contracts-storage` | The product's node types are registered in the types-registry; the records live in graph-storage. |

### 1.3 Architecture Layers

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| REST | The project's gear repository and product, scaffolding, Gearbox, the corpus relay | `OperationBuilder` routes in `rest.rs` |
| Service | A project's records, writes into its repository | `service.rs` (`ProductService`) |
| Writing | Repository creation and gear scaffolding | `scaffold.rs`, `skeleton.rs` |
| Engine | Gearbox CLI over a corpus checkout | `gearbox.rs` |
| Port | The engine and a project's gear repository, for other gears | `port.rs`, `sdk.rs` |
| Storage | `project_gear_repo` and `project_product` nodes | the catalogue graph (`crate::catalog_graph`): graph-storage through `GraphSink`, `MemorySink` without the `graph` feature |

## 2. Principles & Constraints

### 2.1 Design Principles

#### The portal and the IDE resolve with one engine

- [x] `p2` - **ID**: `cpt-studio-principle-product-one-engine`

The backend image, the session image and the desktop's engine extension build
the Gearbox engine at the same commit (`STUDIO_GEARBOX_REF`), and the preview
reads the CLI's JSON (`catalogue`, `validate`, `resolve` with `--format json`),
its stable contract for tooling. The gear holds no composition rule of its own
beyond one: a plugin is written under the host whose extension point it fills,
because that is how `product.gdl` spells it.

#### A moved route keeps its old path while clients still call it

- [x] `p2` - **ID**: `cpt-studio-principle-product-legacy-paths`

The routes moved from `/studio-components-catalog/v1` to `/studio-product/v1`
with the gear. Three are still served at the old path, by the same handlers,
marked deprecated: `GET …/gearbox/catalogue`, which IDEs released before the
move ask for, and the two corpus relay routes, because a desktop clone fetches
from the URL it was cloned from. The IDE asks the new path first and falls back
to the old one on 404. They go once no supported desktop release reads them.

### 2.2 Constraints

#### Gearbox is off unless configured

- [x] `p2` - **ID**: `cpt-studio-constraint-product-gearbox-optional`

Previews, the engine catalogue, extension points, completion, repository facts
and the corpus relay need `STUDIO_GEARBOX_WORKDIR` (the chart's
`backend.gearbox`). The default corpus ref is `feature/gearbox`, because
`gear.gdl` descriptors exist only on that branch until
constructorfabric/gears-rust#4793 merges. Once a catalogue sync finds
`gear.gdl` descriptors in the catalogue's own gears repository, the engine
adopts that repository as its corpus, so the catalogue, the previews and the
IDE read one checkout.

## 3. Technical Architecture

### 3.1 Domain Model

- [x] `p2` - **ID**: `cpt-studio-entity-product-node`

Both records are owned nodes in the catalogue graph, keyed on the project id
with a deterministic instance id, so a write replaces rather than duplicates.
Their type ids keep the `catalog` segment they had before the split, because
the nodes already stored carry them; the types-registry registration moved
here (`catalog_graph::gts::product_type_schemas`). With graph-storage the
store registers the whole catalogue vocabulary, its own two types included,
before each write (`GraphSink::register_types`).

| Type | What it is |
|------|-----------|
| `gts.cf.studio.catalog.project_gear_repo.v1~` | The repository a project's gears live in: tenant, connection, `owner/repo`, branch |
| `gts.cf.studio.catalog.project_product.v1~` | The gears picked for a project's product, its deployment profile, the engine's last answer and where `product.gdl` was written |

### 3.2 Component Model

#### Scaffolding

- [x] `p2` - **ID**: `cpt-studio-component-product-scaffold`

##### Why this component exists

The skeleton lived in the prototype's `scaffold.ts`, so only a browser knew
what a gear looks like. An agent asked to create a gear without an IDE needs the
same bytes.

##### Responsibility scope

`skeleton.rs` generates the canonical starter gear (the request's `files` are
optional; a plugin names its `plugin_host` from `/gearbox/extension-points`);
`scaffold.rs` commits the files onto a branch off the connected base branch,
named after the slug, in one commit through the project's
`connectors::sdk::Repository` (`commit_files`), and optionally opens or reuses
a pull request (`open_pull_request`); how the provider makes that commit
(GitHub: the git-data API, one tree, one commit) is the driver's
(`connectors/github_write.rs`). `create-repo` creates the repository
through the connector and records it as the project's gear repository in one
step. A project with no gear repository is written into the repository its
project config names (`sources[]`).

##### Responsibility boundaries

The one place in this gear that writes to a repository besides the preview's
optional commit. The token is borrowed from studio-connector per call and never
stored here.

##### Related components (by ID)

- `cpt-studio-component-connector` — creates repositories and writes through

#### Gearbox engine

- [x] `p2` - **ID**: `cpt-studio-component-product-gearbox`

##### Why this component exists

A product is resolved by the engine, not by the portal: which gears a selection
pulls in, which applications they land in, and what cannot work, as `GBX…`
diagnostics.

##### Responsibility scope

`gearbox.rs`: a shallow checkout of the gear corpus under the workdir,
refreshed every `STUDIO_GEARBOX_REFRESH_SECS`; the engine catalogue; the
extension points a plugin can fill; completion (`/gearbox/complete` drops what
the catalogue proves cannot run and adds a plugin for a bare host and a REST
host for REST gears, saying why, writing nothing); the preview, which writes a
`product.gdl` declaring every deployment profile, validates and resolves it for
the one asked, and with `write` commits it to the project's gear repository on
a new branch; and the corpus over Git smart HTTP, fetch only, authenticated as
a member (`authenticate_member`, Basic or Bearer) and relayed with the corpus's
own token. The engine is published on the ClientHub at `init`, so the
catalogue finds it by the REST phase.

##### Responsibility boundaries

Does not run the IDE's Gearbox views; `cpt-studio-component-theia-gearbox-studio`
does, on the same engine commit. A push to the corpus relay is refused whatever
the token upstream would allow.

##### Related components (by ID)

- `cpt-studio-component-theia-gearbox-studio` — shares the engine commit with
- `cpt-studio-component-git-proxy` — reuses the authentication and relay of
- `cpt-studio-component-components-catalog` — is read by, for gear facts, the corpus checkout and the engine catalogue

#### Product port

- [x] `p2` - **ID**: `cpt-studio-component-product-port`

##### Why this component exists

The catalogue reads the engine and a project's gear repository; before the
split it reached into the modules that hold them.

##### Responsibility scope

`port.rs`: `engine(hub)`, the Gearbox engine when this deployment configures
one; `ProjectProducts` (`gear_repo(ctx, project_id)`), a project's gear
repository as recorded, and `Products`, the handle that resolves it from the
ClientHub when used. `sdk.rs` names the engine's types (`Gearbox`,
`GearConfig`, `CorpusSource`) for a gear that holds the engine.

##### Responsibility boundaries

Both are resolved per use, so start order does not matter, and both answer
`None` in an assembly without them. Completion for spec-mapping is still
served through the catalogue's `port::ComponentCatalog::engine_completion`,
which calls this engine; moving it here is a follow-up.

##### Related components (by ID)

- `cpt-studio-component-components-catalog` — is called by
- `cpt-studio-component-spec-mapping` — is reached through the catalogue by, for completion

### 3.3 API Contracts

- [x] `p2` - **ID**: `cpt-studio-interface-product-rest`

- **Contracts**: `cpt-studio-interface-rest-api`
- **Technology**: REST/OpenAPI through `api_gateway`, operation ids `studio_product.*`, tag `StudioProduct`
- **Location**: [`studio-backend/docs/api-contract.json`](../../studio-backend/docs/api-contract.json)

**Endpoints Overview** (all under `/studio-product/v1`):

| Method | Path | Description | Stability |
|--------|------|-------------|-----------|
| `GET` | `/projects/{project_id}/gear-repo` | The project's gear repository, 0 or 1 node | unstable |
| `POST` | `/projects/{project_id}/gear-repo` | Connect or replace it; the branch defaults to `main` | unstable |
| `POST` | `/projects/{project_id}/create-repo` | Create a repository through the connector and record it | unstable |
| `POST` | `/projects/{project_id}/scaffold` | Write a gear skeleton on a branch, optionally as a pull request | unstable |
| `GET` | `/projects/{project_id}/product` | The product being composed | unstable |
| `PUT` | `/projects/{project_id}/product` | Merge fields into it | unstable |
| `POST` | `/projects/{project_id}/product/preview` | Compose `product.gdl`, resolve it, optionally commit it | unstable |
| `GET` | `/gearbox` | Engine version and the corpus previews resolve against | unstable |
| `GET` | `/gearbox/catalogue` | The engine catalogue over the backend's corpus, for an IDE whose workspace has none | unstable |
| `GET` | `/gearbox/extension-points` | The hosts a new plugin gear can fill | unstable |
| `POST` | `/gearbox/complete` | Complete picked gears into a resolvable set; writes nothing | unstable |
| `GET` | `/gearbox/corpus/info/refs` | Git smart-HTTP ref advertisement for the corpus | unstable |
| `POST` | `/gearbox/corpus/git-upload-pack` | Git smart-HTTP upload-pack, fetch only | unstable |

The two corpus routes are `.anonymous().exposed()`, because `git` sends Basic
credentials that the gateway's Bearer-only layer would refuse before they
arrive; `authenticate_member` is the check.

**Deprecated, registered by this gear under the old prefix**
(`cpt-studio-principle-product-legacy-paths`), tag `StudioComponentsCatalog`:

| Method | Path | Same as |
|--------|------|---------|
| `GET` | `/studio-components-catalog/v1/gearbox/catalogue` | `/studio-product/v1/gearbox/catalogue` |
| `GET` | `/studio-components-catalog/v1/gearbox/corpus/info/refs` | `/studio-product/v1/gearbox/corpus/info/refs` |
| `POST` | `/studio-components-catalog/v1/gearbox/corpus/git-upload-pack` | `/studio-product/v1/gearbox/corpus/git-upload-pack` |

The plan a product is composed from is `cpt-studio-component-spec-mapping`'s
([studio-spec-mapping](studio-spec-mapping.md)); the gears picked are the
catalogue's ([studio-components-catalog](studio-components-catalog.md)).

### 3.4 Internal Dependencies

| Dependency Gear | Interface Used | Purpose |
|-------------------|----------------|----------|
| `types_registry` | `types-registry-sdk` | Register `project_gear_repo` and `project_product` at init |
| `account_management` | `account-management-sdk` | A project's configured sources, for a write without a gear repository; whether a caller reaches the organization a request names |
| `cpt-studio-component-connector` | `connectors::sdk::Connectors`; `Repository`, `create_repository`; `git_checkout` | Create repositories, write scaffolds and `product.gdl` (`Repository::commit_files`, `open_pull_request`); the corpus checkout (`git_checkout::clone_or_update`) |
| `cpt-studio-component-graph-storage` | `GraphStorageClientV1` (`graph` feature), through `catalog_graph::build_sink` | The two records |
| `cpt-studio-component-git-proxy` | `git_proxy::sdk` (`authenticate_member`, `send_upstream`, `stream_back`) | The corpus relay |
| `authn_resolver` | `AuthNResolverClient` | Authenticate a member on the corpus relay |
| `cpt-studio-component-session` | `studio_session::sdk::TenantMembership` | Whether the caller reaches the workspace |

`port::engine` and `port::ProjectProducts` are published for
`cpt-studio-component-components-catalog`.

### 3.5 External Dependencies

#### Gearbox engine

Contract `cpt-studio-contract-gearbox-engine`, defined in
[Constructor Studio's design](constructor-studio.md#gearbox-engine).

| Dependency Gear | Interface Used | Purpose |
|-------------------|---------------|---------|
| `cpt-studio-component-product-gearbox` | The `gearbox` CLI (`STUDIO_GEARBOX_BIN`) with `--format json`; Git for the corpus | Catalogue, validation, resolution |

#### GitHub

Contract `cpt-studio-contract-provider-apis`, defined in
[Constructor Studio's design](constructor-studio.md#source-hosts-model-providers-and-chat-platforms).

| Dependency Gear | Interface Used | Purpose |
|-------------------|---------------|---------|
| `cpt-studio-component-product-scaffold` | REST through a studio-connector connection | Branches, commits, pull requests, repository creation |

### 3.6 Interactions & Sequences

Composing a product is `cpt-studio-seq-compose-product` in
[Constructor Studio's design](constructor-studio.md#compose-a-product), for
`cpt-studio-usecase-compose-product`.

### 3.7 Database schemas & tables

This gear has no database: its records are nodes in the catalogue graph
(§3.1), held in memory without the `graph` feature. With Gearbox configured,
the workdir holds the corpus checkout and the engine's last catalogue, so a
restart does not wait for a fetch.

### 3.8 Deployment Topology

In-process in the one `studio-backend` binary: gear `studio-product`,
capabilities `[rest]`, deps `types_registry`, `account_management`. The gear
reads no configuration section; it is configured by environment.

| Variable | Default | Meaning |
|---|---|---|
| `STUDIO_GEARBOX_WORKDIR` | unset: Gearbox is off | Where the corpus is checked out |
| `STUDIO_GEARBOX_BIN` | `gearbox` | The engine CLI |
| `STUDIO_GEARBOX_CORPUS_URL` | `https://github.com/MikeFalcon77/gears-rust.git` | The corpus |
| `STUDIO_GEARBOX_CORPUS_REF` | `feature/gearbox` | Its ref |
| `STUDIO_GEARBOX_REFRESH_SECS` | `600` | How often the checkout is refreshed |

On start, with Gearbox configured, the corpus is checked out and the engine run
once, so the first preview or components reference does not pay for a clone.

## 4. Additional context

What is not done yet:
- `ComponentCatalog::engine_completion`, which spec-mapping's conformance
  calls, lives on the catalogue's port and should move here.
- The deprecated paths under `/studio-components-catalog/v1` go once no
  supported desktop release reads them.

## 5. Traceability

- **PRD**: [Constructor Studio](../prd/constructor-studio.md) — `cpt-studio-fr-gear-scaffold`, `cpt-studio-fr-gearbox-product`
- **Design**: [Constructor Studio](constructor-studio.md)
- **ADRs**: [ADR index](../adr/README.md)
- **Code**: [`studio-backend/src/product/`](../../studio-backend/src/product/)
