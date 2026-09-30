---
type: feature
status: proposed
owner: studio-team
---

# Feature: The editor's session

- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-editor-session`

- [ ] `p1` - `cpt-studio-feature-editor-session`

## Table of Contents

<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [Open the editor of a project](#open-the-editor-of-a-project)
  - [Try again after a failed launch](#try-again-after-a-failed-launch)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
  - [Turn the project's sources into session sources](#turn-the-projects-sources-into-session-sources)
  - [Reuse or launch the project's session](#reuse-or-launch-the-projects-session)
  - [Wait for a starting session](#wait-for-a-starting-session)
- [4. States (CDSL)](#4-states-cdsl)
  - [Editor Session State Machine](#editor-session-state-machine)
- [5. Definitions of Done](#5-definitions-of-done)
  - [One session per project](#one-session-per-project)
  - [The session clones the project's repositories](#the-session-clones-the-projects-repositories)
  - [No personal credential reaches the shared session](#no-personal-credential-reaches-the-shared-session)
  - [Opening the editor reuses or launches](#opening-the-editor-reuses-or-launches)
  - [Readiness is the backend's run, followed to its end](#readiness-is-the-backends-run-followed-to-its-end)
  - [Each launch gets its own readiness run](#each-launch-gets-its-own-readiness-run)
  - [A session that answers is not made to wait](#a-session-that-answers-is-not-made-to-wait)
  - [The event client replays from the cursor it is given](#the-event-client-replays-from-the-cursor-it-is-given)
  - [Trying again resumes the wait](#trying-again-resumes-the-wait)
  - [The address lives only in the frame property](#the-address-lives-only-in-the-frame-property)
  - [Launching and failure are on screen](#launching-and-failure-are-on-screen)
  - [A project switch abandons the launch in flight](#a-project-switch-abandons-the-launch-in-flight)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

## 1. Feature Context

### 1.1 Overview

The editor screen (`space-mfe`, a frame entry) gets a real address: the
project's Theia session, reused when one is alive and launched when not. The
shell owns the session — it asks for it, follows the backend's wait until it
ends, and hands its address to the frame through the frame property and
nowhere else.

### 1.2 Purpose

Opening a file already navigates to the editor screen (#320, #321), but the
frame shows a static page: the portal has no notion of sessions at all. The
prototype launches a session, waits for it and mounts its space
(`studio-frontend-prototype/src/App.tsx`, `startStudioSession`); this feature
does the same in the shell, and is the address that #323 then talks to.

**Assumptions fixed here**, because the issue or the design is silent or wrong
and each changes the code:

- **The session is the project's.** The backend confirmed on 2026-09-29 that
  for now a session is shared per project, so the project's tenant id is what
  goes into `workspace_id`. The backend keys everything by that id (session id,
  Pod name, directory) and decides access by reading that tenant under the
  caller's identity (`studio_session/access.rs`); Theia reads the tenant's type
  and scopes itself to a project with its parent workspace
  (`theia/studio/src/browser/analyze-studio-client.ts`, `scope`). The PRD's
  "per workspace" (`cpt-studio-fr-ide-session`) predates projects as tenants.
- **The portal sends the repositories.** A new managed session clones exactly
  the `repos` of its launch request and prunes anything else
  (`studio_session/service.rs`, `rewrite_workspace_toml`,
  `prune_stale_sources`); the backend reads no project settings itself. A
  launch with `{ workspace_id }` alone is therefore an empty IDE. The sources
  are the project's `cf.studio.project.config.v1~` `sources`, the ones the
  wizard writes and the artifacts screen reads.
- **Credentials go by reference, and never a personal one.** A source's
  credential is its connection's `secret_ref`, resolved by the backend under
  the launcher and placed in the container's environment for its credential
  helper (`theia/docker/git-credentials.mjs`). The session is shared, so a
  `personal` connection's token would serve every member of the project; it is
  not sent. This is interim: ADR-0030 moves repository access to `studio-git`
  under each person's own token, and then no `token_ref` is sent at all.
- **The launch is lazy.** A session starts when the editor screen opens with a
  project, not when a project is opened: a session is a container, and most
  visits to a project never reach the editor. It is asked for once per stay on
  the editor: a file switch inside it asks nothing, leaving and coming back
  asks again.
- **The IDE is in a same-origin frame, for now.** On a stand the session's
  address is `/studio/{id}/` on the portal's own origin, and `MfeHandlerIframe`
  sets no `sandbox` — Theia needs `allow-same-origin` and `allow-scripts`, and
  with both on one origin `sandbox` isolates nothing. Script that runs inside
  the IDE's page — an extension, a repository's own tooling, another member at
  a terminal of the shared session — can reach `window.parent` and the portal's
  `sessionStorage`, where the refresh token of whoever has the editor open is
  kept. This is accepted here as it has been for the prototype on the same
  stands (a local Docker backend answers on another port, so on another
  origin). #323 kept it that way — no `sandbox`, for the reasons in the
  contract's §6 (`docs/theia-bridge-contract-v1.md`, Trust); a separate origin
  for `/studio/` is the step if the boundary has to hold.
- **Leaving the editor does not stop the session.** Stopping is the backend's
  (`session.reap`). Unsaved buffers are still lost when the frame unmounts;
  that is #582, not this feature's.
- **The shell draws the states.** It owns the session, so it says what the
  session is doing — over the editor's slot, in the shell's own components and
  translations. The frame handler keeps its generic waiting state.
- **The address comes with the launch.** `POST /sessions` answers with `url`
  even while the session is `starting`: the address is fixed at launch (a
  loopback port, or `/studio/{id}/`, `service.rs` `session_url`) and so is the
  gate token. The shell holds it and publishes it once the session is ready;
  no read after the launch is needed to learn it. It is published as it is:
  a stand answers it relative, same origin through the proxy, and a local
  backend on `public_host: localhost`, the same site as a portal on
  `localhost`; a portal on any other origin is refused by `allowed_origins`
  anyway.
- **The backend owns the wait; the portal follows it.** The launch's
  `ready_run_id` is a `session.await_ready` run that probes the container
  (`studio_session/ready_task.rs`). It retries on its own — three minutes an
  attempt, five attempts — and its end is the answer. The portal sets no
  deadline of its own. It reads the session record only where there is no run
  to follow: a deployment without `studio-tasks`.
- **A run handed back may be older than the request.** The queue returns an
  existing run for the same idempotency key in any state
  (`tasks/service.rs`, `find_by_idempotency_key`). A 200 for a `starting`
  session can therefore carry a run that has already ended, whose events are
  before the cursor. The portal reads that run once before it waits.
- **The backend's readiness is fixed in this feature, in two places.** Today a
  relaunch is handed the first launch's run: the probe is queued with
  `idempotency_key = session_id`, the session id is a UUIDv5 of the project
  (`session_id_for`), a unique index forbids a second run with that key
  (`tasks/migrations.rs`), and runs in a member's tenant are never pruned — the
  retention sweep prunes only the platform tenant (`tasks/sweep.rs`). And a
  replica that has not probed a session itself lists it as `starting` after a
  restart or on another replica (`service.rs`, `refresh`), so a live IDE is
  answered as `starting` with an old run. The key becomes one launch's
  (`cpt-studiofrontend-dod-editor-session-probe-key`), and a listed `starting`
  session is probed once before a run is queued
  (`cpt-studiofrontend-dod-editor-session-probe-first`).
- **Trying again resumes the wait.** A run that gave up on a container still
  starting is put back on the queue (`POST /studio-tasks/v1/runs/{id}/retry`),
  not replaced by a new launch: the session is shared, and stopping it could
  throw out a member who just reached it.

**Requirements**: `cpt-studio-fr-ide-session`, `cpt-studio-nfr-credential-isolation`

**Principles**: `cpt-studio-principle-credentials-by-reference`

### 1.3 Actors

Actor ids are defined in the [PRD](../prd/constructor-studio.md); a gear taking part is cited by its design component id.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** (`cpt-studio-actor-member`) | A member of the project. Opens a file, waits for the editor, retries a failed launch. |
| **Shell** (`cpt-studio-actor-shell`) | Reads the project's sources, launches or reuses the session, follows its readiness, publishes its address, draws its state. |
| **Session** (`cpt-studio-actor-session`) | The Theia container behind the gate. Answers once it is serving. |

### 1.4 References

- **PRD**: [PRD](../prd/constructor-studio.md)
- **Design**: [DESIGN](../design/constructor-studio.md), sequence `cpt-studio-seq-open-ide-session`
- **Decomposition**: [DECOMPOSITION](../decomposition/constructor-studio.md), entry `cpt-studio-feature-editor-session`
- **Feature**: [Levels in the shell](shell-levels.md) — the editor screen and its address (`cpt-studiofrontend-dod-shell-levels-artifact-address`)
- **Feature**: [The editor's bridge](editor-bridge.md) — the IDE's answer ends the launching state (#323)
- **Feature**: [Create a project](project-create.md) — where the sources are written
- **Feature**: [Project artifacts](project-artifacts.md) — the same sources and connections, resolved for the import
- **ADR**: [ADR-0003 — Theia sessions](../adr/0003-theia-sessions.md), [ADR-0010 — a project is an AM tenant](../adr/0010-projects-are-am-tenants.md), [ADR-0021 — an MFE entry may be a frame](../adr/0021-an-mfe-entry-may-be-a-frame.md), [ADR-0026 — studio-events](../adr/0026-studio-events-push-channel.md), [ADR-0030 — a shared session is many people, each as themselves](../adr/0030-a-shared-session-is-many-people-each-as-themselves.md)
- **Issues**: #322 (this), #310 (the editor epic), #323 (the editor's bridge), #582 (unsaved edits on leaving the editor)
- **Dependencies**: studio-session (`/cf/studio-session/v1`, and its readiness probe in `studio-backend/src/studio_session/`), studio-tasks (`/cf/studio-tasks/v1`), studio-events (`/cf/studio-events/v1`), account-management (`/cf/account-management/v1`), studio-connector (`/cf/studio-connector/v1`)

## 2. Actor Flows (CDSL)

Unchecked on purpose, for the reason stated in `project-create.md`: a checked
flow obliges every instruction to carry a code marker, and these span the
router, the shell's effects and the frame.

**Use case**: edit a project's file in the IDE.

### Open the editor of a project

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-editor-session-open`

