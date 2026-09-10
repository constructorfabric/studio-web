# Theia backend bridge — Contract v1

Companion to **ADR-0010**. Defines the concrete v1 wire surface between
studio-backend (`studio-theia` gear, `TheiaControlClientV1`) and the Theia node
backend (`StudioRuntimeEndpoint`). GTS type: `gts.cf.studio.theia.control.v1~`.

Source of truth for every request/response shape is the existing TypeScript in
`theia/studio/src/common/{studio-protocol,workspace-protocol}.ts`. v1 does **not**
invent new payload shapes for anything that already exists there — it re-exposes
a subset over a server-to-server transport. New editor commands (§4) are the only
genuinely new shapes, and they are added to `studio-protocol.ts` first.

## 1. Transport & envelope

- **Direction studio → Theia:** HTTP/1.1 + JSON, on the container's **internal
  control port** (separate from the browser Theia port; never proxied).
  `POST /internal/theia/v1/{method}` — body is the method's request type, `200`
  body is the response type. Errors: `4xx/5xx` with
  `{ code, message, unsupported? }`.
- **Direction Theia → studio:** the node backend POSTs each broadcast event to
  the studio-theia ingress (`POST {ingress}/theia-events/v1`), body =
  `{ session, event }` (see §3).
- **Auth (both directions):** header `X-CFS-Theia-Token: <s2s-token>`. The token
  is minted per session by `studio-theia`, injected into the container as an env
  secret at launch (next to the existing `agent_env`), and paired with the
  `session_token` studio-session already issues. A request without a valid token
  never reaches endpoint logic.
- **Session identity & discovery:** the bridge is addressed by `workspace_id`
  (`SessionTarget`), not a raw session id. studio-theia's `StudioSessionResolver`
  asks the studio-session discovery client (`StudioSessionDiscoveryClientV1`, in
  `ClientHub`) to resolve the caller's live session for that workspace under the
  caller's `SecurityContext` — tenant scoping happens inside studio-session
  (ADR-0009), so the container stays tenant-blind. The resolver returns the
  control `base_url` + the per-session S2S token minted at launch.
- **Endpoint (Docker MVP):** studio-session mints a per-session control token
  (`STUDIO_THEIA_S2S_TOKEN`, injected into the container) and derives the
  control `base_url` from the session address — `http://<control_reach_host>:<port>`
  for a loopback session. In the MVP the Theia node serves this control API on
  the session's own port under the internal `/internal/theia/v1/` path, gated by
  the S2S token (the browser never holds it); a dedicated internal port /
  in-cluster Service is the production hardening (ADR-0010 phase 4). Everything
  is dormant unless `studio-session.theia_control_enabled = true`.
- **Idempotency:** write methods already carry an `idempotencyKey`
  (`EnqueueStudioOperationRequest`) — reused verbatim; the operation queue
  dedupes. `reusedExisting` / `reusedExisting`-style flags flow back unchanged.
- **Versioning:** additive method/field ⇒ minor bump, back-compatible. Breaking
  ⇒ `…control.v2~`, both served during migration. Any optional
  `StudioRuntimeService` method a given session does not implement answers
  `{ unsupported: true }`, not an error — callers must tolerate it.

## 2. studio → Theia methods (v1 slice of `StudioRuntimeService`)

v1 covers **read state + enqueue/observe operations**. The heavier
workspace-config mutation, sync, and migration families are deferred to v2
(listed at the end) so v1 can ship without portal UX for those flows.

Included (exact signatures from `studio-protocol.ts`):

| S2S method | Maps to | Purpose in portal |
|---|---|---|
| `getSession()` → `StudioRuntimeSession` | `StudioRuntimeService.getSession` | IDE identity + feature flags (git mode, allowed origins) |
| `getRepositories()` → `readonly StudioRepositoryDescriptor[]` | `getRepositories` | list repos the IDE has mounted, with git descriptors and `kind` |
| `resolveWorkspacePath(StudioWorkspaceRequest)` → `StudioWorkspaceLocation` | `resolveWorkspacePath` | map a portal path to its owning repo/rel-path |
| `enqueueOperation(EnqueueStudioOperationRequest)` → `EnqueueStudioOperationResponse` | `enqueueOperation` | **primary write** — queue a save/commit/push through the journal |
| `getOperationDeltas(StudioOperationDeltaRequest)` → `StudioOperationDeltaResponse` | `getOperationDeltas` | cursor backfill of operation events after a sequence |
| `getAuditDeltas(StudioAuditDeltaRequest)` → `StudioAuditDeltaResponse` | `getAuditDeltas` | cursor backfill of audit entries |
| `retryOperation(StudioRetryOperationRequest)` → `StudioOperationSnapshot` | `retryOperation` | retry a failed operation by id |
| `getWorkspaceSnapshot(WorkspaceSnapshotRequest)` → `WorkspaceSnapshotResponse` | `getWorkspaceSnapshot` | read workspace sources / sync / migration state (read-only) |

`kind` is `"project"` for the repository whose root is the configured
repository root -- the synthetic `/workspace` host in a managed workspace, the
single checkout in a classic one -- and `"source"` for a checkout mounted below
it. It is not a field of `StudioRepositoryDescriptor`: only `RepositoryRegistry`
knows the configured root, and the descriptor is built in places that do not, so
the node derives `kind` in the control-API projection. Consumers that predate the
field see nothing; the Rust DTO defaults it to `"source"`.

