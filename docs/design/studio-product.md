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

What the product makes is read back from where it runs. Each gear on the
project's Product map and each product row of its Components tab says where
it runs — "running in stage since 2026-10-19 (0.1.0)", or "not deployed" —
from the latest successful deploy in each environment (`studio-environments`,
ADR-0043 §4): a later deploy that failed, waits or was declined does not
replace what runs there. The portal joins it from what it already reads, the
project's deployments, its targets and this gear's product record; no route
was added (`gear-deploys-model.ts`). The version is the one `product.gdl`
names (`analytics@0.1.0`, ADR-0044 §2), else the deploy's commit. A deploy
record names the product and the commit, not the gears, so a deploy older
than the product's last change, at a commit other than the one `product.gdl`
was last written at, is said to be "from an earlier product": the gear may
not have been in it. Two readings contradict a gear's maturity and are shown
as a hint: a `stable` gear that runs nowhere, and an `experimental` (or
`design`) one running in a production-like environment — protected, or named
`prod`, `production` or `live` — since experimental must not ship as stable.

### 1.2 Architecture Drivers

#### Functional Drivers

| Requirement | Design Response |
|-------------|------------------|
| `cpt-studio-fr-gear-scaffold` | A `project_gear_repo` node per project; repository creation and a generated skeleton written on a branch through the project's connection, optionally as a pull request. |
| `cpt-studio-fr-gearbox-product` | A `project_product` node per project; a preview writes `product.gdl` and runs the Gearbox CLI over the backend's corpus checkout. A save keeps the file as a description revision in the gear's database (ADR-0053), which builds and the desktop take; publishing writes it to the repository: a new product at `products/<id>/product.gdl`, the layout the IDE's Gearbox finds, and a written one where it already is. |

#### NFR Allocation

| NFR ID | NFR Summary | Allocated To | Design Response | Verification Approach |
|--------|-------------|--------------|-----------------|----------------------|
| `cpt-studio-nfr-credential-isolation` | No secret in a session, a browser or a response | `cpt-studio-component-product-gearbox` | Repository tokens are borrowed from studio-connector per call; the corpus token is held in memory, attached upstream by the Git relay and never returned | `product::gearbox` tests |

#### Key ADRs

| ADR ID | Decision Summary |
|--------|------------------|
| `cpt-studio-adr-a-desktop-session-keeps-the-secrets-on-the-server` | A laptop clones a private gear corpus through the backend, which attaches the token. |
| `cpt-studio-adr-types-registry-catalogs-meaning-graph-storage-contracts-storage` | The product's node types are registered in the types-registry; the records live in graph-storage. |
| `cpt-studio-adr-product-description-in-studio` | A product's description is kept by this gear by revision and built with the code of a chosen branch; publishing it to the repository is optional (ADR-0053). |

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

The backend image, the session image and the desktop's engine extension take
the Gearbox engine from the same constructorfabric/gearbox release
(`STUDIO_GEARBOX_RELEASE`, its commit `STUDIO_GEARBOX_REF`), and the preview
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
and the corpus relay need `STUDIO_GEARBOX_WORKDIR`. The corpus is the
platform's gears (ADR-0042), read from the platform's **gear repositories**
(ADR-0046): connections of the `gear-repository` kind held by the root tenant,
in the order they were added (`gear_roots.rs`). Each is checked out at
`gearbox-roots/<key>/<source id>` under the engine's working directory -- the
key a hash of its URL and ref, so the same repository connected by the
platform and by an organization is one clone, each directory behind its own
lock -- and passed as its own `--root`: the engine names a root by its
directory when there are several, and it follows links to the real one, so the
checkout itself carries the id.

**An organization's corpus** (phase 3) is the platform's roots, then the
organization's own gear repositories, in a corpus of its own (one per
organization, each behind its own lock). A request about an organization --
named by `?organization_id=`, else the caller's own, else a project's --
reads that organization's corpus: the catalogue, extension points,
completion, config schemas, previews, Create a gear and the status
(`gearbox::Scope`). An organization with none of its own reads the platform's
corpus. Its own repositories are listed when such a request comes, at most
once a minute; one whose source id a platform repository already has is left
out and named in the status (`shadowed`). The components reference, the
catalogue sync's facts and spec-mapping's completion read the platform's. They are always read together,
because a gear in one may use a gear in another; where two declare the same
gear, the first wins. The list is read on the way into a route of this gear or
the catalogue's, at most once a minute (`GET /studio-product/v1/gearbox?refresh=true`
reads it now); a changed list is checked out on the next use. No
organization's settings or sync can change it.

