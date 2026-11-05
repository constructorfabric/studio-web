---
type: adr
status: proposed
date: 2026-10-13
---

# ADR-0043: An organization's products run in its environments

**ID**: `cpt-studio-adr-deployment-environments`

Status: **proposed** · Date: 2026-10-13 · Extends `cpt-studio-component-product` (from a generated product to a running one) · Applies `cpt-studio-adr-a-desktop-session-keeps-the-secrets-on-the-server` to clusters

Amended by [ADR-0062](0062-a-projects-build-and-its-images-are-its-own-not-the-platforms.md) (2026-11-04): a project's namespace is named from its immutable slug and recorded at the first build or deploy, and every later one reads the record; a found namespace another project's label claims is refused, and a cluster that gives namespaces instead of letting Studio make them is described by the environment's `namespaces`, each project assigned one by an administrator. The bootstrap manifest is versioned (`studio.constructor.tech/bootstrap-version`, now 2), and a build or deploy on a partially bootstrapped cluster is refused (`CLUSTER_NOT_BOOTSTRAPPED`).

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

Studio takes a project from its specification to a product composed of
gears: the portal picks the gears, Gearbox resolves and generates them, and
the desktop builds and runs the result. On 2026-10-13 a product went that
whole way on a desktop, as far as a running process on the member's machine
(the `local` profile).

The step after that is where a product is meant to run: a cluster. Nothing in
Studio knows about one:

- **A product's `kubernetes` profile names no place.** It may say a
  `namespace` and an `image_registry`, written by hand into `product.gdl`.
  The same text is used whichever cluster it ends up in.
- **The desktop's Deploy uses the member's own kubectl.** It lists the
  contexts in the member's kubeconfig and runs `helm upgrade --install` from
  their machine. Whoever deploys needs the cluster's credentials on their
  laptop. That is what ADR-0027 refused for git and model providers: a
  member's machine holds no organization secret.
- **Nobody knows what runs where.** A deploy from a desktop leaves no record
  in Studio: not which version of which product is in which cluster, nor who
  put it there.
- **The organization has clusters, and a policy about them.** Projects deploy
  into a cluster the organization runs, in a namespace it hands out, pulling
  from its registry, with a database it provides. Production is not a place
  every member may change.

## Considered Options

1. **Environments are the organization's.** The organization declares the
   places its products run: a cluster, a registry, how namespaces and
   databases are given out, and who may deploy. Projects bind a product's
   profiles to them. Deploys run on the server, as the organization.
2. **Clusters stay on the member's machine.** Deploy runs the member's
   kubectl and helm, as the desktop does today. Studio records nothing.
3. **Clusters are a project's setting.** Each project stores its own cluster
   credentials, in the way it stores its repositories.

## Decision Outcome

Chosen option: **environments are the organization's.**

Option 2 puts organization credentials on laptops and leaves no record.
Option 3 copies the same cluster into every project. Each copy then has to be
rotated, and there is no organization-wide view of what runs where.

### 1. An environment

An organization lists its **environments**. Each one has:

| Field | Meaning |
|---|---|
| name | `dev`, `stage`, `prod`: what people choose and see |
| cluster | a **connection** of the new `kubernetes` kind: the API server, its CA, and a service-account token in credstore |
| registry | a connection the images are pushed through (`ghcr.io/<org>`, a Harbor project), and the prefix the chart pulls from |
| namespaces | a pattern, `{project}-{environment}` by default; one namespace per project and environment |
| database | how a product's `db` gears get Postgres: a shared server of the environment (one database per gear) or none |
| protected | a deploy needs an organization administrator's approval, as publishing needs a curator's (ADR-0042 §4) |
| projects | which projects may deploy there; all by default |

Environments are organization settings. They are kept with the
organization, and their credentials are referenced, never stored inline. The
connection ownership rule applies unchanged: an organization uses only
connections it, its workspaces or its projects hold.

### 2. A project binds a product's profiles to environments

> Amended by ADR-0057 ([a profile is chosen per environment and checked per profile](0057-a-profile-is-chosen-per-environment-and-checked-per-profile.md)): a binding is environment → profile, each environment bound once and a profile to any number of them, and the engine's verdict is kept per profile.

A project maps each `kubernetes` profile of its product to an environment of
its organization, for example `prod` → *Org prod*. Generate takes the
profile's `namespace` and `image_registry` from that environment instead of
from text in `product.gdl`. The same product deploys to `stage` and `prod`
without edits.

