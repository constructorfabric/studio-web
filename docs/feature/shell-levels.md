---
type: feature
status: accepted
owner: studio-team
---

# Feature: Levels in the shell

- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-shell-levels`

- [x] `p1` - `cpt-studio-feature-shell-levels`

## Table of Contents

<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [Go down a level](#go-down-a-level)
  - [Move sideways within a level](#move-sideways-within-a-level)
  - [Choose a section of the level](#choose-a-section-of-the-level)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
  - [Resolve the menu of the level](#resolve-the-menu-of-the-level)
  - [Decide what a menu click does](#decide-what-a-menu-click-does)
  - [Assemble the path](#assemble-the-path)
- [4. States (CDSL)](#4-states-cdsl)
  - [Context Ladder State Machine](#context-ladder-state-machine)
- [5. Definitions of Done](#5-definitions-of-done)
  - [The extension declares its level](#the-extension-declares-its-level)
  - [The shell draws the navigation of every level](#the-shell-draws-the-navigation-of-every-level)
  - [Every level has a header](#every-level-has-a-header)
  - [One entry, one mount: sections change by action](#one-entry-one-mount-sections-change-by-action)
  - [The chain is a breadcrumb of the workspace and the project](#the-chain-is-a-breadcrumb-of-the-workspace-and-the-project)
  - [The workspace level is its projects list](#the-workspace-level-is-its-projects-list)
  - [The entry point is the first item of the level](#the-entry-point-is-the-first-item-of-the-level)
  - [Counts arrive with the list that shows them](#counts-arrive-with-the-list-that-shows-them)
  - [The address decides, and only the shell writes it](#the-address-decides-and-only-the-shell-writes-it)
  - [An open artifact is a place in the address](#an-open-artifact-is-a-place-in-the-address)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

## 1. Feature Context

### 1.1 Overview

The shell stops being one flat list of the MFEs it happens to have. The session
is at a level — organization, workspace or project — the top bar names the path
to it, a header names the level, and a row of tabs under the header shows the
sections of that level and nothing else.

### 1.2 Purpose

Until now every screen extension appeared in one drawer, sorted by
`presentation.order`, with a rule drawn at `order >= 100` to separate the
"working areas" from the tenant level. That worked while the portal had one
level. It does not survive three: the same drawer would offer Findings of a
project next to People of an organization.

The levels themselves already exist in the data — account management holds
Platform, Organization, Workspace and Project as tenants — and the shell already
carries two of them in its context state. What is missing is that **a screen
cannot say which level it belongs to**, so the shell cannot group by level, and
the level is not visible anywhere except as two switchers that share one slot.

**2026-10-08: the rail became a row of tabs.** The design
(https://studio.constructor.rocks) moved a level's navigation from a rail beside
the content to a row of tabs under a header that names the level. The mechanism
did not change — the same items, the same rule for the active one, the same
address — only where and how it is drawn. What came with it: the path lost its
organization slot, the organization's Overview was removed, and a section's
title is the page's second heading. The DoDs
below are written for the tabs; the rail's history is in git.

**Assumptions fixed here**, because the mockups are silent and each choice
changes the code:

- The level is **declared by the extension**, through a derived extension type
  this repository owns, and never inferred from `presentation.route`. Three
  separate screen domains were rejected: a domain is a place content mounts
  into, and the content area is one.
- The **shell draws the navigation of every level**. The project's sections are
  declared in `projects-mfe`'s manifest rather than drawn inside its screen, so
  one mechanism governs every level's tabs and the active one is decided in one
  place.
- A menu item may point at an **entry that is already mounted**. When it does,
  the shell sends the extension an action instead of mounting again — otherwise
  changing a section inside a project would cost a full remount and lose the
  section's own state.
- The **address is the shell's**. ADR-0028 gives the portal one screen-domain
  entry (`?screen=<token>;org=…;workspace=…;project=…;section=…`) that the
  shell alone reads and writes; a click becomes a route, and the shell follows
  the address. MFEs still read no `location`: the level reaches them as shared
  properties and actions, as before.
- **Every level draws its row of tabs**, the workspace level included, whose
  only screen is still the list of its projects. The row is the frame of every
  level, so the content does not move up and down between levels, and the
  workspace's settings will be its second tab.
- Icons carry **one weight**. Filled-when-active would need a second field in
  the presentation contract; the active tab is distinguished by its background.
- Counts shown next to a name come from the **list that is already being read**
  (`child_count`). The artifact count of a project is not shown at all: it would
  be one request per project, and the slot for it stays empty until
  artifact-ingest can answer for several projects at once.

**Out of scope**, deliberately, each to get its own artifact: the Workspaces
screen, the Gears MFE, the workspace's settings, the project's Components, the
Studio AI panel, putting a section's sub-tabs into the address, and translating
a screen's label: the tabs read `presentation.label` as the rail did. This
feature is the mechanism they sit on. The organization Overview screen, once
listed here, was built as a placeholder and removed on 2026-10-08: the design
has no organization overview any more (`organization-overview.md` is
superseded).

**Requirements**: `cpt-studio-fr-portal-levels`

**Principles**: `cpt-studio-principle-project-is-unit`

### 1.3 Actors

Actor ids are defined in the [PRD](../prd/constructor-studio.md); a gear taking part is cited by its design component id.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** (`cpt-studio-actor-member`) | A signed-in member. Moves between levels and chooses sections of the level they are in. |
| **Shell** (`cpt-studio-actor-shell`) | The portal shell. Owns the level, the path to it, the level's header and tabs, and which extension is mounted. |
| **MFE** (`cpt-studio-actor-mfe`) | A screenset. Declares the level and label of each of its screens, receives the section to show when its entry is already mounted, and titles that section. |

### 1.4 References

- **PRD**: [PRD](../prd/constructor-studio.md)
- **Design**: [DESIGN](../design/constructor-studio.md)
- **Decomposition**: [DECOMPOSITION](../decomposition/constructor-studio.md), entry `cpt-studio-feature-shell-levels`
- **ADR**: [ADR-0008 — simplified navigation shell](../adr/0008-simplified-navigation-shell.md)
- **ADR**: [ADR-0010 — a project is an AM tenant](../adr/0010-projects-are-am-tenants.md)
- **Feature**: [Workspaces in scope](workspace-scope.md) — the workspace slot this feature turns into a level
- **Feature**: [Project artifacts](project-artifacts.md) — the sections whose navigation moved into the shell
- **Design source**: the prototype, https://studio.constructor.rocks (the tabs, the level header, the two-slot path, the editor under Artifacts)
- **Dependencies**: account-management (`/cf/account-management/v1`)

## 2. Actor Flows (CDSL)

Unchecked on purpose, for the reason stated in `project-create.md`: a checked
flow obliges every instruction to carry a code marker, and these span the shell,
the manifests of two MFEs and the extension plumbing between them. Their
evidence is the acceptance criteria in section 6; the implementation claims they
rest on are the Definitions of Done, which are traced.

**Use case**: work at the level you are in.

### Go down a level

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-shell-levels-descend`

