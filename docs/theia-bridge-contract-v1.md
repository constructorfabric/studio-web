# Theia backend bridge — Contract v1

Companion to **ADR-0022**. Defines the concrete v1 wire surface between
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
  in-cluster Service is the production hardening (ADR-0022 phase 4). Everything
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
repository root -- the single checkout in a classic workspace, an adopted root
repository where there is one -- and `"source"` for a checkout mounted below
it. It is not a field of `StudioRepositoryDescriptor`: only `RepositoryRegistry`
knows the configured root, and the descriptor is built in places that do not, so
the node derives `kind` in the control-API projection. Consumers that predate the
field see nothing; the Rust DTO defaults it to `"source"`.

A managed workspace is a container: its root is a plain directory holding one
repository per source, so no entry is `"project"` and a caller that needs a
target has to offer the choice. Source Control shows the project's repositories
and nothing else, which is the point.

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

## 5. First vertical slice (aligns with ADR-0022 phase 2–3)

1. `getRuntimeStatus()` + `getRepositories()` end-to-end (read-only, proves
   transport + discovery + auth).
2. `enqueueOperation` + `operation`/`audit` event forwarding + `getOperationDeltas`
   backfill (proves the write + observe + gap-recovery loop).
3. `openInEditor` (first genuinely-new editor command, proves the frontend
   command contribution path).

Everything else in §2/§4 is additive on top of this slice.

## 6. Portal ↔ IDE browser channel (`postMessage`)

A second, unrelated transport to §1–§5: the **portal page** talking to the
**IDE page** it embeds as an iframe (a "Space"). No backend hop, no S2S token —
`window.postMessage` between two browser windows, origin-checked on both ends
(`theia/studio/src/browser/portal-bridge-contribution.ts` in the IDE; the
spaces host of `studio-frontend-prototype`, and
`studio-frontend/src-app/app/mfe/editorBridge.ts` in the official portal).
Present because some things are properties of the *running UI*, not of the
workspace: the theme, the editor that is open, the dirty count.

This section describes the bridge as it is on `main`; its tests
(`portal-bridge-contribution.test.ts`) are the source when the two disagree.

**Handshake.** The bridge listens only once `StudioRuntimeService.getSession()`
has answered over the IDE's websocket — it needs the session's origin rules
first. Anything posted before that is dropped, not queued, and if the call
fails the bridge stays off for the life of the page. It answers the first
`studio.init` it accepts with `studio.status`; a repeat gets no answer, since
the status is posted only when the dirty count changes. The acknowledgement is
therefore *any* `studio.*` message from the IDE, not `studio.status` in
particular.

**Delivery.** The portal repeats `studio.init` about every two seconds until
the IDE answers, and holds every other message until then, flushing in order —
the prototype every message, this portal only the latest of each type, since a
later file, theme or token makes the earlier one moot.
This is what makes editing a single gesture: a view can ask for a file while
the session is still being launched, and the message lands when the IDE is
ready instead of being dropped into a booting iframe. Every load of the frame
re-arms the handshake — the gate's splash (served at the session's address
while Theia binds its port, refreshing itself), the IDE, the IDE again after a
reload — and what was already delivered is not replayed: a reloaded IDE
restores its own layout. Opening messages are not deduplicated by the IDE:
each copy opens again and switches the perspective again (`studio.openGear`
without a path shows its quick pick again), so the portal sends each once.

**Origins.**

- *Portal → IDE.* The bridge takes a message only from `window.parent`, only
  with a `studio.` type, and only from an allowed origin: with no list, the IDE
  page's own origin (`same-origin` mode); with one, exactly an origin on it;
  `null` never. The first accepted origin is pinned for the life of the page,
  and everything the bridge posts goes to it, never to `*`.
- *The list* is the backend's static `allowed_origins`
  (`studio-backend/src/studio_session/config.rs`), passed to the container as
  `STUDIO_ALLOWED_ORIGINS` only when it is not empty; nothing is taken from
  the launch request. The stands set none, so a session there trusts its own
  origin; the local profiles list `http://localhost:5173`,
  `http://localhost:8080` and `http://localhost:8081`. The same list is the IDE
  page's `frame-ancestors` (`'self'` when there is none), so adding an origin to
  a stand's list drops `'self'` from it.
- *IDE → portal.* The portal takes a message only from its frame's window
  (`event.source === iframe.contentWindow`) and the origin of the frame's
  address, and posts only to that origin.

**Trust.** The frame has no `sandbox` (decided in #323, which ADR-0021 left it
to). On a stand the session's address is relative (`/studio/{id}/`), so the
IDE is on the portal's own origin: a sandbox without `allow-same-origin` gives
the IDE an opaque origin, and Theia refuses its websocket (the `Origin` must
name the `Host`); with `allow-same-origin` and `allow-scripts` on one origin the
IDE can lift its own sandbox. Script in the IDE's page can therefore reach
`window.parent` and the portal's `sessionStorage`, where the refresh token of
whoever has the editor open is kept. The IDE's webviews are served from the
same address (`/studio/{id}/webview/…`), so an extension's webview is on that
origin too, and the origin's `localStorage` is one quota for the portal, every
session's layout and every webview — the Claude Code webview's Statsig cache
alone has been seen filling it. That is accepted, as it was for the prototype
on the same stands; the IDE is handed the member's access token in any case. A separate origin for `/studio/` is the step if the boundary has to
hold. The frame is allowed `clipboard-read; clipboard-write`, which only a
session on another origin needs — a local Docker session answers on its own
port.