**Actor**: Member

**Success Scenarios**:
- The project's session is alive; the IDE is in the frame at once, without a reload when the address is the one already shown.
- The project has no session; the member sees it being launched, and the IDE appears in the frame when it answers.

**Error Scenarios**:
- Sessions are off in this deployment, or there is no capacity for one (503); the editor says so with the backend's own words.
- The member no longer reaches the project (404); the editor says the project is not available.
- The project's sources or the organization's connections cannot be read; nothing is launched, and the editor says the launch failed.
- The backend's wait gives up on the session; the editor says why and offers to try again.

**Steps**:
1. [ ] - `p1` - Member opens a file of the project; the shell navigates to the editor screen - `inst-1`
2. [ ] - `p1` - The route is materialized on the editor screen with a project in scope - `inst-2`
3. [ ] - `p1` - Reuse or launch the project's session - `inst-3`
4. [ ] - `p1` - Publish the session's address to the frame property - `inst-4`
5. [ ] - `p1` - **RETURN** the IDE in the editor's frame - `inst-5`

### Try again after a failed launch

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-editor-session-retry`

**Actor**: Member

**Success Scenarios**:
- The session is gone; the launch starts a new one with its own run, and the IDE appears.
- The session is still starting and its run gave up; the run is put back on the queue, and the IDE appears when it answers.
- Another member already tried again; the run is already queued, and it is followed.

**Error Scenarios**:
- It fails again; the editor says why, as the first time.

**Steps**:
1. [ ] - `p1` - Member activates "Try again" on the failed editor - `inst-1`
2. [ ] - `p1` - Reuse or launch the project's session, from the start - `inst-2`
3. [ ] - `p1` - **IF** the launch hands back a run that failed or was cancelled - `inst-3`
   1. [ ] - `p1` - Read the cursor, then `API: POST /cf/studio-tasks/v1/runs/{id}/retry` - `inst-4`
   2. [ ] - `p1` - **IF** the retry is refused because the run is already queued or running - `inst-5`
      1. [ ] - `p1` - Follow it as it is - `inst-6`
   3. [ ] - `p1` - Wait for the session on that run - `inst-7`
4. [ ] - `p1` - **RETURN** the IDE in the frame, or the failure again - `inst-8`

## 3. Processes / Business Logic (CDSL)

### Turn the project's sources into session sources

- [ ] `p1` - **ID**: `cpt-studiofrontend-algo-editor-session-sources`

**Input**: the project's configured sources, the organization's connections

**Output**: the `repos` of a launch request

**Steps**:
1. [ ] - `p1` - **FOR EACH** source with a `clone_url`, in the order the project stores them; one without it has nothing to clone, and the backend refuses a git source without a url - `inst-1`
   1. [ ] - `p1` - Name its directory after the last segment of `full_path`, lower-cased, with every character outside `[a-z0-9_-]` replaced by `-` - `inst-2`
   2. [ ] - `p1` - **IF** the name is already taken by an earlier source, suffix it with `-2`, `-3`, … - `inst-3`
   3. [ ] - `p1` - Take the credential reference from the connection with the source's `connection_id`; none when the organization no longer has it, and none when its `scope` is `personal` - `inst-4`
   4. [ ] - `p1` - Emit `{ name, kind: 'git', url: clone_url, token_ref }` - `inst-5`
2. [ ] - `p1` - **RETURN** the sources, possibly none - `inst-6`

### Reuse or launch the project's session

- [ ] `p1` - **ID**: `cpt-studiofrontend-algo-editor-session-launch`

**Input**: the project in scope, the organization in scope

**Output**: the address of a serving session, or a failure with its reason

**Steps**:
1. [ ] - `p1` - `API: GET /cf/studio-events/v1/events?after_seq=0&limit=1` for the tenant's cursor, past the shared fetch cache, before anything is launched - `inst-1`
2. [ ] - `p1` - `API: GET /cf/account-management/v1/tenants/{project}/metadata/{project config type}` and `API: GET /cf/studio-connector/v1/connections?tenant={org}` - `inst-2`
3. [ ] - `p1` - **IF** either read fails - `inst-3`
   1. [ ] - `p1` - **RETURN** failed, without launching: a session launched without its sources or credentials would be reused as it is - `inst-4`
4. [ ] - `p1` - Turn the sources into session sources - `inst-5`
5. [ ] - `p1` - `API: POST /cf/studio-session/v1/sessions (workspace_id = project, repos)` — 200 for a live session, 201 for a new one - `inst-6`
6. [ ] - `p1` - **IF** the answer is 503, 404 or any other refusal - `inst-7`
   1. [ ] - `p1` - **RETURN** failed with the reason and the problem's `detail` - `inst-8`
7. [ ] - `p1` - Keep the answer's `url`, unpublished - `inst-9`
8. [ ] - `p1` - **IF** the session is `starting` - `inst-10`
   1. [ ] - `p1` - Wait for it - `inst-11`
9. [ ] - `p1` - **IF** the session is not `running`, or the wait failed - `inst-12`
   1. [ ] - `p1` - **RETURN** failed; a retry launches again and is handed the same run - `inst-13`
10. [ ] - `p1` - **RETURN** the kept `url`, as it is - `inst-15`

### Wait for a starting session

- [ ] `p1` - **ID**: `cpt-studiofrontend-algo-editor-session-wait`

**Input**: the launch's answer (its status and record), the cursor read before it

**Output**: ready, or a failure with its reason and its run

**Steps**:
1. [ ] - `p1` - **IF** the record carries `ready_run_id` - `inst-1`
   1. [ ] - `p1` - `API: GET /cf/studio-events/v1/stream` from the cursor, for the `task.*` events whose `subject_id` is that run - `inst-2`
   2. [ ] - `p1` - Before waiting on the stream — the run may be one this launch did not queue, and the client does not tell a 200 from a 201 - `inst-3`
      1. [ ] - `p1` - `API: GET /cf/studio-tasks/v1/runs/{id}` once, past the shared fetch cache - `inst-4`
      2. [ ] - `p1` - **IF** it `succeeded` - `inst-5`
         1. [ ] - `p1` - **RETURN** ready - `inst-6`
      3. [ ] - `p1` - **IF** it `failed` or was `cancelled` - `inst-7`
         1. [ ] - `p1` - **RETURN** failed with the run's `last_error` - `inst-8`
      4. [ ] - `p1` - **IF** the read fails for a reason other than 404 — the run may have ended before the cursor, and the stream would never say - `inst-26`
         1. [ ] - `p1` - Read the run every two seconds instead of the stream, as in `inst-16` - `inst-27`
   3. [ ] - `p1` - **IF** `task.succeeded` - `inst-9`
      1. [ ] - `p1` - **RETURN** ready; the address is the launch's, so nothing is read - `inst-10`
   4. [ ] - `p1` - **IF** `task.failed` or `task.cancelled` - `inst-11`
      1. [ ] - `p1` - **RETURN** failed with the run's error - `inst-12`
   5. [ ] - `p1` - **IF** `task.queued` or `task.progress` — the backend is retrying or still probing - `inst-13`
      1. [ ] - `p1` - Stay launching - `inst-14`
   6. [ ] - `p1` - **IF** the stream fails, or cannot replay what it missed - `inst-15`
      1. [ ] - `p1` - `API: GET /cf/studio-tasks/v1/runs/{id}` every two seconds, past the shared fetch cache, and answer from its state as from the events - `inst-16`
      2. [ ] - `p1` - **IF** five reads in a row fail for a reason other than 404 - `inst-28`
         1. [ ] - `p1` - **RETURN** failed: the state could not be read; the first failure is logged - `inst-29`
2. [ ] - `p1` - **IF** there is no `ready_run_id` — a deployment without `studio-tasks` - `inst-17`
   1. [ ] - `p1` - `API: GET /cf/studio-session/v1/sessions/{id}` every two seconds, past the shared fetch cache; the read itself probes the container - `inst-18`
   2. [ ] - `p1` - **IF** the record says `running` - `inst-19`
      1. [ ] - `p1` - **RETURN** ready - `inst-20`
   3. [ ] - `p1` - **IF** the record says `stopped`, or the session is gone (404) - `inst-21`
      1. [ ] - `p1` - **RETURN** failed - `inst-22`
   4. [ ] - `p1` - **IF** five reads in a row fail for a reason other than 404 - `inst-30`
      1. [ ] - `p1` - **RETURN** failed: the state could not be read - `inst-31`
   5. [ ] - `p1` - **IF** three minutes pass — one attempt of the backend's own probe, since nobody else waits here - `inst-23`
      1. [ ] - `p1` - **RETURN** failed: not ready in time - `inst-24`
3. [ ] - `p1` - Close the stream and stop reading as soon as there is an answer - `inst-25`

## 4. States (CDSL)

### Editor Session State Machine

- [ ] `p1` - **ID**: `cpt-studiofrontend-state-editor-session`

**States**: Idle, Launching, Ready, Failed

**Initial State**: Idle

**Transitions**:
1. [ ] - `p1` - **FROM** Idle **TO** Launching **WHEN** the editor screen is materialized with a project in scope and the launch answers `starting`, or a frame is made for the session's address — the address published, or the editor mounted on the one already published; until then the frame's own waiting state shows - `inst-1`
2. [ ] - `p1` - **FROM** Launching **TO** Ready **WHEN** the IDE in the frame answers ([editor bridge](editor-bridge.md)); a session the backend calls running is not yet an editor - `inst-2`
3. [ ] - `p1` - **FROM** Idle or Launching **TO** Failed **WHEN** a read before the launch fails, the launch is refused, or the run ends without the session running; or the IDE has not answered two minutes after its address was published, with no launch in flight - `inst-3`
4. [ ] - `p1` - **FROM** Failed **TO** Launching **WHEN** the member tries again — the frame is made anew — or opens the editor of the project again - `inst-4`
5. [ ] - `p1` - **FROM** Ready **TO** Launching **WHEN** the editor is opened again for the same project — a new frame loads the IDE — or the IDE's page loads again; a changed address is republished, a session that has to be launched again waits for its run, and a refusal moves to Failed - `inst-5`
6. [ ] - `p1` - **FROM** any state **TO** Idle **WHEN** the project in scope changes or is closed; the address is cleared - `inst-6`
7. [ ] - `p1` - **FROM** Failed **TO** Ready **WHEN** the IDE answers after all: its bridge is still being asked - `inst-7`

## 5. Definitions of Done

### One session per project

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-session-per-project`

