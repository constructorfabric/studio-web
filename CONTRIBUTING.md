# Contributing to Constructor Studio Web

This guide covers what is specific to this repository. The organization-wide
rules apply to it as to every Constructor Fabric repository, and this guide
does not repeat them:

- [Contribution baseline](https://github.com/constructorfabric/governance/blob/main/CONTRIBUTING.md)
  — license, the fork-based flow, where to ask questions;
- [Code review policy](https://github.com/constructorfabric/governance/blob/main/CODE_REVIEW.md)
  — approvals, CI, resolved conversations, squash merge;
- [Developer Certificate of Origin](https://github.com/constructorfabric/governance/blob/main/DCO.md)
  — the `Signed-off-by` line every commit carries.

Where this guide is stricter, it wins for this repository.

## Contents

- [Set up a clone](#set-up-a-clone)
- [Make a change](#make-a-change)
- [Check it before you push](#check-it-before-you-push)
- [Contracts, decisions and documents](#contracts-decisions-and-documents)
- [Open the pull request](#open-the-pull-request)
- [Review and merge](#review-and-merge)
- [Secrets](#secrets)

## Set up a clone

Fork the repository, clone your fork, and add this repository as `upstream`:

```bash
git clone https://github.com/<you>/studio-web.git
cd studio-web
git remote add upstream https://github.com/constructorfabric/studio-web.git
git config core.hooksPath .githooks
```

The last line turns on the [shared hooks](.githooks/README.md):
`prepare-commit-msg` adds your `Signed-off-by` line, and `pre-commit` blocks a
commit whose backend code is not `rustfmt`-clean (it skips itself when `cargo`
is not installed).

To run the stack, follow the [quick start](README.md#quick-start). Docker is the
only hard prerequisite; Node.js 22 is needed for the portal and IDE dev loops,
and a Rust toolchain only if you want to build the backend outside a container.

## Make a change

`main` moves fast — often more than a hundred commits a week — so branch from the
current `upstream/main`, not from your fork's `main`, which lags:

```bash
git fetch upstream
git switch -c <topic> upstream/main
```

Keep a pull request to one topic. If a change needs a backend part and a portal
part, two stacked pull requests review faster than one, and the second says
which one it builds on.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
with the area as the scope, and say what is now true rather than what was done:

```
fix(session): a closed tab no longer kills the session gate
feat(documents): read a bound repository file's text
```

Common scopes: `backend`, `session`, `documents`, `reports`, `components`,
`theia`, `desktop`, `prototype`, `deploy`, `ci`, `docs`. The pull request title
follows the same form, because a squash merge makes it the commit on `main`.

## Check it before you push

CI runs only the jobs of the components a change touches. Run the same checks
locally for each component you changed:

| Component | Checks |
|---|---|
| `studio-backend/` | `scripts/backend-check.sh` — fmt, clippy, build, feature combinations and tests in CI's own image; only Docker is needed |
| `studio-frontend/` | `npm ci && npm run build:packages`, then `npm run lint`, `npm run type-check` and `npm run test:unit` |
| `studio-frontend-prototype/` | `npm ci && npm test && npm run build` |
| `theia/` | `npm test`; for an IDE change, rebuild with `docker compose build session-image` and try it in a session |
| `keycloak/` | the account-takeover tests against the running Compose Keycloak — [`keycloak/README.md`](keycloak/README.md) has the command |
| `deploy/` | `helm lint deploy/helm/studio-web -f deploy/helm/values-dev.example.yaml`, and the same for `values-test.example.yaml` |

`npm run test:unit` is the frontend command CI runs. A bare `vitest` reads one
config and misses the per-package suites.

A test proves the code; it does not prove the change works. For anything a user
sees, run it — the Compose stack, or the portal against the `dev` stand — and
say in the pull request what you saw.

## Contracts, decisions and documents

**API, events and errors.** Read [`docs/api-conventions.md`](docs/api-conventions.md)
before adding or changing an endpoint. A new event `kind` goes into
[`docs/events-catalog.md`](docs/events-catalog.md); an error a screen branches on
uses a category from [`docs/errors-catalog.md`](docs/errors-catalog.md). The
portal is held to the backend's OpenAPI by a ratchet
(`scripts/check-api-usage.mjs`, [ADR-0020](docs/adr/0020-one-contract-with-the-frontend.md)):
a new call outside the contract fails CI, so extend the contract rather than the
baseline.

**Architecture decisions.** A change to how the system works — a new gear, a
new boundary, a different storage, a rule others must follow — needs an ADR in
[`docs/adr/`](docs/adr/README.md), in the same pull request or before it. Take
the next free number, follow the front matter the index describes, and add the
record to the index table.

**Documents.** Specifications under `docs/` follow Studio's own document types
([`docs/README.md`](docs/README.md)), and their `cpt-` ids are defined once.
Update the README of a component when you change how it is built or run.

**Desktop Studio.** Changes to `theia/electron-app` or the desktop half of
`theia/studio` follow [`docs/desktop-contributing.md`](docs/desktop-contributing.md);
the first rule is that the web session must not notice.

## Open the pull request

Push the branch to your fork and open the pull request against
`constructorfabric/studio-web:main`. The [template](.github/pull_request_template.md)
asks for three things a reviewer needs: what changes and why, how you
verified it, and which contracts or decisions it touches.

Pull requests from a fork run the tests but never publish images or deploy.
If a reviewer needs to see the change on a stand, a maintainer runs
**Studio Delivery → Build, publish and deploy** for it.

## Review and merge

[`CODEOWNERS`](.github/CODEOWNERS) requires an approval from
`@constructorfabric/studio-maintainers`; changes to `.github/`, `LICENSE`,
`NOTICE` and `SECURITY.md` need `@constructorfabric/studio-leaders`. CI must be
green and every conversation resolved. Pull requests are squash-merged.

A merge to `main` publishes images but deploys nothing. Rolling a change out to
`dev` or `test` is a separate **Deploy existing images** run — see
[`deploy/PIPELINES.md`](deploy/PIPELINES.md).

## Secrets

Never commit a real key, token, password, kubeconfig or certificate, and never
commit `.env`. Local examples use the development credentials in
[`.env.example`](.env.example) and the Keycloak realm; shared environments read
theirs from GitHub Environments and Kubernetes Secrets
([`deploy/README.md`](deploy/README.md)). If you commit a secret by mistake,
treat it as leaked: rotate it first, then remove it. Vulnerabilities are
reported privately — see [`SECURITY.md`](SECURITY.md).
