# studio-environments

Where an organization's products run.

The decision — why environments are the organization's, why a deploy runs on
the server, what a record of it holds — is
[ADR-0043](../../../docs/adr/0043-an-organization-deploys-products-to-its-environments.md);
how a product's images and chart reach it through the organization's registry
is [ADR-0048](../../../docs/adr/0048-a-product-ships-as-images-and-a-chart-in-the-organizations-registry.md);
previews are
[ADR-0055](../../../docs/adr/0055-a-build-is-previewed-in-a-namespace-of-its-own-that-expires.md);
what keeps a project's build, images and namespaces its own -- the builder by
digest, push and pull apart, project paths, image records, recorded
namespaces, the build namespace, the build plan, the IdP preflight -- is
[ADR-0062](../../../docs/adr/0062-a-projects-build-and-its-images-are-its-own-not-the-platforms.md).
This README is what you need to work in the directory.

## REST

All under `/studio-environments/v1`. An organization is named with
`?organization_id=`, a project with `?project_id=`.

| Method + path | Who | Does |
|---|---|---|
| `GET /environments` | member | the organization's environments, and `may_manage` |
| `POST /environments` | admin | add one |
| `PUT`/`DELETE /environments/{environment_id}` | admin | change or remove one |
| `POST /environments/{environment_id}/test` | admin | ask the cluster for its version with the environment's connection |

Testing a `kubernetes` connection (studio-connector) also asks the cluster,
with a SelfSubjectAccessReview each, whether the connection holds the rights
`deploy/k8s/studio-environments/bootstrap.yaml` gives (`create namespaces`,
`create rolebindings`, `bind clusterroles/admin`), and reports each in the
answer's `checks`. A missing one does not fail the test.
| `GET /targets?project_id=` | member | the environments the project may deploy to, its namespace in each, its bindings |
| `PUT /bindings?project_id=` | member | bind each environment to the kubernetes profile it runs (a profile may run in several; ADR-0057) |
| `POST /deployments?project_id=` | member | ask for a deploy: the chart (`.tgz`, base64), a published one (`chart_ref` `oci://<registry prefix>/…` and `chart_version`), or a build by id alone (`build`: its chart, images, commit and lock come from its record), or an earlier deployment again (`redeploy_of`), or `action: uninstall` of the release (`product`); refused into an environment with `promote_from` until the release succeeded there (ADR-0048); with `preview` (`name`, `ttl_hours`), into a namespace of its own that the sweep removes when it expires (ADR-0055); 202 `queued` or `awaiting_approval` |
| `POST /builds?project_id=` | member | build the product in the environment's cluster: a Job in the project's namespace (prepare, rootless BuildKit, publish), watched until it ends and recorded as a `studio` build (ADR-0048 §9); naming neither `product_file` nor `ref` builds what the Product step last wrote, on its branch; refused before it is queued when a connection or the cluster would stop it (see "Before a build or a deploy is queued"); 202 with `build_id` |
| `GET /builds/{build_id}/log?project_id=` | member | a Studio build's steps and the end of each one's log, read from its pod; a build that failed as it started (`failure_step` `start`) never had a pod, and answers one failed `start` step whose log is the reason its record keeps |
| `POST /build-workflows?project_id=` | member | propose `.github/workflows/studio-build-<product>.yml` for the product `product_file` describes (default the path the product record gives, `products/<id>/product.gdl`) to the project's repository as a pull request (ADR-0048 §5) |
| `POST /environments/{environment_id}/push-tokens?project_id=` | member | a push-only token for named repositories under the environment's registry prefix, from the registry's token service (ADR-0048 §1); 201 |
| `PUT`/`DELETE /config-secrets/{key}?project_id=&environment_id=` | member | set or remove a secret of the release's configuration there; the value goes to credstore and never comes back |
| `POST /builds/plan?project_id=` | member | what `POST /builds` would do, without starting it: sources with their refs and connections, description revision, registry paths, namespace and build namespace, builder and Gearbox version, strictness, warnings, and the `refusal` it would meet (ADR-0062 §8) |
| `GET /environments/{environment_id}/readiness` | member | `bootstrapped`, `namespace_limited` (with the namespaces given) or `partial` (with what is missing), asked of the cluster now (ADR-0062 §6) |
| `GET /images?project_id=`, `GET /images/{image_id}` | member | the project's image and chart records, newest first, each with the live releases that run it; filters `environment_id`, `app`, `kind`, `state`, `build_id` |
| `PUT`/`DELETE /images/{image_id}/pin` | member | keep an image past retention, or let it go |
| `DELETE /images/{image_id}` | member | 409 `IMAGE_RUNNING` / `IMAGE_PINNED`; else 202 with the run that deletes the digest |
| `POST /images/{image_id}/promotions` | member | copy the digest into another environment's registry, under the project's path there; 202 |
| `POST /images/imports` | member | copy an external image or OCI chart by digest into `<prefix>/<slug>/mirror/<name>`, with its provenance; 202 |
| `GET`/`PUT /image-retention` | member (project) / admin (organization) | `keep_last`, `keep_days`; the daily `environments.image_sweep` applies it |
| `GET /registries`, `…/{connection_id}/repositories`, `…/repositories/{repo}/tags`, `DELETE …/versions/{digest}`, `…/orphans` | admin | the organization's registries as they are, against the records (ADR-0062 §5) |
| `GET`/`PUT /namespace-assignments` | admin | the namespace each project was given in each environment; an administrator assigns one on a cluster that gives namespaces |
| `GET /deployments` | member | the history, newest first; filter by `project_id`, `environment_id` |
| `DELETE /previews/{deployment_id}?project_id=` | member | remove a preview before it expires: a sweep of it alone deletes its namespace (ADR-0055); 202 with the run |
| `POST /deployments/{deployment_id}/decisions` | admin | `approve` or `decline` (with a reason) a deploy to a protected environment |
| `GET /deployments/{deployment_id}/status` | member | the release's workloads and ingress hosts, read from the cluster now |

