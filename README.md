# Constructor Studio Web

> The server side of Constructor Studio — portal, backend, login and IDE sessions.

[![Studio Delivery](https://github.com/constructorfabric/studio-web/actions/workflows/studio-delivery.yml/badge.svg?branch=main)](https://github.com/constructorfabric/studio-web/actions/workflows/studio-delivery.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**Constructor Studio Web** is the runtime that hosts
[Constructor Studio](https://github.com/constructorfabric/studio) for a team:
a web portal where people organise their projects and repositories, a Rust
backend assembled from [Constructor Gears](https://github.com/constructorfabric/gears-rust),
Keycloak-based sign-in, and a Theia IDE session per workspace where the work
itself happens, with AI agents alongside. The same IDE also ships as a desktop
application that signs in to a Studio Web deployment.

This repository holds every component of that stack, the Docker Compose file
that runs it on one machine, and the Helm chart and pipeline that deploy it to
Kubernetes.

- [What it provides](#what-it-provides)
- [Architecture](#architecture)
- [Repository structure](#repository-structure)
- [Quick start](#quick-start)
- [Deployment](#deployment)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Contributing](#contributing) · [Security](#security) · [License](#license)

---

## What it provides

| For | What they get |
|---|---|
| **Engineers** | A browser IDE per workspace ("Open Studio"): sources cloned on first launch, Git, document editors, and Claude Code / Codex agents inside the session. Or the desktop Studio, which keeps the secrets on the server. |
| **Project administrators** | Organizations, workspaces and projects; members and roles; repository sources, connectors and secrets. |
| **Operators** | One Compose file for a laptop, one Helm chart for shared environments, and a single delivery workflow that builds immutable images and deploys them on request. |

Who the product is designed around, and what it deliberately is not, is in
[`PRODUCT.md`](PRODUCT.md); the full requirements are in the
[PRD](docs/prd/constructor-studio.md).

## Architecture

```
  Browser                                    Desktop
┌──────────────────────────┐            ┌──────────────────────────┐
│ Portal (studio-frontend) │            │ Desktop Studio           │
│ FrontX shell + MFEs      │            │ theia/electron-app       │
└─────────────┬────────────┘            └─────────────┬────────────┘
              │ REST · studio-events (SSE)            │ REST (Git and LLM proxied)
┌─────────────▼───────────────────────────────────────▼────────────┐
│ Backend (studio-backend) — one API gateway, /cf on :8090          │
│ assembled from gears: tenants · projects · sessions · documents · │
│ credentials · events · graph storage · LLM gateway · ...          │
└──────┬───────────────────────┬──────────────────────┬────────────┘
       │                       │                      │ launches
┌──────▼──────────────┐ ┌──────▼──────────┐ ┌─────────▼────────────┐
│ PostgreSQL 19       │ │ Keycloak        │ │ IDE session (theia/) │
│ gear databases +    │ │ realm "studio"  │ │ one per workspace —  │
│ graph_storage       │ │ OIDC sign-in    │ │ Docker or K8s Pod    │
└─────────────────────┘ └─────────────────┘ └──────────────────────┘
```

| Component | Role |
|---|---|
| **Portal** | The primary web UI, built on [FrontX](https://github.com/constructorfabric/gears-frontx). It talks to the backend through one contract ([ADR-0020](docs/adr/0020-one-contract-with-the-frontend.md)) and is told about background work over the `studio-events` push channel ([ADR-0026](docs/adr/0026-studio-events-push-channel.md)). |
| **Prototype portal** | The first portal: a workbench over the live API with a screen per gear, including the system view of gears and LLM upstreams. |
| **Backend** | A Gears host with almost no code of its own. Platform gears are linked in as crates from crates.io; Studio's own gears are modules of the one backend crate. Serves OpenAPI at `/cf/docs`. |
| **IDE session** | Eclipse Theia with the Studio extensions, launched by the backend per workspace ([ADR-0003](docs/adr/0003-theia-sessions.md)); it reaches the backend through the Theia bridge ([ADR-0022](docs/adr/0022-theia-backend-bridge.md)). |
| **Desktop Studio** | The same IDE as an Electron app. Credentials stay on the server and Git and LLM calls are proxied ([ADR-0027](docs/adr/0027-a-desktop-session-keeps-the-secrets-on-the-server.md)). |
| **PostgreSQL** | One server for every gear database and for `graph_storage`, which holds the domain model ([ADR-0024](docs/adr/0024-domain-model-in-graph-storage.md)). |
| **Keycloak** | Sign-in. An identity proves who you are and decides nothing else ([ADR-0018](docs/adr/0018-an-identity-proves-it-is-you-and-decides-nothing-else.md)); roles are Studio's ([ADR-0019](docs/adr/0019-a-role-narrows-what-a-member-may-do.md)). |

The full architecture — gears, storage, interfaces — is in the
[design document](docs/design/constructor-studio.md).

## Repository structure

```
studio-web/
├── studio-backend/             Rust backend: the Gears host, its config and Studio's gears (`src/`)
├── studio-frontend/            Portal: FrontX shell, microfrontends, packages, e2e tests
├── studio-frontend-prototype/  Prototype portal
├── theia/                      IDE: browser session image, desktop app, Studio extensions
├── keycloak/                   Keycloak image, "studio" realm, GitHub SSO
├── docker/keycloak/            Local TLS certificates for Compose
├── domain-model/               Rendered view of the domain model graph
├── deploy/                     Helm chart, environment values, K8s manifests, runbooks
├── scripts/                    Local gates, smoke tests, one-off migrations
├── docs/                       Specifications (PRD, design, features, ADRs) and contracts
├── docker-compose.yml          The full local stack, built from this checkout
└── docker-compose.published.yml  Override: run the images CI published instead
```

| If you want to… | Start with |
|---|---|
| run the whole stack locally | [Quick start](#quick-start) |
| work on the portal | [`studio-frontend/docs/stands.md`](studio-frontend/docs/stands.md) |
| work on the backend | [`studio-backend/README.md`](studio-backend/README.md) |
| add or change an endpoint or event | [`docs/api-conventions.md`](docs/api-conventions.md) |
| work on the IDE session | [`theia/README.md`](theia/README.md) |
| work on the desktop Studio | [`docs/desktop-contributing.md`](docs/desktop-contributing.md) |
| change sign-in | [`keycloak/README.md`](keycloak/README.md) |
| deploy or operate an environment | [`deploy/README.md`](deploy/README.md) |
| understand why something is the way it is | [`docs/adr/`](docs/adr/README.md) |

## Quick start

You need Docker Desktop or Docker Engine with Compose v2, network access to
GitHub (the backend build downloads pinned dependencies), and preferably the
GitHub CLI.

```bash
git clone https://github.com/constructorfabric/studio-web.git
cd studio-web

cp .env.example .env                 # every value is optional; never commit .env
export GITHUB_TOKEN=$(gh auth token) # the IDE image build calls api.github.com

docker compose up --build -d
docker compose ps
```

The first run takes a while: besides the backend and portal it builds the IDE
session image (about ten minutes) and seeds the root tenant on the empty
database. Both happen once; later `up`s reuse them.

| Service | Address |
|---|---|
| Portal | <http://localhost:8080> |
| Prototype portal | <http://localhost:8081> |
| Backend API and OpenAPI | <http://localhost:8090/cf/docs> |
| Keycloak | <https://localhost:8443> |
| PostgreSQL | `127.0.0.1:5433` |

Open <https://localhost:8443> once and accept the self-signed certificate, then
sign in to the portal as `admin` or `demo` with password `studio`. The Keycloak
console uses `admin` / `admin`. All of these are local development credentials.

```bash
docker compose logs -f backend   # follow the backend
docker compose down              # stop
docker compose down -v           # stop and delete the local database
```

### Configuration

[`.env.example`](.env.example) documents every variable. A blank value turns
its feature off with a clear message rather than breaking the stack.

| Capability | What to set |
|---|---|
| Ask AI, mini-chat, Codex agent | `STUDIO_LLM_API_KEY` (any OpenAI-compatible key) |
| Claude Code agent in sessions | `STUDIO_ANTHROPIC_API_KEY` |
| Secrets that survive a restart | `STUDIO_CREDSTORE_KEY` — generate once with `openssl rand -base64 32` and keep it; a new key makes stored values unreadable |
| A private session image from GHCR | `STUDIO_REGISTRY_USER`, `STUDIO_REGISTRY_TOKEN` (a PAT with `read:packages`) |
| Spec quality, Insight analytics | `STUDIO_SPEC_QUALITY_API_KEY`, `STUDIO_INSIGHT_API_KEY` |

S3 file storage is not provisioned by Compose; test the S3 path on a
Kubernetes environment ([`deploy/FILE_STORAGE_S3.md`](deploy/FILE_STORAGE_S3.md)).

### Running the published images

`docker-compose.published.yml` swaps every build for the image CI pushed, so you
can run exactly what a stand runs:

```bash
docker login ghcr.io   # a token with read:packages
docker compose -f docker-compose.yml -f docker-compose.published.yml pull
docker compose -f docker-compose.yml -f docker-compose.published.yml up -d --no-build
```

Pick the snapshot with `STUDIO_IMAGE_TAG`:

| Tag | What it is |
|---|---|
| `edge` (default) | The tip of `main`; moves on every push |
| `sha-<40-char-commit>` | One commit; never moves. Stands are deployed with these |
| `latest` | The last stable `v*` release — not the tip of `main` |

Keep `--no-build`: without it a missing tag is silently rebuilt from source
([why](#a-published-run-rebuilds-images)).

## Deployment

Kubernetes is the shared deployment mode. The Helm chart
([`deploy/helm/studio-web`](deploy/helm/studio-web)) and environment values
live in this repository, and GitHub Actions deploys them — there is no Argo CD
or separate infrastructure repository.

| Environment | Namespace | Hosts |
|---|---|---|
| Dev | `studio-dev` | `studio-dev.cfabric.org`, `studio-dev-poc.cfabric.org` |
| Test | `studio-test` | `studio-test.cfabric.org`, `studio-test-poc.cfabric.org` |

Everything goes through one workflow, **Studio Delivery**:

- **Every pull request and push** runs the tests of the components it touches.
  A push to this repository then publishes a complete immutable `sha-<commit>`
  image set, rebuilding only what changed. Forks run tests but never publish,
  and nothing deploys automatically.
- **Build, publish and deploy** does all three in one reviewed run for the
  selected services (`backend`, `frontend`, `prototype` or `all`) and
  environment; unchanged components keep the tags they run.
- **Deploy existing images** puts a `sha-<commit>` snapshot or a `v*` release on
  `dev` or `test`, or an `infra-v*` release of PostgreSQL, Keycloak and the
  other infrastructure.

Releases are tags pushed to this repository: `v*` for services, `infra-v*` for
infrastructure. The desktop Studio and the IDE extensions are released by
their own workflows under `desktop-v*`, `studio-cli-v*` and
`gearbox-engine-v*` ([Releases](https://github.com/constructorfabric/studio-web/releases)).

```bash
git tag v0.1.0 && git push origin v0.1.0              # a service release
git tag infra-v0.1.0 && git push origin infra-v0.1.0  # an infrastructure release
```

Each GitHub Environment deploys with the namespace-scoped `studio-deployer`
kubeconfig; never a cluster-admin one. The Secret contract, Helm values,
session RBAC and recovery procedures are in [`deploy/README.md`](deploy/README.md);
the promotion rules are in [`deploy/PIPELINES.md`](deploy/PIPELINES.md).

## Development

**Backend.** Run CI's backend gates before you open a pull request. They run in
CI's own image, so Docker is the only prerequisite — no Rust toolchain, linker
or Visual Studio Build Tools on the host:

```bash
scripts/backend-check.sh                      # fmt, clippy, build, features, test
scripts/backend-check.sh clippy               # one gate
scripts/backend-check.sh test studio_session  # a gate plus cargo arguments
```

**Portal.** `npm run dev:all` in `studio-frontend/` faces the shared `dev`
stand — its backend, data, Keycloak and IDE sessions — so you need no local
stack. `STUDIO_STAND=local npm run dev:all` points it at the Compose stack
instead, for a backend branch or when the stand is down
([`stands.md`](studio-frontend/docs/stands.md),
[ADR-0031](docs/adr/0031-the-portal-is-developed-against-a-shared-stand.md)).

**IDE.** Rebuild the session image with `docker compose build session-image`;
the desktop app has its own build and rules in
[`docs/desktop-studio.md`](docs/desktop-studio.md) and
[`docs/desktop-contributing.md`](docs/desktop-contributing.md).

**Contracts.** Every endpoint, event and error follows
[`docs/api-conventions.md`](docs/api-conventions.md),
[`docs/events-catalog.md`](docs/events-catalog.md) and
[`docs/errors-catalog.md`](docs/errors-catalog.md); a ratchet in CI holds the
portal to them. A decision that changes how the system works gets an
[ADR](docs/adr/README.md).

How to branch, sign off, test and get a change reviewed is in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Troubleshooting

### The backend never becomes healthy

`docker compose ps` shows which dependency it waits for, and
`docker compose logs -f backend` why. On an empty database the backend waits
for `backend-bootstrap` to seed the root tenant, and that waits for Keycloak to
finish importing its realm.

### Browser sign-in fails

Open <https://localhost:8443> and accept the self-signed certificate; the
portal cannot redirect to a Keycloak the browser does not trust yet.

### The session image build fails on GitHub's rate limit

The image resolves the Studio skill engine through `api.github.com`, whose
anonymous limit is 60 requests an hour per IP, and the build fails rather than
ship an empty CLI. `export GITHUB_TOKEN=$(gh auth token)` before building;
Compose passes it as a build secret, so it never lands in the image history.

### A session runs an old IDE

`docker compose up` builds `cf-studio-theia:local` only when the tag is
missing; it never refreshes it. Run `docker compose build session-image`, then
recreate the session — a running session keeps the image it started with.

### A published run rebuilds images

Compose keeps the base file's `build:` sections even when the override supplies
an `image:`, so without `--no-build` a tag that failed to pull is rebuilt from
source without a word. Run `pull` first and keep `--no-build`; a missing tag
then fails visibly. Published services use `pull_policy: always` because `edge`
moves: a three-day-old `edge` on your machine is not what `main` runs.

### Sessions cannot see their files

The backend and the session containers share `/srv/cf-studio-workspaces` on
the host, because the host Docker daemon creates the sessions. Change both
sides of that mount or neither.

## Documentation

| Area | Where |
|---|---|
| Documentation index | [`docs/README.md`](docs/README.md) |
| Product brief and requirements | [`PRODUCT.md`](PRODUCT.md), [`docs/prd/`](docs/prd/constructor-studio.md) |
| Architecture and decomposition | [`docs/design/`](docs/design/constructor-studio.md), [`docs/decomposition/`](docs/decomposition/constructor-studio.md) |
| Architecture decisions | [`docs/adr/`](docs/adr/README.md) |
| API, events, errors | [`api-conventions.md`](docs/api-conventions.md), [`events-catalog.md`](docs/events-catalog.md), [`errors-catalog.md`](docs/errors-catalog.md) |
| Push channel in the portal | [`studio-frontend/docs/studio-events.md`](studio-frontend/docs/studio-events.md) |
| Backend | [`studio-backend/README.md`](studio-backend/README.md) |
| IDE session | [`theia/README.md`](theia/README.md) |
| Desktop Studio | [`docs/desktop-studio.md`](docs/desktop-studio.md), [release notes](docs/desktop-release-notes.md) |
| Keycloak | [`keycloak/README.md`](keycloak/README.md) |
| Deployment and pipelines | [`deploy/README.md`](deploy/README.md), [`deploy/PIPELINES.md`](deploy/PIPELINES.md) |

## Contributing

Contributions follow the Constructor Fabric
[contribution baseline](https://github.com/constructorfabric/governance/blob/main/CONTRIBUTING.md):
fork, a focused pull request, every commit signed off under the
[DCO](https://github.com/constructorfabric/governance/blob/main/DCO.md). What is
specific to this repository — setup, checks, contracts, review — is in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Questions go to
[Discord](https://discord.gg/QWHtHGgEdq) or the repository's issues.

## Security

Do not report vulnerabilities in public issues. Use
[private vulnerability reporting](https://github.com/constructorfabric/studio-web/security/advisories/new);
see [`SECURITY.md`](SECURITY.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
Copyright 2026–present Constructor Fabric Foundation — see [`NOTICE`](NOTICE).
