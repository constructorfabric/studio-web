---
type: adr
status: proposed
date: 2026-10-23
---

# ADR-0048: A product ships as images and a chart in the organization's registry, built by CI or the desktop and deployed from either

**ID**: `cpt-studio-adr-product-images`

Status: **proposed** · Date: 2026-10-23 · Completes `cpt-studio-adr-deployment-environments` (ADR-0043: the registry connection it names, and its phase 3 for builds that do not come from a desktop) · Uses `cpt-studio-adr-project-builds` (ADR-0045) · Keeps `cpt-studio-adr-a-desktop-session-keeps-the-secrets-on-the-server` (ADR-0027)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. A registry is a connection](#1-a-registry-is-a-connection)
  - [2. The cluster pulls with the environment's registry](#2-the-cluster-pulls-with-the-environments-registry)
  - [3. The chart is published beside the images](#3-the-chart-is-published-beside-the-images)
  - [4. A build says what it published](#4-a-build-says-what-it-published)
  - [5. CI builds the product from a workflow Studio proposes](#5-ci-builds-the-product-from-a-workflow-studio-proposes)
  - [6. A deploy names a build, from the portal or the desktop](#6-a-deploy-names-a-build-from-the-portal-or-the-desktop)
  - [7. Databases and configuration](#7-databases-and-configuration)
  - [8. Environments in order, rollback and uninstall](#8-environments-in-order-rollback-and-uninstall)
  - [9. Studio builds in the organization's cluster](#9-studio-builds-in-the-organizations-cluster)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

An organization holds environments, each with a cluster (ADR-0043), and the
server can install a chart into one: `environments.deploy` creates the
namespace and runs `helm upgrade --install`. What reaches that run, and how,
stops short of a product that runs:

- **Only the desktop makes images.** Generate writes a Dockerfile per
  application, `docker/build.sh` and an umbrella chart for a `kubernetes`
  profile; the member runs `docker build` and pushes with their own
  `docker login`. The backend never builds (ADR-0045 option 2), and no
  product repository has a pipeline that would.
- **The registry is a prefix.** `Environment.registry` is a string. There is
  no credential, so a cluster cannot pull a private image, and nothing pushes
  in the organization's name.
- **The chart travels as an upload.** `POST /deployments` carries the
  packaged chart (at most 512 KiB). Only a desktop that has just run Generate
  has one, so the portal cannot deploy, and a CI build cannot be deployed.
- **A build does not say what it made.** `BuildReport.outputs` is never
  filled; a deploy cannot pick the images of a build.
- **The product starts without its database and its configuration.**
  `DatabaseMode::Shared` is recorded and unused; required gear
  configuration is not in the chart's values.

The organization wants one thing: build its product from gears into images
and run it in its clusters, from Studio web or from the desktop, with the
same result.

## Considered Options

1. **Images and chart are published to the organization's registry; a deploy
   names what was published.** CI or the desktop builds and publishes, and
   records the build. The server deploys by reference.
2. **The backend builds.** Docker or BuildKit in the portal's pods, per
   product. Rejected by ADR-0045 for the same reasons: a privileged builder
   in a multi-tenant service, toolchains per gear, and minutes of CPU per
   build on the portal's budget. What stands of the option is the other
   half: Studio may start a build, as long as it runs in the organization's
   own cluster, unprivileged (§9).
3. **Keep the upload, add CI uploads.** CI posts its chart and images to
   Studio. Studio becomes a store of build artifacts it has no reason to
   keep, and a chart larger than the limit cannot be deployed at all.

## Decision Outcome

Chosen option: **1**.

### 1. A registry is a connection

A new connection kind, `registry`, holds an OCI registry (ghcr.io, a Harbor
project, a GitLab registry): its address, and a credential
`username:token` in credstore. Its test logs in to the registry's `/v2/`
API, following the token challenge the registry answers with. Like a
cluster, it is held by the organization and used by the server; the desktop
gets a short-lived push credential from the server rather than the token
(ADR-0027), as it does for git.

An environment names its registry connection beside the prefix it already
has. The prefix stays where images and the chart are pushed (`ghcr.io/acme`);
the connection is how to get in. A prefix on another host than the
connection's is refused.

### 2. The cluster pulls with the environment's registry

Before installing, the deploy run writes the registry's credential into the
namespace as a `kubernetes.io/dockerconfigjson` secret, `studio-registry`,
and names it in two places. A generated chart runs each application as a
service account of its own, so the deploy passes the secret as
`global.imagePullSecrets`, which that chart puts on every pod. A chart from
anywhere else gets it on the namespace's `default` service account. The
secret is written on every deploy, so a rotated token reaches the cluster
with the next one.

### 3. The chart is published beside the images

A build publishes the chart to the same registry as an OCI artifact
(`helm push` to `oci://<prefix>/charts`). A deploy names it as
`oci://…/<chart>` with a version. The server pulls it with the registry's
credential and installs it; nothing is uploaded. A reference may name only
the environment's registry, so the server never fetches from a host the
organization did not connect.

The upload stays for a chart that was never published: a desktop deploy to
an environment without a registry, as today.

### 4. A build says what it published

A build's record (ADR-0045) carries what it published:

- each application's image, with its digest;
- the chart reference and version;
- the product's revision and lock hash, as now.

CI writes them into `studio-build.json`, uploaded as a workflow artifact;
the sync reads it into the run's build. The desktop reports them with the
build it already reports.

### 5. CI builds the product from a workflow Studio proposes

Studio proposes a workflow in the product's repository, through a change
request as it does `product.gdl`. It:

1. runs Generate for the `kubernetes` profile, with the engine the IDE pins;
2. builds the images from the generated Dockerfiles;
3. pushes them and the chart to the environment's registry;
4. uploads `studio-build.json`.

The portal's **Build** dispatches it (ADR-0045 §3). GitHub Actions comes
first; GitLab CI follows through the same connector layer. A team with its
own pipeline only has to upload the same file.

### 6. A deploy names a build, from the portal or the desktop

**Deploy** takes a build and an environment. The portal offers it on a
passed build and on the project's Deploys tab. The desktop offers the same
choice: the build it just made and pushed, or one from CI. Both call the
same route; the server deploys the build's chart with its images, pinned by
digest. The record keeps the build, so "what runs where" names a commit, a
lock hash and the digests.

### 7. Databases and configuration

A generated chart fixes what it needs of a database in the configuration it
carries: the profile's host (`postgres` by default) and user, a database name
per gear, and the password as `${NAME}`, read from the secret the profile's
`database(existing_secret = …)` names under the key `NAME`. Two projects on
one shared server would therefore collide on their names, so the
environment's database mode is one of:

- **`namespace`**: the product gets a Postgres of its own in the project's
  namespace, under the host's name: a StatefulSet with a volume, a Service,
  and its password in a secret kept there. Before each install the deploy
  renders the chart (`helm template`, the same chart and values), reads the
  servers, databases and secrets it needs, makes sure the server runs,
  creates the databases that are missing with a Job, and writes the password
  into each secret the chart reads. The server is reached from inside the
  cluster, never from Studio.
- **`shared`**: recorded, not used, until generated charts name their
  databases per release.
- **`none`**: the product brings its own.

A release's configuration in an environment is the project's. Plain chart
values are kept on the profile's binding and laid under what the deploy sets;
the chart's own `values.schema.json`, which the engine writes, is what helm
checks them against. Secret values are kept in credstore, under a reference
Studio derives from the project, the environment and the key, so none can
name another's. The deploy writes them into the release's `<release>-config`
secret, which every application reads (`existingSecret` and `secretKeys`, the
chart's own values).

### 8. Environments in order, rollback and uninstall

An environment may take releases from another: `prod` takes only what
succeeded in `stage`, the same build or, without one, the same chart and
images. A rollback installs an earlier deployment of the project again,
which works for a published chart (an uploaded one is not kept). An
uninstall takes the release out with `helm uninstall`; its database and
secrets stay. Both go through the same request, the same approval of a
protected environment and the same record as a deploy.

### 9. Studio builds in the organization's cluster

A build need not wait for a pipeline. **Build in Studio** (portal or
desktop) asks the server, which starts a Kubernetes Job in the project's
namespace of the chosen environment: the organization's nodes do the work,
nothing compiles in the portal, and nothing runs privileged.

1. `prepare`, in this Studio's own backend image (`studio-backend
   build-prepare`): clones the product's repository at its branch -- through
   the repository's connection, whose token is a Secret in the namespace for
   the Job's lifetime -- and the gear sources its description names, runs
   `gearbox generate` with the engine this Studio runs, and makes the tree
   buildable (constructorfabric/gearbox#12).
2. `build`, rootless and daemonless BuildKit: builds each application's image
   and pushes it, tagged with the commit, with the namespace's registry login
   (the same `studio-registry` secret the cluster pulls with).
3. `publish` (`studio-backend build-publish`): pushes the chart beside the
   images and leaves the manifest -- images by digest, chart and version -- as
   the container's termination message.

The run that starts the Job ends at once; a watch run follows it, a few
minutes at a time, so a build outlives the task queue's lease and a restart
of the portal. When the Job ends the build is recorded -- `where: studio`,
passed with what it published or failed with the step and its last words --
and the token Secret is removed. A deploy then names the build like any
other (§6).

The namespace must admit a container with seccomp and AppArmor unconfined
and no privilege (what rootless BuildKit needs for its user namespace); a
cluster whose policy refuses that keeps building in CI (§5). BuildKit's cache
lives as long as the Job: each build compiles from scratch, about six minutes
for a two-gear product on the first test cluster.

## Consequences

- One path from gears to a running product, whichever surface starts it. The
  portal can build and deploy without a desktop; the desktop deploys what it
  built through the same record.
- The organization's registry becomes required for anything beyond a member's
  own cluster. An environment without one keeps today's upload.
- The run needs write access to secrets and service accounts in the project's
  namespace. The `admin` role a deployer gets there already includes them.
- A rotated registry token is picked up by the next deploy, not by running
  pods; a pull after rotation and before a deploy fails until then.

## More Information

**Phases:**

1. **Registry connection, pull secret, chart by reference.** The `registry`
   kind and its test, an environment's `registry_connection_id`, the pull
   secret on every deploy, and a deploy that names an OCI chart. *Built.*
2. **CI builds and publishes.** The proposed workflow, `studio-build.json`,
   images and chart on a build's record. *Built: `POST /build-workflows`
   proposes `.github/workflows/studio-build-<product>.yml` as a pull request, for any product description in the repository; the sync
   records a `ci-run-<id>` build from each run's `studio-build` artifact; a
   build reported as `ci` by anyone else is refused. GitLab CI is not written
   yet. The workflow builds any product description in
   the repository (`product_file`); `products/sample/product.gdl` is the one
   the path was first checked with. Until the engine fixes
   constructorfabric/gearbox#12, the workflow and the desktop give each
   generated Dockerfile its own `Dockerfile.dockerignore` (build.sh's
   `--ignorefile` is no docker flag) and protoc, the protobuf well-known
   types and cmake in its build stage.*
3. **Deploy a build, from either surface.** *Built: a deploy that names only
   `build` takes its chart, images, commit and lock from the record (it must
   have passed and published a chart); the portal's Deploys tab offers the
   builds; the desktop's Publish gets a push-only token
   (`POST /environments/{id}/push-tokens`, the registry's token service),
   pushes the images and the chart with it, reports the build when Deploy is
   pressed and deploys it by id. A registry without a token service is
   refused for Publish.*
4. **Databases and configuration** (§7). *Built: `namespace` mode, binding
   values, configuration secrets.*
5. **Order of environments, rollback and uninstall** (§8). *Built:
   `promote_from`, `redeploy_of`, `action: uninstall`.*

6. **Studio builds in the organization's cluster** (§9). *Built:
   `POST /builds`, the `environments.build` and `environments.build.watch`
   runs, `studio-backend build-prepare` / `build-publish`; Build in Studio on
   the Deploys tab and in the desktop's Deploy.*

Checked on the first cluster: rootless BuildKit runs in a project namespace
and compiled the sample product (`products/sample`) there, and
`build-prepare` prepared it from the repository. A whole build Job, the
pushes and a deploy of its result have not been run yet.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-adr-deployment-environments`
* `cpt-studio-adr-project-builds`
* `cpt-studio-adr-a-desktop-session-keeps-the-secrets-on-the-server`
