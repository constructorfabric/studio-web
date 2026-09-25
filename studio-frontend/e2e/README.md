# End-to-end tests

A handful of Playwright scenarios that open a real browser against a running
portal and prove the things a unit test cannot: sign-in through the IdP, a
Module Federation screen mounting, the Theia frame coming up. Why they are few,
where they run and how they stay ignorant of the stand is decided in
[ADR-0029](../../docs/adr/0029-end-to-end-tests-are-few-and-do-not-know-where-they-run.md);
this file is the operating manual.

## Where it runs

- **CI**: on the compose stack, from the published snapshot, when a merge
  reaches `main` — the only place the suite is a gate. Not on pull requests.
- **After a deploy**: as an authenticated smoke against the stand — deferred
  until the stands have a realm-local `e2e` account (ADR-0029).
- **Your machine**: against whatever backend you have — the compose stack, or
  the `dev` backend once local development moves there. The defaults below are
  the compose stack's; anything else needs explicit credentials.

## Running

Against the compose stack (`docker compose up --build -d` at the repository
root; the portal answers on `http://localhost:8080`):

```sh
npx playwright install chromium   # once per machine
npm run e2e
npm run e2e:ui                     # the same, with the inspector
```

If the backend never turns healthy and its log says *ONNX Runtime did not
load*, bring the stack up with `STUDIO_EMBEDDING_PROVIDER=fake` — the sign-in
scenario needs no embeddings.

Against a shared stand — a realm-local account with a password, never an SSO
identity:

```sh
E2E_BASE_URL=https://studio-dev.cfabric.org \
E2E_USER=e2e E2E_PASSWORD=… \
npm run e2e
```

Only what is safe on shared data:

```sh
npm run e2e -- --grep @readonly
```

| Variable       | Default (compose stack only) | Meaning                                       |
| -------------- | ---------------------------- | --------------------------------------------- |
| `E2E_BASE_URL` | `http://localhost:8080`      | The portal. Anything else needs credentials.  |
| `E2E_USER`     | `demo`                       | From `docker/keycloak/realm-studio.json`.     |
| `E2E_PASSWORD` | `studio`                     |                                               |

A failed run leaves a trace and a screenshot under `e2e/test-results/`;
`npx playwright show-trace <trace.zip>` opens it.

## Writing one

- A scenario earns a place here when its failure means *nobody* can do the
  thing — not when a component misbehaves. That belongs in Vitest next to the
  component.
- No hosts, no accounts, no ids of live data in a spec. Read `support/env.ts`.
- Tag it: `@readonly` may run against any stand including production;
  `@mutating` creates data, names it `e2e-<runId>-…`, and removes it after.
- Locate by role and name. MFEs mount inside open shadow roots and Playwright
  locators pierce those on their own; the Theia frame is reached with
  `page.frameLocator(...)` and its address is never in a test — it arrives at
  runtime (ADR-0021).