The system **MUST** launch the session with the project's tenant id as
`workspace_id`, and **MUST** decide that in one place.

One place, because the backend's answer was "for now": should the session
become the workspace's, one line changes and not every caller.

**Implements**:
- `cpt-studiofrontend-algo-editor-session-launch`

**Touches**:
- API: `POST /cf/studio-session/v1/sessions`
- Entities: `StudioSessionApiService`, `editorSessionEffects`

### The session clones the project's repositories

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-session-sources`

The system **MUST** send the project's configured sources as the launch's
`repos`, naming each directory by the rule of
`cpt-studiofrontend-algo-editor-session-sources`, and **MUST** pass a private
repository's credential as the connection's `secret_ref` only, never as a
token.

The directory rule is the convention `project-artifacts.md` notes as missing:
an artifact's `repository` is the source's `full_path`, so the same pure
function tells #323 where a file is inside the checkout. It is exported for
that reason.

**Implements**:
- `cpt-studiofrontend-algo-editor-session-sources`

**Touches**:
- Data: `cf.studio.project.config.v1~` `sources`, `ConnectionDto.secret_ref`
- Entities: `sessionSources`

### No personal credential reaches the shared session

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-session-no-personal-token`

The system **MUST NOT** send a `token_ref` for a connection whose `scope` is
`personal`, and **MUST** decide which credential goes in one place, the
source function.

