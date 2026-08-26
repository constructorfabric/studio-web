# Feature: Create a project


<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [Create an empty project](#create-an-empty-project)
  - [Create a project from an existing repository](#create-a-project-from-an-existing-repository)
  - [Abandon the wizard](#abandon-the-wizard)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
  - [Resolve the applicable step sequence](#resolve-the-applicable-step-sequence)
  - [Write the project](#write-the-project)
  - [Read the repository catalogue](#read-the-repository-catalogue)
- [4. States (CDSL)](#4-states-cdsl)
  - [Wizard State Machine](#wizard-state-machine)
  - [Project Status State Machine](#project-status-state-machine)
- [5. Definitions of Done](#5-definitions-of-done)
  - [The wizard is an overlay extension, not a dialog](#the-wizard-is-an-overlay-extension-not-a-dialog)
  - [A project always has an owner](#a-project-always-has-an-owner)
  - [Steps are declared data](#steps-are-declared-data)
  - [The draft never survives a close](#the-draft-never-survives-a-close)
  - [Creation is two writes and is not atomic](#creation-is-two-writes-and-is-not-atomic)
  - [One or more sources, capped](#one-or-more-sources-capped)
  - [Each root resolves the organization for itself](#each-root-resolves-the-organization-for-itself)
  - [The list learns without polling](#the-list-learns-without-polling)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-project-create`

## 1. Feature Context

### 1.1 Overview

A two-step wizard, opened from the Projects list, that creates a project either
empty or from existing repositories. It is rendered by the projects MFE into
the shell's overlay domain, not as a dialog the MFE draws itself.

### 1.2 Purpose

Projects are the unit the whole portal is organised around, and until now they
could only be seeded by hand. The `studio-project` gear that was going to own
their creation has been retired: a project is an account-management tenant, and
its attributes are tenant metadata (ADR-0010). This feature is the first write
path in the portal against that model.

**Assumptions fixed here**, both because the mockups are silent and the choice
changes the code:

- A project is created under the **organization** in scope, not under a
  workspace. The wizard has no workspace field, and the tenant type accepts both
  parents (`allowed_parent_types` in every backend profile).
- A new project starts with the stage list `['intent']`. The wizard has no stage
  picker; `intent` is the one mandatory stage.
- A modernization takes **one or more** repositories, at most 100 in total. The
  mockup's checkboxes and "3 selected" counter are literal, and the selection
  spans connection tabs — a project may be seeded from a GitHub repository and a
  GitLab one. ADR-0010 lists "modernize carries exactly one source" among the
  invariants that became advisory when the `studio-project` gear was retired;
  this feature widens it and the ADR records the change.

### 1.3 Actors

Named, not identified. A FEATURE may only define `algo`, `dod`, `featstatus`,
`flow` and `state` ids; `actor` and `usecase` belong to a PRD or DESIGN, and this
repository has neither yet. Giving them ids here would either fail validation or
invent a definition in the wrong artifact, so they stay prose until a DESIGN
exists to own them.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** | A signed-in member of the organization in scope. Opens the wizard from the Projects list, fills it in, and confirms creation. |
| **Shell** | The portal shell. Owns the overlay frame: mounts and unmounts the wizard, draws the scrim, and handles Escape and click-outside without consulting the wizard. |

### 1.4 References

- **ADR**: [ADR-0010 — a project is an AM tenant](../../../../docs/adr/0010-projects-are-am-tenants.md)
- **ADR**: [ADR-0008 — simplified navigation shell](../../../../docs/adr/0008-simplified-navigation-shell.md) (no router; steps are state, not routes)
- **Design**: Figma `Constructor Studio mockups`, nodes `40001737:12397` and `40001737:12442`
- **Dependencies**: account-management (`/cf/account-management/v1`), studio-connector (`/studio-connector/v1`)

## 2. Actor Flows (CDSL)

The three flows below stay unchecked on purpose, and not because they are
unimplemented. A checked flow obliges every one of its CDSL instructions to
carry a `@cpt-begin`/`@cpt-end` block, and these span the toolbar, the overlay
plumbing, both steps, the write effect and — for "Abandon the wizard" — the
shell's own dismissal code, which is outside this system's codebase scope. Their
evidence is the acceptance criteria in section 6, exercised against a running
stack; the implementation claims they rest on are the Definitions of Done, which
are traced.

**Use case**: create a project, empty or from existing repositories.

### Create an empty project

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-create-greenfield`

**Actor**: Member

**Success Scenarios**:
- A project appears in the list with status Draft and the given name.

**Error Scenarios**:
- The name duplicates a sibling; account-management refuses and the wizard keeps the draft.
- The tenant is created but its metadata write fails; the project exists with no attributes.

**Steps**:
1. [ ] - `p1` - Member activates "New project" in the list toolbar - `inst-1`
2. [ ] - `p1` - Mount the overlay extension in the shell's overlay domain - `inst-2`
3. [ ] - `p1` - Reset the draft so no earlier attempt is carried in - `inst-3`
4. [ ] - `p1` - Member enters a name, an optional goal, and picks "Start from scratch" - `inst-4`
5. [ ] - `p1` - **IF** the mode is greenfield - `inst-5`
   1. [ ] - `p1` - The repositories step is not applicable, so the primary action reads "Create project" - `inst-6`
6. [ ] - `p1` - Run `cpt-studiofrontend-algo-project-create-write` - `inst-7`
7. [ ] - `p1` - Announce the created project on the MFE event bus so the list refetches - `inst-8`
8. [ ] - `p1` - **RETURN** unmount the overlay extension - `inst-9`

### Create a project from an existing repository

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-create-modernize`

**Actor**: Member

**Success Scenarios**:
- A project appears in the list with status Draft and records every chosen repository as a source.

**Error Scenarios**:
- No connection is configured; the step offers "Manage connections" and nothing to pick.
- The provider rejects the catalogue read; the step reports it and the member can go Back.

**Steps**:
1. [ ] - `p1` - Member fills the details step and picks "Import existing work" - `inst-1`
2. [ ] - `p1` - Advance to the repositories step, now applicable - `inst-2`
3. [ ] - `p1` - `API: GET /studio-connector/v1/connections (one tab per connection)` - `inst-3`
4. [ ] - `p1` - `API: GET /studio-connector/v1/connections/{id}/repositories?search=&limit= (rows for the active tab)` - `inst-4`
5. [ ] - `p1` - Member picks one or more repositories, across tabs if needed, up to the cap - `inst-5`
6. [ ] - `p1` - Run `cpt-studiofrontend-algo-project-create-write` - `inst-6`
7. [ ] - `p1` - **RETURN** unmount the overlay extension and announce the created project - `inst-7`

### Abandon the wizard

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-create-abandon`

**Actor**: Shell

**Success Scenarios**:
- The overlay closes and nothing is written.

**Error Scenarios**:
- None. Dismissal cannot fail and cannot be refused.

**Steps**:
1. [ ] - `p1` - Member presses Escape, clicks the scrim, or activates Cancel - `inst-1`
2. [ ] - `p1` - **IF** the trigger was Cancel - `inst-2`
   1. [ ] - `p1` - The wizard unmounts itself through the overlay domain - `inst-3`
3. [ ] - `p1` - **ELSE** - `inst-4`
   1. [ ] - `p1` - The shell unmounts it without consulting the wizard; there is no confirmation and no veto - `inst-5`
4. [ ] - `p1` - **RETURN** the draft is discarded with the React root - `inst-6`

## 3. Processes / Business Logic (CDSL)

### Resolve the applicable step sequence

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-create-steps`

**Input**: the draft and the current step key

**Output**: the step to render, its neighbours, and whether it is the last one

**Steps**:
1. [x] - `p1` - Filter the declared steps by `isApplicable(draft)` - `inst-1`
2. [x] - `p1` - **IF** the current key is not in the applicable set - `inst-2`
   1. [x] - `p1` - Fall back to the first applicable step, because editing the draft can strand the wizard - `inst-3`
3. [x] - `p1` - Derive previous and next by position in the applicable set, never by a stored index - `inst-4`
4. [x] - `p1` - **RETURN** the resolved step, its neighbours, and whether next is absent - `inst-5`

### Write the project

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-create-write`

**Input**: a complete draft and the organization tenant in scope

**Output**: the created tenant's id, or the reason it was refused

**Steps**:
1. [x] - `p1` - Trim the name; reject an empty one before any request - `inst-1`
2. [x] - `p1` - `API: POST /cf/account-management/v1/tenants (name, project tenant type, parent = organization)` - `inst-2`
3. [x] - `p1` - **IF** account-management refuses - `inst-3`
   1. [x] - `p1` - **RETURN** the refusal; the draft survives so the member can correct it - `inst-4`
4. [x] - `p1` - `API: PUT /cf/account-management/v1/tenants/{id}/metadata/{project config type} (mode, stages, status, brief, source)` - `inst-5`
5. [x] - `p1` - **IF** the metadata write fails - `inst-6`
   1. [x] - `p1` - Report it but keep the tenant: a project without attributes is recoverable, a rollback is not - `inst-7`
6. [x] - `p1` - **RETURN** the tenant id - `inst-8`

### Read the repository catalogue

Two known gaps, both in the gear rather than here, recorded so the screen is not
blamed for them:

- **`@cpt-gap`** — the listing is wider than the connection suggests. The GitHub
  driver calls `GET /user/repos?sort=updated&per_page=N` with no `affiliation`
  parameter, and that endpoint defaults to
  `owner,collaborator,organization_member` — so every organization the
  credential's owner belongs to contributes repositories. Narrowing it needs
  `affiliation` on the driver call or in `RepoQuery`; it cannot be done from the
  client, because one page is clamped to 100 rows and a local filter would hide
  repositories that exist beyond it.
- **`@cpt-gap`** — no repository carries a timestamp anywhere in the connector
  API, so the design's UPDATED column has no data source.

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-create-repos`

**Input**: the active connection and the search text

**Output**: the rows to show

**Steps**:
1. [x] - `p1` - `API: GET /studio-connector/v1/connections?tenant= and GET /studio-connector/v1/providers (source-code drivers only, one tab each, captioned provider and label)` - `inst-1`
2. [x] - `p1` - Pass the search text to the endpoint rather than filtering a page, since it narrows server-side where the provider supports it - `inst-2`
3. [x] - `p1` - Render Updated empty: the connector API carries no timestamp for a repository - `inst-3`
4. [x] - `p1` - **RETURN** the rows - `inst-4`

## 4. States (CDSL)

### Wizard State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-project-create-wizard`

**States**: Details, Repositories

**Initial State**: Details

**Transitions**:
1. [ ] - `p1` - **FROM** Details **TO** Repositories **WHEN** the primary action is used and the mode is modernize - `inst-1`
2. [ ] - `p1` - **FROM** Repositories **TO** Details **WHEN** Back is used - `inst-2`
3. [ ] - `p1` - **FROM** Repositories **TO** Details **WHEN** the mode is changed to greenfield, which strands the current step - `inst-3`

### Project Status State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-project-create-status`

**States**: Draft, Active, Archived

**Initial State**: Draft

**Transitions**:
1. [ ] - `p1` - **FROM** Draft **TO** Active **WHEN** the project is started from the project screen - `inst-1`
2. [ ] - `p1` - **FROM** Active **TO** Archived **WHEN** the project is archived; Archived is terminal - `inst-2`

## 5. Definitions of Done

### The wizard is an overlay extension, not a dialog

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-overlay`

The system **MUST** render the wizard as a second extension of the projects MFE
in the shell's overlay domain, mounted and unmounted through the extension
lifecycle actions, with its own entry and lifecycle instance.

**Implements**:
- `cpt-studiofrontend-flow-project-create-greenfield`
- `cpt-studiofrontend-flow-project-create-abandon`

**Touches**:
- Entities: `mfe.json`, `wizardLifecycle`, `wizardActions`

### A project always has an owner

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-owner`

The system **MUST** set the owner to the member creating the project, writing it
to `owner_id` in the project's metadata, and **MUST** show who that is without
offering a choice.

One owner, not a list, and not selectable at creation: transferring a project is
a decision about a project that already exists, and there is no screen yet where
it could be undone. The mockup draws a picker with a chevron; this screen shows
the member instead, as plain content rather than a control that refuses clicks.

Only the subject id is stored. It comes from the session profile the shell
publishes as a shared property — `/me`'s `subject_id`, with the display name and
address from the token claims — so this screen reads no user list of its own. It
is applied once, when the profile arrives, which may be after the wizard has
mounted.

**Implements**:
- `cpt-studiofrontend-flow-project-create-greenfield`

**Touches**:
- Property: `constructor_studio.session.user.profile.v1~` (published by the shell)
- Entities: `DetailsStep`, `NewProjectWizard`, `ProjectConfig`

### Steps are declared data

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-steps`

The system **MUST** derive which step is shown, what the footer buttons read,
and whether the primary action submits, from the declared step list and the
draft — not from a step index and not from per-screen markup.

**Implements**:
- `cpt-studiofrontend-algo-project-create-steps`

**Touches**:
- Entities: `wizardSteps`, `NewProjectWizard`

### The draft never survives a close

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-reset`

The system **MUST** reset step and draft when the wizard mounts, because the
store outlives the overlay root and the shell offers no affordance for resuming
an abandoned attempt.

**Implements**:
- `cpt-studiofrontend-flow-project-create-abandon`

**Touches**:
- Entities: `createSlice`

### Creation is two writes and is not atomic

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-write`

The system **MUST** create the tenant first and write its attributes second, and
**MUST NOT** attempt to undo the tenant when the second write fails.

**Implements**:
- `cpt-studiofrontend-algo-project-create-write`

**Touches**:
- API: `POST /cf/account-management/v1/tenants`
- API: `PUT /cf/account-management/v1/tenants/{id}/metadata/{type}`

### One or more sources, capped

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-many-sources`

The system **MUST** add each picked repository to the selection rather than
replacing what is already there, **MUST** keep the selection across connection
tabs, **MUST** let a picked row be removed by activating it again, and **MUST
NOT** let the selection exceed 100 repositories in total — at the cap the
unpicked rows are inert and the footer says so.

A repository is identified by its connection together with its provider-native
id: that id is unique only within one connection, and the selection spans them.

**Implements**:
- `cpt-studiofrontend-flow-project-create-modernize`

**Touches**:
- Entities: `createSlice`, `projectDraft`

### Each root resolves the organization for itself

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-org-scope`

The system **MUST** resolve the organization in scope independently in each
mounted root, from one shared derivation, and the wizard **MUST** refuse to
submit without one.

Handing it over is not available. `MfeHandlerMF` loads every expose into its own
blob-URL module graph, so the two entries have separate stores and separate event
buses; a value published by the list is unreachable from the wizard. The
QueryClient is shared (`queryCacheShared` retains the host's off `globalThis`),
so resolving twice costs cache hits rather than requests.

**Implements**:
- `cpt-studiofrontend-algo-project-create-write`

**Touches**:
- Entities: `shared/organization`, `projectTree`, `NewProjectWizard`

### The list learns without polling

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-create-announce`

The system **MUST** make a created project appear in the list without a manual
refresh, by invalidating the organization's children page on the shared
QueryClient.

Not by an event the list listens to: the two roots do not share an event bus.
Only the organization's own page is invalidated — a project is created as its
direct child, so no other branch gained a row.

**Implements**:
- `cpt-studiofrontend-flow-project-create-greenfield`

**Touches**:
- Entities: `wizardEffects`, `NewProjectWizard`

## 6. Acceptance Criteria

- [ ] Activating "New project" opens the overlay; the projects list stays visible behind the scrim.
- [ ] Escape, a click on the scrim, and Cancel all close the overlay and write nothing.
- [ ] Reopening the wizard after abandoning a filled-in draft shows an empty first step.
- [ ] With "Start from scratch" selected, the details step's primary action reads "Create project" and there is no second step.
- [ ] With "Import existing work" selected, the primary action reads "Continue" and leads to the repositories step.
- [ ] Switching back to "Start from scratch" while on the repositories step returns to the details step.
- [ ] The primary action is disabled until the current step is complete: a non-empty name and a chosen starting point on the details step, at least one chosen repository on the repositories step.
- [ ] Picking a second repository keeps the first; picking a selected one removes it; the footer counts what is selected.
- [ ] The selection survives switching connection tabs, and a created project records every picked repository.
- [ ] At 100 selected the unpicked checkboxes are inert and the footer states the maximum.
- [ ] A connection to a model provider (an API key) is not offered as a tab on the repositories step.
- [ ] A created project is a tenant of the project type whose parent is the organization in scope, with `status = draft`, `stages = ['intent']` and an `owner_id` in its metadata.
- [ ] The owner field names the signed-in member and offers no way to change them; the created project carries their subject id as `owner_id`.
- [ ] A refused creation leaves the wizard open with the draft intact and shows what was refused.
- [ ] The created project appears in the list without a manual refresh.
- [ ] The Updated column on the repositories step renders empty rather than a fabricated value.