**Actor**: Member

**Success Scenarios**:
- The header names the new level, its tabs show the sections of the new level, the path in the top bar gains the level's slot, and the level's first section is on screen.

**Error Scenarios**:
- The level below is empty — an organization with no workspace, a workspace with no project; the member stays where they are and the screen says so.
- The screen of the new level fails to mount; the shell falls back to the level's entry point, and when that does not mount either nothing is mounted and the console says so (ADR-0028).

**Steps**:
1. [ ] - `p1` - Member picks a workspace in the path or on the Workspaces screen, or opens a project from the list - `inst-1`
2. [ ] - `p1` - Write the new level into the address, and from there into the shell's context, clearing everything below it - `inst-2`
3. [ ] - `p1` - Run `cpt-studiofrontend-algo-shell-levels-menu` for the new level - `inst-3`
4. [ ] - `p1` - **IF** the level has no item to show - `inst-4`
   1. [ ] - `p1` - **RETURN** stay at the level above and report that the level below is empty - `inst-5`
5. [ ] - `p1` - Run `cpt-studiofrontend-algo-shell-levels-click` for the level's first item - `inst-6`
6. [ ] - `p1` - **IF** the mount does not happen - `inst-7`
   1. [ ] - `p1` - **RETURN** fall back once to the level's entry point, so the tabs and the content agree; when that does not mount either, nothing is mounted and the warning says so - `inst-8`
7. [ ] - `p1` - Run `cpt-studiofrontend-algo-shell-levels-path` so the new level is named in the top bar, and name it in the level header - `inst-9`
8. [ ] - `p1` - **RETURN** the new level, its header, its tabs and its first section - `inst-10`

