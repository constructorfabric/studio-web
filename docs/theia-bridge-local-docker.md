# Running the studio-backend ↔ Theia bridge locally in Docker (ADR-0022)

Goal: bring the bridge up end-to-end on Docker Desktop (WSL2) and **observe the
event loop** — a Theia session forwards its events to studio-backend, which logs
each one through `LoggingEventSink`. No `event-broker`, no GTS registration, no
schema. That path is deferred (see §5); it is not needed to see the loop work.

Everything below is already wired in the repo — this doc is the runbook, not a
list of edits to make.

## What was wired

| File | Change | Why |
|---|---|---|
| `docker-compose.yml` | `backend.build.args.CARGO_FEATURES: "--features theia-bridge"` | Links the `studio-theia` gear (additive to `llm` + `graph`). |
| `config/docker.yaml` | `studio-theia.config.enabled: true` | Mounts the ingress + control routes. |
| `config/docker.yaml` | `studio-session.config.theia_control_enabled: true` | Mints the per-session S2S token and injects `STUDIO_THEIA_S2S_TOKEN` + `STUDIO_GATEWAY_URL` into the session container, so the forwarder self-arms. |
| `config/docker.yaml` | `studio-session.config.control_reach_host: host.docker.internal` | Backend is containerised; session containers publish ports on the host, so it dials siblings via the host gateway. |
| `config/docker.yaml` | `studio-session.config.image: cf-studio-theia:local` | The ghcr `edge` tag predates `studio-event-forwarder.ts`; a local build carries it. |

The sink stays `LoggingEventSink` — the broker sink only compiles under the
separate `--features theia-event-broker`, which is **not** set here.

## 1. Build the Theia session image (carries the forwarder)

The host WSL build fails on `native-keymap` (missing X11 dev libs), but the
Dockerfile installs `libx11-dev libxkbfile-dev libsecret-1-dev` itself and runs
`npm ci` + `npm run build:browser` inside the image — so build it in Docker and
the host problem is irrelevant:

```bash
cd /mnt/c/Repos/CFS/studio-web-main
docker build -f theia/Dockerfile -t cf-studio-theia:local theia
```

(First build is slow — full `npm ci` + Theia browser build. Subsequent builds
reuse layers.)

## 2. Configure the environment

```bash
cp .env.example .env    # if you don't have one yet
# minimum for the loop: a credstore key so secrets survive a restart
openssl rand -base64 32   # -> paste into STUDIO_CREDSTORE_KEY in .env
```

`STUDIO_LLM_API_KEY` / `STUDIO_ANTHROPIC_API_KEY` are optional — the loop does not
need them (they only power in-IDE AI). The session image is now local, so
`STUDIO_REGISTRY_USER/TOKEN` are not needed either.

## 3. Build + start the backend (with the bridge linked)

```bash
docker compose up --build backend frontend
```

`--build` rebuilds the backend image with `CARGO_FEATURES=--features theia-bridge`.
First build compiles the ~90-crate gears workspace (cargo-chef caches it after).
Watch for the studio-theia gear coming up (it mounts the ingress) and the backend
healthcheck passing (`/cf/health`).

## 4. Exercise + observe the loop

1. Open the portal (frontend) and create / open a workspace → studio-session
   launches a `cf-studio-theia:local` container. On launch it receives
   `STUDIO_THEIA_S2S_TOKEN` and `STUDIO_GATEWAY_URL=http://host.docker.internal:8090/cf`.
2. The forwarder self-arms (token present) and derives its ingress URL as
   `…/cf/studio-theia/v1/events`.
3. Do something in the IDE that emits an event — a save/commit (operation), a repo
   change. The node broadcasts it to all `StudioRuntimeClient`s, the forwarder
   POSTs it to the ingress.
4. **Watch the backend log:**

   ```bash
   docker compose logs -f backend | grep "studio-theia:"
   ```

   Each forwarded event logs as:
   `studio-theia: received forwarded Theia event  kind=… tenant=… workspace=… session=…`

   `tenant` / `workspace` / `session` come from **reverse-resolving the token** —
   proof the trusted-identity path works, not the request body.

## Optionally: drive the IDE (control plane)

The 7 control endpoints (`GET …/workspaces/{id}/status|session|repositories`,
`POST …/operations`, `…/open`) are mounted under the same gear. Try them from the
OpenAPI surface (tag `StudioTheia`) at the backend's `/cf/docs`, under an
authenticated portal session.

Caveat to verify at runtime: the control call dials the container on
`control_reach_host:{published_port}`. Confirm the Docker session driver publishes
the control port (studio-theia `control_port` default `3031`) to the host — if the
node serves control on its main published port this just works; if control is a
separate unpublished port, driving the IDE needs that port exposed. This does
**not** affect the event loop (§4), which is container→backend.

## 5. Deferred — NOT needed for the local loop

These are the `event-broker` items; the local run above deliberately avoids all of
them by using `LoggingEventSink`.

- **Confirm GTS names + register schema.** The broker sink's topic/event-type/
  subject ids are placeholders. Needed only under `--features theia-event-broker`,
  and only once a broker exists to register them in.
- **Link `event-broker`.** `deps=[cluster]`, `capabilities=[rest, stateful]`; needs
  a storage backend (memory or postgres) and topic provisioning. A separate infra
  decision — the local profile does not link it.
- **First `StudioRuntimeService` expansion method.** Optional. The bridge currently
  observes events + drives the 7 control methods; adding e.g. `addWorkspaceSource`
  or a migration method follows the existing pattern (client method → wire call →
  Portal route) and is unrelated to bringing the loop up.

## Troubleshooting

- **`cf-studio-theia:local` not found** on session launch → run §1 first.
- **`host.docker.internal` doesn't resolve** (native Linux Docker, not Desktop) →
  add `extra_hosts: ["host.docker.internal:host-gateway"]` to the backend service
  and ensure the session driver passes the same. Docker Desktop/WSL2 provides it
  automatically.
- **No `studio-theia:` lines in the log** → the gear is off. Check the backend was
  built with `--features theia-bridge` (`docker compose build backend`) and
  `studio-theia.enabled: true` is in `config/docker.yaml`.
- **Forwarder silent** → the session container is missing `STUDIO_THEIA_S2S_TOKEN`;
  confirm `studio-session.theia_control_enabled: true`.
