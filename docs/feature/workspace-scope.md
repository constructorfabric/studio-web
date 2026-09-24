---
type: feature
status: accepted
owner: studio-team
---

# Feature: Workspaces in scope

- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-workspace-scope`

- [x] `p1` - `cpt-studio-feature-workspace-scope`

## Table of Contents

<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [Create a workspace](#create-a-workspace)
  - [Switch the workspace in scope](#switch-the-workspace-in-scope)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
  - [Resolve the organization's workspaces](#resolve-the-organizations-workspaces)
  - [Write the workspace](#write-the-workspace)
- [4. States (CDSL)](#4-states-cdsl)
  - [Workspace Slot State Machine](#workspace-slot-state-machine)
- [5. Definitions of Done](#5-definitions-of-done)
  - [The shell owns the workspace list](#the-shell-owns-the-workspace-list)
  - [Every announcement names the scope it was made in](#every-announcement-names-the-scope-it-was-made-in)
  - [The workspace has its own slot next to the organization](#the-workspace-has-its-own-slot-next-to-the-organization)
  - [Creation is an overlay extension with one field](#creation-is-an-overlay-extension-with-one-field)
  - [A created workspace reaches the shell and becomes current](#a-created-workspace-reaches-the-shell-and-becomes-current)
  - [The projects list is rooted at the workspace](#the-projects-list-is-rooted-at-the-workspace)
  - [A project is created inside the current workspace](#a-project-is-created-inside-the-current-workspace)
  - [Without a workspace there is nothing to create a project in](#without-a-workspace-there-is-nothing-to-create-a-project-in)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

## 1. Feature Context

### 1.1 Overview

The workspace a session is working in: created from the Projects list, chosen in
the shell's top bar next to the organization, and applied to everything below —
the Projects list shows that workspace's projects, and a new project is created
inside it.

### 1.2 Purpose

A project is an account-management tenant, and the level it belongs in is the
**workspace** (ADR-0010). Until now the portal had no workspace anywhere: the
Projects list read the organization's children and the wizard created projects
directly under the organization. This feature introduces the missing level.

The backend permits both parents — `allowed_parent_types` for
`cf.studio.tenant.project.v1` names the organization *and* the workspace — so
what the wizard did was accepted rather than refused. The choice made here is
the portal's: every project it creates goes into a workspace, and the list shows
one workspace at a time. A project parented straight to an organization (seeded,
or written by another client) is therefore not listed anywhere; nothing in the
portal produces one.

**Assumptions fixed here**, because the mockups are silent and the choice
changes the code:

- A workspace is created **under the organization** in scope, and carries a name
  and nothing else. There is no description, no template and no member picker:
  account-management accepts `name`, `parent_id` and `tenant_type` on create, and
  a field the backend would drop is not offered.
- The **shell owns** the workspace list, as it already owns the organization
  list: both are account-management tenants the shell reads for the top bar, and
  a list that must exist before any MFE mounts cannot be an MFE's to publish.
- **One workspace is always current** when the organization has any. There is no
  "all workspaces" scope: the tenant API has no subtree read, so a list across
  workspaces would be one request per workspace and still incomplete.
- The **first** workspace of the list becomes current on arrival, and a created
  one becomes current immediately. The selection is not persisted between
  sessions; nothing in the portal persists per-user preferences yet.

**Requirements**: `cpt-studio-fr-workspace-project-tenants`, `cpt-studio-fr-portal-levels`

**Principles**: `cpt-studio-principle-project-is-unit`

### 1.3 Actors

Actor ids are defined in the [PRD](../prd/constructor-studio.md); a gear taking part is cited by its design component id.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** (`cpt-studio-actor-member`) | A signed-in member of the organization in scope. Creates workspaces and chooses the current one. |
| **Shell** (`cpt-studio-actor-shell`) | The portal shell. Reads the organization's workspaces, draws the switcher next to the organization, and publishes the current one to every MFE. |

### 1.4 References

- **PRD**: [PRD](../prd/constructor-studio.md)
- **Design**: [DESIGN](../design/constructor-studio.md)
- **Decomposition**: [DECOMPOSITION](../decomposition/constructor-studio.md), entry `cpt-studio-feature-workspace-scope`
- **ADR**: [ADR-0010 — a project is an AM tenant](../adr/0010-projects-are-am-tenants.md)
- **ADR**: [ADR-0008 — simplified navigation shell](../adr/0008-simplified-navigation-shell.md)
- **Feature**: [Create a project](project-create.md) — the parent it creates under is this feature's answer
- **Dependencies**: account-management (`/cf/account-management/v1`)

## 2. Actor Flows (CDSL)

Unchecked on purpose, for the reason stated in `project-create.md`: a checked
flow obliges every instruction to carry a code marker, and these span the shell,
two MFE roots and the extension plumbing between them. Their evidence is the
acceptance criteria in section 6; the implementation claims they rest on are the
Definitions of Done, which are traced.

**Use case**: work inside a workspace.

### Create a workspace

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-workspace-scope-create`