### Move sideways within a level

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-shell-levels-sideways`

**Actor**: Member

**Success Scenarios**:
- The path and the header name the chosen sibling, the level and its tabs stay as they were, and the same section of the new sibling is shown.

**Error Scenarios**:
- The chosen sibling is the current one; nothing happens and no request is made.
- Choosing a sibling above the current level invalidates the levels below it, and the session lands at the chosen level rather than in a project that is no longer under it.

**Steps**:
1. [ ] - `p1` - Member opens a slot of the path, or the organization switch in the organization's header, and picks a sibling - `inst-1`
2. [ ] - `p1` - **IF** the sibling is the one already in scope - `inst-2`
   1. [ ] - `p1` - **RETURN** nothing changes and nothing is requested - `inst-3`
3. [ ] - `p1` - Write the sibling into its slot and clear every level below it - `inst-4`
4. [ ] - `p1` - **IF** levels were cleared - `inst-5`
   1. [ ] - `p1` - **RETURN** the session is at the level of the chosen sibling, with that level's tabs - `inst-6`
5. [ ] - `p1` - **RETURN** the same section, now of the chosen sibling - `inst-7`

### Choose a section of the level

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-shell-levels-section`

**Actor**: Member

**Success Scenarios**:
- The chosen section is on screen and its tab is the active one.

**Error Scenarios**:
- The action reaches an entry that has meanwhile been unmounted; the shell mounts it instead of reporting a failure.
- The MFE changes the section by itself; the tabs follow it rather than pointing at the section the member last clicked.

**Steps**:
1. [ ] - `p1` - Member activates a tab of the level - `inst-1`
2. [ ] - `p1` - Run `cpt-studiofrontend-algo-shell-levels-click` - `inst-2`
3. [ ] - `p1` - Mark the item active in the shell's own state, not in the MFE's - `inst-3`
4. [ ] - `p1` - **IF** the MFE reports a section of its own - `inst-4`
   1. [ ] - `p1` - **RETURN** adopt the reported section as the active item - `inst-5`
5. [ ] - `p1` - **RETURN** the section on screen with its item active - `inst-6`

## 3. Processes / Business Logic (CDSL)

### Resolve the menu of the level

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-shell-levels-menu`

**Input**: the level in scope, and the screen extensions registered in the screen domain

**Output**: the level's tabs, in order, and which of them is the settings tab. A hidden item is not among them

**Steps**:
1. [x] - `p1` - Keep the extensions whose declared level is the level in scope - `inst-1`
2. [x] - `p1` - **IF** an extension declares no level - `inst-2`
   1. [x] - `p1` - Treat it as belonging to the organization level, so an un-migrated manifest stays reachable - `inst-3`
3. [x] - `p1` - Sort what is left by `presentation.order` - `inst-4`
4. [x] - `p1` - Move the item marked as the level's settings to the end - `inst-5`
5. [x] - `p1` - Drop the items marked hidden: they stay registered and mountable, reached by something other than the tabs - `inst-7`
6. [x] - `p1` - **RETURN** the ordered items - `inst-6`

### Decide what a menu click does

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-shell-levels-click`

**Input**: the chosen item, the current address, and the extension currently mounted in the screen domain

**Output**: the address the click means and, once the shell has followed it, either a mounted extension or the chosen section relayed to the mounted one

**Steps**:
1. [x] - `p1` - Write the address the item means — its token, the context its level carries over from the current address, and its section — as a new history entry - `inst-1`
2. [x] - `p1` - Following the address, write its section into the shell's context, or `null` when the item declares none, and publish it as the section property - `inst-2`
3. [x] - `p1` - Write the project scope the address names — the project it carries, or none — so the section of the old screen does not outlive it - `inst-4`
4. [x] - `p1` - **IF** the group the address names is the one already mounted - `inst-3`
   1. [x] - `p1` - **RETURN** the section changed without a remount; re-picking the open section republishes the same value and changes nothing - `inst-6`
5. [x] - `p1` - Mount the group's owner in the screen domain, one mount at a time - `inst-5`
6. [x] - `p1` - **RETURN** the mounted extension; a mount that did not happen falls back once to the level's entry point (ADR-0028) - `inst-7`

The click writes the address, and the address is what decides the active item:
the section is written when the address is applied, before the mount starts —
`inst-2` before `inst-5` — and by the same hand for a click, for Back and
Forward, and for a pasted link (ADR-0028). Deciding it when the mount finishes
would put the decision on the far side of an await, where the next click cannot
overrule it: two overlapping mounts then land in whichever order they happen to
resolve, and the tabs name a section the screen does not show. The mount is
the slow part and the part that can fail; what the member asked for is in the
address before it starts.

One mount at a time is the runtime's rule: its queue keeps one mount running
and one waiting, and a newer request replaces the waiting one. So `inst-5` is
about where things end up — once the overlapping requests have settled, the
domain holds the group the address names. A click that arrives while a mount is
running is not dropped: it is in the address, and when the running mount
settles the address is applied again, which mounts what it names now. A mount
started for an address the member has since left says nothing about the one
they are on: its outcome is ignored, and the current address gets its own pass
(ADR-0028, amendment of 2026-11-02).

