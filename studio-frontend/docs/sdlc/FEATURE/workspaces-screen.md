# Feature: The organization's workspaces

<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [Open a workspace's projects](#open-a-workspaces-projects)
  - [Create a workspace from the list](#create-a-workspace-from-the-list)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
  - [List the organization's workspaces](#list-the-organizations-workspaces)
- [4. States (CDSL)](#4-states-cdsl)
  - [Workspaces Screen State Machine](#workspaces-screen-state-machine)
- [5. Definitions of Done](#5-definitions-of-done)
  - [The list is a screen of the organization level](#the-list-is-a-screen-of-the-organization-level)
  - [A row is the way into the workspace level](#a-row-is-the-way-into-the-workspace-level)
  - [Creation moves next to the list](#creation-moves-next-to-the-list)
  - [The counts come from the tenant list](#the-counts-come-from-the-tenant-list)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-workspaces-screen`

## 1. Feature Context

### 1.1 Overview

The organization's workspaces, listed on a screen of the organization level:
what each one holds, and the way into it. Creating one moves here too, from the
projects list where it sat because there was nowhere else to put it.

### 1.2 Purpose

`shell-levels` made the workspace a level of its own and took Projects out of
the organization's rail: choosing a workspace is what opens its projects. That
left one hole, which this feature fills — **there is no screen that lists the
workspaces**. The chain in the top bar names the one in scope and switches
between them, but a switcher is not a list: it shows no counts, offers no
creation, and answers nothing about a workspace one is not in.

Until this screen exists, the workspace slot doubles as the entry to the level
even at the organization level, which is a deviation from the design recorded in
`cpt-studiofrontend-dod-shell-levels-workspace-level`. This feature is what lets
that be tightened back.

**Assumptions fixed here**, because the design is silent and each changes the
code:

- The screen is **organization-mfe's**, not a new package: it is the
  organization's own data — workspaces are its child tenants — and that MFE
  already owns the organization level's other screen.
- The workspaces are read **by the MFE itself**, from account-management, the
  way projects-mfe reads projects. The shell's own list (for the chain) stays
  the shell's; two readers of one AM endpoint is the lesser evil against a
  screen that cannot render without a new host → child channel.
- **Opening a row enters the workspace level** through the same request the
  chain uses, so there is one way into a level and not two.
- **Creation moves** out of the projects list's toolbar. A workspace is not a
  thing one makes from inside another workspace's projects.

### 1.3 Actors

Named, not identified — a FEATURE may only define `algo`, `dod`, `featstatus`,
`flow` and `state` ids. See the same note in `project-create.md`.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** | A signed-in member of the organization in scope. Reads the list, opens a workspace, creates one. |
| **Shell** | Owns the levels: it mounts the workspace level's screen when a row asks for it. |
| **MFE** | organization-mfe. Reads the workspaces, draws the list, and hands a created one to the shell. |

### 1.4 References

- **Feature**: [Levels in the shell](shell-levels.md) — the level this screen leads into
- **Feature**: [Workspaces in scope](workspace-scope.md) — the slot, the creation form, and the announcement this reuses
- **ADR**: [ADR-0010 — a project is an AM tenant](../../../../docs/adr/0010-projects-are-am-tenants.md)
- **Dependencies**: account-management (`/cf/account-management/v1`)

## 2. Actor Flows (CDSL)

Unchecked on purpose, for the reason stated in `project-create.md`: a checked
flow obliges every instruction to carry a code marker, and these span an MFE,
the shell's level request and the overlay in between.

**Use case**: work with the organization's workspaces.

### Open a workspace's projects

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-workspaces-screen-open`

**Actor**: Member

**Success Scenarios**:
- The projects of the chosen workspace are on screen, and the path in the top bar names it.

**Error Scenarios**:
- The workspace was deleted between the read and the click; the level opens empty and says so rather than showing another workspace's projects.

**Steps**:
1. [ ] - `p1` - Member activates a row of the list - `inst-1`
2. [ ] - `p1` - Announce the chosen workspace to the shell as the one in scope - `inst-2`
3. [ ] - `p1` - Ask the shell for the workspace level, the same request the path's slot makes - `inst-3`
4. [ ] - `p1` - **RETURN** the workspace level's screen, mounted by the shell - `inst-4`

### Create a workspace from the list

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-workspaces-screen-create`

**Actor**: Member

**Success Scenarios**:
- The created workspace appears in the list and in the path, and is the one in scope.

**Error Scenarios**:
- Account-management refuses the name; the form stays open with the name intact.
- The overlay is dismissed; nothing is written and the list is unchanged.

**Steps**:
1. [ ] - `p1` - Member activates "New workspace" beside the list - `inst-1`
2. [ ] - `p1` - Mount the workspace overlay extension in the shell's overlay domain - `inst-2`
3. [ ] - `p1` - Member names it and confirms; the form writes the tenant and announces it - `inst-3`
4. [ ] - `p1` - Re-read the list, so the new row is there with its own count - `inst-4`
5. [ ] - `p1` - **RETURN** the list with the created workspace in it - `inst-5`

## 3. Processes / Business Logic (CDSL)

### List the organization's workspaces

- [ ] `p2` - **ID**: `cpt-studiofrontend-algo-workspaces-screen-list`

**Input**: the organization in scope

**Output**: the workspaces to show, each with how many projects the caller can see

**Steps**:
1. [ ] - `p1` - **IF** no organization is in scope - `inst-1`
   1. [ ] - `p1` - **RETURN** nothing to list; the screen says so rather than reading for an organization it does not have - `inst-2`
2. [ ] - `p1` - `API: GET /cf/account-management/v1/tenants/{org}/children?$filter=tenant_type eq '{workspace type}' (one page)` - `inst-3`
3. [ ] - `p1` - Take each row's `child_count` as its project count, which is what the caller can see and not the subtree - `inst-4`
4. [ ] - `p1` - **RETURN** the rows in the order account-management gave them - `inst-5`

## 4. States (CDSL)

### Workspaces Screen State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-workspaces-screen-list`

**States**: NoOrganization, Loading, Empty, Listed, Failed

**Initial State**: NoOrganization

**Transitions**:
1. [ ] - `p1` - **FROM** NoOrganization **TO** Loading **WHEN** an organization is in scope - `inst-1`
2. [ ] - `p1` - **FROM** Loading **TO** Listed **WHEN** the read answers with rows - `inst-2`
3. [ ] - `p1` - **FROM** Loading **TO** Empty **WHEN** the read answers with none - `inst-3`
4. [ ] - `p1` - **FROM** Loading **TO** Failed **WHEN** the read fails; the rows already shown are kept - `inst-4`
5. [ ] - `p1` - **FROM** Failed **TO** Loading **WHEN** the member asks again - `inst-5`
6. [ ] - `p1` - **FROM** Listed **TO** Loading **WHEN** the organization is switched, or a workspace is created - `inst-6`

## 5. Definitions of Done

### The list is a screen of the organization level

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-workspaces-screen-level`

The system **MUST** register the list as a screen extension of organization-mfe
declaring the organization level, and **MUST** place it above the settings item
in that level's rail.

A screen of the MFE that owns the organization, not a package of its own: the
rows are the organization's child tenants, and one more MFE for one table would
buy nothing but a second remote to load.

**Implements**:
- `cpt-studiofrontend-algo-workspaces-screen-list`

**Touches**:
- Entities: `mfe.json` (organization-mfe), `WorkspacesScreen`

### A row is the way into the workspace level

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-workspaces-screen-row-opens`

The system **MUST** enter the workspace level from a row by announcing the
workspace and then asking the shell for that level, and **MUST NOT** mount the
workspace level's screen itself.

One way into a level. The chain's slot already asks the shell, the shell already
knows which screen is the level's entry point, and an MFE that mounted a screen
of its own choosing would be deciding what the level is.

**Implements**:
- `cpt-studiofrontend-flow-workspaces-screen-open`

**Touches**:
- Action: `constructor_studio.context.workspaces.publish.v1~`
- Entities: `WorkspacesScreen`, `appContextEffects`

### Creation moves next to the list

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-workspaces-screen-create-moves`

The system **MUST** offer "New workspace" beside this list, and **MUST NOT**
offer it in the projects list any more.

The overlay itself does not change — the form, the write and the announcement
are `workspace-scope`'s and stay as they are. What moves is which screen opens
it, and the reason is the level: a workspace is created in an organization, and
the projects list is a screen of one workspace already.

**Implements**:
- `cpt-studiofrontend-flow-workspaces-screen-create`

**Touches**:
- Entities: `mfe.json` (organization-mfe, projects-mfe), `NewWorkspaceForm`, `ProjectsToolbar`

### The counts come from the tenant list

- [x] `p2` - **ID**: `cpt-studiofrontend-dod-workspaces-screen-counts`

The system **MUST** show each workspace's project count from the `child_count`
of the row it already read, and **MUST NOT** issue a request per row.

The same rule the chain's menus follow: account-management counts the direct
children visible to the caller, which is exactly what the column should claim.

**Implements**:
- `cpt-studiofrontend-algo-workspaces-screen-list`

**Touches**:
- API: `GET /cf/account-management/v1/tenants/{id}/children`
- Entities: `WorkspacesScreen`

## 6. Acceptance Criteria

- [ ] The organization's rail has a Workspaces item above Organization settings, and it mounts this screen.
- [ ] The screen lists every workspace of the organization in scope, with a project count per row taken from one request.
- [ ] An organization with no workspaces shows an empty state and the creation control, not a spinner.
- [ ] Activating a row opens that workspace's projects, and the path in the top bar gains the workspace slot naming it.
- [ ] Switching the organization re-reads the list, and never shows the previous organization's workspaces.
- [ ] A failed read keeps whatever rows were shown and offers to try again.
- [ ] "New workspace" beside the list opens the same overlay the projects list used to open; Escape and the scrim close it and write nothing.
- [ ] A created workspace is in the list, is the one in scope, and its count reads zero projects.
- [ ] The projects list no longer offers "New workspace".
