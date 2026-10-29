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

| Stage in **Studio Delivery** | Responsibility | Trigger |
| --- | --- | --- |
| **1. Test changed components** | Test and validate changed source and deployment definitions | Every pull request, branch push, and manual **Build and publish** run |
| **2. Build & Publish** | Build and publish either service or infrastructure images | After tests on an upstream push, or manual **Build and publish**; fork pushes do not publish automatically |
| **3. Deploy Infrastructure** | Reconcile PostgreSQL and Keycloak for one environment | Manual **Deploy existing images** with **Infrastructure**, using an `infra-v*` release only |
| **3. Deploy Services** | Deploy backend, frontend, or both | Manual **Deploy existing images** with **Services**, using a branch snapshot or service release |

Publishing and deployment are intentionally separate. Creating a Git tag may
publish a release, but it never deploys automatically to an environment.

## Runners

The Linux build and test jobs of **Studio Delivery** and **Studio CLI
extension** are routed to the self-hosted runners of the org runner group
`studio-runners`: each names one runner class in its `runs-on`. They fall back
to GitHub-hosted in the cases listed under [Routing and
rollback](#routing-and-rollback). The deploy jobs and the Windows and macOS
builds always run on GitHub-hosted. Every self-hosted runner is
**ephemeral**: it takes one job, then it is destroyed. Nothing a job leaves on
disk, in Docker or in a build directory reaches the next job.

| Label | What it is | Size |
| --- | --- | --- |
| `studio-small` | A Kubernetes pod (`ci-pod-studio` image). When the pods are full, the job runs on a small VM with the same label instead | 1 CPU, 2 GiB (up to 4 GiB) |
| `studio-small-vm` | A small VM with Docker (`ci-studio` image, Ubuntu 24.04) | 2 vCPU, 4 GiB |
| `studio-large` | A large VM with Docker (`ci-studio` image, Ubuntu 24.04) | 8 vCPU, 16 GiB |
| `ubuntu-latest`, `ubuntu-24.04` | GitHub-hosted | — |

### Which class a job uses

- **`studio-small` (pod).** The job starts no container: no `docker`, no
  `services:` and no `container:`. It uses no secret beyond `GITHUB_TOKEN`, and
  its token has no write permission. Give the job its own `permissions:` block
  (at least `contents: read`), because the workflow-level block grants
  `contents: write` and `packages: write`. The pod image has **no Rust
  toolchain**. Keep the job short. Because a full pod pool overflows to a
  small VM, the job must also work on a VM.
  Examples: change detection, Node tests, actionlint and helm lint, the
  `echo` gates.
- **`studio-small-vm`.** The job is short but needs a write permission
  (`contents: write`, `packages: write`), a secret, or a little Docker.
  Examples: the GitHub-release jobs, the `studio-cli` build.
- **`studio-large`.** The job compiles Rust, builds or runs images, or brings up
  the Compose stack. Examples: `test-backend`, `test-frontend`, `test-infra`,
  the `build-*-binary` jobs, `build-service-images`, `build-infra-images`,
  `test-e2e`.
- **GitHub-hosted, always.** The `deploy-*` jobs: they use the Environment
  kubeconfigs, and the runners cannot reach the clusters. Also the Windows and
  macOS builds in `desktop.yml` and `gearbox-engine.yml`.

What the images already have, so a job does not install it: Node 22 and 24,
Python 3.12, `git`, `gh`, `jq`, `yq`, `helm`, `kubectl`, `curl`, `make`. The VM
image also has Docker with Compose and Buildx, Rust 1.97.0 with `clippy` and
`rustfmt`, `protoc`, `cmake`, `pkg-config`, `sccache` and Chromium's system
libraries. Steps that `sudo apt-get install` these are guarded by
`if: runner.environment == 'github-hosted'`.

### Routing and rollback

Every routed job uses the same expression, with only its class and its
GitHub-hosted image changing:

```yaml
runs-on: ${{ (vars.STUDIO_FORCE_GITHUB_HOSTED == 'true' || github.repository != 'constructorfabric/studio-web' || github.event.pull_request.head.repo.fork) && 'ubuntu-latest' || 'studio-large' }}
```

- `STUDIO_FORCE_GITHUB_HOSTED` = `true` (repository variable) sends every
  routed job back to GitHub-hosted. This is the rollback.
- A run inside a fork (a push to the fork, or its own pull requests) runs on
  GitHub-hosted: the organisation's runners serve this repository only.
- A pull request from a fork to this repository always runs on GitHub-hosted.
  To use the self-hosted runners, push a branch to this repository.
- A new runner label must also be added to `.github/actionlint.yaml`, or the
  workflow lint fails.

### Caches

The runners start empty, so each cache has to come from somewhere:

- `actions/cache`, `setup-node`'s npm cache and `Swatinem/rust-cache` use the
  GitHub cache, the same as on hosted runners.
- `build-service-images` uses the BuildKit layer cache in S3 through
  `.github/actions/ci-cache`. Only a push to `main` writes to it, under the
  Environment `ci-trusted`. Every other run only reads it. On a GitHub-hosted
  runner the action does nothing. `.github/actions/ci-cache` is a copy of the
  platform's action: replace it with a new copy rather than editing it here.

## Tag contract

| Tag | Meaning | Build scope | Allowed deployment |
| --- | --- | --- | --- |
| `sha-<40 lowercase hex>` | Immutable commit snapshot | Services | Any configured application environment |
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

## 1. Test changed components

Test runs before any image publication and is matched to the exact commit SHA.
Build & Publish runs only after the successful Test stage for the same SHA.

Required checks include:

- backend formatting, linting, locked build, tests, and gear assembly smoke test;
- frontend build and tests;
- graph PostgreSQL compatibility with CloudNativePG;
- Keycloak container build/start validation when its build context changes;
- GitHub Actions syntax and Helm lint for pipeline or deployment changes.

Path filtering may skip unaffected component jobs, but a successful workflow
result for the exact commit remains mandatory.

## 2. Build & Publish

Build & Publish selects exactly one scope:

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

## 3. Deploy Infrastructure

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

## 3. Deploy Services

Inputs:

```text
environment: dev | test | prod
component: backend | frontend | all
image_tag: sha-<commit> | v<semver>
```

Policy:

- a `sha-*` snapshot and a `v*` release can both deploy to any configured
  environment — a snapshot names one commit and one image for ever, so the
  distinction was never about what could change underneath it;
- `infra-v*`, `edge`, and `latest` are rejected;
- test and production are meant to use GitHub Environment reviewers — **as of
  2026-09-23 neither `dev` nor `test` has any protection rule or reviewer
  configured**, so this line describes an intent and not the repository;
- a component deployment must preserve the currently deployed versions of all
  components that were not selected;
- rollout, HTTPS, backend health, and OIDC smoke checks run after deployment;
- Helm uses wait and automatic rollback semantics.

During the compatibility phase, the workflow reads the currently deployed
image tags before upgrading the shared `studio` release. After the chart split,
each component will have an independent Helm release and this preservation step
will no longer be necessary.

## One-off data steps after a deploy

Run each once per environment, as a platform administrator, after the backend
that carries it is up. Each is idempotent, so a second run is harmless.

- **ADR-0040, since #682:** `POST /cf/studio-user/v1/grants/backfill` answers
  `{organizations, rewritten, failed}`. Deploy the backend and the prototype
  together, then run it. `failed > 0` means read the backend log
  (`studio-user: grant rekey failed`) and run it again. Skipping it does not
  change who has access, because login-keyed grants still match, but the
  prototype cannot name the grants written before it.

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
- Require reviewers for test and production deployments. **Not configured
  today** (checked 2026-09-23: both environments have empty
  `protection_rules`). This is the gate that should decide who may put an
  unmerged branch on a shared environment; the delivery workflow
  deliberately does not try to be that gate, it only records what landed.
- Protect `main` and release tag creation so only maintainers can publish or
  deploy releases.
- Never store kubeconfigs, passwords, realm secrets, or rendered Secret values
  in Git.

## Rollout phases

1. Split build scopes and enforce `v*` versus `infra-v*` tags.
2. Split Deploy Services and Deploy Infrastructure stage responsibilities while
   retaining the shared Helm release.
3. Exercise dev service and infrastructure deployments, including rollback.
4. Split the Helm releases and migrate dev ownership.
5. Promote the proven model to test.
6. Design and provision production separately.
## Service image and deployment policy

`Build & Publish` runs after tests for every internal branch push. It calculates
the changed service components and rebuilds only those; the other components
are copied from the last known-good `edge` snapshot so every commit still gets
a complete immutable `sha-<full-commit>` image set.

A push in a fork runs tests but does not automatically publish images. For a
deployable dev snapshot from a feature branch, run **Build and publish**
manually in the upstream repository with `source_ref` naming a ref available
there; the published image prefix remains `ghcr.io/constructorfabric/studio-web`.

- A branch snapshot may be deployed to `dev` or `test`. In **Studio
  Delivery**, set the operation to **Deploy existing images**, select
  **Services**, set `source_ref` to the branch name or the full commit SHA, and
  leave `image_tag` empty; the workflow resolves the exact commit and its
  `sha-…` tag.

  Snapshots reached only `dev` until 2026-09-23. The rule was not protecting
  `test` from anything — `sha-<40 hex>` is as immutable as a release tag. What
  a release carries and a snapshot does not is *intent*, and test is where that
  decision gets made rather than confirmed, so requiring a tag first put the
  release before the thing it was a release of. Every deploy now writes its
  source and source kind into the run summary, which is how "what is on test"
  stays answerable.
- A stable release tag such as `v1.4.0` may be deployed to `dev` or `test` and
  advances `latest` only after all images are published.
- A prerelease tag such as `v1.4.0-rc.1` may also be deployed to `dev` or
  `test`, but never changes `latest`.
- `image_tag`, when supplied, must exactly match the resolved `source_ref`.
  This prevents deploying an image built from a different commit by mistake.