### portal → IDE

| Message | Payload | Effect |
|---|---|---|
| `studio.init` | `{ theme?, apiToken?, workspaceId?, workspaceName?, viewer? }` | the handshake, answered with `studio.status` the first time only. `theme`, `apiToken`, `viewer` and `workspaceName` as below; `workspaceId` is the tenant the Artifact Graph scopes to |
| `studio.theme` | `{ theme }` | the portal's theme changed. `'light'` is light and anything else dark; with no theme at all the IDE follows the OS |
| `studio.token` | `{ apiToken, viewer?, workspaceId?, workspaceName? }` | silent renew: the path `studio.init` takes, without the theme or the answer |
| `studio.openInEditor` | `{ path }` | open a repository file by its path from the workspace root (`<checkout directory>/<path in the repository>`); the IDE also looks one level below each root. Markdown opens in the documents perspective |
| `studio.openProduct` | `{ path, branch? }` | open a product description (`product.gdl`) in the Gearbox perspective (`gearbox.product.openAt`), from `branch` when it is not the one checked out; a plain open if that command fails |
| `studio.openGear` | `{ path? }` | open the gear at `path`, or the project's own (a quick pick when there are several), in the Gearbox perspective (`gearbox.gear.openAt`) |
| `studio.openGraph` | — | open the Artifact Graph view |
| `studio.openDocument` | `{ workspaceId, documentId, title? }` | open a **portal document** in the markdown editor, in the documents perspective |
| `studio.notify` | `{ message, level?, detail?, source?, link? }` | show a notification in the IDE; an unknown `level` is `info`, and only an http(s) `link` is offered |

The opening messages wait for the IDE's layout; theme, token and notify apply
at once.

- **`apiToken`** is the member's portal token. Gears are called with it
  same-origin through the session gate (`/studio-api/…`), the agent CLIs use it
  per request, and it is written into Theia AI's User-scope preferences as the
  key of the Studio model — in a shared session, the last member's
  (ADR-0030 moves this to the connection).
- **`viewer`** is `{ sub, name?, email?, kind? }`: `sub` is the person
  (`oidc:<sub>` in the IDE, and a viewer without it is ignored), `name` is
  shown and names the presence, `email` is what the IDE commits as, and `kind`
  is `person` unless the portal drives the IDE as an `agent` or a `product`
  (only `agent` changes anything). Every message that carries an `apiToken`
  sets the viewer from the same message, so a token sent without `viewer`
  clears it and stops the presence: the two travel together.
- **`workspaceName`** is read from any `studio.*` message. Without it the IDE
  names the workspace after the container's directory, and an empty string
  reverts to that.

### IDE → portal

| Message | Payload | Effect |
|---|---|---|
| `studio.status` | `{ dirty }` | how many widgets hold unsaved changes: in answer to the first `studio.init`, then whenever the count changes (a two-second poll) |
| `studio.documentSaved` | `{ workspaceId, documentId }` | the IDE wrote a portal document back; a portal showing that row re-reads it |
| `studio.openComponent` | `{ name }` | show that component's page in the portal's catalogue, by catalogue name; sent by the command `studio.portal.openComponent` (the Gearbox Inspector, `gearbox.gear.openInCatalogue`), and never before the origin is pinned |

### Who sends what

The prototype portal (`studio-frontend-prototype/src/App.tsx`) sends every
portal → IDE message above and handles all three answers. The official portal
(`studio-frontend`, [editor bridge](feature/editor-bridge.md)) sends
`studio.init`, `studio.theme`, `studio.token` and `studio.openInEditor` — only
files open in its editor so far — and answers `studio.openComponent` with a
notice until it has a component page (#583). It reads `studio.status` only as
the acknowledgement (unsaved changes on leaving the editor are #582) and
ignores `studio.documentSaved`: it opens no portal documents in the IDE.

### Portal documents as editor resources

`studio.openDocument` is the one that needed a new addressing scheme. A
document is not a file: it lives in the `studio-documents` gear, keyed by
(workspace tenant, document id), so the IDE had no way to name it and the
portal's textarea was the only editor. The IDE now gives it a URI —

```
studio-doc:/{workspaceId}/{documentId}/{slug}.md
```

— resolved by `StudioDocumentResourceResolver`, which reads and writes it
straight through `GET`/`PUT /studio-documents/v1/workspaces/{ws}/documents/{id}`
over the same session gate and portal-issued token as every other Studio call.
There is no local copy: the portal's list and the IDE's editor are two views of
one row.

The trailing filename carries no identity — it makes the tab readable and keeps
`.md` editor routing working. Identity is the first two segments, so renaming a
document never orphans an open editor.

`workspaceId` here means the workspace tenant that **stores** the document,
which is not the tenant the session was opened against: a project shows the
documents of its parent workspace, and the session is keyed by the project. The
two ids genuinely differ, which is why the message carries its own rather than
reusing the handshake's scope.

**Conflicts.** The gear's `PUT` carries no version, so the resource does not
claim optimistic concurrency. It reports `updated_at` as the editor's version
marker — enough for the markdown editor's external-change detection (Compare /
Reload from Disk / Keep Local) — and last write wins if two sessions really do
race. The prototype portal takes the other half of that deal: on
`studio.documentSaved` it reloads the row, unless its own textarea holds
unsaved edits, in which case it offers the reload rather than discarding them.