That leaves two writers of the active section, which is what
`cpt-studiofrontend-flow-shell-levels-section` already asks for: the shell
writes what the address says (`inst-3` there), and the MFE's own report is
written into the address without a history entry and adopted from there
(`inst-4`/`inst-5` there). Neither races the other — one answers the click, the
other answers the MFE, and both go through the address.

### Assemble the path

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-shell-levels-path`

**Input**: the level in scope, and what is selected at each level

**Output**: the slots of the path, outermost first

**Steps**:
1. [x] - `p1` - Take the levels from the workspace down to the level in scope; the organization has no slot, its header names it and switches it - `inst-1`
2. [x] - `p1` - **IF** the level in scope is the organization, take the workspace slot alone, naming no workspace ("All workspaces"); a pick in it enters the workspace. With no workspace in the organization there is no slot, and while the list is being read the slot holds a placeholder - `inst-4`
3. [x] - `p1` - **IF** the level in scope is the workspace or the project and nothing is selected at one of those levels, leave that slot out rather than naming an empty level - `inst-2`
4. [x] - `p1` - **RETURN** the slots, outermost first, each with its siblings behind it and an entry for the level above it: "All workspaces" in the workspace slot, "Projects in <workspace>" in the project slot - `inst-3`

There is no narrow layout for the path: it is drawn at one width and every slot
in scope is always shown. A breakpoint invented here would be a guess at a
design nobody has made — see the same reasoning in
`cpt-studiofrontend-dod-shell-levels-chain`. The level's tabs are the one row
that does change on a narrow window: they wrap, as the design shows.

## 4. States (CDSL)

### Context Ladder State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-shell-levels-ladder`

**States**: Organization, Workspace, Project

**Initial State**: Organization

**Transitions**:
1. [ ] - `p1` - **FROM** Organization **TO** Workspace **WHEN** a workspace is chosen in the path or on the Workspaces screen - `inst-1`
2. [ ] - `p1` - **FROM** Workspace **TO** Project **WHEN** a project is opened - `inst-2`
3. [ ] - `p1` - **FROM** Project **TO** Workspace **WHEN** the project is left: "Back to projects" in its header, or "Projects in <workspace>" in the path - `inst-3`
4. [ ] - `p1` - **FROM** Workspace **TO** Organization **WHEN** "All workspaces" in the path or "Organization" in the avatar menu is chosen - `inst-4`
5. [ ] - `p1` - **FROM** Project **TO** Organization **WHEN** "All workspaces" in the path or "Organization" in the avatar menu is chosen, skipping the level between - `inst-5`
6. [ ] - `p1` - **FROM** Project **TO** Workspace **WHEN** the workspace is switched, because the open project is not under the new one - `inst-6`
7. [ ] - `p1` - **FROM** Organization **TO** Organization **WHEN** the organization is switched from its header, because neither the workspace nor the project of the old one survives it - `inst-7`
8. [ ] - `p1` - **FROM** Organization **TO** the level the address names **WHEN** the session is reloaded or a link is opened, because the address is what the shell restores; an empty address stays at Organization (ADR-0028) - `inst-8`

## 5. Definitions of Done

### The extension declares its level

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-declared`

The system **MUST** read the level of a menu item from the extension itself,
through a derived extension type this repository owns — the shell ships its
schema and registers it before any manifest, the MFE only chains its extension
ids through it — and **MUST NOT** infer it from `presentation.route` or from any
list of screen ids kept in the shell.

A derived type is the mechanism the framework already names for this: the screen
domain requires extensions of a type derived from `extension_screen.v1~`, whose
purpose is exactly to add presentation metadata. `ExtensionPresentation` in
`@gears-frontx/mfes` carries `label`, `icon`, `route` and `order` and is not
ours to widen.

Three separate screen domains — one per level — were rejected: a domain is the
place content mounts into, and there is one content area. Three domains would
also force `MfeScreenContainer` to watch three places for one mounted screen.

The `order >= 100` band that separated the tenant level from the working areas
goes away with this: the rule it stood for is now the level, and a magic number
in an MFE manifest no longer decides where a separator is drawn.

The same derived type carries an optional field that came with the tabs:
`parentSection`, the section a hidden screen belongs to
(`cpt-studiofrontend-dod-shell-levels-shell-draws`). A manifest that does not
declare it is drawn as before.

**Implements**:
- `cpt-studiofrontend-algo-shell-levels-menu`

**Touches**:
- Entities: `mfe.json` (every MFE), `app/mfe/schemas`, `screenLevels`, `LevelTabs`

### The shell draws the navigation of every level

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-shell-draws`

The system **MUST** draw a level's navigation in the shell, as a row of tabs
under the level's header, from the extensions registered in the screen domain,
and **MUST NOT** leave a level's navigation to be drawn inside an MFE.

