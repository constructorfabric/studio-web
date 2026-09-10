# studio-theia

The backend-to-backend bridge between studio-backend and the Theia node backend
running inside a session (ADR-0010).

## Why it exists

A session container is not just a UI. Its Theia node backend can open
workspaces, run operations and report what happened — and the portal needs
those things from *outside* the IDE, without a browser in the loop and without
the browser ever holding a token that reaches the session directly.

So the bridge is backend-to-backend in both directions:

- **studio → Theia**: `sdk::TheiaControlClientV1`, published to the ClientHub so
  other gears make control calls without a network hop through our own gateway.
- **Theia → studio**: an authenticated event ingress the session posts to.

## How a session is found

Endpoint discovery goes through `discovery::StudioSessionResolver`: it asks
[`../studio_session`](../studio_session) for the session's control endpoint and
its per-session S2S token. That token is minted at launch and injected into the
container as `STUDIO_THEIA_S2S_TOKEN` — never handed to a browser, and distinct
from the session gate token.

The ingress authenticates by resolving that token back to the session's trusted
`(tenant, workspace)` coordinates. It is the ingress's authentication primitive:
it bypasses `SecurityContext` because it is what mints one.

## Phases

| Phase | State |
|---|---|
| 1–2 | control client, discovery, authenticated event ingress with tracing |
| 3 | the ingress republishes forwarded events onto the `event-broker` gear |

Phase 3 is behind the `theia-event-broker` Cargo feature, which implies
`theia-bridge`; without it the sink logs instead of publishing.

## REST

| Method + path | Does |
|---|---|
| `POST /workspaces/{id}/open` | open a workspace in the session |
| `GET`/`POST /workspaces/{id}/operations` | list, or ask for, an operation |
| `POST /workspaces/{id}/operations/{op}/retry` | run one again |
| `GET /workspaces/{id}/repositories` | what the session has checked out |
| `GET /workspaces/{id}/session`, `GET /workspaces/{id}/status` | which session, and how it is |
| `POST /events` | the Theia → studio ingress |

## In the assembly

- Gear `studio-theia`, capabilities `[rest]`.
- Behind the **`theia-bridge`** Cargo feature; dormant unless
  `studio-theia.enabled = true`.
- Read next: `studio-backend/docs/theia-bridge-architecture.md`, and in the
  repository root `docs/adr/0010-theia-backend-bridge.md` plus
  `docs/theia-bridge-contract-v1.md`.
