# Build and Deployment Pipelines

## Status

This document defines the target GitHub Actions architecture for Studio Web.
The first implementation phase keeps the existing `studio` Helm release so the
current dev and test installations remain compatible. Splitting the chart into
independent `studio-infra`, `studio-backend`, and `studio-frontend` releases is
a separate migration and must not be mixed with a live database upgrade.

GitHub Actions is the authoritative deployment interface. Direct `kubectl` or
`helm` mutations are reserved for documented break-glass recovery and must be
reconciled through GitHub afterward.

## Workflow model

| Workflow | Responsibility | Trigger |
| --- | --- | --- |
| **Test** | Test and validate changed source and deployment definitions | Every pull request and branch push |
| **Build Images** | Build and publish either service or infrastructure images | `main`, `v*`, `infra-v*`, or a manual service snapshot |
| **Deploy Infra** | Reconcile PostgreSQL and Keycloak for one environment | Manual dispatch using an `infra-v*` release only |
| **Deploy Services** | Deploy backend, frontend, or both | Manual dispatch using a branch snapshot or service release |

Publishing and deployment are intentionally separate. Creating a Git tag may
publish a release, but it never deploys automatically to an environment.

## Tag contract

| Tag | Meaning | Build scope | Allowed deployment |
| --- | --- | --- | --- |
| `sha-<40 lowercase hex>` | Immutable commit snapshot | Services | Dev only |
| `v<semver>` | Application release | Backend, frontend, prototype, and Theia | Any configured application environment |
| `infra-v<semver>` | Infrastructure release | Graph PostgreSQL and Keycloak | Any configured infrastructure environment |
| `edge` | Convenience pointer to the latest successful `main` service build | Services | Never accepted by deployment workflows |
| `latest` | Convenience pointer to the latest service release | Services | Never accepted by deployment workflows |
| `infra-latest` | Convenience pointer to the latest infrastructure release | Infrastructure | Never accepted by deployment workflows |

Examples:

```text
sha-d142bccc9e032d462ec4843e6798c7005db21910
v1.8.0
infra-v1.2.0
```

Release tags must point to commits reachable from `main`. Deployment workflows
must resolve the tag to its commit and reject malformed, missing, or unrelated
tags. Image manifests must exist before a deployment changes cluster state.

## Test

Test runs before any image publication and is matched to the exact commit SHA.
The Build Images workflow waits for a successful Test run for that SHA.

Required checks include:

- backend formatting, linting, locked build, tests, and gear assembly smoke test;
- frontend build and tests;
- graph PostgreSQL compatibility with CloudNativePG;
- Keycloak container build/start validation when its build context changes;
- GitHub Actions syntax and Helm lint for pipeline or deployment changes.

Path filtering may skip unaffected component jobs, but a successful workflow
result for the exact commit remains mandatory.

## Build Images

Build Images selects exactly one scope:

### Service scope

- `studio-backend`
- `studio-frontend`
- `studio-frontend-prototype`
- `cf-studio-theia`

A `v*` tag publishes the immutable full-SHA tag, the version tag, and `latest`.
A successful `main` build publishes the immutable full-SHA tag and `edge`.
A manually selected feature branch publishes only the immutable full-SHA tag.

### Infrastructure scope

- `graph-postgres`
- `cf-studio-keycloak`

Only an `infra-v*` Git tag selects this scope. It publishes the immutable
full-SHA tag, the infrastructure version tag, and `infra-latest`. It must not
move service `edge` or `latest` tags.

For both scopes, all images are built and verified before human-readable or
movable tags are promoted. Deployments never consume `edge`, `latest`, or
`infra-latest`.

## Deploy Infra

Inputs:

```text
environment: dev | test | prod
infra_tag: infra-v<semver>
```

The workflow must:

1. run only from the default branch;
2. validate that the tag exists, points to `main`, and has a published GitHub Release;
3. verify `graph-postgres` and `cf-studio-keycloak` image manifests;
4. use the namespace-scoped kubeconfig from the selected GitHub Environment;
5. reject cluster-admin credentials;
6. verify required namespace Secrets without printing their values;
7. render and server-side dry-run all changes;
8. reconcile the CloudNativePG image catalog/cluster before Keycloak;
9. wait for PostgreSQL health, then roll out Keycloak;
10. verify database readiness, Keycloak health, and the public OIDC issuer.

Infrastructure deployment is explicit and environment-specific. An
`infra-v*` release is an approved artifact, not permission to deploy to every
environment automatically. Test and production must use GitHub Environment
reviewers. Stateful PostgreSQL changes require backups and a documented
rollback/restore decision before production approval.

## Deploy Services

Inputs:

```text
environment: dev | test | prod
component: backend | frontend | all
image_tag: sha-<commit> | v<semver>
```

Policy:

- a `sha-*` snapshot can deploy only to dev;
- a `v*` release can deploy to any configured environment;
- `infra-v*`, `edge`, and `latest` are rejected;
- test and production use GitHub Environment reviewers;
- a component deployment must preserve the currently deployed versions of all
  components that were not selected;
- rollout, HTTPS, backend health, and OIDC smoke checks run after deployment;
- Helm uses wait and automatic rollback semantics.

During the compatibility phase, the workflow reads the currently deployed
image tags before upgrading the shared `studio` release. After the chart split,
each component will have an independent Helm release and this preservation step
will no longer be necessary.

## Helm release migration

Target ownership:

```text
studio-infra
  CloudNativePG resources
  Keycloak
  infrastructure routing

studio-backend
  backend Deployment, Service, RBAC, autoscaling, and session policies

studio-frontend
  frontend Deployment, Service, and public application routing
```

Migration order:

1. Introduce charts that render resources equivalent to the existing chart.
2. Validate rendered manifests against dev without changing ownership.
3. Migrate dev Helm ownership and verify rollback.
4. Repeat for test after an approved dev soak period.
5. Add production only after DNS, namespace, values, backups, credentials, and
   GitHub Environment approval rules exist.

## GitHub controls

- Keep workflow permissions read-only by default and grant `packages: write`
  or `contents: write` only to the jobs that need them.
- Store a different namespace-scoped `KUBE_CONFIG_B64` secret in each GitHub
  Environment.
- Require reviewers for test and production deployments.
- Protect `main` and release tag creation so only maintainers can publish or
  deploy releases.
- Never store kubeconfigs, passwords, realm secrets, or rendered Secret values
  in Git.

## Rollout phases

1. Split build scopes and enforce `v*` versus `infra-v*` tags.
2. Split Deploy Services and Deploy Infra workflow responsibilities while
   retaining the shared Helm release.
3. Exercise dev service and infrastructure deployments, including rollback.
4. Split the Helm releases and migrate dev ownership.
5. Promote the proven model to test.
6. Design and provision production separately.