A level's tabs belong to several MFEs — the organization's to organization-mfe,
people-mfe, connections-mfe and kits-mfe — and only the shell's registry holds
them all. An MFE drawing its own row would need the others' items and would
decide the active one a second time; that is why `ProjectRail` was deleted, and
the tabs do not bring it back.

The row is built on the kit's `NavigationMenu`. Each tab is a
`NavigationMenuLink` whose `active` comes from the active-item rule, so the
active tab carries `aria-current="page"` and is styled through `[data-active]`.
The kit's `Tabs` is not used here: a `tablist` with `aria-selected` announces
panels of one page, and a tab of the level changes the address and may mount
another MFE. A tab shows the item's icon and its label. Icons keep one weight; the active
tab is distinguished by its background. Filled-when-active would need a second
icon field in the presentation contract, and a contract change for an icon
variant is not worth what it costs every manifest. The settings tab of a level
is labelled "Settings": the header already says whose settings they are.

**Every level draws its row, a level of one tab included.** The row is the frame
of every level, so the content does not move up and down between levels, and the
workspace level, which has only Projects until its settings exist, shows where
those will appear. On a window too narrow for the row, the row wraps to a second
line, as the design does. Horizontal scroll and an overflow menu were rejected:
both hide tabs a person then has to look for.

**A hidden screen may name the section it belongs to.** The editor is a hidden
project-level screen (`cpt-studiofrontend-dod-shell-levels-artifact-address`),
and while it is on screen the Artifacts tab is the active one, as in the design.
Its manifest declares `parentSection: "artifacts"`, and the active-item rule
takes the tab of the level with that section when the mounted screen declares
one. The existing `section` field cannot carry this: the editor is an address
group of its own (`space`), and to `materialize` a `section` on it would be a
section of that group, written into the editor's address — where ADR-0028 lets a
project route carry a section or an artifact, never both.

`ProjectRail` in `projects-mfe` stays deleted, and the project's sections are
declared in its manifest. What the MFE keeps is its own section state; what it
loses is the drawing of navigation.

**Implements**:
- `cpt-studiofrontend-flow-shell-levels-section`

**Touches**:
- Entities: `LevelTabs`, `Rail` (removed), `Layout`, `mfe.json` (every MFE with a settings item, space-mfe)

### Every level has a header

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-header`

The system **MUST** draw, between the top bar and the level's tabs, a header
naming the level in scope as the page's `h1`, and **MUST** leave the section's
title to the MFE, as an `h2`.

- **Organization:** its name, and "Switch organization". The button opens the
  organization list the shell already holds (`app/context.orgs`, with the
  `child_count` of each, `cpt-studiofrontend-dod-shell-levels-counts`); a pick
  emits the existing `app/context/org/changed`. It is drawn only for a person
  in two or more organizations: with one there is nothing to switch to.
- **Workspace:** its name, with the organization's name above it. While the
  workspace list is being read, a placeholder stands where the name goes, not
  the organization's header; when the read fails, the header is empty.
- **Project:** "Back to projects", which emits `app/context/level/requested` for
  the workspace level and so lands on the workspace's projects list, and the
  project's name. No type badge: a project carries no type
  (`ProjectConfig` has `mode` and `status`, nothing the design's badge shows).
  A linked project is open before its name is read (ADR-0028); until then a
  placeholder stands where the name goes, not an empty heading.

The header is the shell's because it sits above the tabs, which are the
shell's. It replaces nothing the MFE drew: an MFE never named its level, it
named its section, and still does — one heading level down. Every MFE section
title is an `h2`, and so is the `_blank-mfe` template's. The search dialog keeps
its `h1`, which titles a dialog rather than a section of the page. The onboarding
state (`OrganizationAccessGate`) keeps its `h1` too: it is drawn when the person
has no organization, and then there is no level to name.

The header, the tabs and the MFE's section row start on one vertical line: the
shell's rows use `var(--space-6)` as their side gutter, the value most screens
already pad with, and the People, Kits and organization-settings screens and the
`_blank-mfe` template move from `2rem` to it. The template's card titles are
`h3`, under its section's `h2`.

**Implements**:
- `cpt-studiofrontend-flow-shell-levels-descend`
- `cpt-studiofrontend-flow-shell-levels-sideways`

**Touches**:
- Event: `app/context/org/changed`, `app/context/level/requested`
- Entities: `LevelHeader`, `Layout`, every MFE's section title, `_blank-mfe`

### One entry, one mount: sections change by action

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-one-mount`

The system **MUST** send an action to the mounted extension when the chosen menu
item points at the entry that is already mounted, and **MUST** mount only when
the entry differs.