**Actor**: Member

**Success Scenarios**:
- The workspace appears in the shell's switcher, becomes the current one, and the Projects list is empty and rooted in it.

**Error Scenarios**:
- The name duplicates a sibling workspace; account-management refuses and the form keeps the name.
- There is no organization in scope; the form refuses to submit and says so.
- The workspace is written but the shell never hears it; the overlay stays open and offers to retry the announcement alone, because retrying the creation would write a second workspace under the same name.

**Steps**:
1. [ ] - `p1` - Member activates "New workspace" in the Projects list toolbar - `inst-1`
2. [ ] - `p1` - Mount the workspace overlay extension in the shell's overlay domain - `inst-2`
3. [ ] - `p1` - Reset the form so no abandoned name is carried in - `inst-3`
4. [ ] - `p1` - Member types a name and confirms - `inst-4`
5. [ ] - `p1` - Run `cpt-studiofrontend-algo-workspace-scope-write` - `inst-5`
6. [ ] - `p1` - **IF** account-management refuses - `inst-6`
   1. [ ] - `p1` - **RETURN** the overlay stays open with the name intact and reports the refusal - `inst-7`
7. [ ] - `p1` - Announce the created workspace to the shell so it enters the switcher and becomes current, and wait for the shell to have heard it - `inst-8`
8. [ ] - `p1` - **IF** the announcement does not land - `inst-9`
   1. [ ] - `p1` - **RETURN** the overlay stays open, reports that the workspace exists but was not announced, and offers the announcement alone as the retry - `inst-10`
9. [ ] - `p1` - **RETURN** unmount the overlay extension - `inst-11`

### Switch the workspace in scope

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-workspace-scope-switch`

**Actor**: Member

**Success Scenarios**:
- The Projects list shows the chosen workspace's projects and nothing else.

**Error Scenarios**:
- The organization has no workspace; the switcher shows nothing and "New project" is inert.

**Steps**:
1. [ ] - `p1` - Member opens the workspace slot in the top bar - `inst-1`
2. [ ] - `p1` - Member picks a workspace - `inst-2`
3. [ ] - `p1` - The shell makes it current and publishes it as a shared property - `inst-3`
4. [ ] - `p1` - **IF** a project was open - `inst-4`
   1. [ ] - `p1` - Leave project scope: the open project belongs to the workspace being left - `inst-5`
5. [ ] - `p1` - **RETURN** the Projects list re-roots on the workspace and reads its children - `inst-6`

## 3. Processes / Business Logic (CDSL)

### Resolve the organization's workspaces

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-workspace-scope-resolve`

**Input**: the organization tenant in scope

**Output**: the workspaces to offer, and which of them is current

**Steps**:
1. [x] - `p1` - `API: GET /cf/account-management/v1/tenants/{org}/children?$filter=tenant_type eq '{workspace type}' (one page)` - `inst-1`
2. [x] - `p1` - **IF** the organization in scope is no longer the one this read was made for - `inst-2`
   1. [x] - `p1` - **RETURN** nothing; the answer belongs to an organization that has been left - `inst-3`
3. [x] - `p1` - **IF** the read fails - `inst-4`
   1. [x] - `p1` - **RETURN** the workspaces already in scope, marked unread rather than emptied - `inst-5`
