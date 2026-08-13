# studio-web

Constructor Studio web server — backend, frontend, installer.

| Project | What | Stack |
|---|---|---|
| [`studio-backend/`](studio-backend/) | Studio API service assembled from [CF/Gears](https://github.com/constructorfabric/gears-rust): multi-tenancy, users, groups. REST + OpenAPI at `/cf/docs`. | Rust (axum/tokio/sea-orm via gears) |
| [`studio-frontend/`](studio-frontend/) | Portal UI — being rebuilt on FrontX (shell + microfrontends, ADR-0006). | React 19 + TS via FrontX templates |
| [`studio-frontend-prototype/`](studio-frontend-prototype/) | The current portal SPA, moved aside for the FrontX rebuild; still what compose serves. | Vite + React 19 + TS, vitest |

## Quick start

**One click (Docker):** everything — Postgres, backend built from source, frontend on nginx:

```bash
docker compose up --build -d
# portal:   http://localhost:8080    (sign in: studio-admin-token)
# API/docs: http://localhost:8090/cf/docs
```

Requires Docker (Desktop with WSL integration is fine) and a `gears-rust` checkout as a
sibling of this repo. The first build compiles the whole gears workspace — grab a
coffee; rebuilds are cached. Stop with `docker compose down` (add `-v` to wipe data).

**Daily dev (fast iteration):** infra in Docker, backend on the host (WSL), frontend via Vite:

```bash
docker compose up -d postgres keycloak          # once

# Environment (put these in your shell profile / a sourced env file):
export STUDIO_PG_PASSWORD=<compose postgres password>
export STUDIO_LLM_API_KEY=<LLM provider key>          # AI chats + in-IDE Theia AI
                                                      # free default: Groq — console.groq.com → API Keys
export STUDIO_REGISTRY_USER=<your github login>       # pulls the IDE image from ghcr
export STUDIO_REGISTRY_TOKEN=<PAT with read:packages> # (Docker API ignores `docker login`)

cd studio-backend && cargo run -- --config config/oidc.yaml run       # WSL
cd studio-frontend && npm install && npm run dev      # http://localhost:5173
```

Sign in with SSO (`admin`/`studio`) — see "OIDC login" below for the one-time
self-signed-cert step. Static-token profiles remain for scripts:
`config/postgres.yaml` (Postgres) and `config/dev.yaml` (zero-Docker, SQLite).

Secrets self-heal on every boot (`studio-secrets-bootstrap` gear): the LLM key
is re-seeded into credstore automatically — no manual curls after restarts.
Switching the LLM provider is env-only: `STUDIO_LLM_BASE_URL`,
`STUDIO_LLM_MODEL` (Theia AI proxy) and `STUDIO_LLM_HOST` (mini-chat/OAGW)
override the Groq defaults; any OpenAI-compatible endpoint works.

## Theia IDE sessions (Open Studio)

"Open Studio" launches a dedicated Theia IDE container per workspace via the
`studio-session` gear (our first own gear — see
`studio-backend/docs/adr/0003-theia-sessions.md`).

No local image build needed: CI publishes the IDE image on every `fabric-poc`
push touching `poc/theia/**` (workflow `theia-image.yml`), and the gear pulls
and refreshes it automatically:

- image: `ghcr.io/constructorfabric/fabric-poc/cf-studio-theia:edge`
- auth: the package is private — set `STUDIO_REGISTRY_USER` /
  `STUDIO_REGISTRY_TOKEN` (PAT with `read:packages`) before starting the
  backend. `docker login` alone is NOT enough: the gear talks to the Docker
  API directly, which ignores the CLI credential store.
- freshness: `always_pull: true` re-pulls the mutable `edge` tag on every
  launch; a failed pull falls back to the local copy (offline-friendly).
- hacking on the image locally: `cd ../fabric-poc/poc/theia && docker build
  -t cf-studio-theia:latest .`, then in the config set
  `image: cf-studio-theia:latest` + `always_pull: false`.

In the portal: workspace → Open Studio → Launch. Optional Git URL is
cloned into the workspace on first launch. Sessions bind to loopback ports
41000-41099, live 4 h (reaper), survive backend restarts (label adoption),
and can be stopped from the launcher. Inside the IDE, Theia AI (chat with
@Universal/@Coder agents, inline completion) is configured automatically by
the portal bridge through the backend's `studio-llm-proxy` — the provider
key never enters the container.

Requirements: Docker daemon reachable from the backend (`/var/run/docker.sock`).
In the full-docker profile the compose file mounts the socket and
`/srv/cf-studio-workspaces` into the backend (host and container paths must be
identical — bind sources are resolved by the host daemon).

## OIDC login (real sign-in)

The static dev tokens stay for scripts and quick starts; real browser login
uses the `oidc-authn-plugin` gear against a Keycloak shipped in compose.

```bash
docker compose up -d postgres keycloak
cd studio-backend && cargo run -- --config config/oidc.yaml run
```

Then in the portal press "Sign in with SSO" — users `admin` / `demo`
(password `studio`). Dev Keycloak runs self-signed TLS on
<https://localhost:8443>: open that URL once and accept the certificate
before the first login. Admin console: same URL, `admin`/`admin`.

Sessions renew silently: the refresh token is kept in `sessionStorage` and
used to mint a new access token a minute before expiry, after any 401, and on
page load — so a reload keeps you signed in and the hourly access-token expiry
is invisible. Sign out (or closing the tab) drops it.

How it fits together: the portal does Authorization Code + PKCE
(`src/oidc.ts`, no dependencies), Keycloak issues a JWT whose `sub` is the
user UUID and whose `tenant_id` claim (from a user attribute, see
`docker/keycloak/realm-studio.json`) is the home tenant UUID; the
`oidc-authn-plugin` validates it via discovery/JWKS (the dev CA is trusted
through `http_client.custom_ca_certificate_paths`) and maps claims into the
platform SecurityContext. mini-chat's background S2S goes through the same
realm (`s2s_oauth`, confidential client `mini-chat`).

### Cloning from a self-hosted GitLab (or GitHub Enterprise)

The GitHub/GitLab chips compose `github.com` / `gitlab.com` URLs. For a
self-hosted host use the **Git URL** source with the full HTTPS clone URL and
a PAT:

| Field | Value |
|---|---|
| name | `csh_hypotheses_back` (becomes the directory) |
| source | **Git URL** |
| url | `https://gitlab.constr.dev/hypotheses/csh_hypotheses_back.git` |
| PAT | a GitLab personal access token with the `read_repository` scope |
| mount at | optional — e.g. `.workspace-sources/hypotheses/csh_hypotheses_back` to match a CLI-created workspace layout |

**The workspace root can be a repository too.** A Studio workspace created by
the CLI *is* a git repo (manifest, docs, `.workspace-sources/`). Put its clone
URL in the dashboard's **Workspace root** field (plus a PAT and branch if
needed) and the session clones it on first launch — nothing has to exist on
the backend host. Sources then clone into it, and because CLI workspaces
gitignore `.workspace-sources/`, the root repo stays clean. The local-folder
field remains as the alternative and takes precedence when both are set.