The screen domain mounts exclusively: a mount evicts the previous screen. Making
every project section its own mount would therefore throw away the section's
filters, scroll and loaded data on every click inside one project, and pay a
remote module load for a tab change.

The channel is **two-way**. The MFE changes the section by itself — the projects
MFE lands on Artifacts after a first import — so the shell adopts a section the
MFE reports rather than insisting on the one last clicked. Without that the tabs
would highlight a section that is not on screen.

The active item is the shell's state, not `projects/nav`. That slice stays as the
MFE's own view of itself, but it stops being the truth the tabs read.

The channel is the one that already crosses a module realm: a shared property
carries the shell's choice down (`…context.project_section.selected.v1~`, the
token the item declared), and the existing context action carries the MFE's own
moves back up as `kind: 'section'`. Neither direction is an event: an MFE's
`eventBus` is not the shell's.

**Implements**:
- `cpt-studiofrontend-algo-shell-levels-click`

**Touches**:
- Property: `constructor_studio.context.project_section.selected.v1~`
- Action: `constructor_studio.context.projects.publish.v1~` (`kind: section`)
- Entities: `LevelTabs`, `screenLevels`, `appContextSlice`, `sharedContext`, `contextActions`, `ProjectsRoot` (projects-mfe), `navSlice`, `ProjectRail` (removed)

### The chain is a breadcrumb of the workspace and the project

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-chain`

The system **MUST** show the path to the level in scope as a breadcrumb in the
top bar — a slot for the workspace and, at the project level, one for the
project, each with its own menu of siblings — and **MUST** build it on the
kit's `Breadcrumb`. The organization **MUST NOT** have a slot.

The organization is named and switched in its own header
(`cpt-studiofrontend-dod-shell-levels-header`), and "Organization" in the
avatar menu (`UserMenu`) leads back to its screens from any depth, by
`app/context/level/requested`. A slot that only repeated the header would take
room from the two that move the session.

One slot per level, not one slot with several modes: the workspace and the
project are in scope at the same time, so `ContextSwitcher`'s `org`/`project`
alternation and the separate `WorkspaceSwitcher` were replaced by one slot
component used for each level in the path.

Each slot's menu has an entry for the level above it, above the siblings: "All
workspaces" in the workspace slot, which emits `app/context/level/requested` for
the organization and so lands on its Workspaces; "Projects in <workspace>" in
the project slot, which does the same for the workspace. The project slot's menu
also searches the projects by name.

Every slot is the design's ghost button — the level's icon, the entity's name
and a chevron — rendered as its menu's trigger, the last one included:
`BreadcrumbPage` marks the current crumb `aria-disabled`, and here the current
level is the most clickable thing in the bar. `aria-current="page"` is set by us
instead. An arrow stands between two slots.

- `BreadcrumbList` ships `flex-wrap: wrap`; the path is `nowrap`, so it never
  breaks the 56px bar. It is not responsive: rather than invent a narrow layout,
  every slot in scope stays drawn.
- A slot is as wide as its name, up to a cap, and a long name truncates inside
  it.
- The icon carries no text, so the accessible name of the trigger says the level
  and the entity ("Workspace: Platform Workspace").
- Both menus are the kit's own, at the kit's row: the workspace slot's a
  `DropdownMenu` with the current workspace checked, the project slot's a
  `Popover` with the way up, the kit's search field (`InputGroup` at its 32px
  step) and a `Command` list it filters by name. Neither counts anything — the design's menus name
  each entry and stop there.

The slot is the kit's `Button` (`utility`, `sm`) at the body size with the label
weight: `utility` is the kit's ghost with the design's 18px glyph. The path
hardcodes no type and no icon size.

Until 2026-10-08 a slot was two lines — the level's name in caps above the
entity's — at a fixed width; it follows the design's single line now.

**Implements**:
- `cpt-studiofrontend-flow-shell-levels-sideways`
- `cpt-studiofrontend-algo-shell-levels-path`

**Touches**:
- Entities: `Header`, `ContextChain`, `UserMenu`, `ContextSwitcher` (removed), `WorkspaceSwitcher` (removed), `appContextSlice`

### The workspace level is its projects list

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-workspace-level`

The system **MUST** treat the projects list as the screen of the workspace level,
**MUST** draw that level's row of tabs even while Projects is its only tab, and
**MUST NOT** offer Projects as a tab of the organization level.

The workspace's second screen — its settings — does not exist yet. When it
does, it is the row's second tab and nothing else here changes.