`embedded` and `self_hosted` profiles stay where they are: on the member's
machine, built and run by the desktop.

### 3. A deploy runs on the server, as the organization

> Amended by ADR-0059 ([a build or a deploy names its cause before it starts](0059-a-build-or-deploy-names-its-cause-before-it-starts.md)): the cluster's bootstrap (`deploy/k8s/studio-environments/bootstrap.yaml`) is checked, not trusted to have been applied once. Before a build or an install is queued, the connections are read as the run reads them, and the cluster is asked whether the project's namespace exists and what the connection may do there; a connection test reports the bootstrap's rights.

**Deploy** is a request to the backend: this product, at this commit, built
into these images, to this environment. The backend runs it as a background
run (ADR-0038). It uses the environment's connection: `helm upgrade
--install` of the generated chart, in the environment's namespace for the
project, with images from its registry and the database it gives out. The
member's machine never holds the cluster's credentials.

The images come before the deploy, from one of:

- **CI**: the project's pipeline builds the generated Dockerfiles and pushes
  them through the environment's registry. This is the default for anything
  beyond `dev`.
- **The desktop**: Build images and Push, as the Generate view does today,
  pushing through the registry connection (credentials proxied, as for git).

A protected environment queues the request until an organization
administrator approves it. The approval is recorded with the deploy.

### 4. Studio knows what runs where

Every deploy is a record: product, commit, lock hash, images, environment,
namespace, who asked, who approved, and the outcome. The portal shows a
product's environments and what version runs in each. The project shows its
deployments. The organization shows its environments and what runs in them.
The status (rollout, pods ready, the product's address) is read back through
the same connection.

### 5. The desktop's own kubectl stays, for the member's own clusters

Deploy on the desktop lists the organization's environments first. The
member's own kube contexts remain below them, for a cluster of their own
(kind, Docker Desktop). A deploy there is the member's business, and Studio
records it as "on a member's cluster" or not at all.

## Consequences

- Good, because a cluster's credentials live in one place, the organization's
  connection, and never on a laptop.
- Good, because one product deploys to several environments without edits,
  and the portal answers "what runs where".
- Good, because production gets an approval step without a separate tool.
- Bad, because the backend gains a Kubernetes and Helm client for clusters it
  does not run in. Sessions use the in-cluster API (`studio_session::k8s`);
  this is a remote cluster per environment, with its own failure modes.
- Bad, because images must be built somewhere. The backend does not build
  Rust products; until CI is wired, the desktop is that place.
- Bad, because what the generated chart needs from an environment (database,
  required config as values) depends on the engine. See More Information.

## More Information

**What the engine must provide** (constructorfabric/gearbox#8, #9): a build
context that holds only the generated tree and the sources it reads; image
repositories that carry the profile's registry; a database section or chart
values for `db` gears; and required configuration declared by each gear, so
the chart can ask for it as values (`values.schema.json`). Until then a
deploy reaches the cluster but the product does not start.

**Phases in Studio:**

1. **Environments** in the organization's settings: the model, the
   `kubernetes` connection kind, REST, and the portal screen. No deploy yet.
2. **Profiles bound to environments** in the project. Generate fills
   `namespace` and `image_registry` from the environment.
3. **Deploy on the server**: the run, approval for protected environments,
   deployment records, and status read back. The desktop's Deploy targets
   environments.
4. **Databases and required configuration** from the environment, once the
   engine's chart asks for them.

The desktop's Deploy panel from the 2026-10-13 walk-through (#717) is the
phase-0 stand-in: the member's own kube contexts, every step a visible
command, and nothing recorded.

**Where it is built.** Phases 1 to 3 are the gear `studio-environments`
(`studio-backend/src/environments/`, its README lists the routes) and the
`kubernetes` connection kind (`connectors/kubernetes.rs`). The portal has the
organization's Environments section and an Environments block on a
project's product card; the desktop's Deploy lists the environments above
the kube contexts and asks the server to deploy into them. Phase 4 waits for
the engine.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/studio-product.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-fr-gearbox-product`
* `cpt-studio-component-product`
* `cpt-studio-component-connector`
* `cpt-studio-component-organizations`
* `cpt-studio-adr-a-desktop-session-keeps-the-secrets-on-the-server`
* `cpt-studio-adr-one-story-for-async-work`
* `cpt-studio-adr-component-tiers`
