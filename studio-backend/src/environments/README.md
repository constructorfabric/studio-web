# studio-environments

Where an organization's products run.

The decision — why environments are the organization's, why a deploy runs on
the server, what a record of it holds — is
[ADR-0043](../../../docs/adr/0043-an-organization-deploys-products-to-its-environments.md);
how a product's images and chart reach it through the organization's registry
is [ADR-0048](../../../docs/adr/0048-a-product-ships-as-images-and-a-chart-in-the-organizations-registry.md).
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
| `GET /targets?project_id=` | member | the environments the project may deploy to, its namespace in each, its bindings |
| `PUT /bindings?project_id=` | member | bind the product's kubernetes profiles to environments |
| `POST /deployments?project_id=` | member | ask for a deploy: the chart (`.tgz`, base64), a published one (`chart_ref` `oci://<registry prefix>/…` and `chart_version`), or a build by id alone (`build`: its chart, images, commit and lock come from its record), or an earlier deployment again (`redeploy_of`), or `action: uninstall` of the release (`product`); refused into an environment with `promote_from` until the release succeeded there (ADR-0048); 202 `queued` or `awaiting_approval` |
| `POST /builds?project_id=` | member | build the product in the environment's cluster: a Job in the project's namespace (prepare, rootless BuildKit, publish), watched until it ends and recorded as a `studio` build (ADR-0048 §9); 202 with `build_id` |
| `POST /build-workflows?project_id=` | member | propose `.github/workflows/studio-build-<product>.yml` for the product `product_file` describes (default `product.gdl`) to the project's repository as a pull request (ADR-0048 §5) |
| `POST /environments/{environment_id}/push-tokens?project_id=` | member | a push-only token for named repositories under the environment's registry prefix, from the registry's token service (ADR-0048 §1); 201 |
| `PUT`/`DELETE /config-secrets/{key}?project_id=&environment_id=` | member | set or remove a secret of the release's configuration there; the value goes to credstore and never comes back |
| `GET /deployments` | member | the history, newest first; filter by `project_id`, `environment_id` |
| `POST /deployments/{deployment_id}/decisions` | admin | `approve` or `decline` (with a reason) a deploy to a protected environment |
| `GET /deployments/{deployment_id}/status` | member | the release's workloads and ingress hosts, read from the cluster now |

"Admin" is an organization owner, a platform administrator, or on the roles
model whoever holds `environment.manage` (`access_config::PRIVILEGES`), asked
of studio-user through `OrgAuthority`.

## In the assembly

- Gear `studio-environments`, capabilities `[rest]`, deps
  `account_management`. No database and no config section.
- Task type `environments.deploy` (studio-tasks), registered at `init`.
- The cluster is a connection of the `kubernetes` kind
  (`connectors/kubernetes.rs`, plugin gear `kubernetes-connector-plugin`). Its
  credential is a service-account token or a kubeconfig with inline data only;
  `ClusterAccess::parse` refuses `exec`, `auth-provider`, file paths and
  `insecure-skip-tls-verify`, and a kubeconfig for another server than the
  connection's address. An environment refuses a personal connection: the run
  acts as the service, which cannot read one.
- An environment may name a `registry` connection (`connectors/registry.rs`,
  plugin gear `registry-connector-plugin`; ADR-0048), on the host its registry
  prefix names, organization-held like the cluster. Every deploy then writes
  its login into the namespace as the `studio-registry`
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
- A project's configuration per environment: chart `values` on the profile's
  binding, laid under the deploy's own (images, pull secret); secrets in
  credstore under `studio-env-config-<project>-<environment>-<key>`, written by
  the run into `<release>-config` and given to every application through
  `existingSecret`/`secretKeys`.
- `helm` must be on the server's PATH (or `STUDIO_HELM`); both backend images
  install a pinned one.

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
- `deploy.rs` — the run: namespace, the pull secret, configuration secrets,
  the database step, `helm upgrade --install --wait` (or `helm uninstall`) with
  a kubeconfig (and a registry login for a published chart) in a scratch
  directory removed afterwards; the rollout read.
- `database.rs` — what a rendered chart needs of databases, and the
  namespace's Postgres that gives it.
- `workflow.rs` — the build workflow proposed to a product's repository.
- `build.rs` — a build in the organization's cluster: the Job, the start and
  watch runs, and the Job's own steps (`studio-backend build-prepare`,
  `build-publish`), which run in this Studio's backend image
  (`STUDIO_BUILDER_IMAGE`, else `…/studio-backend:sha-<commit>`).
- `rest.rs` — the routes.

## Not yet

A `shared` database (one server for many projects) is recorded and not used:
a generated chart fixes its database names. The build workflow is written for
GitHub Actions only. Nothing here has run against a real cluster yet.