The workspace slot of the path is drawn at every level, the design's two
switchers. At the organization level it names no workspace ("All workspaces"),
and a pick in it enters the workspace with one `app/context/workspace/changed`
that carries `enter: true` — one announcement rather than a pick and a level
request, for the reason `cpt-studiofrontend-dod-workspaces-screen-row-opens`
gives. A pick without `enter` at the organization level is only remembered; that
was right while the slot was not drawn there, and is not what a person picking a
workspace from a menu expects. The Workspaces screen stays the other way in.

Picking in any slot other than the one in scope moves the session to that slot's
level; picking a sibling of the level in scope keeps the screen, and with it
whatever section the MFE is showing.

**Implements**:
- `cpt-studiofrontend-flow-shell-levels-descend`

**Touches**:
- Event: `app/context/workspace/changed` (`enter: true`)
- Entities: `mfe.json` (projects-mfe), `LevelTabs`, `ContextChain`

### The entry point is the first item of the level

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-entry-point`

The system **MUST** mount the first item of the level in scope, by order, and
**MUST NOT** name any screen in the shell's code to decide that. A hidden item
is never that first item: it is not among the tabs, so it cannot be where a
level opens.

The organization opens on Workspaces since its Overview was removed
(2026-10-08). Nothing in the shell names it: Workspaces is simply the
organization's lowest order now. An old link with `section=overview` needs no
rule of its own — `materialize` already warns that it is not a section of the
group and opens the level's entry point with a `replace` (ADR-0028). The
project's Overview is not affected: `overview` is still a section of the
project.

`MfeScreenContainer` currently prefers the extension whose route is `/projects`
and falls back to the lowest order. After this feature there is no such screen
at the organization level, and a shell that names one screen cannot be reused for
three levels.

It names no level's item either: on the root it is handed, it asks for the
outermost level and nothing more. The item is then chosen — and its section
written — by the handler every other navigation already goes through, so the
screen a session opens on is not the one screen reached by a second path.

**Implements**:
- `cpt-studiofrontend-algo-shell-levels-menu`

**Touches**:
- Entities: `MfeScreenContainer`, `appContextEffects`

### Counts arrive with the list that shows them

- [x] `p2` - **ID**: `cpt-studiofrontend-dod-shell-levels-counts`

The system **MUST** take the count shown under a name in the organization
switch of the organization's header from the `child_count` of the tenant list
already being read, and **MUST NOT** issue a request per row to fill a menu.

Organizations, workspaces and projects are all account-management tenants, so
the count of what is inside one arrives in the same page as its name.
`child_count` counts the direct children visible to the caller — which is
exactly what the menu should claim, and what makes "only what you can see"
true rather than approximate.

The path's menus show names only, as the design does
(`cpt-studiofrontend-dod-shell-levels-chain`). A count that would cost a request
per row is not shown anywhere: the artifact count of a project lives in
artifact-ingest, one `total` per project, and a menu that fans out a request per
row on every open is worse than a menu without a subtitle.

**Implements**:
- `cpt-studiofrontend-flow-shell-levels-sideways`

**Touches**:
- API: `GET /cf/account-management/v1/tenants/{id}/children`
- Entities: `appContextSlice`, `appContextEffects`, `LevelHeader`

### The address decides, and only the shell writes it

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-no-address`

The system **MUST NOT** read `location` or write browser history from any MFE,
and **MUST** deliver the level to MFEs as shared properties and actions rather
than as an address.

The shell itself has an address (ADR-0028): one entry of the screen domain in
the query string, holding the screen's token, the organization, the workspace,
the project and the section as far down as the level in scope goes. Every
navigation a person makes is a write to that entry (`src-app/app/routing/`),
and the shell brings its context and its mounted screen to what the entry
says — on a click, on Back and Forward, on reload and on a pasted link. A
reload therefore returns to the level, screen and section it left; the two
costs this DoD once accepted no longer apply.

The rule above is what keeps that arrangement honest: an MFE that read the
address would be a second reader of one fact, and the shell's answer through
shared properties would no longer be the only answer.

**Implements**:
- `cpt-studiofrontend-state-shell-levels-ladder`

**Touches**:
- Entities: `appContextSlice`, `sharedContext`, `contextActions`