"Admin" is an organization owner, a platform administrator, or on the roles
model whoever holds `environment.manage` (`access_config::PRIVILEGES`), asked
of studio-user through `OrgAuthority`.

## In the assembly

- Gear `studio-environments`, capabilities `[db, rest]`, deps
  `account_management`. Its database (`studio_environments`) keeps project
  slugs, namespace assignments, image records and retention (`records.rs`,
  `migrations.rs`); without one it stands down to namespaces from the
  pattern and paths from the name, and the image routes answer 503.
- Task types `environments.images` (delete, copy) and
  `environments.image_sweep` (daily, scheduled when a retention is set).
- Task type `environments.deploy` (studio-tasks), registered at `init`.
- The cluster is a connection of the `kubernetes` kind
  (`connectors/kubernetes.rs`, plugin gear `kubernetes-connector-plugin`). Its
  credential is a service-account token or a kubeconfig with inline data only;
  `ClusterAccess::parse` refuses `exec`, `auth-provider`, file paths and
  `insecure-skip-tls-verify`, and a kubeconfig for another server than the
  connection's address. An environment refuses a personal connection: the run
  acts as the service, which cannot read one.
- A project's namespace (`<slug>-<environment>` by default, the slug made
  once from its name and kept) is recorded at the first build or deploy that
  made or found it, and read from the record by every later one
  (`placement.rs`). A found namespace whose `studio.constructor.tech/project`
  label names another project is refused; one without the label only when
  an administrator assigned it. An environment that lists `namespaces` (a
  cluster that gives them) takes only an administrator's assignment. Builds
  run in the build namespace (`<slug>-build` by default): the Job, the
  repository token and the push token live there, the runtime namespace
  holds only the pull secret. A missing namespace is made by the
  first build or deploy into it, labelled
  `app.kubernetes.io/managed-by=constructor-studio`, and the connection then
  binds itself `admin` there (the `constructor-studio` RoleBinding, as the
  user a `SelfSubjectReview` names). A cluster administrator makes that
  possible once with `deploy/k8s/studio-environments/bootstrap.yaml`: the
  account may create namespaces and bind `admin`, and an admission policy holds
  it to the namespaces labelled as Studio's. The prototype's "Connect a
  cluster" form shows the same file.