4. [x] - `p1` - Keep the current workspace if it is still in the list, otherwise drop it; which one is opened in its place is the address's to say, and the first is what the shell opens when the address names none (ADR-0028) - `inst-6`
5. [x] - `p1` - **RETURN** the list and the current workspace - `inst-7`

### Write the workspace

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-workspace-scope-write`

**Input**: a name and the organization tenant in scope

**Output**: the created tenant, or the reason it was refused

**Steps**:
1. [x] - `p1` - Trim the name; reject an empty one before any request - `inst-1`
2. [x] - `p1` - `API: POST /cf/account-management/v1/tenants (name, workspace tenant type, parent = organization)` - `inst-2`
3. [x] - `p1` - **IF** account-management refuses - `inst-3`
   1. [x] - `p1` - **RETURN** the refusal; the name survives so the member can correct it - `inst-4`
4. [x] - `p1` - **RETURN** the created tenant's id and name - `inst-5`

## 4. States (CDSL)

### Workspace Slot State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-workspace-scope-slot`

**States**: Unresolved, Empty, Selected

**Initial State**: Unresolved

**Transitions**:
1. [ ] - `p1` - **FROM** Unresolved **TO** Selected **WHEN** the organization's workspaces are read and at least one exists - `inst-1`
2. [ ] - `p1` - **FROM** Unresolved **TO** Empty **WHEN** the organization is read and has no workspace - `inst-2`
3. [ ] - `p1` - **FROM** Empty **TO** Selected **WHEN** a workspace is created - `inst-3`
4. [ ] - `p1` - **FROM** Selected **TO** Unresolved **WHEN** the organization is switched - `inst-4`
5. [ ] - `p1` - **FROM** Unresolved **TO** Unresolved **WHEN** the read fails; the next workspace-scoped screen retries it - `inst-5`
6. [ ] - `p1` - **FROM** Selected **TO** Selected **WHEN** the read fails; the workspace in scope outlives a transient error - `inst-6`

## 5. Definitions of Done

### The shell owns the workspace list

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-workspace-scope-shell-owns`

The system **MUST** read the organization's workspaces in the shell, keep the
current one in the shell's own context state, and publish it to the MFEs as a
shared property — never derive it inside an MFE.

Same split as the organization, and for the same reason: workspaces are
account-management tenants, which the shell already talks to, and the answer is
needed by the top bar before any MFE has mounted. Publishing it is the only
host → child channel that survives an MFE's module realm.

Two rules follow from the shell owning it, and neither is optional:

- A read may only write for the organization it was made for. Organizations are
  switched faster than the list comes back, so every answer — the list and the
  failure alike — is checked against the organization in scope when it arrives,
  and dropped if that is no longer the one it was read for.
- A **failed** read is not an empty one. An organization with no workspace and
  an organization whose workspaces could not be read are different states, and
  the list carries a `pending`/`ready`/`failed` status saying which — the same
  three-way answer the MFE bootstrap status gives the menu, for the same reason.
  A failure leaves the list and the workspace in scope exactly as they were, and
  the next workspace-scoped screen re-reads them.

**Implements**:
- `cpt-studiofrontend-algo-workspace-scope-resolve`

**Touches**:
- API: `GET /cf/account-management/v1/tenants/{id}/children`
- Property: `constructor_studio.context.workspace.selected.v1~`
- Entities: `appContextSlice`, `contextCatalogs`, `materialize`, `sharedContext`

### Every announcement names the scope it was made in

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-workspace-scope-claim`

The system **MUST** carry the scope an announcement was made in on the
announcement itself — the organization for a workspace, the workspace for a
project and for its sibling list — and the shell **MUST** drop an announcement
whose scope is not the one in scope when it arrives, rather than apply it to
whatever is current now. A sender that cannot name its scope **MUST NOT**
announce at all.

The same rule the workspace read already follows, generalised to every writer.
Scopes are switched faster than a gear answers, and an announcement is a read
that has been travelling: a project opened from a list, a workspace named on a
screen, a tenant written by an overlay. Each of them was true of the scope it
was made in and of no other. The scope therefore has to be part of the message
— derived at the receiving end it is only ever "now", which is the one answer
that cannot be checked.