### An open artifact is a place in the address

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-artifact-address`

The system **MUST** answer a request to open an artifact with a navigation to
the editor screen — the `space` token, a project-level screen with
`placement: hidden` — writing the artifact (`artifact`, `repository`, `path`,
`kind`) into the address after the level context, and **MUST** publish
`context.artifact.selected` from that address: the artifact while the editor is
on screen in a project, `null` everywhere else.

Opening is a `push`, so Back is the way out: the router reports the entry the
person left, the artifact list of the same project, and the shell mounts that
screen again with the project still open. The path is the other way out: a
project or workspace picked in it opens at that level's entry point, never at
the editor. A hidden screen is never the one a level opens on, and the editor
means nothing without its artifact. Forward and reload
remount the editor cold (ADR-0021); the address is what survives. An artifact on another
screen is dropped from the address with a warning rather than published. An
editor address with nothing the editor can open (a kind it does not know, no
artifact, no project, or a project the lookup refuses) lands on the level's
entry point instead, with a warning, the way a failed mount falls back. The
editor screen is `space-mfe`, a frame
package; its frame shows the project's session once it is ready (#322), and
the artifact reaches the frame in #323.

**Implements**:
- `cpt-studiofrontend-algo-shell-levels-click`

**Touches**:
- Action: `constructor_studio.context.artifact.open.v1~`
- Property: `constructor_studio.context.artifact.selected.v1~`
- Entities: `createArtifactOpenHandler`, `appContextEffects`, `materialize`, `route`, `appContextSlice`, `space-mfe`

## 6. Acceptance Criteria

- [ ] At the organization level the header names the organization and the tabs read Workspaces, People, Connections, Kits and Settings; Artifacts, Specs and the other project sections are absent from them.
- [ ] A fresh session, and an empty address, open the organization on Workspaces; a link with `section=overview` opens Workspaces with a console warning.
- [ ] Choosing a workspace in the path or on the Workspaces screen shows that workspace's projects under a header naming the workspace, with the organization above it, and a row holding the one tab Projects.
- [ ] Projects is not a tab of the organization level anywhere in the product.
- [ ] Opening a project shows the project's tabs — Overview, Artifacts, Specs, Sources, Activity, Timeline, Team, and Settings last — the header names the project, and the path gains the project slot.
- [ ] "Back to projects" in the project's header shows the workspace's projects list.
- [ ] The level's name in the header is the page's only `h1`; the section's title below the tabs is an `h2`.
- [ ] The header, the tabs and the section's title start on one vertical line on every level.
- [ ] On a window too narrow for the project's tabs, the row wraps to a second line and no tab is hidden.
- [ ] Switching between two sections of the same project does not remount the screen: a filter set on Artifacts is still set after visiting Specs and coming back.
- [ ] Switching between two items of the same MFE at the organization level behaves the same way, with no remount.
- [ ] Switching to an item of a different MFE mounts it, and the previous screen is unmounted.
- [ ] After the projects MFE moves the section by itself, the active tab is the section that is on screen, not the one last clicked.
- [ ] The path has no organization slot. At the organization level it holds the workspace slot alone, reading "All workspaces", and a pick in it opens that workspace's projects; from the workspace level down it holds the workspace and, at the project level, the project.
- [ ] Every slot of the path opens a menu of its siblings, the last slot included, with an entry for the level above: "All workspaces" leads to the organization's Workspaces, "Projects in <workspace>" to the workspace's projects; the project slot's menu filters projects by name.
- [ ] "Organization" in the avatar menu leads to the organization's Workspaces from any level.
- [ ] Choosing the sibling already in scope makes no request and changes nothing.
- [ ] Switching the workspace while a project is open leaves the project and lands at the chosen workspace.
- [ ] Switching the organization from its header clears the workspace and the project, and the session is at the organization level.
- [ ] For a person in two or more organizations, the organization switch shows how many workspaces each has, without a request per row; with one organization the header has no switch. The path's menus show names only.
- [ ] The project slot's menu shows names with no artifact count under them.
- [ ] Each slot of the path reads as the design's ghost button — icon, name, chevron — a long name truncates inside its slot, and the top bar never wraps to a second line.
- [ ] A screen reader announces each slot as the level and the entity.
- [ ] Reloading the page returns the session to the screen, level and section it was on; an empty address opens the organization level's first item (ADR-0028).
- [ ] A pasted link to a project opens that project; an id the person cannot read degrades to the level's entry point with a console warning.
- [ ] No MFE reads `location` or pushes browser history; Back and Forward move between screens, projects and sections without a reload, and the tabs follow.
- [ ] A manifest that declares no level still shows its screen at the organization level rather than disappearing.
- [ ] A screen declared `placement: hidden` appears in no level's tabs and is never the screen a level opens on, yet the shell still mounts it when asked by id.
- [ ] Opening a file from a project's artifacts replaces the project area with the editor while the header, the tabs, the path and the top bar stay put, the Artifacts tab stays active, and the address carries `screen=space` and the artifact.
- [ ] Back from the editor shows the artifact list of the same project, with the project still open; Forward and reload show the editor again on the same artifact.
- [ ] Picking another project or workspace in the path while the editor is open leaves the editor for that level's entry point; only when the level has none does the editor stay, with no artifact and a warning.
- [ ] The last tab of the organization and of the project reads "Settings".