- An environment may name a `registry` connection (`connectors/registry.rs`,
  plugin gear `registry-connector-plugin`; ADR-0048), on the host its registry
  prefix names, organization-held like the cluster, and may name a
  read-only `registry_pull_connection_id`. Images and charts go under the
  project's own path `<prefix>/<slug>/`, and a deploy takes nothing outside it.
  Every deploy writes the pull identity (else the push connection's, and the
  environment warns that the cluster gets a credential that can write) into
  the namespace as the `studio-registry`
  `kubernetes.io/dockerconfigjson` secret and adds it to the `default` service
  account's `imagePullSecrets`, so the cluster pulls private images whatever
  the chart says. A published chart (`chart_ref`) is accepted only under the
  environment's registry prefix and pulled with the same login, through a
  `--registry-config` in the run's scratch directory. The cluster connection
  needs to manage secrets and service accounts in the namespace; `admin` there
  does.
- Database mode `namespace` (`database.rs`, ADR-0048 §7): before the install
  the run renders the chart with `helm template`, reads from its ConfigMaps the
  Postgres servers, user, `${NAME}` password and databases, and from its
  workloads the secrets that password is read from; then applies a
  `studio-postgres-<host>` Secret (the kept password), a Service named as the
  host, a StatefulSet (default `pgvector/pgvector:pg18`, or the environment's
  `database_image`, 10Gi volume), waits for it, creates the missing databases
  with a Job running `psql` in the namespace, and writes the password into each
  secret the chart reads. The cluster connection needs to manage StatefulSets,
  Services, Jobs and Secrets there; `admin` does.
- Infra services (`infra.rs`, `infra_install.rs`, ADR-0064): a project's list
  (`GET`/`PUT /infra-services`) of `service.gdl` passports with `kind =
  "infra"`, each naming its image (and optionally a ready chart) imported into
  the project's path. An environment's `infra` says `with_product` (default;
  always in a dev environment) or `shared` with the organization's places.
  Before the release the run makes each service's secrets once
  (`INFRA_<SERVICE>_<KEY>` in credstore), writes what it provides as the
  release's configuration secrets (`oidc.issuer` -> `OIDC_ISSUER`), and
  installs it as its own Helm release in the namespace: from its ready chart,
  or from a chart generated from the passport (Deployment or StatefulSet with
  a volume claim, Service, Secret). A service providing `postgres` is made by
  the database step with its image. `GET /environments/{id}/infra-plan` says
  all of it before a deploy; a deploy refuses `INFRA_IMAGE_NOT_IMPORTED`,
  `IMAGE_NOT_IN_PROJECT_PATH` or `INFRA_NOT_IN_SHARED_PLACE`. The cluster
  connection needs Deployments, StatefulSets, PVCs, Services and Secrets in
  the namespace; `admin` there does.
- A project's configuration per environment: chart `values` on the profile's
  binding, laid under the deploy's own (images, pull secret); secrets in
  credstore under `studio-env-config-<project>-<environment>-<key>`, written by
  the run into `<release>-config` and given to every application through
  `existingSecret`/`secretKeys`.
- `helm` must be on the server's PATH (or `STUDIO_HELM`); both backend images
  install a pinned one.
- Previews (ADR-0055): an environment with `previews` takes a deploy with
  `preview: {name, ttl_hours}`. It goes into `<namespace>-pv-<name>`,
  labelled `studio.constructor.tech/preview=true` and annotated
  `studio.constructor.tech/expires-at`; with a preview `domain`, the run
  routes `<namespace>.<domain>` to the Service port named `http`, else `rest`,
  with the Ingress `studio-preview`. Task type `environments.previews.sweep`
  deletes the namespaces of expired previews; the first preview of an
  organization schedules it every 15 minutes (`studio-scheduler`, platform
  tenant, the organization in the payload), and a removal by hand is one
  more run. Deleting a namespace needs the current bootstrap manifest, which
  allows it for preview namespaces only.

