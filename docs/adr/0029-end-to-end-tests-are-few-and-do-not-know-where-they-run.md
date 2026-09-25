---
type: adr
status: accepted
date: 2026-09-25
---

# ADR-0029: End-to-end tests are few, and they do not know where they run

**ID**: `cpt-studio-adr-end-to-end-tests-are-few-and-do-not-know-where-they-run`

Status: accepted · 2026-09-25 · Builds on ADR-0021 · Relates to ADR-0011 and ADR-0028 · Branch `feature/e2e-playwright-suite`

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Decision Outcome](#decision-outcome)
  - [One runner, and it is the one already here](#one-runner-and-it-is-the-one-already-here)
  - [There are few of them, and the bar for a new one is stated](#there-are-few-of-them-and-the-bar-for-a-new-one-is-stated)
  - [A spec never knows where it runs](#a-spec-never-knows-where-it-runs)
  - [Where the suite runs, and when](#where-the-suite-runs-and-when)
  - [Shared stands keep their data](#shared-stands-keep-their-data)
  - [What carries a session between tests, and what does not](#what-carries-a-session-between-tests-and-what-does-not)
  - [The login step uses Keycloak's ids](#the-login-step-uses-keycloaks-ids)
  - [Where it lives](#where-it-lives)
  - [Considered and rejected](#considered-and-rejected)
  - [Consequences](#consequences)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

`studio-frontend` carries about 145 Vitest files and not one of them opens a
browser. That is the right shape for most of what they check — a reducer, a
hook, a screen rendered into jsdom — and the wrong shape for the three things
the portal is actually made of at runtime.

**The sign-in.** `AuthGate` hands the browser to Keycloak and takes it back
with a code. Unit tests mock the auth runtime on both sides of that redirect,
so nothing in the suite has ever performed one against a realm.

**The mount.** Every product screen is a Module Federation remote loaded into a
shadow root by `DefaultMountManager`. The contract tests in `src-app/app/mfe/`
prove that the shell and a package agree on paper; whether a built remote
actually arrives, resolves its shared dependencies and paints inside the root is
established today by somebody opening the portal.

**The frame.** ADR-0021 puts the Theia editor into an `iframe` whose address is
served by the session gate on its own origin and arrives at runtime through a
shared property. That is cross-origin by construction, and jsdom does not
render frames at all.

The delivery pipeline stops one step short of these. `scripts/post-deploy-smoke.sh`
runs after every deploy and asserts headers, compression and the IdP discovery
document, and says of itself: *"It is deliberately unauthenticated, so it
covers no business behaviour. An authenticated smoke test needs a service
account nobody has created yet."*

Three more facts shape what can be done about it.

The `theia/` tree already depends on `@playwright/test` (1.63.0 resolved) and
keeps two specs under `theia/tests/e2e/`.

The environments are not symmetrical. The compose stack answers on
`http://localhost:8080` with a realm imported from
`docker/keycloak/realm-studio.json` and two seeded password users; `dev` and
`test` are shared stands at `studio-dev.cfabric.org` and
`studio-test.cfabric.org` whose people sign in through GitHub SSO; production
does not exist yet (`deploy/PIPELINES.md`: *"Design and provision production
separately"*).

And the compose stack is about to stop being where frontend work happens.
Frontend and backend have agreed that local development runs the portal
against the `dev` stand's backend instead of a stack of containers — the Vite
proxy already takes `STUDIO_BACKEND_URL`, and the stand realm's `studio-portal`
client already whitelists `localhost` — with the move as its own task. A
developer's machine will usually have no backend of its own, and a suite that
assumed one would be a suite nobody runs.

## Decision Outcome

### One runner, and it is the one already here

The portal's end-to-end tests are written with Playwright, pinned to the exact
version `theia/` resolves so the repository drives browsers with one tool.
Three properties of the runtime decide this, and each of them is a place where
the obvious alternative would be fought rather than used.

- *The frame is cross-origin.* Playwright drives the browser from outside the
  page, so `page.frameLocator(...)` reaches into a frame from another origin
  exactly as it reaches into one from the same origin. An in-page runner
  cannot, without plugins and caveats, and the most important scenario this
  suite will ever hold is inside that frame.
- *The shadow roots are open.* `attachShadow({ mode: 'open' })` precedes every
  handler branch in the mount manager, and Playwright locators pierce open
  shadow roots by default. Nothing is configured, and nothing has to be
  remembered per call.
- *The editor ships page objects.* `@theia/playwright` exists for the same
  runner, so the scenario inside the frame does not start from the DOM.

One browser project, Chromium. This is not a compatibility matrix; it is a
check that the product works.

### There are few of them, and the bar for a new one is stated

A scenario belongs here when its failure means that *nobody can do the thing*.
A component that renders the wrong label is a Vitest failure next to the
component; a portal nobody can sign in to is an end-to-end failure. The initial
set, in the order they become possible:

1. A user signs in through Keycloak and reaches the portal shell.
2. A member opens a project by its address (ADR-0028) and its screen — a
   Module Federation remote — mounts inside the shadow root.
3. The Theia frame comes up inside the project area and shows a workbench.
4. One round trip through the Theia bridge (ADR-0022), once it exists.

Anything a unit or component test can establish is refused here, whatever its
importance. The suite stays small enough to run after every deploy and to be
read in one sitting.

### A spec never knows where it runs

Every difference between stands enters through three variables read once in
`e2e/support/env.ts` — `E2E_BASE_URL`, `E2E_USER`, `E2E_PASSWORD` — and the
specs see only a `baseURL` and a credential pair. The defaults are the compose
stack's `demo/studio`, and they are defaults only there: away from `localhost`
a missing credential fails at config load with a message that names the stand,
not as a login form that times out.

The default address is `http://localhost:8080` rather than `127.0.0.1` or the
Vite port because the realm's `studio-portal` client whitelists exactly those
redirect URIs; a stand chosen by hostname is also a stand chosen by what the
realm will send the browser back to.

`ignoreHTTPSErrors` is set only for the compose stack, whose Keycloak presents
a self-signed certificate on `:8443`. A stand must present a valid one, and
accepting any certificate there would hide the one failure a smoke run after a
deploy is for.

The Theia frame's address is never in a test. ADR-0021 has it arrive at runtime
through a shared property, so a scenario finds the frame in the project area
and waits for the workbench inside it; it is stand-agnostic without any effort
of its own.

### Where the suite runs, and when

**In CI, on the compose stack, when a merge reaches `main`.** The backend runs
in a container beside a fresh database and the seeded realm: nothing is shared
with anybody and nothing is borrowed from a stand, so a red run means the
merge and not the weather. This is the one place the suite is a gate. It runs
on the published `sha-<commit>` snapshot through `docker-compose.published.yml`
after `build-service-images`, so nothing is rebuilt for it — the database
bootstrap included, which is the published backend image running
`bootstrap --apply`, as it does on a stand, and the graph database, which is
the newest infrastructure release rather than part of a services snapshot
(the published override says why). `docker-compose.ci.yml`, layered last,
holds the three departures from the published stack and their reasons. A
failure blocks `build-complete`, and with it any deploy of that snapshot, and
the `edge` promotion is moved to follow it — today `edge` moves inside
`build-service-images`, before anything has opened a browser.

It does not run on every pull request. The pipeline's own note on
`test-complete` puts a runner as the scarcest thing it has, with a deploy
measured queueing two hours behind two `echo` jobs, and the stack costs minutes
to pull and bring up on top of that. A pull request keeps the gates it has —
unit, contract and type checks — and the merge is what the browser proves.
The cost is stated under Consequences: a break is found on `main`, after the
fact.

**On a developer's machine, against whatever backend the machine has.** Once
local development runs against the `dev` backend, the usual local run is the
portal on `localhost` with the stand's realm behind it, and the credentials are
the stand's `e2e` account, given explicitly. The `demo/studio` defaults belong
to the compose stack; `env.ts` keys them off `localhost` today, which is right
while `localhost` means compose and stops being right the day it means the
`dev` backend — the transition task changes the rule to *default only when the
issuer is local too*. Whoever still has the compose stack up runs the suite
against it exactly as CI does.

**As a smoke, on `dev` and `test`, after a deploy — deferred.**
`E2E_BASE_URL=https://studio-dev.cfabric.org`, run from the *Verify rollout and
public endpoints* step immediately after `post-deploy-smoke.sh`. Helm has
already rolled back a failed rollout by then; this answers the question the
curl script declines to: can a person sign in and open something. It sees a
class of failure the CI gate cannot — the runtime environment the image is
started with, the stand's own realm and its `/auth/` path, the ingress in
front of both, a migration meeting real data — because none of that exists on
the compose stack.

It is deferred, not dropped. In code it costs the suite nothing — one step in
the deploy job — but its prerequisite is operational: the account the smoke
script says nobody has created, a **realm-local user with a password** on
each stand, never an SSO identity, because there is no automating a GitHub
login, with its credentials in the GitHub Environment as `E2E_USER` /
`E2E_PASSWORD` beside the `FILE_STORAGE_S3_*` secrets that already live there.
The step is taken up once that account exists and deploys are frequent enough
for "it rolled out, and nobody can sign in" to be worth a browser after every
one. Until then `post-deploy-smoke.sh` is the whole of what runs after a
deploy.

**Read-only, on production, when there is one.** Every scenario carries a tag
from the day it is written: `@readonly` may run anywhere; `@mutating` creates
data and may not run where people keep theirs. Production runs
`--grep @readonly`. The decision of what production may be subjected to is made
once, in the tag, and not again at every run.

### Shared stands keep their data

`dev` and `test` are used by people. Read-only scenarios look at a permanent
fixture project, `e2e-fixture`, created by hand once per stand. A mutating
scenario names what it creates `e2e-<runId>-…` and removes it afterwards; when
the removal fails the prefix says what may be swept up. The bulk of the
checking stays on the compose stack in CI, where the data is nobody's.

### What carries a session between tests, and what does not

The portal keeps the access token in memory and the refresh token in
`sessionStorage` (`keycloakOidcProvider.ts`), and Playwright's `storageState`
captures cookies and `localStorage` but not `sessionStorage`. What does carry
across tests is Keycloak's own SSO cookie on the IdP origin. A setup project
that signs in once and saves `storageState` therefore works — the next test
clicks *Continue with Constructor ID*, the IdP recognises the cookie and sends
the browser straight back with a code, and no form is shown. That pattern is
adopted when the second authenticated scenario lands; the first scenario *is*
the sign-in and gains nothing from skipping it.

### The login step uses Keycloak's ids

`#username`, `#password` and `#kc-login` are the form ids Keycloak's built-in
login themes have carried across versions and locales; the label text beside
them changes with both. The realm declares no `loginTheme`. The helper waits
for the authorization endpoint before filling anything and, after submitting,
waits for the browser to *leave* the IdP origin — a rejected password stays
there, and the failure is then named as a credential problem rather than
surfacing as a portal landmark that never appeared.

### Where it lives

`studio-frontend/e2e/` with its own `playwright.config.ts` and `tsconfig.json`,
deliberately apart from the Vitest configs: `vitest.shared.ts` governs unit and
component tests, and this is neither. `npm run e2e` and `npm run e2e:ui` run
the suite; `type-check:e2e` joins the `type-check` chain so a spec that no
longer compiles fails where every other type error fails. `eslint .` already
covers the directory. `theia/tests/e2e/` stays where it is — it proves the
editor on its own, this proves the product around it.

### Considered and rejected

- **Cypress.** Runs inside the page, which is exactly the wrong side of a
  cross-origin frame; `cy.origin` covers navigation, not nested frames, and the
  shadow roots need `includeShadowDom` per call or globally. Two of the three
  runtime facts above would be fought.
- **WebdriverIO or Selenium.** Would work, add nothing over Playwright, and put
  a second runner beside the one `theia/` already has.
- **Vitest browser mode.** Component-level; it neither brings a stack up nor
  renders frames. A different tier, not an alternative.
- **The suite on every pull request.** Rejected for what a runner costs in this
  pipeline. Revisited if a post-merge break turns out to be a recurring cost
  rather than a rare one.
- **The gate against the `dev` backend instead of the compose stack.** A
  frontend-only image in CI pointed at `studio-dev.cfabric.org` is fast and
  needs no compose. It was rejected for the *gate* because a red run could then
  be the stand's outage or a contract drifting between a merged frontend and
  the backend last deployed there — signals worth having, neither of them
  "this merge is broken". That shape is instead what local development
  becomes, and the smoke after a deploy covers the stand side.
- **A development-only credential fallback in the specs.** Two roads to one
  value; `env.ts` has the defaults, and nothing else does.
- **A browser matrix.** A rendering difference in Firefox or WebKit is not
  what this suite is for; the unit and component suites are where component
  behaviour is checked.

### Consequences

- **The CI gate is the `test-e2e` job, and its first run on a runner is still
  ahead.** The one service `docker-compose.published.yml` leaves to a local
  build, `backend-bootstrap`, turned out not to be the obstacle it looked
  like. The seeder exists to get past a first-boot deadlock in the `oagw`
  gear, and `oagw` sits behind the `llm` cargo feature that the pipeline
  builds the published backend *without*
  (`--no-default-features --features graph,theia-bridge`); the published
  image therefore seeds the root tenant on its own, as the seeder would. What
  remains of the bootstrap is `studio-backend bootstrap --apply` — the gear
  databases and their migrations, which `run` does not provision — and that is
  the same image with a different subcommand, exactly what the Helm
  `database-bootstrap` hook runs before every deploy. `docker-compose.ci.yml`
  points `backend-bootstrap` at the published image with that subcommand, and
  nothing is compiled. Exercised once, on published images and fresh volumes:
  the bootstrap applied every gear's migrations, the backend's own bootstrap
  saga seeded the root, and the sign-in scenario passed. The runner differs
  from that machine in architecture and in owning a Docker socket the backend
  cannot open, both of which the log showed to be warnings, not failures.
- **The published stack had not been runnable for some time.** Two things
  surfaced on the way to the gate and are fixed in the published override: the
  backend from a published image ran the host profile (`config/dev.yaml`,
  PostgreSQL on `127.0.0.1`) because the image's CMD is meant for `docker run`
  and nothing under compose said otherwise; and the graph database was asked
  for by the services' snapshot tag, which the infrastructure build never
  publishes — the `edge` it fell back to predates the image's entrypoint and
  exits at once. It now follows the newest infrastructure release,
  `infra-latest`, as a stand does, with `STUDIO_INFRA_IMAGE_TAG` to pin one.
- **A pull request is not protected by the suite.** A break in what only a
  browser can see reaches `main` and is found by the post-merge run. The
  remedy is a revert or a forward fix; the snapshot does not deploy and, once
  the promotion is moved, `edge` does not move until the run is green.
- **The smoke after a deploy is deferred**, and with it the `e2e` user it
  needs. Creating a realm-local account with a password on `dev` and `test`,
  and storing its credentials in the GitHub Environments, is operational work
  this decision does not do; until it is done, a deploy is verified by
  `post-deploy-smoke.sh` alone, unauthenticated.
- **The transition of local development changes `env.ts`.** When `localhost`
  starts meaning the `dev` backend, the `demo/studio` defaults and
  `ignoreHTTPSErrors` must follow the issuer, not the portal's hostname. That
  belongs to the transition task, and this record names it so it is not
  forgotten there.
- Chromium only. A rendering difference in Firefox or WebKit is not something
  this suite will find, by design.
- `e2e/**` is outside every Vitest `include` and coverage glob, so the coverage
  ratchet in `vitest.shared.ts` is unaffected.
- The first scenario asserts landmarks — `banner`, `main` — rather than
  content, so it passes both for a member and for somebody the onboarding
  state (ADR-0011) is shown to. That is deliberate: which screen is inside
  `main` is scenario 2's question.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-fr-delivery-pipeline` — the pipeline gains a browser-driven gate after a merge to `main`; an authenticated smoke after a deploy is deferred
* `cpt-studio-fr-deploy-compose` — the compose stack is the suite's test bed in CI, from the published snapshot
* `cpt-studio-component-portal-shell` — the first scenario proves the shell comes up behind a real sign-in
* `cpt-studio-component-deployment` — a red run stops a snapshot from deploying and from becoming `edge`
* `cpt-studio-adr-authentication-does-not-grant-organization-membership` — the shell scenario passes for the unassigned state as for a member
* `cpt-studio-adr-an-mfe-entry-may-be-a-frame` — the frame's address arrives at runtime, so no scenario carries one
* `cpt-studio-adr-the-address-decides-where-the-shell-is` — the project scenario opens a project by its address