While the platform has no gear repository, the deployment's corpus is the one
root, under the source id `gears-rust`: `STUDIO_GEARBOX_CORPUS_URL` (the
chart's `backend.gearbox.corpusUrl`). The deployments name
`MikeFalcon77/gears-rust` at `feature/gearbox` for now, because `gear.gdl`
descriptors exist only on that branch until constructorfabric/gears-rust#4793
merges; connecting the platform's gear repositories moves them off it without
a deployment.

A generated `product.gdl` declares one `source` per gear repository, each at
the commit it was checked against, and each `use_gear` names the repository the
engine found the gear in (`render_product_gdl_from`). The status
(`GET /studio-product/v1/gearbox`) lists every root with its commit, gear
count and tier (`sources`). The catalogue (`GET /gearbox/catalogue`) lists
every root (`roots`: source id, URL, ref, commit, whether it takes a token,
and the path to clone a private one through this backend), and the relay
serves each: the platform's at `/gearbox/corpus/{source_id}`, an
organization's own at `/organizations/{organization_id}/gearbox/corpus/{source_id}`
to its members only (404 for anyone else). The old single-root fields and
route stay, naming the first root, for IDEs that read one. The IDE
(`gearbox-studio`) brings the roots in all or none -- half a corpus would list
gears whose hosts are missing -- each under its source id in the per-machine
cache, and opens every engine on all of them.

#### A project writes only through its organization's own connections

- [x] `p1` - **ID**: `cpt-studio-constraint-product-own-connections`

The rule is the connectors' (`cpt-studio-constraint-connector-own-connections`):
a project sees the platform root's connections because they are inherited,
and must not write with them. `ProductService::ensure_owned` asks it before
every write, for the project (or, through the ports, the caller's tenant):

- the scaffold (`POST …/scaffold`, and `GearScaffolds` for the catalogue),
  into whichever target it picked -- the project's gear repository, the
  organization's, or the project's first source;
- `product.gdl` (`POST …/product/preview` with `write`);
- Declare it (`GearDeclarations`) and publish (`GearContributions`): the
  latter is the root writing the platform's repository with the root's own
  connection, which the rule lets through;
- repository creation (`POST …/create-repo`), before anything is created;
- recording a gear repository (`POST …/gear-repo`), before it is stored.

A refusal is a 400 `failed_precondition` `CONNECTION_NOT_OWNED` naming the
tenant that holds the connection and what to do: connect the repository with
an organization-scope connection of the organization's own.

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
optional; a plugin names its `plugin_host` from `/gearbox/extension-points`;
the request's `capabilities` are written into `gear.toml`, so a gear made for a
capability nothing closes declares it once the catalogue syncs it);
`scaffold.rs` commits the files onto a branch off the connected base branch,
named after the slug, in one commit through the project's
`connectors::sdk::Repository` (`commit_files`), and optionally opens or reuses
a pull request (`open_pull_request`); how the provider makes that commit
(GitHub: the git-data API, one tree, one commit) is the driver's
(`connectors/github_write.rs`). `create-repo` creates the repository
through the connector and records it as the project's gear repository in one
step.

**Where a new gear goes** (ADR-0042 §2, ADR-0060 §1), in this order
(`service::pick_scaffold_target`):

1. The project's source marked `gears_here`, when it has one: it wins for
   its project. A project's old gear repository (`project_gear_repo`) is
   folded into its sources as that source the first time it is read
   (`fold_legacy_gear_repo`); where the config cannot be written, the old
   record is still read, for one release.
2. Else the organization's gear repository, which the catalogue keeps
   (`components_catalog::port::Registry::gear_repository`); the organization
   is found by walking up from the project
   (`organizations::sdk::organization_of`), and the write goes as the caller
   acting in the organization, where its organization-scoped connection is
   readable. The catalogue answers only a setting whose connection is the
   organization's own, never one inherited from the platform's root, so a
   project's gear is never written with the platform's token.
3. Else the project's home source (`project_sources::description_home`).

The scaffold's answer names the repository (`repo`) and which of the three
it was (`target`: `project`, `organization`, `sources`); a dry run says where
it would go, so a screen can state it before anything is written.

**Where a product's description goes** (ADR-0060 §1). Studio keeps it by
revision (ADR-0053). It is published only to the source marked
`publish_here`; with none marked, a publish is refused and the revisions are
all there is. Where new gears go decides nothing about the product.

**What a revision pins** (ADR-0060 §3). A save records, beside the revision,
the commit of every source the text uses (`sources_lock`): each project
source at the head of its branch, read through its connection; any other
`git(...)` source at its `rev` when that is a commit. A dev environment
builds each source's branch and records the commits it got
(`source_commits`); a protected one builds only the lock, and refuses a
revision without one (`REVISION_NOT_PINNED`). A description that names one
repository twice is refused at save (§2); a save composes from the whole
product record and never drops a picked gear or the frontend silently (§4).

**How the server checks a description** (ADR-0060 §6). The engine runs on
the description laid in an overlay of the project's home checkout, at its
branch, with the home repository's own catalogue over the organization's
corpus: a `path("../..")` source resolves as it does in a build. An
environment of dev strictness has the checked profile marked
`development = True` (§5).

The skeleton is generated in one place (`new_gear.rs`) for both callers: the
project's route, and `port::GearScaffolds::scaffold_into`, through which the
catalogue's `POST /registry/scaffold` writes a new gear straight into the
organization's gear repository. The manifest's description reads well with
or without an App Spec: the `problem` followed by the origin note when a problem is given; else "`<capability>`
capability for `<app title>`. `<origin>`"; else, with no app title,
"`` `<capability>` `` capability. `<origin>`". The catalogue's scaffold passes the
organization's name as the app title when the request names none.

**Declare it's manifest** (`port::GearDeclarations`,
`skeleton::declaration`). One file beside the module the registry found:
the engine's `gear.gdl`, with the declaration's description and category set
as the gear's own arguments (`gdl_with`; capability keys as a closing
comment, GDL having no list for them), when the Gearbox engine is configured
-- gears-rust#4793 retires `gear.toml` in favour of it; else a `gear.toml`.
A directory inside a crate's `src/` always gets the `gear.toml`: the
catalogue skips a `gear.gdl` under `src/` (the shape of a plugin compiled
into its host's crate), so one written there would never make the candidate
declared. `port::declaration_manifest` says which a set of files is; the
catalogue's Declare it answers it as `manifest`.

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
host for REST gears, saying why, writing nothing; a host with several
extension points gets one plugin per point, matched by the point's GTS spec,
since two points can share an SDK crate); gears named by their crate, or by
their engine id when other gears share that crate (mini-chat's static plugins
live in `cf-gears-mini-chat`), so a plugin never folds into its host; each named gear's config
schema (`/gearbox/config-schema`: the fields its `gear.gdl` declares, with
`required`, `default`, and `derived` for the addresses generation writes from
`serves[].config_key`, so the portal's product form asks for what the engine
would refuse without); the preview, which writes a
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
ClientHub when used. `GearDeclarations` writes Declare it's manifest
(ADR-0041 P3), and `GearScaffolds` (`scaffold_into(ctx, target, gear)`) a new
gear's skeleton into a repository this gear keeps no record of: the
organization's gear repository (ADR-0042 §2). `sdk.rs` names the engine's types (`Gearbox`,
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
| `GET` | `/projects/{project_id}/gear-repo` | The project's source marked `gears_here` (ADR-0060), 0 or 1 node | unstable |
| `POST` | `/projects/{project_id}/gear-repo` | Mark the source new gears go to, adding it to the sources when it is not one | unstable |
| `POST` | `/projects/{project_id}/create-repo` | Create a repository through the connector and record it | unstable |
| `POST` | `/projects/{project_id}/scaffold` | Write a gear skeleton on a branch, optionally as a pull request: into the project's gear repository, else the organization's, else the project's sources; answers `repo` and `target` (`project`, `organization`, `sources`), on a dry run too | unstable |
| `GET` | `/projects/{project_id}/product` | The product being composed | unstable |
| `PUT` | `/projects/{project_id}/product` | Merge fields into it | unstable |
| `POST` | `/projects/{project_id}/product/preview` | Compose `product.gdl` and resolve it; `write` saves it as the next description revision (409 with both texts against a stale `base_revision`, unless the text is the latest's: then that revision, `created: false`) and answers within 20 s, `checking: true` while its check still runs (kept under `checks.<profile>`), `publish` also writes it to the repository (ADR-0053) | unstable |
| `GET` | `/product-description?project_id=` | The latest description revision Studio keeps (the first read of a project with none takes the text from where its record says it was last saved, as revision 1), its path, where it was published, and a change made to the published file in the repository since | unstable |
| `POST` | `/product-description-revisions?project_id=` | A new revision against `base_revision`; 409 `DESCRIPTION_REVISION_STALE` with both texts when that is not the latest | unstable |
| `GET` | `/product-description-revisions?project_id=` | The revisions, newest first, without their text | unstable |
| `GET` | `/product-description-revisions/{revision}?project_id=` | One revision | unstable |
| `POST` | `/product-description-publications?project_id=` | Publish the latest revision: onto `product/<id>`, recreated from the base branch, with one pull request, or onto the base branch | unstable |
| `GET` | `/product-description-branches?project_id=` | The `product/*` branches from before, with their pull requests and whether Studio holds their description; deletes nothing | unstable |
| `GET` | `/gearbox` | Engine version and the corpus previews resolve against | unstable |
| `GET` | `/gearbox/catalogue` | The engine catalogue over the backend's corpus, for an IDE whose workspace has none | unstable |
| `GET` | `/gearbox/extension-points` | The hosts a new plugin gear can fill | unstable |
| `POST` | `/gearbox/complete` | Complete picked gears into a resolvable set; writes nothing | unstable |
| `POST` | `/gearbox/config-schema` | Each named gear's config fields: required, default, derived; writes nothing | unstable |
| `POST` | `/gearbox/brings` | What adding one gear would bring into the product with it: the gears that come along and why, whether each keeps its own database, and every contract the product would then get from two gears (interview problem 4.7, issue #732); writes nothing | unstable |
| `GET` | `/gear-explanations` | The organization's plain explanations of gears (`generated` or `edited`), by engine id; a metadata row on the organization only this gear writes | unstable |
| `PUT` | `/gear-explanations/{gear_id}` | Save a person's explanation (`edited`) | unstable |
| `POST` | `/gear-explanations/{gear_id}/generations` | A model's explanation on the caller's key, from the catalogue entry and README; never over an `edited` one unless `force` | unstable |
| `GET` | `/gearbox/corpus/info/refs` | Git smart-HTTP ref advertisement for the corpus | unstable |
| `POST` | `/gearbox/corpus/git-upload-pack` | Git smart-HTTP upload-pack, fetch only | unstable |
| `GET` | `/gearbox/corpus/{source_id}/info/refs` | The same, for one of the platform's gear repositories (ADR-0046 phase 2) | unstable |
| `POST` | `/gearbox/corpus/{source_id}/git-upload-pack` | The same, for one of the platform's gear repositories | unstable |
| `GET` | `/organizations/{organization_id}/gearbox/corpus/{source_id}/info/refs` | The same, for one of an organization's own gear repositories, to its members only | unstable |
| `POST` | `/organizations/{organization_id}/gearbox/corpus/{source_id}/git-upload-pack` | The same, for one of an organization's own gear repositories | unstable |

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
| `cpt-studio-component-components-catalog` | `components_catalog::port::Registry::gear_repository` | The organization's gear repository, where a project without one of its own writes a new gear (ADR-0042 §2) |
| `cpt-studio-component-organizations` | `organizations::sdk::organization_of` | The organization a project hangs under |

`port::engine`, `port::ProjectProducts`, `port::GearDeclarations` and
`port::GearScaffolds` are published for
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

The two records are nodes in the catalogue graph (§3.1), held in memory
without the `graph` feature. With Gearbox configured, the workdir holds the
corpus checkout and the engine's last catalogue, so a restart does not wait
for a fetch.

A product's description is kept by revision in the gear's own PostgreSQL
database (`studio_product`, ADR-0053 §1), one table:

| Table | Key | Columns |
|---|---|---|
| `studio_product_descriptions` | `(tenant_id, project_id, revision)` | `text` (the whole `product.gdl`), `author` (a subject id, or `studio`), `created_at_ms`, `sha256`, `source` (`studio`, `repository`, `migrated`) |

The tenant is the organization the project hangs under, resolved from the
project as the caller reads the tenant tree -- never the tenant a request acts
in, so the portal (`?organization_id=`) and the desktop (the member's home
tenant) reach one description; a caller who cannot read the project gets 404.
The primary key is the save's lock: a
save names the revision it started from, and two saves from one revision both
try the next number -- the second is answered 409 with both texts. A save whose
text is the latest revision's already is that revision (`created: false`)
whatever it started from, so the same save sent twice -- a retry after the
gateway lost the first answer -- never conflicts with itself nor makes a second
revision (ADR-0053, amendment 2026-11-04). The product
record keeps `description` (the latest revision and its path) and `published`
(the revision last published, its branch, commit, pull request and digest).

A save does not wait for the engine. A preview with `write` composes the text
from the catalogue (`Gearbox::describe`), keeps the revision and records the
product first, then runs the check (`Gearbox::check`) on a task of its own: the
answer carries the check when it is done within 20 s of the request's start
(`SAVE_ANSWERS_WITHIN`, inside the api-gateway's fixed 30 s), else
`checking: true` with no verdict. The task keeps the verdict under the record's
`checks.<profile>` with the description's hash whenever it finishes, and the
portal reads the record again until it lands. A check alone (no `write`) runs
on the same task, so its verdict is kept even when the gateway gave up on the
request; the portal asks again on 504 and the engine's cache answers.

How the description travels (ADR-0053):

- **Builds** take it from here (§2): a Studio build's Job gets the latest
  revision's text in `STUDIO_PRODUCT_DESCRIPTION` and lays it at the product's
  path before `gearbox generate`; the build record carries
  `description_revision` beside `commit`. The desktop reports the revision its
  file is in step with. A project with no revision builds the checkout's file,
  and of a `product/*` ref only the file, with the base branch's code (§4).
- **The desktop** writes the latest revision into the checkout when it opens a
  product from Studio, and saves every change of the file as the next revision
  (a conflict shows both texts; the person keeps theirs or takes Studio's).
- **Publishing** (§3) writes the latest revision onto `product/<id>`,
  recreated from the base branch each time (`commit_replacing_branch`), and
  opens or keeps one pull request -- or onto the base branch. A change merged
  into the published file is offered back as a new revision on the next read.
- **Migration** (§5): the first read of a project with no revision takes the
  text at the commit (else the branch) its record says it was last saved at.
  The old `product/*` branches are listed, never deleted.
- **Not yet**: a Research deploy re-renders its chart from the checkout's file at
  the build's commit, not from the revision the build used; the proposed CI
  workflow does not fetch the revision yet (its manifest may name one).
- **Without the database** (`dev.yaml`), the description routes answer 503 and a
  preview's `write` commits onto a `product/<id>-<digest>` branch as before.

### 3.8 Deployment Topology

In-process in the one `studio-backend` binary: gear `studio-product`,
capabilities `[db, rest]`, deps `types_registry`, `account_management`. Its
`database:` section (`studio_product`, `pool.max_conns: 2`) is in every
profile but `dev.yaml`; otherwise the gear is configured by environment.

| Variable | Default | Meaning |
|---|---|---|
| `STUDIO_GEARBOX_WORKDIR` | unset: Gearbox is off | Where the corpus is checked out |
| `STUDIO_GEARBOX_BIN` | `gearbox` | The engine CLI |
| `STUDIO_GEARBOX_CORPUS_URL` | unset: no corpus until the platform has a gear repository | The corpus while the platform has no gear repository (ADR-0046) |
| `STUDIO_GEARBOX_CORPUS_REF` | `main` | Its ref |
| `STUDIO_GEARBOX_CORPUS_ID` | the corpus URL's repository name, kebab-case; `gears-rust` without a URL | The source id that source descriptions use to name the corpus |
| `STUDIO_GEARBOX_REFRESH_SECS` | `600` | How often the checkout is refreshed |
| `STUDIO_FRONTX_SHELL_TEMPLATE` | `github:constructorfabric/gears-frontx-templates//template-shell@main` | The shell a new frontend is assembled on (`product/frontx.rs`); served with the Gearbox status |
| `STUDIO_FRONTX_SOURCE` | `constructorfabric/gears-frontx-templates@main` | The FrontX repository the frontend constructor suggests for micro-frontends |

On start, with Gearbox configured, the corpus is checked out and the engine run
once, so the first preview or components reference does not pay for a clone.

## 4. Additional context

What is not done yet:
- `ComponentCatalog::engine_completion`, which spec-mapping's conformance
  calls, lives on the catalogue's port and should move here.
- The deprecated paths under `/studio-components-catalog/v1` go once no
  supported desktop release reads them.
- Where a gear runs is inferred, not recorded: a deploy should carry the gears
  and versions of the `product.gdl` it was generated from, which the IDE has
  at Deploy, so "from an earlier product" can say which. The deployments'
  history keeps the latest record of each environment, not the latest
  successful one, so past 200 records an environment whose last deploy failed
  can read as not deployed.

## 5. Traceability

- **PRD**: [Constructor Studio](../prd/constructor-studio.md) — `cpt-studio-fr-gear-scaffold`, `cpt-studio-fr-gearbox-product`
- **Design**: [Constructor Studio](constructor-studio.md)
- **ADRs**: [ADR index](../adr/README.md)
- **Code**: [`studio-backend/src/product/`](../../studio-backend/src/product/)