## Before a build or a deploy is queued

`readiness.rs`. A build (and an install, before it is recorded) reads every
connection its run will read, the way the run reads it, and asks the cluster,
so a run that could only fail is refused with its cause instead of failing in
the middle of a Job with a 403 or "no pod left". Each refusal is a
`failed_precondition` whose violation carries the code:

| Code | When |
|---|---|
| `REPOSITORY_CONNECTION_PERSONAL` | the project's repository is reached through a personal connection: a build clones as the organization's service, which cannot read a person's token, even when the person asking owns it |
| `REPOSITORY_CONNECTION_UNREADABLE` | the repository's connection could not be read as the organization's service (removed token, a connection the organization does not reach) |
| `REGISTRY_CONNECTION_UNREADABLE` | the environment's registry connection could not be read as the run reads it (the service of the tenant it is found from, ADR-0054 §5) |
| `CLUSTER_CONNECTION_UNREADABLE` | the same, for the cluster connection, or its credential is not a usable token or kubeconfig |
| `ENVIRONMENT_CLUSTER_UNREACHABLE` | the cluster did not answer within 20 seconds |
| `CLUSTER_CANNOT_READ_NAMESPACE` | the connection may not read the project's namespace, so whether it exists cannot be told |
| `CLUSTER_CANNOT_CREATE_NAMESPACE` | the namespace does not exist, and the connection lacks a right the bootstrap manifest gives (`create namespaces`, `create rolebindings`, `bind clusterroles/admin`); names the namespace and the manifest |
| `CLUSTER_NAMESPACE_RIGHTS_MISSING` | the namespace exists, and the connection may not `create` secrets, Jobs or Deployments in it |
| `CLUSTER_NOT_BOOTSTRAPPED` | the cluster is partially bootstrapped: a right, the admission policy, or the manifest's version label (2) is missing; all are listed |
| `NAMESPACE_NOT_ASSIGNED` | the cluster gives namespaces and none is assigned to the project, or a found namespace without Studio's label was not assigned |
| `NAMESPACE_OF_ANOTHER_PROJECT` | a found namespace's `studio.constructor.tech/project` label names another project |
| `BUILDER_NOT_PINNED` | the builder image names no digest (or none is configured); a stand with `STUDIO_BUILDER_ALLOW_TAG=1` takes a tag |
| `REGISTRY_CONNECTION_PERSONAL` | a build's registry connection is personal |
| `REGISTRY_TOKEN_TOO_BROAD` | the registry token may also administer or delete (`admin:*`, `delete:*`, `repo`…), unless the environment sets `allow_broad_registry_token` |
| `PRODUCT_USES_PLATFORM_IDP` | the product's OIDC issuer is Studio's own (`STUDIO_OIDC_ISSUER`) or its client is one of Studio's (`studio-portal`) |
| `IMAGE_NOT_IN_PROJECT_PATH` | a deploy names an image or chart outside the project's path |

The rights are asked with SelfSubjectAccessReviews made with the cluster
connection's own credential. A namespace the connection may not read used to
be assumed to exist (`deploy.rs`); the run now fails there with the same
reason, should the cluster change between the check and the run.

## A Studio build's record

Each `studio` build node keeps, beside what every build keeps, where it ran
and with what (`artifact_ingest::port::BuildPlace`): `environment_id`,
`environment`, `namespace`, `git_ref`, `repository`, `source_connection_id`
and `source_connection` (its label), `builder_image`, and `gearbox_version`,
the engine's commit `publish` reads in its image (the manifest's `gearbox`),
and `source_commits`, `id=commit` for every source the build fetched
(ADR-0060 §3).

