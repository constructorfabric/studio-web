---
type: adr
status: proposed
date: 2026-11-03
---

# ADR-0056: Places, environments and releases are laid out the way an organization runs them

**ID**: `cpt-studio-adr-delivery-layout`

Status: **proposed** · Date: 2026-11-03 · Lays out the screens of `cpt-studio-adr-deployment-environments` (ADR-0043), ADR-0048, `cpt-studio-adr-research-environments` (ADR-0049), `cpt-studio-adr-project-environments` (ADR-0054) and ADR-0055 · Changes no data model

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. The model, in the words a person uses](#1-the-model-in-the-words-a-person-uses)
  - [2. Organization › Infrastructure](#2-organization--infrastructure)
  - [3. Project › Product](#3-project--product)
  - [4. Project › Releases](#4-project--releases)
  - [5. One form per place](#5-one-form-per-place)
  - [6. The product map's next layers](#6-the-product-maps-next-layers)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

Four ADRs added places and environments one at a time:
- ADR-0043: an organization's clusters and environments;
- ADR-0048: registries and charts;
- ADR-0049: Constructor Research;
- ADR-0054: a project's own environments.

The screens grew with each ADR, and people now cannot tell from them what owns what:

- **An environment is added from three places:**
  - Organization › Environments, under a cluster's card;
  - a project's Deploys tab, as "an environment of the project's own";
  - the Research connection.
- **The same form serves all three and does not know where it was opened.** Opened from a cluster's card, it still offered Constructor Research and asked for a sign-in to it.
- **A project shows its environments twice.** Product › Infrastructure shows where the product runs, and Deploys shows its bindings and deploys.
- **Releases have no ladder.** `promote_from` exists, but no screen shows a build going through dev, stage and prod with the version each one runs.
- **Configuring and running are split.** The Product page configured the product, and Builds and Deploys were separate tabs with nothing leading from one to the next.

How do the screens follow the way an organization actually runs its products?

## Considered Options

1. **Keep the screens and fix the form.** This is the smallest change, and it leaves the other four problems.
2. **Lay the screens out by owner and by stage.** The organization's places and environments go on one screen, and a project's way from configured to running on its own two tabs.
3. **One delivery screen for everything.** It mixes what an administrator manages with what a project's members do, and it needs every reader to see every project.

## Decision Outcome

Chosen option: **2.** No data changes. The ADRs listed above keep their models: environments, bindings, owners, open clusters, connections, deployments and previews.

### 1. The model, in the words a person uses

- **The organization holds places.** A place is a Kubernetes cluster (a `kubernetes` connection) or a Constructor Research project (ADR-0049). Registries are held the same way.
- **The organization defines environments on its places.**
  - Environments are the stages of its releases: `dev`, `stage`, `prod`.
  - Each one runs on one place.
  - Each one says how a product gets its database, whether a deploy waits for approval, and which environment a release must have passed first (`promote_from`).
  - Several environments may share a cluster. `prod` usually has its own.
- **A project's product goes through those environments.**
  - The product is configured and saved as a description.
  - A build turns one revision of it into images and a chart.
  - That build is deployed to an environment, into the project's namespace there, and promoted to the next one.
- **A project may keep environments of its own** on places the organization opens to it (ADR-0054). This is the exception, and the screens show it as one.
- **Research is a place of the organization, not a person's.** Its sign-in is the member's own, as rewritten ADR-0049 §5 says: every build and deploy there runs with the requesting member's connection. The environment, and the Research project it names, belong to the organization.

### 2. Organization › Infrastructure

This replaces Organization › Environments. It has three parts.

- **Places.**
  - The clusters, Research projects and registries the organization holds.
  - Each one with its connection test and whether it is open to projects (ADR-0054 §2).
  - A place lists the environments on it.
- **Environments.**
  - The ladder: environments in `promote_from` order, each with its place, database and approval.
  - Adding an environment starts from a place (§5).
- **What runs where.**
  - Projects by environments, with the version each one runs and its state.
  - The deploys waiting for an administrator's approval.

### 3. Project › Product

Configure, then Save to `product.gdl`, then Build, then Deploy, as one strip above the sections (`product-flow.ts`).

The **product map** is Configure's overview and its constructor (`product-map.ts`, `product-map-view.tsx`): the product's frontend, backend and infrastructure as layers of one picture, with the links the facts give between them and the problems they show. Screens and gears are added and removed on it, through the same product record the sections write. The sections are its detailed views: each layer opens as the section of its name. The map and `product.gdl` are two views of one product: the text view shows the description the next save would write, and selecting a node selects its lines.

- **Infrastructure** shows what the product needs: its profile, Postgres, the services its gears ask for. It also shows which environments it may go to, as links.
- **Infrastructure does not edit environments or bindings.** That is Releases' job (§4).

### 4. Project › Releases

This replaces the Builds and Deploys tabs.

- **On top, the ladder.** Example: `build 0.3.1 → dev ✓ 0.3.1 → stage ✓ 0.3.0 → prod ⏳ waiting for approval`. Each environment shows the version it runs.
- **Actions on each step:**
  - *Deploy* a published build to an environment;
  - *Promote* the one its `promote_from` runs.
- **Below the ladder,** the builds (in Studio, the desktop and CI, as ADR-0045 and ADR-0048 keep them), then the deploy history.
- **One section folded at the bottom,** *Environments of this project*, holds two things:
  - the bindings of the product's profiles;
  - the project's own environments (ADR-0054). This is the only place a project adds one.
- **Previews** (ADR-0055) sit beside the build they preview.

### 5. One form per place

- An environment is added from the place it runs on.
- The form names that place and does not offer another one.
- A Research place asks for the Research project and hardware. A cluster asks for the registry, namespaces and database.
- A project's own environment is added from Releases. Its place is chosen from the ones ADR-0054 allows.

### 6. The product map's next layers

The product map (§3) shows the product as it is described: its screens, its
gears, and what they need beside them. To give the whole picture it gains
four layers. Each one is read from data Studio already keeps, so none of
them asks the person to describe anything twice.

1. **Specs, above the screens.** The capabilities the project's documents
   declare are what Backend's Specs coverage shows today. Each capability
   links to the gears that close it:
   - a solid link when a gear closes it by contract;
   - a dashed link when a gear only mentions its words;
   - a red link to a "needs a gear" placeholder, with candidates from the
     catalogue, when nothing closes it.

   A deployment capability links to a profile and its environments instead.
   Selecting a gear shows the requirements it closes. A gear that closes
   none and that no screen calls is a candidate for removal. Specs do not
   go into `product.gdl`: they are why the product is what it is, not part
   of its description.
2. **Configuration and secrets on the nodes.** A gear in the product can
   still be unable to run, because it is not configured. Today that is the
   line "N things to finish". On the map, a node carries its own items: what
   is not set, and for each environment what is not set there. The values
   and secrets are the ones Releases keeps per environment.
3. **External services**, a group inside the infrastructure layer. These
   are the model providers reached through the gateway, the identity
   provider, the code host and Constructor Research. Each gear that uses one
   links to it. The service shows whether the project has a working
   connection to it: a shared one, only a member's personal one, or none.
4. **What runs, as an overlay.** Pick an environment, and each node shows
   the version running there and whether it is healthy. The data is the
   Releases ladder and its deploys. The map without the overlay is the
   product as described; with it, the product as deployed. The difference
   between the two is what a release still has to close.

Configuration, external services and the overlay come first, because they
are what most often makes a product that resolves fail to run. Specs follow.
The domain model (which entities each gear keeps), test coverage of
capabilities, and where each part's code comes from with newer versions are
later layers, not part of this step.

## Consequences

- **Each thing has one owner and one screen:**
  - an administrator manages places and environments under Infrastructure;
  - a project's members configure, build and release under Product and Releases.
- **The ladder makes `promote_from` and approvals visible** where a release happens.
- **Bookmarks to the old tabs need to keep working.** Organization › Environments, Builds and Deploys move, so their links must open the new places, as Product already does for the old Frontend tab.
- **This is done in steps:**
  1. The form follows its place (§5), and the Product strip (§3) is done.
  2. Releases (§4) is done. Previews still sit with an environment's step, not beside the build they preview.
  3. Infrastructure (§2) is done.
  4. The product map's next layers (§6), in this order: configuration and
     external services, then the runtime overlay, then Specs.

## More Information

- ADR-0043: an organization's products run in its environments.
- ADR-0045: a project keeps a record of its builds.
- ADR-0048: a product ships as images and a chart in the organization's registry.
- ADR-0049: Constructor Research runs a product as one of its applications. Its §5, as rewritten, makes the sign-in the member's own.
- ADR-0054: a project keeps environments of its own, on places the organization opens.
- ADR-0055: a build is previewed in a namespace of its own that expires.

## Traceability

- `studio-frontend-prototype/src/product-flow.ts`, `product-flow-view.tsx`: the Product strip (§3).
- `studio-frontend-prototype/src/environments-screen.tsx`: `EnvironmentForm` names the place it was added from (§5).
- `studio-frontend-prototype/src/releases.ts`, `releases-tab.tsx`: Project › Releases (§4). `releases.ts` orders the ladder by `promote_from` and says what each step runs, whether a deploy waits for approval, and what it can promote. `releases-tab.tsx` draws the ladder, the builds (`builds-tab.tsx`), the deploy history, and the folded *Environments of this project*.
- `studio-frontend-prototype/src/product-sections.ts`: `MOVED_PROJECT_TABS` opens the old `builds` and `deploys` addresses, pins and project types on Releases.
- `studio-frontend-prototype/src/environments-screen.tsx`: `OrgInfrastructure` is Organization › Infrastructure (§2): Places, the Environments ladder, and What runs where. The ladder and the projects-by-environments table come from `releases.ts` (`ladderOrder`, `whatRunsWhere`).
- `studio-frontend-prototype/src/place-url.ts`: the section's address is `/infrastructure`. The old `/environments` still opens it.