The project repository is where `.cf-studio-kit.toml` lives and is what
`installKit` targets when the caller sends no `repositoryId`, so a portal that
offers a repository picker uses `kind` to preselect the same target the node
would have chosen on its own.

The delta methods matter for reliability: they are already sequence-cursored, so
the push events in §3 are an optimization and `getOperationDeltas`/`getAuditDeltas`
are the **authoritative backfill** studio-theia calls on (re)connect to close any
gap — no event is lost across a restart.

**Deferred to v2 (mutations/flows):** `createWorkspaceConfig`,
`addWorkspaceSource`, `updateWorkspaceSource`, `removeWorkspaceSource`,
`renameWorkspace`, `readWorkspaceRawToml`, `saveWorkspaceRawToml`,
`scanWorkspaceSources`, `detectContainingWorkspaceRepository`,
`ignore/unignoreWorkspaceSuggestion`, `start/confirmWorkspaceSync`,
`cancel/retryWorkspaceJob`, and the whole `*WorkspaceMigration` family. All
already exist on `StudioRuntimeService` (most as optional), so promoting them to
the bridge later is additive.

## 3. Theia → studio events (v1 slice of `StudioRuntimeClient`)

studio-theia registers one non-browser `StudioRuntimeClient` inside the node
backend; every callback it receives is forwarded to the ingress and republished
to the `event-broker` gear. Wire payloads are the callback arguments verbatim.

| Event | Callback arg type | Downstream use |
|---|---|---|
| `operation` | `StudioOperationEvent` | operation lifecycle → portal status, graph ingest |
| `audit` | `StudioAuditEntry` | commit/push audit trail |
| `repositories-changed` | `readonly StudioRepositoryDescriptor[]` | repo set changed → refresh portal + graph |
| `workspace-snapshot-changed` | `WorkspaceSnapshot` | sources/sync/migration state changed |
| `workspace-activity` | `WorkspaceActivityEvent` | fine-grained activity feed |

Ingress body: `{ session: { sessionId, workspaceId }, kind, sequence?, payload }`,
where `sequence` (present on operation/audit) lets studio-theia detect gaps and
trigger a delta backfill (§2). Delivery is at-least-once; consumers key on
`(operationId, sequence)` / `(sequence)` to stay idempotent.

## 4. New editor commands (added to `studio-protocol.ts` first)

`openInEditor` and `notifyEditor` are implemented; the rest of this section is
still design. They did not exist when the contract was written — the portal
needs to *drive the running editor UI*,
which the current contract (workspace/git only) does not cover. Each is added as
a new method on `StudioRuntimeService` (node side) plus a Theia **frontend
command contribution** that actually acts on the editor, then exposed over the
bridge. Kept deliberately small for v1:

| New method | Request → Response | Behaviour |
|---|---|---|
| `openInEditor(OpenInEditorRequest)` → `OpenInEditorResult` | `{ location: StudioWorkspaceRequest, selection?, preview? }` → `{ opened: boolean, resolved: StudioWorkspaceLocation }` | reveal/open a workspace file in the running IDE (portal "jump to file"); resolves through the existing `WorkspaceBoundary` so it cannot escape `/workspace` |
| `revealRepository(RevealRepositoryRequest)` → `{ revealed: boolean }` | `{ repositoryId }` | focus a repo root in the explorer |
| `notifyEditor(NotifyEditorRequest)` → `{ shown: boolean }` | `{ level: 'info'\|'warn'\|'error', message, detail?, link?, source? }` | **implemented** — surface a Studio-originated message inside the IDE (e.g. "the repository import finished"). `shown` is false when the session is up but no browser client is attached to show it: a fact, not an error. `link` is offered as an *Open* action and followed through Theia's opener service, http(s) only. `studio-notify` reaches it with `workspace_id` instead of `connection_id` |
| `getRuntimeStatus()` → `RuntimeStatus` | `{}` → `{ ready: boolean, workspaceMode, activeClients, lastEventSequence, version }` | richer readiness than studio-session's TCP probe; also the reconnect cursor source |
| `requestEventResync(ResyncRequest)` → `StudioOperationDeltaResponse` | `{ afterSequence }` | force a full re-broadcast/backfill after studio-theia detects a gap |

Security notes for the new commands: `openInEditor`/`revealRepository` reuse the
same `assertPathWithinWorkspace` / `WorkspaceBoundary` guards the existing
methods use — no new path-trust surface. `notifyEditor` is display-only (no
workspace mutation). All five are S2S-token gated and tenant-clamped on the
studio-theia side like every other bridge call.

## 5. First vertical slice (aligns with ADR-0010 phase 2–3)

1. `getRuntimeStatus()` + `getRepositories()` end-to-end (read-only, proves
   transport + discovery + auth).
2. `enqueueOperation` + `operation`/`audit` event forwarding + `getOperationDeltas`
   backfill (proves the write + observe + gap-recovery loop).
3. `openInEditor` (first genuinely-new editor command, proves the frontend
   command contribution path).

Everything else in §2/§4 is additive on top of this slice.