A build takes every source its description uses (ADR-0060 §3): the home
source cloned for the `path(...)` ones, and each `git(...)` source that is
one of the project's repositories fetched at the ref the server chose
(`build-prepare --source-ref id=ref`) -- its branch for a dev environment, the
revision's pinned commit for a protected one, which refuses a revision with
no lock (`REVISION_NOT_PINNED`). An environment's `strictness` (`dev` |
`prod`; unset: `prod` when protected, else `dev`) is passed as
`--strictness`: `dev` builds the profile marked `development = True` (§5).
The start writes all but the engine; a later record keeps what an earlier one
said unless it says it again. Each is absent from a record written before it
was kept.

## Where things are kept

Account-management metadata, declared in every `config/*.yaml`:

| Type | On | Written by |
|---|---|---|
| `cf.studio.environment.list.v1~` | the organization | this gear only, as the service |
| `cf.studio.environment.deployments.v1~` | the organization | this gear only, as the service |
| `cf.studio.environment.bindings.v1~` | the project | the project's members |

The first two are in `studio_authz_plugin::GEAR_HELD_METADATA`: the PDP refuses
anybody's write of them except a service token, so the administrator check
here cannot be stepped around through account-management's own metadata
route. Writes are version-checked (`expected_version`) and retried.

The history keeps `model::HISTORY` (200) deployments plus the latest of every
project and environment and everything waiting for a decision. A record's
state follows its run while it is `queued` or `running`, and is written back
once the run ends.

## Where things are

- `model.rs` — environments, bindings, records and their rules (namespace
  pattern, registry, the history's trimming, image values). No I/O.
- `store.rs` — the metadata rows and the service identity.
- `service.rs` — who may, in which order.
- `readiness.rs` — what a build or a deploy checks before it is queued: the
  connections read as the run reads them, the cluster's namespace and rights
  asked of the cluster; the decisions are plain functions.
- `deploy.rs` — the run: namespace, the pull secret, configuration secrets,
  the database step, `helm upgrade --install --wait` (or `helm uninstall`) with
  a kubeconfig (and a registry login for a published chart) in a scratch
  directory removed afterwards; the rollout read.
- `database.rs` — what a rendered chart needs of databases, and the
  namespace's Postgres that gives it.
- `preview.rs` — a preview's address (the Ingress) and the sweep that
  removes expired previews.
- `workflow.rs` — the build workflow proposed to a product's repository.
- `build.rs` — a build in the organization's cluster: the Job, the start and
  watch runs, and the Job's own steps (`studio-backend build-prepare`,
  `build-publish`), which run in the builder image `builder_for` picks: the
  environment's `builder_image`, else `STUDIO_BUILDER_IMAGE` (the chart's
  `backend.builds.builderImage`, `studio-builder@sha256:…` from CI), else
  `STUDIO_BUILDER_IMAGE_BUILT` (the builder CI baked into the backend image
  of the same commit), by digest, never the server's own. The watch mints the push token once
  `prepare` names its images, and writes each published image as a record.
  The image must start as uid 1000, since the Job's pod is `runAsNonRoot` with every
  capability dropped: the published image does, and so does
  `studio-backend/Dockerfile`'s `builder` target (the binary, git, Gearbox,
  helm; `scripts/check-builder-image.sh` checks it); the stand's
  `Dockerfile.src` image switches user through gosu and cannot. BuildKit
  runs in `STUDIO_BUILDKIT_IMAGE`, else `moby/buildkit:v0.20.0-rootless`. The
  chart sets both (`backend.image`, `backend.builds.buildkitImage`).
- `rest.rs` — the routes; `rest_images.rs` those of ADR-0062.
- `placement.rs` — a project's slug, namespaces and registry path in an
  environment, and whether a found namespace is its own.
- `images.rs` — image records and references, retention, orphans, where a
  record runs. No I/O. `records.rs` keeps them; `image_tasks.rs` deletes,
  copies and sweeps; `service_images.rs` is who may.
- `images_sink.rs` — a pipeline's published images, recorded.

## Not yet

A `shared` database (one server for many projects) is recorded and not used:
a generated chart fixes its database names. The build workflow is written for
GitHub Actions only. Nothing here has run against a real cluster yet.
