# studio-session

Launches, tracks and reaps the per-workspace Theia IDE sessions — Studio's
first gear of its own.

The design — why the runtime is the registry, who may reach a session, what
goes into its container, the drivers, the readiness and reaping runs, desktop
leases, the REST surface — is
[`docs/design/studio-session.md`](../../../docs/design/studio-session.md). This
README is what you need to work in the directory.

## In the assembly

- Gear `studio-session`, capabilities `[rest, stateful]`, deps
  `account_management`, `credstore`.
- Config section `gears.studio-session`; `enabled: false` keeps the gear booting
  and the session routes answering 503, for hosts with no Docker. `driver` is
  `docker` (default) or `kubernetes`.
- Registers the `session.await_ready` and `session.reap` handlers with
  [`../tasks`](../tasks), and asks [`../scheduler`](../scheduler) for the
  `session-reaper` schedule (`platform_schedules()` in `mod.rs`).
- Publishes `StudioSessionDiscoveryClientV1` (`sdk.rs`) for
  [`../studio_theia`](../studio_theia); it resolves nothing unless
  `theia_control_enabled`.
- The Helm chart refuses a second backend replica while sessions are on — see
  the note in `deploy/helm/studio-web/values.yaml`.

## Working here

- The rules worth testing sit behind seams with fakes: `SessionDriver`
  (`driver.rs`), `WorkspaceAccess` (`access.rs`), `SessionActivity`
  (`service.rs`), and the plain `launch_sources::plan`. The service tests run a
  fake runtime, so none needs Docker or a cluster.
- `session_id_for` is pinned by a test: changing it renames every live session.
- The four `k8s_session_*` defaults are pinned against the namespace quota
  arithmetic in `deploy/helm/studio-web/values.yaml`; change both together.