The session is the project's and its environment is everyone's: the
credential helper answers every member's `git push` with the tokens it holds,
and any terminal can read them. A `personal` token is readable only by its
owner, so it is either the launcher's own — then the whole project pushes as
them — or unreadable, and the backend clones without it. A `workspace` or
`organization` token is readable by the members anyway. The cost is stated:
a private repository connected through a personal connection is not cloned,
and the portal does not see that; the session's log does. One place, because
ADR-0030 moves repository access to `studio-git`, and then no `token_ref` is
sent at all.

**Implements**:
- `cpt-studiofrontend-algo-editor-session-sources`

**Touches**:
- Data: `ConnectionDto.scope`, `ConnectionDto.secret_ref`
- Entities: `sessionSources`

### Opening the editor reuses or launches

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-session-reuse-or-launch`

The system **MUST** ask for the session when the editor comes on screen with a
project, once per stay — a file switch inside it asks nothing, leaving and
coming back asks again — **MUST** rely on the launch being idempotent per
project instead of listing sessions first, and **MUST NOT** launch one for any
other screen.

**Implements**:
- `cpt-studiofrontend-flow-editor-session-open`
- `cpt-studiofrontend-algo-editor-session-launch`

**Touches**:
- API: `POST /cf/studio-session/v1/sessions`
- Entities: `StudioSessionApiService`, `editorSessionEffects`, `materialize`

### Readiness is the backend's run, followed to its end

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-session-ready`

