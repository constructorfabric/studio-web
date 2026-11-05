---
type: adr
status: proposed
date: 2026-10-30
---

# ADR-0055: A build is previewed in a namespace of its own that expires

**ID**: `cpt-studio-adr-previews`

Status: **proposed** · Date: 2026-10-30 · Amends `cpt-studio-adr-deployment-environments` (ADR-0043) · Uses ADR-0048 (a product ships as images and a chart in the organization's registry) and ADR-0054 (a project keeps environments of its own)

Amended by [ADR-0062](0062-a-projects-build-and-its-images-are-its-own-not-the-platforms.md) (2026-11-04): a preview's namespace is `<recorded namespace>-pv-<name>`, the recorded namespace being the project's in that environment, not one computed from its name.

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. An environment allows previews](#1-an-environment-allows-previews)
  - [2. A preview is a deploy into a namespace of its own](#2-a-preview-is-a-deploy-into-a-namespace-of-its-own)
  - [3. Its address](#3-its-address)
  - [4. It expires](#4-it-expires)
  - [5. What the cluster lets Studio delete](#5-what-the-cluster-lets-studio-delete)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

A project has one release per environment: a deploy to `dev` replaces whatever ran in `dev`. To try a branch's build, a member either overwrites `dev`, which the rest of the team uses, or asks an administrator for another environment, which then stays for good.

Constructor Insight met the same need for its own frontend and built a `previews` service: a branch's image under `/exp/<name>` on a shared host, removed after a TTL, with Kubernetes as its only store. Its idea carries over. Its code does not: it renders one fixed frontend image, while Studio installs a product's whole chart, with its databases and configuration, through the deploy run it already has (ADR-0043 §3).

## Considered Options

1. **A second release in the project's namespace.** It is cheap, but a generated chart fixes its object and database names, so a second release collides with the first.
2. **A preview environment per branch, added by hand.** This is what ADR-0054 already allows. Nobody removes it, and an administrator or the project manages one more environment for each try.
3. **A preview: a deploy into a namespace of its own that expires.** Studio makes the namespace, installs the build, gives it an address, and deletes the namespace with everything in it later.

## Decision Outcome

Chosen option: **3.**

### 1. An environment allows previews

An environment says whether it takes previews, and how:

| Setting | Meaning | Default |
|---|---|---|
| `domain` | A domain with a wildcard DNS record to the cluster's ingress controller. A preview answers at `<namespace>.<domain>`. Empty: no address | empty |
| `ingress_class` | The Ingress class a preview asks for | the cluster's default |
| `ttl_hours` | How long a preview lives, and the most a member may ask for | 72, at most 336 |
| `max_live` | How many previews one project keeps there at once | 3, at most 20 |

A protected environment takes none, because a preview that waits for approval is no preview. A Constructor Research environment takes none either, because a preview is a namespace on a cluster. Both organization environments and a project's own (ADR-0054) may take previews.

### 2. A preview is a deploy into a namespace of its own

A member asks for a deploy, as for any other, and marks it as a preview with a name (`pr-42`) and, if they want, a shorter life. Then:

- **The namespace** is the project's namespace there with `-pv-<name>` after it, for example `shop-dev-pv-pr-42`. It is labelled `studio.constructor.tech/preview=true` and annotated with its expiry.
- **The run** is the deploy run of ADR-0043: pull secret, configuration secrets, the namespace's own database (ADR-0048 §7), `helm upgrade --install`. A preview gets everything a deploy there gets, in its own namespace, so nothing is shared with what the environment runs.
- **The record** is a deployment in the organization's history, with its preview: name, expiry, address, and when it was removed. It is not "what runs there": the latest deploy to the environment keeps that place. The history keeps every preview that is not removed yet, whatever its age.
- **Promotion**: a preview is how a release is tried before it is promoted, so an environment's `promote_from` does not apply to it.

A project keeps at most `max_live` previews there, each name once, until they are removed.

### 3. Its address

A generated chart has no Ingress. When the environment has a preview domain, the run adds one after the install: `<namespace>.<domain>` goes to the Service port named `http`, or else `rest`. Those are the ports a gear's REST API listens on, the same rule a Research application uses (ADR-0049 §4). The Service named like the release comes first. A chart with no such port is installed without an address, and the record says why.

TLS is the ingress controller's: Studio names no certificate. A wildcard certificate for the domain covers every preview.

### 4. It expires

A sweep removes a preview by deleting its namespace, and records the removal on the deployment. It runs:

- on a schedule, one per organization, every 15 minutes. The first preview an organization asks for creates the schedule. Schedules are platform-level, so its payload names the organization;
- at once, when a member removes a preview before it expires.

A preview whose namespace the cluster would not delete stays live, with the reason on its record, and the next sweep tries again. A preview the history keeps has everything the sweep needs to remove it, such as the cluster connection, so editing or removing its environment does not orphan it.

### 5. What the cluster lets Studio delete

Until now the cluster's bootstrap manifest let Studio create namespaces but delete none. It now lets Studio delete a namespace too, and its admission policy holds that to namespaces labelled as Studio's **and** as a preview's. Studio cannot add that label to a namespace it did not make for a preview: it may not update namespaces at all. The sweep checks the same labels and the project before it deletes, whatever the record says.

A cluster bootstrapped before this has to apply the manifest again. Until then a preview installs, but its removal fails, and its record says so.

## Consequences

- A member tries a branch's build without touching `dev` and without an administrator, and gets an address to share.
- Previews cost cluster capacity until they expire: `max_live` and `ttl_hours` bound it per project.
- A preview of a chart that has its own Ingress (a project building its own chart, ADR-0054 §7) gets that Ingress too, with the same host as the environment's release. The ingress controller then sees two rules for one host. Such a project should template its host from values.
- Open questions:
  - Extending a preview's life is not part of this decision: remove it and preview the build again.
  - A preview per pull request, made and removed by the build workflow, would follow from this; it is not built.

## More Information

- ADR-0043: an organization's products run in its environments.
- ADR-0048: a product ships as images and a chart in the organization's registry.
- ADR-0054: a project keeps environments of its own.
- Constructor Insight's `previews` service (`src/backend/services/previews` in constructorfabric/insight): the same idea for one frontend image.

## Traceability

- `studio-backend/src/environments/`: `model.rs` (preview settings, the preview record, its name, namespace, host and limits), `preview.rs` (the address, the sweep task `environments.previews.sweep`), `deploy.rs` (the preview's namespace and address in the run), `service.rs` (asking for one, removing one, the schedule), `rest.rs` (`preview` on `POST /studio-environments/v1/deployments`, `DELETE /studio-environments/v1/previews/{deployment_id}`, `previews` on an environment).
- `deploy/k8s/studio-environments/bootstrap.yaml`: deleting a preview's namespace, and nothing else.
- `studio-frontend-prototype/src/`: previews on the project's Deploys tab; the preview settings in an environment's form.
