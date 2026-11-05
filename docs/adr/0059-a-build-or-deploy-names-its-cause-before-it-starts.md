---
type: adr
status: proposed
date: 2026-11-04
---

# ADR-0059: A build or a deploy names its cause before it starts

**ID**: `cpt-studio-adr-build-deploy-readiness`

Status: **proposed** · Date: 2026-11-04 · Amends `cpt-studio-adr-deployment-environments` (ADR-0043) §3 and `cpt-studio-adr-product-images` (ADR-0048) §9 · Extends `cpt-studio-adr-project-builds` (ADR-0045): what a Studio build's record says

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. The connections are read as the run will read them](#1-the-connections-are-read-as-the-run-will-read-them)
  - [2. The cluster is asked, not assumed](#2-the-cluster-is-asked-not-assumed)
  - [3. A build that failed as it started logs why](#3-a-build-that-failed-as-it-started-logs-why)
  - [4. A build's record says where it ran and with what](#4-a-builds-record-says-where-it-ran-and-with-what)
  - [5. The builder image runs non-root](#5-the-builder-image-runs-non-root)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

The first end-to-end Build in Studio of a real project on a dev cluster
(2026-11-04) failed four times, and only the last failure named its cause:

- The project's repository was reached through somebody's **personal**
  connection. Build accepted the request, because the connection belonged to
  the right organization. The Job's start then read the token as the
  organization's service, which cannot read a person's token, and failed.
  The build's log said only that it "has no pod left in any of the project's
  environments".
- The cluster had never had `deploy/k8s/studio-environments/bootstrap.yaml`
  applied. ADR-0043 treats that file as something an administrator applies
  once and Studio then relies on. The cluster connection could not create the
  project's namespace, and the build failed with a bare 403.
- A connection that may not read namespaces was assumed to have been given
  the namespace (`deploy.rs`), so the failure moved further into the run.
- The build's record did not say which environment, namespace, connection or
  builder image it had used, so the four failures could not be told apart
  afterwards.
- The image the Job's steps ran in was the local stand's (`Dockerfile.src`),
  which starts as root and switches user with gosu. In a `runAsNonRoot` pod
  with every capability dropped, that fails with "operation not permitted".

Each of these could have been known before anything was queued.

## Considered Options

1. **Keep failing in the run, with better messages.** The cause would still
   arrive minutes later, through a log that a failed start does not have.
2. **Check before queueing, the way the run will act.** Read each connection
   the run reads, as the run reads it, and ask the cluster about the
   namespace with the cluster connection's own credential.
3. **Check only when an environment is saved.** Rights and tokens change
   after that, and the source connection belongs to the project, not to the
   environment.

## Decision Outcome

Chosen option: **2**, and the run keeps its own checks in case the cluster
changes between the request and the run.

### 1. The connections are read as the run will read them

Before a build is queued, Studio reads the credential of every connection
the run will read, in the same context the run reads it:

- the repository's connection, as the organization's service;
- the environment's registry and cluster connections, as the service of the
  tenant they are found from (ADR-0054 §5).

The request is refused, as a `failed_precondition` carrying a code, when:

- `REPOSITORY_CONNECTION_PERSONAL`: the repository's connection is personal.
  This applies even when the person asking owns it, because the run never
  acts as them. The refusal names the connection's label, its scope and the
  repository.
- `REPOSITORY_CONNECTION_UNREADABLE`, `REGISTRY_CONNECTION_UNREADABLE`,
  `CLUSTER_CONNECTION_UNREADABLE`: a credential could not be read, or the
  cluster's credential is not a usable token or kubeconfig.

An install reads the registry and cluster connections the same way.

### 2. The cluster is asked, not assumed

This amends ADR-0043 §3. The cluster's bootstrap is no longer something
Studio trusts was applied. Before a build or an install is queued, Studio
asks the cluster, with the cluster connection's own credential:

- whether the project's namespace exists;
- if it does: may the connection `create` secrets, Jobs and Deployments in it
  (one SelfSubjectAccessReview each);
- if it does not: does the connection hold the bootstrap manifest's rights,
  that is `create namespaces`, `create rolebindings` and `bind
  clusterroles/admin`.

The request is refused when:

- `CLUSTER_CANNOT_CREATE_NAMESPACE`: the namespace is missing and a bootstrap
  right is missing. The refusal names the namespace and the manifest.
- `CLUSTER_NAMESPACE_RIGHTS_MISSING`: the namespace exists and a right in it
  is missing.
- `CLUSTER_CANNOT_READ_NAMESPACE`: the connection may not read the namespace.
  The run no longer assumes such a namespace exists; it fails there with the
  same reason.
- `ENVIRONMENT_CLUSTER_UNREACHABLE`: the cluster does not answer within 20
  seconds.

Testing a `kubernetes` connection also reports each bootstrap right, held or
not, in the test's `checks`. A missing right does not fail the test, because
a cluster prepared by hand, namespace by namespace, is still a working
cluster.

### 3. A build that failed as it started logs why

A build whose record failed at `start` never had a pod. Its log answers one
failed `start` step that holds the reason the record keeps, instead of
saying it has no pod left.

### 4. A build's record says where it ran and with what

This extends ADR-0045. A `studio` build's record also keeps:

- `environment_id`, `environment` and `namespace`;
- `git_ref` and `repository`;
- `source_connection_id` and `source_connection` (the connection's label);
- `builder_image`, and `gearbox_version`, which is the engine's commit that
  `publish` reads in that image.

The start writes all of them except the engine. A later record keeps what an
earlier one said. Every field is optional, so older records still read.

### 5. The builder image runs non-root

This amends ADR-0048 §9. The image `prepare` and `publish` run in must start
as uid 1000, and must need no capability to do it.

- The published backend image already does.
- `studio-backend/Dockerfile` adds a `builder` target: the same binary with
  git, the engine and helm, and nothing only the server needs.
- `scripts/check-builder-image.sh` runs both steps that way, and the delivery
  workflow runs it.
- The stand's image switches user at start, so it is not a builder image.

## Consequences

- A build or deploy that could only fail is refused in about a second, and
  the refusal names what to change and who changes it.
- A request now reaches the cluster and the credential store before it is
  queued, which costs a few round trips. A cluster that does not answer is
  reported within 20 seconds.
- Which connection a server-side build clones through is now visible in its
  record. Who should hold that connection is not decided here.
- Questions still open: which builder image a build runs, pinned by digest;
  separating push from pull credentials; how namespaces are assigned; and
  product kinds that do not build on gears.

## More Information

- ADR-0043: an organization's products run in its environments. This ADR
  amends §3, which treated the bootstrap as applied once and then trusted.
- ADR-0048: a product ships as images and a chart in the organization's
  registry. This ADR amends §9, on the image the build's steps run in.
- ADR-0045: a project keeps a record of its builds. This ADR adds where a
  Studio build ran.
- ADR-0054 §5: where an environment's connections are found and read from.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-adr-deployment-environments`
* `cpt-studio-adr-product-images`
* `cpt-studio-adr-project-builds`

In the code:

- `studio-backend/src/environments/readiness.rs`: `connection_refusal`,
  `cluster_refusal`, `cluster_facts` (§1, §2).
- `studio-backend/src/environments/service.rs`: `check_source_readable`,
  `check_cluster_ready`, called by `request_build` and `request_deploy`;
  `start_failure_log`, called by `build_log` (§3).
- `studio-backend/src/environments/deploy.rs`: `make_namespace` refuses a
  namespace it may not read.
- `studio-backend/src/connectors/kubernetes.rs`: `BOOTSTRAP_RIGHTS`,
  `NAMESPACE_RIGHTS`, `ClusterRight::allowed`; the test's `checks`.
- `studio-backend/src/artifact_ingest/port.rs`: `BuildPlace`;
  `artifact_ingest/builds.rs` writes it and carries it forward (§4).
- `studio-backend/Dockerfile`: the `builder` target;
  `studio-backend/scripts/check-builder-image.sh` (§5).
- `studio-frontend-prototype/src/builds.ts`: `BUILD_REFUSALS`,
  `buildRefusalText`, `placeOf`, `placeLines`.
