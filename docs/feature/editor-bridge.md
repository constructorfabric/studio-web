---
type: feature
status: proposed
owner: studio-team
---

# Feature: The editor's bridge

- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-editor-bridge`

- [ ] `p1` - `cpt-studio-feature-editor-bridge`

## Table of Contents

<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [Open a file in the editor](#open-a-file-in-the-editor)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
  - [Shake hands with the IDE](#shake-hands-with-the-ide)
- [4. States (CDSL)](#4-states-cdsl)
  - [Editor Bridge State Machine](#editor-bridge-state-machine)
- [5. Definitions of Done](#5-definitions-of-done)
  - [The frame handler says when there is a frame, and no more](#the-frame-handler-says-when-there-is-a-frame-and-no-more)
  - [The handshake outlasts a booting frame](#the-handshake-outlasts-a-booting-frame)
  - [Only the frame is heard, and only the frame is told](#only-the-frame-is-heard-and-only-the-frame-is-told)
  - [The IDE works as the member](#the-ide-works-as-the-member)
  - [The IDE follows the portal's theme](#the-ide-follows-the-portals-theme)
  - [The file the member opened is open](#the-file-the-member-opened-is-open)
  - [The editor is ready when the IDE answers](#the-editor-is-ready-when-the-ide-answers)
  - [A request for a component's page is answered](#a-request-for-a-components-page-is-answered)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

## 1. Feature Context

### 1.1 Overview

The editor's frame gets its conversation. Once the project's session is in the
frame ([the editor's session](editor-session.md)), the shell speaks the
`postMessage` contract the IDE's bridge already implements
(`docs/theia-bridge-contract-v1.md` §6): it tells the IDE the portal's theme,
the member's token and who they are, and which file to open, and it takes the
IDE's first answer as the moment the editor is ready.

### 1.2 Purpose

Until this, the frame showed an IDE with its own theme, no token — so no AI —
no author identity and no file open: the member clicked a file and landed in an
empty workspace. The prototype has spoken the contract since #293; the IDE's
side is `theia/studio/src/browser/portal-bridge-contribution.ts`.

**Assumptions fixed here**, because the issue or the design is silent or wrong
and each changes the code:

- **The contract is the bridge on `main`, not the old §6.** §6 had stopped on
  2026-09-18 and missed half the messages; it is brought up to the bridge, with
  the bridge's tests as the source, and nothing is invented beyond it.
- **The bridge listens late, and answers once.** It starts listening only after
  the session's origin rules have arrived over its websocket and drops what came
  before; it answers only the first `studio.init` it accepts. So the portal
  repeats the init every two seconds and takes any `studio.*` message as the
  answer.
- **The module knows the frame, not the shell.** `src-app/app/mfe/editorBridge.ts`
  has no React and no `app`, so it can move into the frame handler unchanged
  when that becomes a platform component. The shell feeds it: the token from
  `app.auth` — never a shared property, which would put it in the type system's
  store — the viewer from the session profile, the project's id and name, the
  theme and the file.
- **The handler learns nothing of Theia.** `MfeHandlerIframe` gains one generic
  hook, told of every frame it makes; the shell attaches the bridge there for
  `space-mfe`'s entry only (ADR-0021 keeps the IDE out of the handler).
- **A new address is a new frame.** The handler used to change `src` on the
  frame it had. Another address is another session: the bridge starts over with
  it, and the frame's own history no longer piles up in the browser's back
  button.
- **Only files open.** The new portal opens no products, gears, documents or
  graphs in the editor, and the shell knows no project type
  (`ProjectConfig.mode` is `greenfield | modernize`), so `studio.openInEditor`
  is the one opening message. Its path is the source's checkout directory
  (`checkoutDirectory`, the rule `sessionSources` names directories by) joined
  with the artifact's path: without the directory the IDE takes the first match
  in any root, and two repositories with a `README.md` are confused.
- **Ready is the IDE's word.** The launching state lasts until the IDE answers,
  on every load of the frame, a live session's included: before that the frame
  holds Theia's boot, and an IDE without the token or the file. The backend
  calls a session ready when its gate takes a connection, before Theia serves,
  so an IDE that stays silent fails only two minutes after its address was
  published, and never while a launch is in flight; its bridge is still asked,
  so a late answer still opens the editor.
- **No sandbox.** On a stand the IDE is on the portal's origin, where a sandbox
  without `allow-same-origin` breaks its websocket and one with it can be lifted
  from inside; §6 says so, and what that exposes.
- **What is not spoken.** `studio.notify` (the portal's notices show over the
  editor anyway), `studio.documentSaved` (no portal documents open in this
  editor), `studio.status` beyond the answer (unsaved edits are #582) and the UI
  language, which the bridge has no field for. `studio.openComponent` has no
  page to land on yet (#583); the member is told so.

**Requirements**: `cpt-studio-fr-ide-session`

**Principles**: `cpt-studio-principle-credentials-by-reference`

### 1.3 Actors

Actor ids are defined in the [PRD](../prd/constructor-studio.md); a gear taking part is cited by its design component id.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** (`cpt-studio-actor-member`) | Opens a file, switches files, changes the theme, works in the IDE. |
| **Shell** (`cpt-studio-actor-shell`) | Attaches the bridge to the editor's frame, feeds it, draws the editor's state from the IDE's answer. |
| **Session** (`cpt-studio-actor-session`) | The IDE in the frame. Answers the handshake, opens what it is told, asks for a component's page. |

### 1.4 References

- **PRD**: [PRD](../prd/constructor-studio.md)
- **Design**: [DESIGN](../design/constructor-studio.md), interface `cpt-studio-interface-portal-ide-bridge`
- **Decomposition**: [DECOMPOSITION](../decomposition/constructor-studio.md), entry `cpt-studio-feature-editor-bridge`
- **Contract**: [`docs/theia-bridge-contract-v1.md` §6](../theia-bridge-contract-v1.md#6-portal--ide-browser-channel-postmessage)
- **Feature**: [The editor's session](editor-session.md) — the address, and the state this feature ends
- **ADR**: [ADR-0021 — an MFE entry may be a frame](../adr/0021-an-mfe-entry-may-be-a-frame.md), [ADR-0030 — a shared session is many people, each as themselves](../adr/0030-a-shared-session-is-many-people-each-as-themselves.md)
- **Issues**: #323 (this), #310 (the editor epic), #582 (unsaved edits on leaving the editor), #583 (the component's page)

## 2. Actor Flows (CDSL)

Unchecked on purpose, for the reason stated in `project-create.md`: a checked
flow obliges every instruction to carry a code marker, and this one spans the
router, the shell's effects, the frame handler and the IDE.

**Use case**: edit a project's file in the IDE.

### Open a file in the editor

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-editor-bridge-open`