The system **MUST** read the studio-events cursor past the shared fetch cache
before the launch and follow `ready_run_id` from it until the run ends,
**MUST** read that run once before it waits on the stream, **MUST** read the run
every two seconds when the stream fails or cannot replay or when that one read
before the wait fails, **MUST** read the
session record every two seconds only when there is no run, **MUST NOT**
set a deadline of its own while there is a run, and **MUST** end the wait as
failed, with the first failure logged, when the run or the record cannot be
read five times in a row for a reason other than 404.

The run is the backend's wait: it probes the container, retries on its own
and ends with the answer, whether or not a browser watches. A deadline in the
portal would give up on a session the backend is still bringing up — a cold
image pull takes minutes. A reused session can hand back a run this launch did not queue,
already ended and before the cursor, so the stream alone would say nothing;
one read of the run tells. With no run there is nobody else waiting, so the
portal waits for one attempt of the backend's probe, three minutes. The
cursor is read past the cache because a cached `0` would replay nothing.
Reads that keep failing — an expired session, a gateway down — are not the
backend still working, and a wait spinning on them unseen could not be
retried.

**Implements**:
- `cpt-studiofrontend-algo-editor-session-wait`

**Touches**:
- API: `GET /cf/studio-events/v1/stream`, `GET /cf/studio-events/v1/events`, `GET /cf/studio-tasks/v1/runs/{id}`, `GET /cf/studio-session/v1/sessions/{id}`
- Entities: `StudioEventsApiService`, `StudioTasksApiService`, `StudioSessionApiService`