HTTPS, not SSH: the session container has no SSH key or agent, while a PAT
travels as a credstore secret reference and is injected into the clone through
an inline credential helper (never written to `.git/config`). If the workspace
manifest lists `git@…` SSH remotes (as CLI-created ones do), the portal's
HTTPS source is what actually materializes the working copy; the manifest entry
stays untouched.

### Using your own IdP (Keycloak, Azure AD, Auth0, …)

1. Create a **public client** with **PKCE (S256)**, redirect URI
   `http://localhost:5173/*` (or your portal origin) and matching web origin.
2. Tokens must carry: UUID `sub`, and a `tenant_id` claim with the user's
   home-tenant UUID (custom claim/attribute mapper). Adjust
   `jwt.claim_mapping` in `config/oidc.yaml` if your claim names differ.
3. Point `jwt.trusted_issuers` (and `s2s_oauth.discovery_url`, if used) at
   your issuer URL — https required; add your corporate root CA via
   `http_client.custom_ca_certificate_paths` when it is not in system roots.
4. Frontend: set `VITE_OIDC_ISSUER` and `VITE_OIDC_CLIENT_ID`.

## CI/CD (GitHub Actions)

- **`ci.yml`** — on push/PR, path-filtered: backend (fmt, clippy `-D warnings`, build, test, `--list-gears` smoke) and frontend (test, build). The backend job checks out `constructorfabric/gears-rust` next to the repo — path dependencies expect `../../gears-rust`; add a `GEARS_RUST_TOKEN` secret if that repo is private. DCO is enforced — commit with `-s`.
- **`release.yml`** — on tag `v*`: release binary + frontend dist → GitHub Release; Docker images → `ghcr.io/constructorfabric/studio-web/studio-{backend,frontend}`; then a `deploy` job gated by the `production` environment.
- **Theia IDE image** — built in `fabric-poc` (`theia-image.yml`): `edge` on main pushes touching `poc/theia/**`, `vX.Y.Z` on `theia-v*` tags.

Release: `git tag v0.1.0 && git push origin v0.1.0`.

## Deploying to Kubernetes

Chart in `deploy/helm/studio-web` (rendered/linted against the dmz values),
environment values + pipeline in GitLab `constructorfabric/studio-web-ci`
(Pattern B: clone the mirror → Trivy → mirror images to Harbor → helm).
The Secret contract and prerequisites live in
`deploy/helm/values-dmz.example.yaml` and `deploy/README.md`. Cluster v1
runs with IDE sessions disabled (`studio-session.enabled=false` in
`config/k8s.yaml`) until the per-session Pod driver lands (ADR-0003).