An announcement that is dropped **MUST** take with it everything that was
conditional on it. A selection that also moves the session to another level
carries that request **in the same announcement**, so that the level change
cannot outlive the selection it was asking for: two independent messages leave
the shell free to honour the second after refusing the first, which lands the
session at a level with the previous scope still current.

Omission is not the escape hatch. An absent scope reads as "not claimed" and so
as "cannot be checked", which is the answer the shell's own top-bar slots need —
they *are* the scope in question and have nothing to disagree with. An MFE's
announcement is never in that position, so its scope is required rather than
optional, and a missing one is a refusal to send and not a message the guard
waves through.

**Implements**:
- `cpt-studiofrontend-flow-workspace-scope-switch`
- `cpt-studiofrontend-algo-workspace-scope-resolve`

**Touches**:
- Action: `constructor_studio.context.workspaces.publish.v1~`, `constructor_studio.context.publish.v1~`
- Entities: `appContextEffects`, `contextActions`, `projectsActions`, `workspaceActions`

### The workspace has its own slot next to the organization

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-workspace-scope-slot`

The system **MUST** show the current workspace in the top bar next to the
organization, as its own slot with its own menu, and **MUST** render nothing at
all when the organization has no workspace **or when the mounted screen does not
work in a workspace**.

A second slot rather than a third scope of the existing one: the organization
and the workspace are both in scope at the same time, while the existing slot's
`org`/`project` scopes are alternatives to each other.

Which screens those are is **not** a list kept in the shell. The screen turns the
slot on for itself, by executing the workspaces action against the screen domain
when it mounts; the shell turns it off when the drawer mounts another screen.
That is the mechanism the project slot beside it already uses, and one top bar
governed by one mechanism is worth more than either rule chosen alone.

Visibility only: the chosen workspace stays chosen and stays published while an
organization-scoped screen is open, or navigating to People and back would lose
the scope and the overlays would open without a parent.

While the read is still pending on a screen that does work in a workspace, the
slot holds a placeholder rather than collapsing — an unread list is not an empty
one here either, and switching organizations would otherwise blank that part of
the top bar and fill it again.

**Implements**:
- `cpt-studiofrontend-flow-workspace-scope-switch`

**Touches**:
- Action: `constructor_studio.context.workspaces.publish.v1~` (`kind: scoped`)
- Entities: `WorkspaceSwitcher`, `Header`, `ProjectsRoot`, `Menu`, `appContextSlice`

### Creation is an overlay extension with one field

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-workspace-scope-overlay`

The system **MUST** render the workspace form as an extension of the projects
MFE in the shell's overlay domain, mounted and unmounted through the extension
lifecycle actions, and **MUST** offer exactly one field — the name.

**Implements**:
- `cpt-studiofrontend-flow-workspace-scope-create`

**Touches**:
- Entities: `mfe.json`, `workspaceOverlayLifecycle`, `NewWorkspaceForm`, `workspaceActions`

### A created workspace reaches the shell and becomes current

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-workspace-scope-announce`

The system **MUST** hand the created workspace to the shell through an action
chain executed against the overlay domain, and the shell **MUST** add it to the
switcher and make it current.

Not an event and not a refetch: the overlay runs in its own module realm, so the
shell never hears its event bus, and the shell has no reason to re-read a list it
is being told the one new row of.

The overlay **MUST NOT** close before the chain has landed. The tenant is
written by the time the announcement runs, so a chain that is sent and not waited on
turns a lost message into a workspace that exists in account-management and in
no list the member can see. An announcement that fails therefore keeps the
overlay open, says the workspace was created, and retries **the announcement** — never
the creation, which would write a second workspace under the same name.

**Implements**:
- `cpt-studiofrontend-flow-workspace-scope-create`

**Touches**:
- Action: `constructor_studio.context.workspaces.publish.v1~`
- Entities: `contextActions`, `bootstrap`, `workspaceEffects`, `workspaceActions`, `NewWorkspaceForm`, `workspaceSlice`

### The projects list is rooted at the workspace

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-workspace-scope-list-root`

The system **MUST** build the Projects list from the projects of the current
workspace, as one flat list, and **MUST** show nothing but an empty state when
there is no workspace.