### Each launch gets its own readiness run

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-session-probe-key`

The backend **MUST** queue a launch's readiness probe under a key of that
launch — the session id together with a launch id minted at launch and kept
on the container or Pod as the label `cf.studio.launch_id` — and **MUST** keep
`partition_key` as the session id. A session without the label, launched by an
older backend, **MUST** fall back to the session id with its
`created_at_epoch_secs`.

A backend change inside a frontend feature, because without it every
relaunch of a project is handed its first launch's run, ended long ago, and
the stream says nothing. Not `created_at_epoch_secs`: a launch records the
clock, and the next listing of the runtime replaces it with the runtime's own
creation time (`docker.rs`, `list_adoptable`), so one launch would get two
keys, and a relaunch within the same second would get the old one. A label
is the same answer on every replica and after a restart, so repeated `POST`s
during one launch share one probe. Not the gate token: the key is stored in
the clear. The queue's lookup and its unique index stay as they are; every
task type relies on them.

**Implements**:
- `cpt-studiofrontend-algo-editor-session-wait`

**Touches**:
- Code: `studio-backend/src/studio_session/rest.rs` (`watch_until_ready`), `service.rs` (`create`, `refresh`), `driver.rs` (`AdoptedSession`), `docker.rs` and `k8s.rs` (`list_adoptable`)
- Data: `studio_tasks_runs.idempotency_key`, the runtime label `cf.studio.launch_id`

### A session that answers is not made to wait

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-session-probe-first`

