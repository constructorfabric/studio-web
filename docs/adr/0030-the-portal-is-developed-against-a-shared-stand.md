---
type: adr
status: accepted
date: 2026-09-25
---

# ADR-0030: The portal is developed against a shared stand, and the stack on the machine is one switch away

**ID**: `cpt-studio-adr-the-portal-is-developed-against-a-shared-stand`

Status: accepted · 2026-09-25 · Builds on ADR-0021 and ADR-0029 · Branch `feature/dev-stand-switch`

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Decision Outcome](#decision-outcome)
  - [The dev server stands in for the container](#the-dev-server-stands-in-for-the-container)
  - [One variable names the stand](#one-variable-names-the-stand)
  - [The IDE frame comes through the proxy, with the stand's origin](#the-ide-frame-comes-through-the-proxy-with-the-stands-origin)
  - [The sign-in is the stand's](#the-sign-in-is-the-stands)
  - [What this does to the end-to-end suite](#what-this-does-to-the-end-to-end-suite)
  - [The data is real](#the-data-is-real)
  - [Considered and rejected](#considered-and-rejected)
  - [Consequences](#consequences)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

Working on the portal has meant running the whole product on the machine
first. `docker compose up --build` brings up PostgreSQL, Keycloak, the backend
and its bootstrap, the session image — ten minutes of Theia's `npm ci` the
first time — and then the portal, and only then does `npm run dev:all` have
something to talk to. On this team's machines that has come with its own
weather: the backend hanging on ONNX until `STUDIO_EMBEDDING_PROVIDER=fake`
is set, published images that are `amd64` only, a `/srv` bind Docker Desktop
refuses, a `GITHUB_TOKEN` the session image needs before it builds. None of
that is portal work, and all of it stands between a frontend change and the
screen that shows it.

The portal itself does not care where its backend is. Every call goes to a
same-origin path — `/cf/*` for the gateway, `/studio/{id}/` for an IDE session
(ADR-0021) — and the only address it knows is the IdP's, read at start from
`window.__STUDIO_ENV__`. That is what lets one image serve every stand: nginx
carries the paths to `BACKEND_HOST`, and `docker/10-runtime-env.sh` writes the
issuer into `/env.js` at container start. The dev server already has half of
this — Vite proxies `/cf` to `STUDIO_BACKEND_URL` — and has never had the
other half, so in development the issuer falls back to the compose stack's
`https://localhost:8443` and the backend to `127.0.0.1:8090`.

Frontend and backend have agreed that local development of the portal runs
against the `dev` stand — its backend, its data, its Keycloak, its IDE
sessions — and that the compose stack remains what CI tests against
(ADR-0029) and what backend work runs on. What is missing is the switch: a
way for the dev server to face a stand, and a way to turn it back to the
machine when a branch of the backend needs to be seen, when the stand is down,
or when the end-to-end suite runs.

## Decision Outcome

### The dev server stands in for the container

What nginx and `10-runtime-env.sh` do for a deployed portal, Vite does for a
developing one. `vite.config.ts` proxies `/cf` and `/studio` to the chosen
stand, and serves `/env.js` from a small plugin with the stand's
`OIDC_ISSUER` and `OIDC_CLIENT_ID` — the same `window.__STUDIO_ENV__` a
container writes, read by the same `src-app/app/config/env.ts`. The
application code does not change, and neither does `scripts/dev-all.ts`: the
variable passes through the environment to the `vite` it spawns. `public/env.js`
stays as the empty placeholder `vite build` ships, for the container to
overwrite.

### One variable names the stand

`STUDIO_STAND` is `dev`, `test` or `local`; `dev` when unset. The three are a
table in `scripts/lib/stands.ts` — a URL to proxy to, a realm to sign in
against, a client id — and the table mirrors `theia/electron-app/environments.json`,
which is the desktop's list of the same Studios (ADR-0027). `local` is the
compose stack's two published ports, `127.0.0.1:8090` and `localhost:8443`,
and those are also the ports a backend started with `cargo run` and
`docker compose up keycloak` answers on, so the backend handover's recipe is
this switch too.

Any single value can be replaced with the variable the container knows it by
— `STUDIO_BACKEND_URL`, `STUDIO_OIDC_ISSUER`, `STUDIO_OIDC_CLIENT_ID` — so a
backend on another port or a realm on another host needs no fourth stand.
Vite reads all four from the shell and from `.env` / `.env.local` next to its
config, which is where a person who lives on `local` for a week keeps the
choice; `envPrefix` stays `VITE_`, so none of it reaches the bundle. An
unknown name fails at config load, naming the known ones, rather than
bringing a dev server up pointed at nothing.

### The IDE frame comes through the proxy, with the stand's origin

The address the portal frames is relative, `/studio/{id}/?token=…` (the
session gear writes it, `nginx.conf.template` and the backend's own proxy
carry it), so the frame loads from the dev server and Theia opens its
WebSocket there too. The proxy carries both to the stand with `ws: true`.

A session pod admits only its own origin: `isOriginAllowed` in
`theia/studio/src/node/studio-runtime-config.ts` compares the request's
`Origin` with its `Host`, and the backend proxy forwards both as they came.
On a stand they agree because nginx sends them from the same hostname; from a
dev server they would not — `Host` is rewritten to the stand's by
`changeOrigin`, `Origin` would still say `http://localhost:5173` — and the
socket would be refused. The `/studio` proxy therefore presents the stand's
origin in `Origin`. It is the dev server telling the pod what nginx would
have told it, on the one path where the pod asks.

### The sign-in is the stand's

The browser signs in against the stand's realm, through GitHub as everybody
on the stand does, and is sent back to `http://localhost:5173/`. That takes
two settings on the `studio-portal` client, not one. The address is a
*redirect URI* the client has to list, or the IdP refuses the sign-in. And
the code exchange that follows is a cross-origin `POST` from the dev server's
origin to the token endpoint, which Keycloak answers with CORS headers only
for an origin the client lists as a *web origin* — for any other it answers
`403` with no headers at all, and the browser blocks the exchange. A preflight
is no evidence either way: Keycloak answers `OPTIONS` for any origin.
`keycloak/realm-studio.json` lists both, for `localhost` and `127.0.0.1`, on
`5173` and `8080`. But a deployed realm is not that file:
`keycloak/README.md` has each environment generate its own and mount it from
a Secret, and Keycloak imports it once, on first boot. At the time of writing
`dev` and `test` list the redirect URIs (added on 2026-09-25) and not yet the
web origins: the sign-in gets as far as the code and stops on the exchange.
Adding `http://localhost:5173` and `http://127.0.0.1:5173` there is an
administrator's change to the stand's realm, and this decision waits for it
before it is worth anything; nothing in this repository can make it.

### What this does to the end-to-end suite

ADR-0029 keyed the suite's seeded defaults, `demo/studio`, off `localhost`, and
recorded that this would stop being right the day `localhost` meant a stand's
backend. That day is this one. The defaults now belong to the compose stack's
own portal on `localhost:8080` and to nothing else; a portal on `localhost:5173`
is the dev server facing whatever `STUDIO_STAND` chose, and it comes with no
defaults — `E2E_USER` and `E2E_PASSWORD` are named, `demo/studio` when the
stand is `local`. `ignoreHTTPSErrors` stays keyed off `localhost`: it exists
for the compose stack's self-signed Keycloak and does nothing against a valid
certificate. The suite against a stand's realm still waits for the `e2e`
account ADR-0029 deferred.

### The data is real

A portal on `dev` shows what the team on `dev` sees, and a project created
from it stays there. That is the point — the screens are exercised against
the shape of real data rather than a seeded root tenant — and it is also the
rule: nothing destructive is tried out on `dev` for the sake of a screen;
`test` is one switch away, and so is `local`, whose data is nobody's.

### Considered and rejected

- **Vite modes** (`vite --mode local`, with a tracked `.env.local`-style file
  per stand). Idiomatic, and rejected for two things a variable does not
  suffer from: a mode cannot be kept in an env file, so the person on `local`
  types it every time, and `--mode test` would load `.env.test`, which is
  Vitest's mode as well.
- **`VITE_OIDC_ISSUER` in tracked `.env` files.** The build-time fallback
  `env.ts` already reads. It puts a stand into the bundle rather than beside
  it, which is the opposite of what the runtime `/env.js` is for, and it
  would leave two mechanisms for one value.
- **CORS on the backend, and the portal calling the stand directly.** No proxy
  at all. It would turn every stand's gateway into a cross-origin API for
  whoever lists an origin, change the backend for the sake of a dev server,
  and leave the IDE frame — which the backend proxies on purpose — with
  nowhere to go.
- **A portal container pointed at the stand** (`STUDIO_BACKEND_URL` into the
  published image). Runs the built portal, not the one being edited; there is
  no hot reload in nginx.
- **A realm client per developer.** Nothing to gain over four URIs on the one
  client the stands already have.

### Consequences

- **The compose stack is no longer a prerequisite for portal work.** Node,
  `npm ci`, `npm run dev:all`, sign in with GitHub. The stack is still what
  backend work and the CI gate run on, and `STUDIO_STAND=local` is the way
  back to it.
- **Nothing works until the realm on `dev` lists the dev server, as a
  redirect URI and as a web origin.** Both are an administrator's change, on
  the stand, outside this repository. Until both land, the sign-in stops at
  one of the two — the IdP's `Invalid parameter: redirect_uri`, or a code
  exchange the browser blocks for CORS — and `STUDIO_STAND=local` is the way
  to work meanwhile.
- **A stand's outage is a local outage.** When `dev` is down or mid-deploy,
  so is the portal on every developer's machine — for as long as it takes to
  switch to `test` or `local`.
- **The end-to-end suite has one fewer default.** `E2E_BASE_URL=http://localhost:5173`
  needs credentials, whichever stand is behind it; `localhost:8080` keeps
  `demo/studio`. CI is unaffected — it runs the compose portal on `8080`.
- **A dev server's `Origin` is rewritten on one path.** Only `/studio`, only
  to the stand's origin, and only because the session pod checks it. `/cf`
  carries the browser's own headers, and the backend does not look.
- The switch has its own unit test (`__tests__/stands.test.ts`) and rides the
  `type-check:package:test` project; `vite.config.ts` resolves a stand only
  when serving, so `vite build` in the image build reads no `STUDIO_*`.
- `studio-frontend/docs/stands.md` is the operating note; `README.md`,
  `QUICK_START.md` and `e2e/README.md` point at it.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-fr-deploy-compose` — the compose stack stops being where portal work happens and stays the CI test bed and the backend's local run
* `cpt-studio-component-portal-shell` — the shell is developed against the same runtime contract it is deployed with: same-origin paths and a runtime `/env.js`
* `cpt-studio-component-deployment` — the dev server reproduces what nginx and the container entrypoint do, so development and deployment share one topology
* `cpt-studio-adr-an-mfe-entry-may-be-a-frame` — the IDE frame's relative address is carried to the stand, with the origin the session pod expects
* `cpt-studio-adr-end-to-end-tests-are-few-and-do-not-know-where-they-run` — the seeded defaults follow the compose portal, as that record said they would have to
* `cpt-studio-adr-a-desktop-session-keeps-the-secrets-on-the-server` — the stand table is the desktop's environment list, kept in step
