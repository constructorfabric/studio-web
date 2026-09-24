# Constructor Studio Web

Constructor Studio Web is the web runtime for Constructor Studio: the Rust
backend, the primary FrontX portal, the prototype portal, Keycloak-based login,
and per-workspace Theia IDE sessions.

## Supported deployment modes

| Mode | Purpose | Entry point | Configuration |
|---|---|---|---|
| Docker Compose | Local development and functional checks on one machine | `http://localhost:8080` | [`.env.example`](.env.example), [`docker-compose.yml`](docker-compose.yml) |
| Kubernetes | Shared dev, test, and future production environments | Environment hostname | [`deploy/helm/studio-web`](deploy/helm/studio-web), [`deploy/README.md`](deploy/README.md) |

The two modes run the same logical stack, but use different runtime drivers:
Compose launches IDE containers through the local Docker daemon; Kubernetes
launches session Pods through the namespace-scoped Kubernetes driver.

## Local development with Docker Compose

### Prerequisites

- Docker Desktop or Docker Engine with Compose v2;
- access to GitHub while building the backend image (it downloads pinned Rust
  dependencies);
- optionally, a GitHub PAT with `read:packages` when launching Theia sessions
  from a private GHCR image.

Create local environment settings. Do not commit `.env`.

```bash
cp .env.example .env
```

Start the complete local stack:

```bash
docker compose up --build -d
docker compose ps
```

| Service | URL / port |
|---|---|
| Main portal | <http://localhost:8080> |
| Prototype portal | <http://localhost:8081> |
| Backend API and OpenAPI | <http://localhost:8090/cf/docs> |
| Keycloak / local admin console | <https://localhost:8443> |
| PostgreSQL | `127.0.0.1:5433` |

The Compose profile starts these services: `graph-postgres`, `keycloak`,
`backend-bootstrap`, `backend`, `frontend`, and `frontend-prototype`.

### Two ways to run it: your sources, or the published images

`docker-compose.yml` builds every service from this checkout. That is the
default and what `scripts/dev-up.sh` uses — it is how you see a change you
just made.

`docker-compose.published.yml` is an override that swaps those builds for the
images the pipeline pushed, so you can run what a stand runs:

```bash
docker login ghcr.io   # a token with read:packages; the registry is private
docker compose -f docker-compose.yml -f docker-compose.published.yml pull
docker compose -f docker-compose.yml -f docker-compose.published.yml up -d --no-build

# an exact snapshot rather than the rolling edge tag
STUDIO_IMAGE_TAG=sha-<40-char-commit> \
  docker compose -f docker-compose.yml -f docker-compose.published.yml up -d --no-build

# the last stable release, which is NOT the tip of main
STUDIO_IMAGE_TAG=latest \
  docker compose -f docker-compose.yml -f docker-compose.published.yml up -d --no-build
```

Every published service is pinned to `pull_policy: always`, because `edge` is a
moving tag: a copy pulled three days ago is still called `edge` on your machine,
and using it in silence is the opposite of running what the tip of `main` runs.

`edge` is the tip of `main`, moved by every push to it; `latest` is the last
stable release tag and moves only when one is cut, so it lags `main` by however
long it has been since — at the time of writing, six days. `sha-<commit>` is the
only tag that cannot move under you, and it is what a stand is deployed with.

Three things worth knowing before you trust either mode:

* **`--no-build` is not optional.** Compose keeps the base file's `build:`
  section even when an override supplies an `image:`, so a missing tag would
  be silently rebuilt from source — the opposite of the point. `pull` first;
  then a missing tag is a visible error.