The backend **MUST** probe a session it reuses in the `starting` state once,
before it queues a readiness run, and **MUST** answer `running` without a run
when the IDE answers.

A replica lists a session as `running` only after it has probed it itself, so
after a restart, or on a replica that did not launch it, a live IDE is
`starting` (`service.rs`, `refresh`), and its run is the earlier one of the
same launch. One connect to the port is what the next read would do anyway.

**Implements**:
- `cpt-studiofrontend-algo-editor-session-launch`

**Touches**:
- Code: `studio-backend/src/studio_session/service.rs` (`SessionService::create`, `probe`)

### The event client replays from the cursor it is given

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-session-replay`

The event client **MUST** replay the gap from a starting cursor it was given,
`0` included, and **MUST** report a failed replay to its consumer instead of
dropping it; a stream opened without a starting cursor **MUST** keep running
past a gap it cannot replay, logging it.

Sequences start at 1, so a cursor of `0` read before a launch is a real
starting point: the tenant's first events are the launch's own. Today
`FetchEventSource.replayGap` treats `0` as "nothing seen" and skips the
replay, and swallows a failed one, so a run can end unheard. A stream opened
without a starting cursor keeps skipping the first replay and losing a gap it
cannot replay, as now: nobody waits on it for an answer, and a live view is
better stale than dead. Its consumer's `onComplete` therefore means only
"finished", while `streamFrom`'s also means "cut".

**Implements**:
- `cpt-studiofrontend-algo-editor-session-wait`

**Touches**:
- Code: `studio-frontend/src/api/sse/FetchEventSource.ts`

### Trying again resumes the wait

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-session-retry`

The system **MUST** launch again on "Try again", **MUST** put a run that failed
or was cancelled back on the queue instead of replacing the session, and
**MUST** follow a run that is already queued when the retry is refused for it.

A run that gave up after five attempts leaves a container still `starting`,
with the same launch id, so the launch hands the same run back.
The session is shared: stopping it to get a new run could throw out a member
who reached it meanwhile. A refused retry for a queued run means another
member tried first.

**Implements**:
- `cpt-studiofrontend-flow-editor-session-retry`

**Touches**:
- API: `POST /cf/studio-session/v1/sessions`, `POST /cf/studio-tasks/v1/runs/{id}/retry`
- Entities: `StudioTasksApiService`, `editorSessionEffects`