The organization is no longer the root: its children are workspaces, and listing
them as rows would present containers as projects.

Flat, and not a tree with the workspace at the top, because the type registry
leaves nothing to nest: a workspace's only allowed parent is an organization, and
a project's are an organization or a workspace — so a workspace's children are
projects, and a project's children are nothing. The lazily expanded tenant tree
the earlier list needed is gone with the level it was walking, chevrons,
indentation, per-node fetching and all.

The one page is narrowed to the project type server-side rather than partitioned
on the client: with one level a tenant of another type has no row to be sorted
into.

**Implements**:
- `cpt-studiofrontend-flow-workspace-scope-switch`

**Touches**:
- API: `GET /cf/account-management/v1/tenants/{workspace}/children?$filter=tenant_type eq '{project type}'`
- Entities: `workspaceProjects`, `useProjectList`, `ProjectsTable`, `workspace` (shared)

### A project is created inside the current workspace

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-workspace-scope-project-parent`

The system **MUST** create a project as a child of the current workspace, and
**MUST NOT** offer a parent picker — the workspace in the top bar is the answer.

This supersedes the assumption in `project-create.md` that a project is created
under the organization. Both parents are allowed by the type registry; the
portal picks the workspace, and the list shows only what is in one.

**Implements**:
- `cpt-studiofrontend-flow-workspace-scope-create`

**Touches**:
- API: `POST /cf/account-management/v1/tenants`
- Entities: `wizardEffects`, `NewProjectWizard`

### Without a workspace there is nothing to create a project in

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-workspace-scope-no-workspace`

The system **MUST** disable "New project" while no workspace is current, and
**MUST** leave "New workspace" available — that is the way out of the state.

"New workspace" is gated on the organization instead, and only on it: a
workspace is created under the organization in scope, so without one there is
nothing to create it in and the button says so rather than opening a form whose
only button is already refused.

**Implements**:
- `cpt-studiofrontend-flow-workspace-scope-create`

**Touches**:
- Entities: `ProjectsToolbar`

## 6. Acceptance Criteria

- [ ] With no workspace in the organization, the top bar shows the organization alone, "New project" is disabled and "New workspace" is not; with no organization at all, both are disabled.
- [ ] The workspace slot is in the top bar on the Projects screen and absent on Connections and People.
- [ ] Leaving Projects for another screen and coming back shows the same workspace still current, and the Projects list unchanged.
- [ ] Activating "New workspace" opens an overlay with a single name field; Escape, the scrim and Cancel all close it and write nothing.
- [ ] Confirming a name creates a tenant of the workspace type whose parent is the organization in scope.
- [ ] The created workspace appears in the top bar slot immediately and is the current one, without a page reload.
- [ ] If the announcement to the shell fails, the overlay stays open and says the workspace was created; the button then retries the announcement and never creates a second workspace.
- [ ] A name that duplicates an existing workspace leaves the overlay open, keeps the name, and shows what was refused.
- [ ] With a workspace current, "New project" is enabled and a project created through the wizard is a child of that workspace.
- [ ] Switching workspaces replaces the Projects list with the chosen workspace's projects, and an open project is left.
- [ ] Switching organizations re-reads the workspaces and selects one of the new organization's, never one of the previous organization's.
- [ ] Choosing the organization already in scope changes nothing: the workspace stays current, an open project stays open, and no request is made.
- [ ] On a workspace-scoped screen the slot holds a placeholder while the list is being read, rather than disappearing and coming back.
- [ ] Switching organizations while the previous organization's workspaces are still being read leaves the slot showing the new organization's, whatever order the two reads answer in.
- [ ] A workspace picked on a screen of an organization since switched away from is not made current, and does not move the session to the workspace level either.
- [ ] A project opened, or a sibling list published, from a workspace since left changes neither the top bar nor the project switcher.
- [ ] A failed workspace read leaves the workspace in scope and the switcher's list untouched, and does not present the organization as having no workspace.
- [ ] The Projects list shows an empty state, not workspace rows, for a workspace with no projects.
- [ ] Every row in the list is a project: no expandable rows, no indentation and no container rows anywhere in it.