**Actor**: Member

**Success Scenarios**:
- The IDE answers; the file is open, in the documents perspective when it is markdown, in the portal's theme, signed in as the member.
- The member opens another file while the editor stays on screen; the IDE opens it, and the frame does not reload.

**Error Scenarios**:
- The IDE never answers; two minutes after the address the editor says so and offers to try again, which makes a new frame.
- The IDE asks for a component's page; the portal says it has no catalogue yet.

**Steps**:
1. [ ] - `p1` - Member opens a file of the project; the shell navigates to the editor screen - `inst-1`
2. [ ] - `p1` - The project's session is reused or launched, and its address published (`cpt-studiofrontend-flow-editor-session-open`) - `inst-2`
3. [ ] - `p1` - The editor stays launching until the IDE answers - `inst-3`
4. [ ] - `p1` - The frame handler makes a frame for the address; the shell attaches the bridge to it and gives it the file - `inst-4`
5. [ ] - `p1` - **IF** the editor shows another file while it stays on screen: tell the IDE to open it - `inst-5`
6. [ ] - `p1` - **RETURN** the file open in the IDE - `inst-6`

## 3. Processes / Business Logic (CDSL)

### Shake hands with the IDE

- [ ] `p1` - **ID**: `cpt-studiofrontend-algo-editor-bridge-handshake`

**Input**: the editor's frame, and what the shell has to say.

**Output**: the IDE answered, and told everything that waited.

**Steps**:
1. [ ] - `p1` - **ON** a load of the frame: **IF** the IDE had answered, report that it loads again - `inst-1`
2. [ ] - `p1` - Post `studio.init`, read afresh, to the origin of the frame's address, and again every two seconds - `inst-2`
3. [ ] - `p1` - **ON** a message: drop it unless it comes from the frame's window, from that origin, with a `studio.*` type - `inst-3`
4. [ ] - `p1` - **IF** it is the first since the load: stop repeating, post what waited in order, report the answer - `inst-4`
5. [ ] - `p1` - **IF** it is `studio.openComponent` with a name: hand the name to the shell - `inst-5`
6. [ ] - `p1` - **ON** a message to post: send it if the IDE has answered, otherwise keep it, only the latest of its type - `inst-6`

## 4. States (CDSL)

### Editor Bridge State Machine

- [ ] `p1` - **ID**: `cpt-studiofrontend-state-editor-bridge`

**States**: Waiting, Answered

**Initial State**: Waiting

**Transitions**:
1. [ ] - `p1` - **FROM** Waiting **TO** Answered **WHEN** a `studio.*` message arrives from the frame's window and origin - `inst-1`
2. [ ] - `p1` - **FROM** Answered **TO** Waiting **WHEN** the frame loads again; the editor is launching until the next answer - `inst-2`
3. [ ] - `p1` - **FROM** Waiting **TO** Waiting **WHEN** the frame loads while nothing has answered — the gate's splash refreshing itself; the repeat starts over, once - `inst-3`

The frame going — the address cleared or replaced, the editor left — ends the
bridge in either state.

## 5. Definitions of Done

