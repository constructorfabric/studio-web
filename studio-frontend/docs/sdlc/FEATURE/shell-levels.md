# Feature: Levels in the shell

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
  - [One entry, one mount: sections change by action](#one-entry-one-mount-sections-change-by-action)
  - [The chain is a breadcrumb of three slots](#the-chain-is-a-breadcrumb-of-three-slots)
  - [The workspace level has no menu](#the-workspace-level-has-no-menu)
  - [The entry point is the first item of the level](#the-entry-point-is-the-first-item-of-the-level)
  - [Counts arrive with the list that shows them](#counts-arrive-with-the-list-that-shows-them)
  - [Nothing owns the address yet](#nothing-owns-the-address-yet)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-shell-levels`

## 1. Feature Context

### 1.1 Overview

The shell stops being one flat list of the MFEs it happens to have. The session
is at a level — organization, workspace or project — the top bar names the path
to it, and the navigation shows the sections of that level and nothing else.

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

**Assumptions fixed here**, because the mockups are silent and each choice
changes the code:

- The level is **declared by the extension**, through a derived extension type
  this repository owns, and never inferred from `presentation.route`. Three
  separate screen domains were rejected: a domain is a place content mounts
  into, and the content area is one.
- The **shell draws the navigation of every level**. The project rail that
  `projects-mfe` draws inside its own screen moves into the manifest, so one
  mechanism governs the whole rail and the active item is decided in one place.
- A menu item may point at an **entry that is already mounted**. When it does,
  the shell sends the extension an action instead of mounting again — otherwise
  changing a section inside a project would cost a full remount and lose the
  section's own state.
- There is **no address**. FrontX has no routing (`presentation.route` is a
  string nothing in the framework reads, and `FrontXConfig.routerMode` is
  declared and unused); routing is coming upstream, so this feature writes
  neither a router nor a bridge to one. The consequences are stated in
  `cpt-studiofrontend-dod-shell-levels-no-address`.
- The **workspace level has no menu**. Its only screen is the list of its
  projects, and a rail holding one item is not a rail.
- Icons carry **one weight**. Filled-when-active would need a second field in
  the presentation contract; the active item is distinguished by its background.
- Counts shown next to a name come from the **list that is already being read**
  (`child_count`). The artifact count of a project is not shown at all: it would
  be one request per project, and the slot for it stays empty until
  artifact-ingest can answer for several projects at once.

**Out of scope**, deliberately, each to get its own artifact: the organization
Overview screen, the Workspaces screen, and the Gears MFE. This feature is the
mechanism they will sit on.

### 1.3 Actors

Named, not identified — a FEATURE may only define `algo`, `dod`, `featstatus`,
`flow` and `state` ids. See the same note in `project-create.md`.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** | A signed-in member. Moves between levels and chooses sections of the level they are in. |
| **Shell** | The portal shell. Owns the level, the path to it, the rail, and which extension is mounted. |
| **MFE** | A screenset. Declares the level of each of its screens, and receives the section to show when its entry is already mounted. |

### 1.4 References

- **ADR**: [ADR-0008 — simplified navigation shell](../../../../docs/adr/0008-simplified-navigation-shell.md)
- **ADR**: [ADR-0010 — a project is an AM tenant](../../../../docs/adr/0010-projects-are-am-tenants.md)
- **Feature**: [Workspaces in scope](workspace-scope.md) — the workspace slot this feature turns into a level
- **Feature**: [Project artifacts](project-artifacts.md) — the sections whose rail moves into the shell
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
- The path in the top bar gains a slot, the rail shows the sections of the new level, and the level's first section is on screen.

**Error Scenarios**:
- The level below is empty — an organization with no workspace, a workspace with no project; the member stays where they are and the screen says so.
- The screen of the new level fails to mount; the level does not change and the rail keeps naming the level that is actually on screen.

**Steps**:
1. [ ] - `p1` - Member picks a workspace in the path, or opens a project from the list - `inst-1`
2. [ ] - `p1` - Write the new level into the shell's context, clearing everything below it - `inst-2`
3. [ ] - `p1` - Run `cpt-studiofrontend-algo-shell-levels-menu` for the new level - `inst-3`
4. [ ] - `p1` - **IF** the level has no item to show - `inst-4`
   1. [ ] - `p1` - **RETURN** stay at the level above and report that the level below is empty - `inst-5`
5. [ ] - `p1` - Run `cpt-studiofrontend-algo-shell-levels-click` for the level's first item - `inst-6`
6. [ ] - `p1` - **IF** the mount fails - `inst-7`
   1. [ ] - `p1` - **RETURN** restore the level that is on screen, so the rail and the content agree - `inst-8`
7. [ ] - `p1` - Run `cpt-studiofrontend-algo-shell-levels-path` so the new level is named in the top bar - `inst-9`
8. [ ] - `p1` - **RETURN** the new level, its rail and its first section - `inst-10`

### Move sideways within a level

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-shell-levels-sideways`

**Actor**: Member

**Success Scenarios**:
- The path names the chosen sibling, the level and the rail stay as they were, and the same section of the new sibling is shown.

**Error Scenarios**:
- The chosen sibling is the current one; nothing happens and no request is made.
- Choosing a sibling above the current level invalidates the levels below it, and the session lands at the chosen level rather than in a project that is no longer under it.

**Steps**:
1. [ ] - `p1` - Member opens a slot of the path and picks a sibling - `inst-1`
2. [ ] - `p1` - **IF** the sibling is the one already in scope - `inst-2`
   1. [ ] - `p1` - **RETURN** nothing changes and nothing is requested - `inst-3`
3. [ ] - `p1` - Write the sibling into its slot and clear every level below it - `inst-4`
4. [ ] - `p1` - **IF** levels were cleared - `inst-5`
   1. [ ] - `p1` - **RETURN** the session is at the level of the chosen sibling, with that level's rail - `inst-6`
5. [ ] - `p1` - **RETURN** the same section, now of the chosen sibling - `inst-7`

### Choose a section of the level

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-shell-levels-section`

**Actor**: Member

**Success Scenarios**:
- The chosen section is on screen and its item is the active one in the rail.

**Error Scenarios**:
- The action reaches an entry that has meanwhile been unmounted; the shell mounts it instead of reporting a failure.
- The MFE changes the section by itself; the rail follows it rather than pointing at the section the member last clicked.

**Steps**:
1. [ ] - `p1` - Member activates an item of the rail - `inst-1`
2. [ ] - `p1` - Run `cpt-studiofrontend-algo-shell-levels-click` - `inst-2`
3. [ ] - `p1` - Mark the item active in the shell's own state, not in the MFE's - `inst-3`
4. [ ] - `p1` - **IF** the MFE reports a section of its own - `inst-4`
   1. [ ] - `p1` - **RETURN** adopt the reported section as the active item - `inst-5`
5. [ ] - `p1` - **RETURN** the section on screen with its item active - `inst-6`

## 3. Processes / Business Logic (CDSL)

### Resolve the menu of the level

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-shell-levels-menu`

**Input**: the level in scope, and the screen extensions registered in the screen domain

**Output**: the items of the rail, in order, and which of them is the settings item

**Steps**:
1. [x] - `p1` - Keep the extensions whose declared level is the level in scope - `inst-1`
2. [x] - `p1` - **IF** an extension declares no level - `inst-2`
   1. [x] - `p1` - Treat it as belonging to the organization level, so an un-migrated manifest stays reachable - `inst-3`
3. [x] - `p1` - Sort what is left by `presentation.order` - `inst-4`
4. [x] - `p1` - Move the item marked as the level's settings to the end - `inst-5`
5. [x] - `p1` - **RETURN** the ordered items - `inst-6`

### Decide what a menu click does

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-shell-levels-click`

**Input**: the chosen item, and the extension currently mounted in the screen domain

**Output**: either a mounted extension, or the chosen section relayed to the mounted one

**Steps**:
1. [x] - `p1` - **IF** the chosen item's entry is the entry of the mounted extension - `inst-1`
   1. [x] - `p1` - Write the chosen item's section into the shell's context and publish it as the section property - `inst-2`
   2. [x] - `p1` - **RETURN** the section changed without a remount; re-picking the open section republishes the same value and changes nothing - `inst-3`
2. [x] - `p1` - Leave the project scope, so the section of the old screen does not outlive it - `inst-4`
3. [x] - `p1` - Write the chosen item's section, or `null` when it declares none, and publish it - `inst-6`
4. [x] - `p1` - Mount the chosen item in the screen domain, one mount at a time - `inst-5`
5. [x] - `p1` - **RETURN** the mounted extension - `inst-7`

The click is what decides the active item, so the click is what writes it —
`inst-6` before `inst-5`, and by the same hand as `inst-2`. Deciding it when
the mount finishes puts the decision on the far side of an await, where the
next click cannot overrule it: two overlapping mounts then land in whichever
order they happen to resolve, and the rail names a section the screen does not
show. The mount is the slow part and the part that can fail; what the member
asked for is known before it starts.

One mount at a time is the rule, not the guarantee: a mount bound to a root
that has since been detached cannot be called off, and the lock is let go for it
so that the next one is not swallowed. So `inst-5` is about where things end up
— once the overlapping mounts have settled, the domain holds the item asked for
last. A mount that has been replaced and still reaches the domain last is undone
rather than prevented, by asking for the current item again once the domain is
free. Preventing it would need a cancellation the runtime does not offer.

`inst-5`'s "one mount at a time" governs the whole click, not just its own
step: a click that arrives while a mount is running is dropped, the relay of
`inst-2` included. Relaying a section of the screen being replaced would leave
that token naming the screen that arrives, and no item of its rail carries it —
the rail then marks nothing at all.

That leaves two writers of the active section, which is what
`cpt-studiofrontend-flow-shell-levels-section` already asks for: the shell
writes what was asked for (`inst-3` there), and the MFE's own report is adopted
when it arrives (`inst-4`/`inst-5` there). Neither races the other — one
answers the click, the other answers the MFE.

### Assemble the path

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-shell-levels-path`

**Input**: the level in scope, and what is selected at each level

**Output**: the slots of the path, outermost first

**Steps**:
1. [x] - `p1` - Take the levels from the organization down to the level in scope - `inst-1`
2. [x] - `p1` - **IF** nothing is selected at one of them, leave that slot out rather than naming an empty level - `inst-2`
3. [x] - `p1` - **RETURN** the slots, outermost first, each with its siblings behind it - `inst-3`

There is no narrow layout to fit into: the design covers the desktop only, so
the path is drawn at one width and every slot in scope is always shown. A
breakpoint invented here would be a guess at a design nobody has made — see the
same reasoning in `cpt-studiofrontend-dod-shell-levels-chain`.

## 4. States (CDSL)

### Context Ladder State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-shell-levels-ladder`

**States**: Organization, Workspace, Project

**Initial State**: Organization

**Transitions**:
1. [ ] - `p1` - **FROM** Organization **TO** Workspace **WHEN** a workspace is chosen in the path - `inst-1`
2. [ ] - `p1` - **FROM** Workspace **TO** Project **WHEN** a project is opened - `inst-2`
3. [ ] - `p1` - **FROM** Project **TO** Workspace **WHEN** the project is left - `inst-3`
4. [ ] - `p1` - **FROM** Workspace **TO** Organization **WHEN** an organization-level item is chosen - `inst-4`
5. [ ] - `p1` - **FROM** Project **TO** Organization **WHEN** an organization-level item is chosen, skipping the level between - `inst-5`
6. [ ] - `p1` - **FROM** Project **TO** Workspace **WHEN** the workspace is switched, because the open project is not under the new one - `inst-6`
7. [ ] - `p1` - **FROM** Workspace **TO** Organization **WHEN** the organization is switched, because neither the workspace nor the project survives it - `inst-7`
8. [ ] - `p1` - **FROM** Organization **TO** Organization **WHEN** the session is reloaded, because no level is restored without an address - `inst-8`

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

**Implements**:
- `cpt-studiofrontend-algo-shell-levels-menu`

**Touches**:
- Entities: `mfe.json` (every MFE), `app/mfe/schemas`, `screenLevels`, `Rail`

### The shell draws the navigation of every level

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-shell-draws`

The system **MUST** draw the rail in the shell for every level, from the
extensions registered in the screen domain, and **MUST NOT** leave a level's
navigation to be drawn inside an MFE.

The rail is a permanent icon-width column that expands over the content with
labels, not a drawer: a drawer is open or closed, and the level's sections have
to be reachable without opening anything first. It is built on the kit's
`Sidebar collapsible="icon"`, which already carries the icon width and the
labels — the shell's local copy of the sidebar primitive goes away with it. No
tooltips: the panel expands on hover, which is where the label belongs.

Icons keep one weight; the active item is distinguished by its background.
Filled-when-active would need a second icon field in the presentation contract,
and a contract change for an icon variant is not worth what it costs every
manifest.

`ProjectRail` in `projects-mfe` is deleted, and the project's sections are
declared in its manifest instead. What the MFE keeps is its own section state;
what it loses is the drawing of navigation. That half lands with the sections
themselves; the shell's rail is what this DoD covers.

The rule for a level with nothing to navigate is stated as a count, not as a
named level: **a rail of one item is not a rail**, because that item is the
level and the path already names it. So the workspace level needs no special
case, and neither will any later level that turns out to have one screen.

**Implements**:
- `cpt-studiofrontend-flow-shell-levels-section`

**Touches**:
- Entities: `Rail`, `Menu` (removed), `ProjectRail` (removed), `components/ui/sidebar` (removed), `mfe.json` (projects-mfe)

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
MFE reports rather than insisting on the one last clicked. Without that the rail
would highlight a section that is not on screen.

The active item is the shell's state, not `projects/nav`. That slice stays as the
MFE's own view of itself, but it stops being the truth the rail reads.

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
- Entities: `Rail`, `screenLevels`, `appContextSlice`, `sharedContext`, `contextActions`, `ProjectsRoot` (projects-mfe), `navSlice`, `ProjectRail` (removed)

### The chain is a breadcrumb of three slots

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-chain`

The system **MUST** show the path to the level in scope as a breadcrumb in the
top bar — one slot per level in scope, each with its own menu of siblings — and
**MUST** build it on the kit's `Breadcrumb`.

One slot per level, not one slot with several modes: the organization, the
workspace and the project are in scope at the same time, so `ContextSwitcher`'s
`org`/`project` alternation and the separate `WorkspaceSwitcher` are replaced by
one slot component used three times.

Every slot is a `BreadcrumbLink` rendered as its menu trigger, the last one
included: `BreadcrumbPage` marks the current crumb `aria-disabled`, and here the
current level is the most clickable thing in the bar. `aria-current="page"` is
set by us instead.

Each slot is two lines — the level's name in caps above the entity's name — and
that has consequences that are part of this decision, not details of it:

- `BreadcrumbList` ships `flex-wrap: wrap`. With 44px slots the chain would wrap
  and break the 56px bar, so the list is `nowrap` here.
- The width is set by the entity's name, not by the caps label: both lines
  ellipsize, and the label — one of three constant words — is the one that gives
  way.
- Each slot is a fixed width, so the path does not re-lay itself out as names
  change length, and a long name truncates inside its slot. The chain is not
  responsive: the design covers the desktop only, and rather than invent a
  narrow layout the list is `nowrap` and every slot in scope stays drawn.
- The caps label is `aria-hidden`; the accessible name of the trigger says the
  level and the entity once ("Organization: Acme Corporation, switch"), so a
  screen reader does not read both lines and then the label again.
- Every slot carries a label, so the separators between them stay on one
  centreline.

Type comes from the kit's roles — `--text-meta-*` for the label, the body size
with the label weight for the name — and the hardcoded 16px/600 in the header
goes away.

**Implements**:
- `cpt-studiofrontend-flow-shell-levels-sideways`
- `cpt-studiofrontend-algo-shell-levels-path`

**Touches**:
- Entities: `Header`, `ContextSwitcher` (removed), `WorkspaceSwitcher` (removed), `appContextSlice`

### The workspace level has no menu

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-workspace-level`

The system **MUST** treat the projects list as the screen of the workspace level,
**MUST** draw no rail at that level, and **MUST NOT** offer Projects as an item
of the organization's rail.

Choosing a workspace in the path is what opens its projects. A rail holding a
single item repeats what the path already says, and the workspace's second
screen — its settings — does not exist yet. The rail is not drawn at a level
that has none, rather than standing empty.

The path follows the same rule: the workspace slot is drawn from the workspace
level down and not before it, so at the organization level the path names the
organization alone. Measured against the design, which shows one slot on the
organization's own screens and two on the projects list. The way into a
workspace is that level's Workspaces screen
(`cpt-studiofrontend-dod-workspaces-screen-row-opens`); for the weeks between
this feature and that screen the slot doubled as the entry, which is now undone.

Picking in any slot other than the one in scope moves the session to that slot's
level; picking a sibling of the level in scope keeps the screen, and with it
whatever section the MFE is showing.

**Implements**:
- `cpt-studiofrontend-flow-shell-levels-descend`

**Touches**:
- Entities: `mfe.json` (projects-mfe), `Rail`, `ContextChain`

### The entry point is the first item of the level

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-entry-point`

The system **MUST** mount the first item of the level in scope, by order, and
**MUST NOT** name any screen in the shell's code to decide that.

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

The system **MUST** take the count shown under a name in a slot's menu from the
`child_count` of the tenant list already being read, and **MUST NOT** issue a
request per row to fill a menu.

Organizations, workspaces and projects are all account-management tenants, so
the count of what is inside one arrives in the same page as its name.
`child_count` counts the direct children visible to the caller — which is
exactly what the menu should claim, and what makes "only what you can see"
true rather than approximate.

The count is left out where it would cost a request per row: the artifact count
of a project lives in artifact-ingest, one `total` per project. The slot for it
is drawn empty until that gear can answer for several projects at once, because
a menu that fans out a request per row on every open is worse than a menu
without a subtitle.

**Implements**:
- `cpt-studiofrontend-flow-shell-levels-sideways`

**Touches**:
- API: `GET /cf/account-management/v1/tenants/{id}/children`
- Entities: `appContextSlice`, `appContextEffects`

### Nothing owns the address yet

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-shell-levels-no-address`

The system **MUST NOT** read `location` or write browser history from any MFE,
and **MUST** deliver the level to MFEs as shared properties and actions rather
than as an address.

FrontX has no routing: `presentation.route` is a string no framework code reads,
and `FrontXConfig` declares `routerMode`, `base` and `autoNavigate` without
consuming any of them. Routing is coming upstream, so this feature writes neither
a router nor a bridge to one — a second navigation system would have to be torn
out.

Two costs are accepted openly and are not defects to be reported: a reload
returns the session to the organization level, and there is no link to a project.
Both are already true of the portal today; what changes is that there is more to
lose. The two rules above are what make adopting the framework's router a
configuration change rather than a rewrite.

**Implements**:
- `cpt-studiofrontend-state-shell-levels-ladder`

**Touches**:
- Entities: `appContextSlice`, `sharedContext`, `contextActions`

## 6. Acceptance Criteria

- [ ] At the organization level the rail shows the organization's items only; Findings, Artifacts and the other project sections are absent from it.
- [ ] Choosing a workspace in the path shows that workspace's projects, and the rail disappears for as long as the session is at the workspace level.
- [ ] Projects is not an item of the organization's rail anywhere in the product.
- [ ] Opening a project shows the project's rail — Overview, Artifacts, Findings, Activity, Timeline, Team, and settings last — and the path gains a third slot.
- [ ] Switching between two sections of the same project does not remount the screen: a filter set on Artifacts is still set after visiting Findings and coming back.
- [ ] Switching between two items of the same MFE at the organization level behaves the same way, with no remount.
- [ ] Switching to an item of a different MFE mounts it, and the previous screen is unmounted.
- [ ] After the projects MFE moves the section by itself, the rail highlights the section that is on screen, not the one last clicked.
- [ ] Every slot of the path opens a menu of its siblings, the last slot included.
- [ ] Choosing the sibling already in scope makes no request and changes nothing.
- [ ] Switching the workspace while a project is open leaves the project and lands at the chosen workspace.
- [ ] Switching the organization clears the workspace and the project, and the session is at the organization level.
- [ ] Under the organization slot the menu shows how many workspaces each organization has, and under the workspace slot how many projects — without a request per row.
- [ ] The project slot's menu shows names with no artifact count under them.
- [ ] Every slot of the path is the same fixed width, a long name truncates inside its slot, and the top bar never wraps to a second line.
- [ ] A screen reader announces each slot once, naming the level and the entity, and does not read the caps label separately.
- [ ] Reloading the page returns the session to the organization level, with the level's first item mounted, and nothing in the console claims a route.
- [ ] No MFE reads `location` or pushes browser history; the back button behaves exactly as it did before this feature.
- [ ] A manifest that declares no level still shows its screen at the organization level rather than disappearing.
