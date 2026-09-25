# Which Studio the dev server talks to

`npm run dev:all` runs the portal on `http://localhost:5173` against a
*stand*: a backend, its data, its Keycloak and its IDE sessions. By default
that is the shared `dev` stand, and nothing on this machine but Node is
needed. Why, and what it means for the data, is decided in
[ADR-0030](../../docs/adr/0030-the-portal-is-developed-against-a-shared-stand.md);
this is the operating note.

## Switching

```sh
npm run dev:all                       # dev  — studio-dev.cfabric.org, sign in with GitHub
STUDIO_STAND=test  npm run dev:all    # test — studio-test.cfabric.org
STUDIO_STAND=local npm run dev:all    # the stack on this machine
```

| `STUDIO_STAND` | Backend, proxied under `/cf` and `/studio`      | Realm the browser signs in against               |
| -------------- | ----------------------------------------------- | ------------------------------------------------ |
| `dev`          | `https://studio-dev.cfabric.org`                | `https://studio-dev.cfabric.org/auth/realms/studio`  |
| `test`         | `https://studio-test.cfabric.org`               | `https://studio-test.cfabric.org/auth/realms/studio` |
| `local`        | `http://127.0.0.1:8090`                         | `https://localhost:8443/realms/studio`           |

`local` is the compose stack (`docker compose up -d` at the repository root;
`STUDIO_EMBEDDING_PROVIDER=fake` if the backend never turns healthy) — and
equally a backend started with `cargo run` beside `docker compose up -d
graph-postgres keycloak`, which answers on the same two ports. Its users are
seeded: `demo` / `studio`. Open <https://localhost:8443> once and accept the
certificate.

To stay on a stand for a while, keep the choice in a gitignored `.env.local`
next to `vite.config.ts`:

```sh
STUDIO_STAND=local
```

The dev server prints the stand it faces under its URLs:

```
  ➜  Stand:   dev → https://studio-dev.cfabric.org (issuer https://studio-dev.cfabric.org/auth/realms/studio)
```

## Overriding one value

Each value of a stand can be replaced with the variable the container knows
it by — in the shell or in `.env.local`, on top of whichever stand is chosen:

| Variable                 | Replaces                          |
| ------------------------ | --------------------------------- |
| `STUDIO_BACKEND_URL`     | where `/cf` and `/studio` go      |
| `STUDIO_OIDC_ISSUER`     | the realm                         |
| `STUDIO_OIDC_CLIENT_ID`  | the client (`studio-portal`)      |

None of these reach the bundle; `VITE_*` is still the only prefix that does.

## How it works

The dev server does what a container does. nginx carries `/cf` and `/studio`
to `BACKEND_HOST`; Vite proxies them to the stand. The container entrypoint
writes `window.__STUDIO_ENV__` into `/env.js`; a plugin in `vite.config.ts`
serves the same file with the stand's issuer. The app reads it through
`src-app/app/config/env.ts` either way. The table lives in
`scripts/lib/stands.ts`.

One path is treated specially. `/studio/{id}/` is an IDE session, and the
session pod admits only its own origin — `Origin` against `Host`. The proxy
presents the stand's origin on that path, as nginx would; on `/cf` the
browser's headers pass as they are.

## What a stand needs from its side

The realm's `studio-portal` client must list the dev server twice:

| Client setting      | Values                                                 | Otherwise                                              |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| Valid redirect URIs | `http://localhost:5173/*`, `http://127.0.0.1:5173/*`   | the IdP answers *Invalid parameter: redirect_uri*      |
| Web origins         | `http://localhost:5173`, `http://127.0.0.1:5173`       | the code exchange is blocked for CORS (token endpoint answers 403 without CORS headers) |

`keycloak/realm-studio.json` in this repository lists both; a deployed realm
is an environment Secret imported on first boot, so an administrator adds
them on the stand. A passing `OPTIONS` preflight proves nothing — Keycloak
answers one for any origin; the `POST` is what carries the headers. Until
both settings are there, `STUDIO_STAND=local` is the way to work.

## The data is real

On `dev` you see what the team sees, and what you create stays. Try nothing
destructive there for the sake of a screen; `test` and `local` are one
variable away.

## End-to-end tests

`npm run e2e` defaults to the compose portal on `http://localhost:8080`,
whose seeded `demo/studio` it knows. Against the dev server the account is
named, because the stand behind it could be any:

```sh
STUDIO_STAND=local npm run dev:all                                  # in one terminal
E2E_BASE_URL=http://localhost:5173 E2E_USER=demo E2E_PASSWORD=studio npm run e2e
```

Against `dev` or `test` the suite waits for the realm-local `e2e` account
ADR-0029 deferred.