### The frame handler says when there is a frame, and no more

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-bridge-frame`

The frame handler **MUST** tell its `onFrame` hook of every frame it makes,
before the frame loads and with its address set, and **MUST** call what the hook
returned when that frame goes. It **MUST** make a new frame for a new address
rather than change `src`, **MUST NOT** put the frame in a `sandbox`, and
**MUST** allow it the clipboard. A hook that throws **MUST NOT** take the frame
down. The shell **MUST** attach the bridge to `space-mfe`'s entry only.

**Implements**:
- `cpt-studiofrontend-flow-editor-bridge-open`

**Touches**:
- Entities: `MfeHandlerIframe`, `FrameHook`, `EDITOR_FRAME_ENTRY`, `main.tsx`

### The handshake outlasts a booting frame

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-bridge-handshake`

The system **MUST** post `studio.init` on every load of the frame and every two
seconds after it until any `studio.*` message answers, reading its payload
afresh each time, and **MUST** hold every other message until then — only the
latest of each type — and post it in order after the answer. It **MUST NOT**
post again what it already delivered when the frame loads again.

**Implements**:
- `cpt-studiofrontend-algo-editor-bridge-handshake`
- `cpt-studiofrontend-state-editor-bridge`

**Touches**:
- Entities: `connectEditorBridge`, `INIT_REPEAT_MS`

### Only the frame is heard, and only the frame is told

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-bridge-sender`

The system **MUST** ignore a message whose source is not the frame's window or
whose origin is not the origin of the frame's address, and one without a
`studio.` type. It **MUST** post only to that origin, never to `*`, and
**MUST NOT** read the portal's `location` for it.

**Implements**:
- `cpt-studiofrontend-algo-editor-bridge-handshake`

**Touches**:
- Entities: `connectEditorBridge`

### The IDE works as the member

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-bridge-init`

`studio.init` **MUST** carry the theme, the member's token, the project's id as
`workspaceId`, its name as `workspaceName` once known, and `viewer` as
`{ sub, name, email, kind: 'person' }` from the session profile. Every renewal
of the token **MUST** reach the IDE as `studio.token`, always with `viewer`. The
token **MUST NOT** become a shared property.

**Implements**:
- `cpt-studiofrontend-flow-editor-bridge-open`

**Touches**:
- Entities: `editorSessionEffects`, `readSessionProfile`, `app.auth`

### The IDE follows the portal's theme

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-bridge-theme`

The system **MUST** tell the IDE `'light'` for the portal's `default` and
`light` themes and `'dark'` for every other, in the init and whenever the
portal's theme changes, without reloading the frame.

**Implements**:
- `cpt-studiofrontend-flow-editor-bridge-open`

**Touches**:
- Entities: `editorTheme`, `app.themeRegistry`

### The file the member opened is open

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-bridge-file`

The system **MUST** send `studio.openInEditor` for a `file` artifact once per
file — to every new frame, and again when the editor shows another file while
it stays on screen — with the path from the workspace root: the checkout
directory of the artifact's repository, then its path. A repository the project
does not list **MUST** fall back to the artifact's path alone.

**Implements**:
- `cpt-studiofrontend-flow-editor-bridge-open`

**Touches**:
- Entities: `checkoutDirectory`, `editorSessionEffects`, `materialize`

### The editor is ready when the IDE answers

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-bridge-answer`

The editor **MUST** stay launching until the IDE in its frame answers, on every
load of the frame. It **MUST** fail as not answered when the IDE has said
nothing two minutes after its address was published, **MUST NOT** fail so while
a launch is in flight, and **MUST** turn ready when a late answer comes. Try
again **MUST** make a new frame.

**Implements**:
- `cpt-studiofrontend-flow-editor-bridge-open`
- `cpt-studiofrontend-state-editor-session`

**Touches**:
- Entities: `editorSessionEffects`, `editorSessionSlice`, `EditorSessionStatus`

### A request for a component's page is answered

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-editor-bridge-component`

A `studio.openComponent` from the IDE **MUST** show the member that the portal
has no component catalogue yet, until #583 gives it a page.

**Implements**:
- `cpt-studiofrontend-flow-editor-bridge-open`

**Touches**:
- Entities: `editorSessionEffects`, `shell:editor_component_unavailable`

## 6. Acceptance Criteria

- [ ] Opening a file shows the editor with that file open; a markdown file opens in the documents perspective.
- [ ] Opening another file while the editor is on screen opens it without reloading the frame.
- [ ] Changing the portal's theme changes the IDE's without reloading the frame.
- [ ] The IDE's AI answers; a commit made in the IDE carries the member's name and email; the IDE names the workspace after the project.
- [ ] After the portal renews its token, the IDE's AI still answers.
- [ ] "Open in catalogue" in the IDE shows the portal's notice.
- [ ] A message posted to the portal from another window or origin changes nothing.
- [ ] An IDE that never answers ends as "The editor did not answer" two minutes after its address; Try again brings up a new frame.
- [ ] Tests with a stubbed frame cover the queue, the repeat, the re-arm, the theme mapping, the path and the sender checks; the handler's tests cover the hook and the frame per address.

**Out of scope**: `studio.notify`; `studio.documentSaved`; unsaved edits on
leaving the editor (#582); `studio.openProduct`, `studio.openGear`,
`studio.openDocument` and `studio.openGraph`, until the portal has entry points
for them; the component's page (#583); the UI language inside the frame; a
separate origin for `/studio/`.