### The address lives only in the frame property

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-session-address`

The system **MUST** take the session's address from the launch's answer,
**MUST** publish it to `…space.mfe.frame_url.v1~` only once the session is
ready, and **MUST NOT** put it in the browser's address, the store, or a log
line. The shell **MUST NOT** seed that property with any page; it starts as
`null`.

The address carries the gate's `?token=`, and the router now writes the
browser's address. The seed goes because a static page that says "not available
yet" would flash before every real session. `seedFrameUrl` and
`firstFrameUrl` go with it, and the shell names `space-mfe`'s entry only to
attach the editor's bridge to its frame ([editor bridge](editor-bridge.md)); the
iframe fixture reads the same property, so it shows the session's address too.

**Implements**:
- `cpt-studiofrontend-flow-editor-session-open`

**Touches**:
- Shared property: `constructor_studio.space.mfe.frame_url.v1~`
- Entities: `publishFrameUrl`, `seedFrameUrl`, `firstFrameUrl`, `editorSessionSlice`

### Launching and failure are on screen

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-session-states`

The system **MUST** show over the editor's slot that the session is being
launched — until the IDE in the frame answers, not only until the backend calls
it running — and when it failed, why — the problem's `detail` for a 503, "not
available" for a 404, the run's error when it gave up, an IDE that did not
answer, and an unreadable state or the portal's own error each by name — with a
way to try again. The frame's slot **MUST** stay mounted underneath.

A 503 means either sessions are off in this deployment or there is no capacity,
and only the `detail` text tells them apart; the text is shown rather than
matched.

**Implements**:
- `cpt-studiofrontend-state-editor-session`
- `cpt-studiofrontend-flow-editor-session-retry`

**Touches**:
- Entities: `editorSessionSlice`, `EditorSessionStatus`, `MfeScreenContainer`

### A project switch abandons the launch in flight

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-session-switch`

The system **MUST** clear the address and discard the result of a launch that
was started for a project no longer in scope.

**Implements**:
- `cpt-studiofrontend-state-editor-session`

**Touches**:
- Entities: `editorSessionEffects`

## 6. Acceptance Criteria

- [ ] Opening a file of a project with a live session puts the IDE in the frame without a launch; the network shows one `POST` answered 200.
- [ ] Opening a file of a project without one shows that the editor is being launched, then the IDE with the project's repositories checked out.
- [ ] A private repository connected through a workspace or organization connection is cloned with its credential, and no token appears in any request the browser makes.
- [ ] No launch request carries the `token_ref` of a `personal` connection.
- [ ] In a deployment with sessions off, the editor shows the backend's explanation and a way to try again, not an empty frame.
- [ ] A session that does not come up stays launching while the backend retries, and ends in the failed state with the run's error when the backend gives up; nothing keeps asking after that.
- [ ] "Try again" on a session still starting puts its run back on the queue and launches no second session.
- [ ] Opening the editor of a project whose session was stopped earlier brings it back as fast as a first launch: its answer carries a new `ready_run_id`, and the stream reports it.
- [ ] After a backend restart, opening the editor of a project whose IDE is running shows it without waiting on a run.
- [ ] While the stream answers, the browser polls neither the run nor the session record.
- [ ] The browser's address never contains the session's address or its token, before, during or after the launch.
- [ ] Switching the project during a launch never shows the previous project's IDE.
- [ ] Coming back to the editor of the same project launches nothing; the frame loads the IDE again (#582), and the launching state lasts until the IDE answers.
- [ ] Tests cover the reuse, the launch, a failed run, a run handed back already ended, resuming a failed run, the fallback reads, the disabled deployment and the project switch; the source rule on its own, with a personal connection; and the event client's replay from a cursor of `0` and its reported failure.
- [ ] Backend tests launch, stop and relaunch one session and get two different readiness runs; two launches of one `starting` session get the same one; and a reused `starting` session whose IDE answers is answered `running` with no run.

**Out of scope**: the artifact, the theme and the token reaching the IDE
([editor bridge](editor-bridge.md), #323) — the UI language is not carried at
all, the bridge has no field for it; keeping the frame alive across screens, or
asking before unsaved edits are lost (#582); stopping a
session, including one whose run gave up; the gear corpus the prototype adds
to product projects' sessions; repository access through `studio-git` with no
token in the container (ADR-0030); a wizard that does not offer personal
connections for a project's sources; the IDE's own transport — Theia's
WebSocket to its backend runs inside the frame, through the gate, and the
portal never opens it.
