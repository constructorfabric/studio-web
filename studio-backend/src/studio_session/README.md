# studio-session

Launches, tracks and reaps the per-workspace Theia IDE sessions — Studio's
first gear of its own.

## Why it exists

The IDE is not a page in the portal; it is a running container with a checkout,
credentials and an agent runtime inside it. Somebody has to decide when one
starts, what goes into it, who may reach it, and when it stops costing money.
That is this gear.

See `docs/adr/0003-theia-sessions.md` for the architecture.

## One contract, two runtimes

The runtime lives behind `driver::SessionDriver`:

| Driver | Runs | Reached by |
|---|---|---|
| `docker.rs` | a container on the local daemon (the MVP) | a published loopback port |
| `k8s.rs` | a Pod + ClusterIP Service per session | the backend's authenticated proxy (`proxy.rs`) |

The REST contract and the portal flow do not change with the backend.

## The runtime is the registry

Sessions are **not** kept in a map this process owns. The Docker daemon and the
Kubernetes API are what know which sessions exist: they create them, they
outlive a backend restart, and they answer the same for every replica. This gear
lists them from the driver and caches the answer for `registry_ttl_secs`.

Two consequences worth knowing:

- A session's id is **derived**, not drawn: `session_id_for(workspace_id)` is a
  UUIDv5 over the workspace, because the service admits one live session per
  workspace and the runtime already names the container after it. Every process,
  before or after a restart, calls a session by the same name.
- Whether the IDE is *answering* is the one thing the runtime cannot report — a
  Pod is `Running` well before Theia binds — so it is probed and remembered
  across listings.

The reaper (`reap_task.rs`) also works from the driver, fired by
[`../scheduler`](../scheduler) rather than by a timer of its own.

## What goes into a session

Minted per session and injected as env: a 256-bit **gate token** (the container
refuses requests without it) and, when the Theia bridge is on, a distinct
**S2S control token** for [`../studio_theia`](../studio_theia). Repository PATs
and agent provider keys are resolved from credstore under the *caller's*
identity, so a workspace only receives keys its tenant may read — a missing one
is a warning and the session still starts.

## REST

| Method + path | Does |
|---|---|
| `POST /sessions` | launch, or reuse the live session for this workspace |
| `GET /sessions` | the tenant's sessions |
| `GET /sessions/{id}` | one session; promotes `starting` → `running` |
| `DELETE /sessions/{id}` | stop and remove it |
| `/ide/{id}/…` | the browser's proxy path into a Kubernetes session |

## In the assembly

- Gear `studio-session`, capabilities `[rest, stateful]`, deps
  `account_management`, `credstore`.
- Config section `gears.studio-session`; `enabled: false` keeps the gear booting
  and the routes answering 503, for hosts with no Docker.
- The Helm chart refuses a second backend replica while sessions are on — see
  the note in `deploy/helm/studio-web/values.yaml`.
