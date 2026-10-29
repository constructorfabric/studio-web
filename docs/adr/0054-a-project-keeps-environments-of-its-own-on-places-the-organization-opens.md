---
type: adr
status: proposed
date: 2026-10-29
---

# ADR-0054: A project keeps environments of its own, on places the organization opens to it

**ID**: `cpt-studio-adr-project-environments`

Status: **proposed** · Date: 2026-10-29 · Amends `cpt-studio-adr-deployment-environments` (ADR-0043) · Uses ADR-0048 (a product ships as images and a chart in the organization's registry) and `cpt-studio-adr-research-environments` (ADR-0049)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. Two owners of an environment](#1-two-owners-of-an-environment)
  - [2. Places the organization opens](#2-places-the-organization-opens)
  - [3. What a project environment may name](#3-what-a-project-environment-may-name)
  - [4. Who manages it](#4-who-manages-it)
  - [5. Deploys and builds read its connections from the project](#5-deploys-and-builds-read-its-connections-from-the-project)
  - [6. Names and namespaces](#6-names-and-namespaces)
  - [7. A project builds on gears or from its own Dockerfiles](#7-a-project-builds-on-gears-or-from-its-own-dockerfiles)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

By ADR-0043 every environment belongs to the organization, and only an organization administrator adds, changes or removes one. That fits the environments the whole organization shares, such as a protected `prod` with approvals. It does not fit what a single project needs for itself.

The case that showed it: a team wanted to check a C# service through Studio. The service is built by the repository's own CI and pushed to the team's registry (`ghcr.io/<owner>`), not the organization's. The only environment on the cluster, `dev`, takes charts only from `ghcr.io/<organization>`. Deploying the service meant asking an organization administrator for a new organization environment. That environment then appeared in every other project's list, unless the administrator remembered to restrict it.

The same holds for a team that brings its own cluster connection, a project-held registry, or its own Constructor Research project (ADR-0049). The project knows what it needs, while the organization only has to decide where the project may go.

## Considered Options

1. **Keep ADR-0043 as it is.** An administrator adds every environment. This is simple, but it routes routine project work through an administrator and fills the organization's list with environments that only one project uses.
2. **Move environments into projects.** Every environment, `prod` included, would belong to a project. The organization would lose the shared environments, their approvals and the one place that says what runs where.
3. **Two owners.** The organization keeps its environments and decides which places projects may use. A project adds environments of its own on those places, or on connections it holds itself.

## Decision Outcome

Chosen option: **3, two owners.**

### 1. Two owners of an environment

An environment belongs either to the organization, as ADR-0043 describes, or to one project.

- **A project environment** is kept with the project, in its own metadata row, next to the project's profile bindings. Only that project sees it and deploys to it.
- **The project's targets** are the organization environments that admit the project, plus the project's own environments. Each target says who owns it.
- **History stays in one place.** Deployments are still recorded in the organization's history, so "what runs where" stays a single question for the organization.

### 2. Places the organization opens

The organization lists the **clusters it opens to projects**: the IDs of `kubernetes` connections it holds and shares. Only an organization administrator changes this list.

A project environment may run on:

| Place | Allowed when |
|---|---|
| A cluster the organization holds | The cluster is on the open list |
| A cluster the project holds | Always. The project connected it and shared it with the project |
| Constructor Research | Always. The member's own Research connection (ADR-0049 §1) |

Personal cluster connections are refused, as in ADR-0043. A deploy runs on the server, so it cannot read anybody's personal cluster token.

### 3. What a project environment may name

A project environment has the fields of ADR-0043 and ADR-0048, with three differences:

- **Projects.** It does not list projects: it is always its own project's.
- **Protection.** It is never `protected`. Approval is the organization administrator's decision, so an environment that needs approval belongs to the organization.
- **Registry connection.** It may name a `registry` connection the project or the organization holds and shares, on the host of its prefix. A personal registry connection is refused, for the same reason as a personal cluster connection.

It may take releases from another environment the project can see (`promote_from`). That can be one of the project's own environments or an organization environment that admits the project.

### 4. Who manages it

Whoever may write the project's settings may add, change or remove its environments. This is the right that profile bindings already require. An organization administrator does not need to be involved, and an administrator is not given control over another project's environments.

### 5. Deploys and builds read its connections from the project

For a project environment, a deploy or a Studio build looks up its cluster and registry connections starting from the project. It reads them as the service of the project. That way a project-held connection is found, and an organization-held one is still inherited. Each run's payload says which tenant that is, so a run queued before this change keeps reading from the organization.

### 6. Names and namespaces

The name of a project environment must not repeat any other environment the project sees. This means its own environments and the organization environments that admit it.

An organization administrator adding an environment cannot see every project's own environments. For that case a deploy to a project environment is refused when an organization environment that admits the project, on the same cluster, gives the same namespace. The refusal names that organization environment.

### 7. A project builds on gears or from its own Dockerfiles

The case above also showed a second gap. A project whose code is not described in GDL has no `product.gdl`, and a build in Studio, which runs `gearbox generate`, has nothing to build.

So a project says how it builds:

| How | A build in Studio | What it needs |
|---|---|---|
| **On gears** (the default) | Clones the repository and the gear sources, generates the profile, builds the generated Dockerfiles and publishes the generated chart (ADR-0048 §9) | `product.gdl` |
| **Its own** | Clones the repository, builds each Dockerfile the project names with its context, and publishes the chart folder it names | One or more `(values key, image name, Dockerfile, context)` and a chart folder, each path from the repository's root |

Both kinds give the same build record: images by digest, chart and version. So Builds, Deploys and the history do not depend on which kind built it. A deploy sets `<values key>.image.repository` and `.tag` for each image, as it does for a generated chart. A chart of the repository's own reads its images from those keys.

A project of either kind may also build in its own CI and upload the manifest (ADR-0048 §5). Studio records that build the same way.

A Constructor Research environment builds on gears only for now: Research builds images from files inside its own project, not from a cluster Job.

## Consequences

- A project deploys to its own registry or cluster without an administrator.
- The organization still decides which of its clusters projects may use. Shared environments keep their approvals, and the history stays one list.
- A project environment on an organization cluster uses that cluster's capacity without an administrator seeing it in the environment list. The deploy history, and the cluster itself, still show it.
- Open questions:
  - Quotas or limits per project on an opened cluster are not part of this decision.
  - An organization that closes a cluster after projects put environments on it does not remove those environments. Their next deploy is refused until the cluster is opened again or the environment is moved.

## More Information

- ADR-0043: an organization's products run in its environments.
- ADR-0048: a product ships as images and a chart in the organization's registry.
- ADR-0049: Constructor Research runs a product as one of its applications.

## Traceability

- `studio-backend/src/environments/`: `model.rs` (owner, open clusters, the checks), `service.rs` (project environments, targets, where connections are read from), `rest.rs` (`/studio-environments/v1/project-environments`, `/studio-environments/v1/open-clusters`, `/studio-environments/v1/project-build`), `build.rs` (`build-prepare --own`).
- `studio-frontend-prototype/src/`: the project's Deploys tab adds and edits its environments. Organization › Environments lists the clusters opened to projects.