* **The session image is built too.** The backend launches it through the host
  daemon rather than running it as a service, so nobody built it for you and it
  drifted behind the checkout — a session started on a three-hour-old tag whose
  panel offered agents that image did not carry. It is now the `session-image`
  service: `docker compose up` builds `cf-studio-theia:local` when that tag is
  missing, the backend waits for it, and the container it starts runs `true`
  and exits. Refresh it deliberately with `docker compose build session-image`
  (ten minutes — Theia's npm ci and bundle, plus the Orca package); `up` does
  not rebuild it, and neither does `scripts/dev-up.sh`. In published mode the
  override points that service at the same snapshot as the backend, so the
  dependency is a pull. Either way a *running* session keeps the image it
  started with — recreate the session to pick up a new one.
* **Export `GITHUB_TOKEN` before the first build.** The session image resolves
  the Constructor Studio skill engine through `api.github.com`, whose anonymous
  limit is 60/hour per IP, and the Dockerfile fails the build rather than ship a
  CLI with nothing behind it. `export GITHUB_TOKEN=$(gh auth token)` is enough;
  Compose passes it as a build secret, so it never lands in image history.
* **An empty database still needs `scripts/dev-up.sh` once.** The root tenant
  is seeded by `backend-bootstrap`, a `--no-default-features` build with no LLM
  chain and no published counterpart, so that one service builds from source in
  both modes.
`graph-postgres` is the single local PostgreSQL instance; it contains both the
application databases and `graph_storage`.

Open <https://localhost:8443> once and accept the local self-signed certificate
before using browser login. Sign in to the portal with Keycloak user
`admin` or `demo`, password `studio`. Keycloak administration uses
`admin` / `admin` and is only intended for local development.

Useful lifecycle commands:

```bash
docker compose logs -f backend
docker compose down
docker compose down -v  # removes local database data as well
```

### Optional local capabilities

| Capability | Local behaviour |
|---|---|
| LLM / Spec Quality | Add the corresponding keys to `.env`; blank keys leave those integrations unavailable without preventing the stack from starting. |
| Durable credential values | Set `STUDIO_CREDSTORE_KEY` once (`openssl rand -base64 32`). Changing it makes previously stored values unreadable. |
| Theia sessions | Build the expected local image before the first session, then set GHCR credentials in `.env` only if the selected image requires them. |
| S3 file storage | Not provisioned by Compose. Local Compose is not an S3 integration test; use the Kubernetes environment for the Virtuozzo S3 path. |

Build the image used by the current Compose session profile:

```bash
docker build -t cf-studio-theia:local ./theia
```

Compose mounts the Docker socket and `/srv/cf-studio-workspaces` into the
backend. Do not change only one side of that mount: session containers are
created by the host Docker daemon and require the same host path.

## Kubernetes deployment

Kubernetes is the supported shared deployment mode. The Helm chart and
environment values remain in this repository; deployment is performed through
GitHub Actions, not Argo CD or a separate infrastructure repository.

| Environment | Namespace | Public endpoints |
|---|---|---|
| Dev | `studio-dev` | `studio-dev.cfabric.org`, `studio-dev-poc.cfabric.org` |
| Test | `studio-test` | `studio-test.cfabric.org`, `studio-test-poc.cfabric.org` |

The exact Secret contract, Helm values, session RBAC bootstrap, S3 setup and
break-glass recovery procedure are documented in [`deploy/README.md`](deploy/README.md).
The CI/CD promotion rules are in [`deploy/PIPELINES.md`](deploy/PIPELINES.md).

Routine delivery flow:

1. Push a branch or merge to `main`. The single **Studio Delivery** workflow
   runs **Test changed components**, then **Build & Publish**, producing a
   complete immutable `sha-<commit>` image set while rebuilding only affected
   components. It never deploys automatically.
2. To publish and deploy in one reviewed run, choose **Build, publish and
   deploy**, select **Services** and the target environment. It tests first,
   publishes the changed components, then deploys those components while
   retaining the running tags for components that did not change. Alternatively,
   choose **Deploy existing images** and select **Services**, with `dev` or
   `test` and either a `sha-<commit>` snapshot or a published `v*` release.
   For a manual build of a specific commit, set `source_ref` to its full SHA:
   tests and change detection use that commit, and a Theia-only change updates
   the session image without replacing unchanged backend/frontend images.
3. For PostgreSQL, Keycloak, or other infrastructure changes, publish an
   `infra-v*` tag, then choose **Deploy existing images** and
   **Infrastructure** in **Studio Delivery**.

Do not use a cluster-admin kubeconfig in GitHub Actions. Each GitHub
Environment uses the namespace-scoped `studio-deployer` kubeconfig stored as
`KUBE_CONFIG_B64`.

## CI/CD

- **Studio Delivery** is the only user-facing Actions workflow. It runs tests
  for every pull request and push; a push then publishes images only after its
  tests succeed. Pull requests never publish or deploy.
- Manual operations are **Build and publish** (tests followed by a build),
  **Build, publish and deploy** (tests, changed-image publishing and a
  deployment in one run), and **Deploy existing images**. Deployment
  operations select **Services** or **Infrastructure**. Services can deploy
  `backend`, `frontend`, `prototype`, or `all`. Both SHA snapshots and release
  tags deploy to any configured environment; the run summary records which kind
  landed where. Infrastructure accepts only published `infra-v*` tags.

The backend's gates can be run before a pull request, in the image CI uses:

```bash
scripts/backend-check.sh            # fmt, clippy, build, features, test
scripts/backend-check.sh clippy     # one gate
scripts/backend-check.sh test studio_session   # a gate plus cargo args
```

It needs only Docker: the gates want a linker plus `protobuf-compiler` and
`cmake`, which on a Windows checkout would otherwise mean an administrator
install of Visual Studio Build Tools. CI stays the authority — it also runs a
gear-assembly smoke test — but a backend change once reached `main` without
compiling because CI was the only check and had not finished.

```bash
# service release
git tag v0.1.0
git push origin v0.1.0

# infrastructure release
git tag infra-v0.1.0
git push origin infra-v0.1.0
```

## Further documentation

- [`studio-backend/README.md`](studio-backend/README.md) — backend architecture
  and development.
- [`docs/api-conventions.md`](docs/api-conventions.md) — the rules every REST
  operation and every published event follows, and how they are enforced. Read
  this before adding an endpoint.
- [`docs/events-catalog.md`](docs/events-catalog.md) — the `studio-events`
  vocabulary: every `subject_type` and `kind` a consumer may rely on.
- [`docs/errors-catalog.md`](docs/errors-catalog.md) — the error contract: the
  sixteen canonical categories, what a screen may read from one, and why it
  branches on `type` rather than on the HTTP status.
- [`docs/adr/0020-one-contract-with-the-frontend.md`](docs/adr/0020-one-contract-with-the-frontend.md)
  — why the contract is enforced by a ratchet rather than by review.
- [`studio-frontend/docs/studio-events.md`](studio-frontend/docs/studio-events.md)
  — consuming the push channel from the portal: how a screen is told that
  background work finished instead of polling for it.
- [`docs/adr/0026-studio-events-push-channel.md`](docs/adr/0026-studio-events-push-channel.md)
  — the channel itself, and why the Theia protocol is not its contract.
- [`docs/adr/0003-theia-sessions.md`](docs/adr/0003-theia-sessions.md)
  — IDE session model.
- [`theia/README.md`](theia/README.md) — Theia image and IDE customisation.
- [`docs/desktop-studio.md`](docs/desktop-studio.md) — the desktop Studio:
  which Studios it connects to, what a stand needs, and how to build the
  installer.
- [`keycloak/README.md`](keycloak/README.md) — Keycloak image and realm setup.
- [`deploy/README.md`](deploy/README.md) — Kubernetes prerequisites and
  operations.
