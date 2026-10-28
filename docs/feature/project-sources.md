---
type: feature
status: draft
owner: studio-team
---

# Feature: The project's sources


- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-project-sources`

- [ ] `p1` - `cpt-studio-feature-project-sources`

## Table of Contents

<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [Connect repositories to a project](#connect-repositories-to-a-project)
  - [See the project's sources](#see-the-projects-sources)
  - [Act on a source from its row](#act-on-a-source-from-its-row)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
  - [Attach the picked repositories](#attach-the-picked-repositories)
  - [Sync the sources nothing has pulled in](#sync-the-sources-nothing-has-pulled-in)
  - [Build the Sources rows](#build-the-sources-rows)
  - [Count the Sources footer](#count-the-sources-footer)
  - [Say what a row's menu offers](#say-what-a-rows-menu-offers)
- [4. States (CDSL)](#4-states-cdsl)
  - [Connect Source Dialog State Machine](#connect-source-dialog-state-machine)
  - [Source Row Sync State Machine](#source-row-sync-state-machine)
- [5. Definitions of Done](#5-definitions-of-done)
  - [Connect source is an overlay extension, opened from the Sources header](#connect-source-is-an-overlay-extension-opened-from-the-sources-header)
  - [The dialog and the wizard share one repository picker](#the-dialog-and-the-wizard-share-one-repository-picker)
  - [A repository is attached once, and the project holds at most 100](#a-repository-is-attached-once-and-the-project-holds-at-most-100)
  - [The picks are appended to the config, and only then does the dialog close](#the-picks-are-appended-to-the-config-and-only-then-does-the-dialog-close)
  - [With no connection, the dialog leads to creating one](#with-no-connection-the-dialog-leads-to-creating-one)
  - [The project screen syncs the sources the graph does not have](#the-project-screen-syncs-the-sources-the-graph-does-not-have)
  - [Each source in the config is a row, joined to its repository node](#each-source-in-the-config-is-a-row-joined-to-its-repository-node)
  - [Last sync is the last successful sync, and the sync this tab follows](#last-sync-is-the-last-successful-sync-and-the-sync-this-tab-follows)
  - [The row says what can be done with its sync](#the-row-says-what-can-be-done-with-its-sync)
  - [A missing number is shown as missing, never as zero](#a-missing-number-is-shown-as-missing-never-as-zero)
  - [The rows are searched by name and path, in the config's order](#the-rows-are-searched-by-name-and-path-in-the-configs-order)
  - [The footer counts the whole project](#the-footer-counts-the-whole-project)
  - [The section reads through the shared cache, and the table shows the rows it builds](#the-section-reads-through-the-shared-cache-and-the-table-shows-the-rows-it-builds)
  - [The row's menu is a component of its own, which the table places](#the-rows-menu-is-a-component-of-its-own-which-the-table-places)
  - [Sync now joins the import, and Cancel sync stops the run](#sync-now-joins-the-import-and-cancel-sync-stops-the-run)
  - [A refused cancel or retry is a notification](#a-refused-cancel-or-retry-is-a-notification)
  - [Open specs shows Specs searched by the source's path](#open-specs-shows-specs-searched-by-the-sources-path)
  - [The repository's page opens from its clone URL](#the-repositorys-page-opens-from-its-clone-url)
  - [Disconnect is shown, disabled, until the backend can take a source out](#disconnect-is-shown-disabled-until-the-backend-can-take-a-source-out)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

## 1. Feature Context

### 1.1 Overview

The Sources section of a project: the repositories the project works from. A
project gets its first repositories in the New project wizard
([Create a project](project-create.md)); this section lists them and attaches
more.

This spec starts with attaching more: **Connect source** in the section's
header opens a dialog with the wizard's repository picker, and the picked
repositories join the project's config and its import (#687). It then builds the
rows the section's table shows (#685): each source joined to its repository in
the graph, its week of pull requests and commits, its specs and its sync. Each
row has a menu (#686): sync the source or cancel its sync, open its specs, open
it at its provider. Disconnect is in the menu, disabled until the backend can
take a source out of a project (#852). The table shows the rows (#688). Upload
documents (#693) adds Markdown and text files to the project as Studio
documents; the section lists them as one more row, Uploaded files, after the
sources.

### 1.2 Purpose

Until now a project's repositories were fixed at creation. The design's Sources
section has Connect source in its header, and everything it needs exists: the
wizard's picker, the config write (#709) and the import that syncs a
repository (`cpt-studiofrontend-algo-project-artifacts-sync`).

**Assumptions fixed here**, because the design is silent and each changes the
code:

- **The dialog offers the organization's existing connections only**, grouped
  by provider, as the wizard does: a chip per source-code provider it has a
  connection to, the chosen provider's connections under it. The design
  authorizes a provider inside the dialog; creating a connection here is out of
  #687's scope. An organization with no source connection is offered the
  connection form of the Connections screen instead.
  GitLab and Bitbucket connections are listed like GitHub ones; their
  repositories are attached and not synced (below).
- **A repository is attached once, whichever connection it came through.** Two
  sources are the same repository when their clone URLs give the same key, the
  one the backend uses (`repository_key`, `studio-backend/src/project_sources.rs`).
  A second connection to the same repository would sync a second copy of it.
- **100 repositories is the project's ceiling**, the attached ones and the
  picked ones together. The wizard's cap is the same number, for a project that
  has none yet.
- **A new source records its branch.** `branch` is the repository's default
  branch as the provider reports it when the source is attached, and
  `share_mode` is `branch`. The IDE session checks out that branch from then on,
  even if the repository's default changes later. A provider that reports no
  default branch gets no `branch`, and the session checks out the remote's HEAD.
- **The dialog writes the config and nothing else.** It is an overlay extension,
  and each extension of this MFE has its own store and event bus
  (`cpt-studiofrontend-dod-project-create-org-scope`), so the project screen
  cannot hear it. The screen finds the sources the graph has no repository for
  and syncs those, deciding from the data as it does for a new project's first
  import (`cpt-studiofrontend-dod-project-artifacts-import-detect`).
- **Only GitHub repositories are synced.** The GitLab and Bitbucket drivers list
  repositories and nothing more: a sync request for one is accepted, then fails
  five times. Such a repository is attached and its line in the import says why
  it is not synced (`cpt-studiofrontend-algo-project-artifacts-sync`).

**For the rows (#685)**, fixed here because the design is silent, or shows data
the prototype does not read:

- **A row is a source in the config, and nothing else.** The design also lists a
  repository the project's artifacts come from but which is not attached ("Not
  connected", "Artifact snapshot · no connection recorded"). Here such a
  repository can only be left over from a failed reconcile, so it gets no row.
- **A row finds its repository node by path and connection.** The node's
  `connector_id` is the connection's `secret_ref`, empty for a connection
  without a token; a node without one, or a source whose connection is not
  known, is matched by its path alone. A repository attached again through
  another connection does not take the old connection's node: it reads Not
  synced, and the screen syncs it, comparing by the same key.
- **The branch is the config's.** A source attached before #687 has none, and
  neither the repository node nor the connection's listing is read for one; its
  row shows the path alone.
- **Last sync has two lines.** The first is the last successful sync, unchanged
  while a sync runs; the second is the sync this tab follows: syncing,
  cancelling, or the last attempt failed or cancelled, as the design's second
  line does.
- **A missing number is not zero.** A read that failed, a repository with no
  node, files the documents gear cannot list: each leaves its numbers missing.
  Only the config and the repository nodes fail the section, because without
  them no row can say whether it was synced.
- **The rows keep the config's order**, as in the design, which sorts no column.
  The footer counts the whole project, whatever the search keeps.
- **The section reads through the shared query cache**, and the table only shows
  what the reads give. The Specs list reads inside its table's load (#711);
  Sources has six reads, the import's live state, and other places that change
  what it reads, each of which drops its query in the shared cache rather than
  reaching into this section.

**For the row menu (#686)**, fixed here because the design is silent, or shows
what the gears cannot do yet:

- **The menu is a component of its own.** The table (#688) puts it in the
  Actions column, and the row's Specs number opens the specs as the menu does.
- **Sync now adds one repository to the import.** It joins the project's
  import beside the other repositories' syncs, as the sync of the missing
  sources does. Asking to sync the project's sources would replace the import's
  lines and end the watch of the runs it follows.
- **A stopped sync is retried when its run can be.** Sync now puts a failed or
  cancelled run back on the queue, and requests a new sync for a lost one or
  one the gear never gave a run.
- **Only a refused cancel or retry is a notification.** Without one, a refused
  cancel turns Cancelling… back into Syncing…, and a refused retry changes
  nothing. A refused sync request and a failed sync are on the row already: its
  second line reads Last attempt failed, with the reason.
- **Disconnect is shown and disabled.** Taking a source out of a project is one
  operation for the backend: the config written and everything synced from the
  repository pruned, durably. Done from the browser as a config write and then
  `POST /studio-artifact-ingest/v1/reconcile`, a reconcile that fails, or a tab
  closed in between, leaves the repository's files, pull requests and specs in
  Artifacts and Specs, with no row left in Sources to try again from.
- **`Open in {provider}` is built from the clone URL.** For GitHub and
  Bitbucket the connection's `base_url` is the provider's API root, not the
  site a person opens. A source whose clone URL is not an `http` or `https`
  address gets no Open in.
- **A disabled item says why in its title**, as the design's Disconnect does.
  For a source whose provider cannot sync or whose connection is gone, its Last
  sync says the same.

**For the table (#688)**, fixed here because the issue or the design leaves it
open:

- **There is a Role column, as in the prototype.** #688 has none, since nothing
  in the data gives a source a role; the column shows the source's provider, as
  the prototype's does.
- **The pager pages by 25, 50 or 100 rows, 25 to start**, as the Specs table
  does, and is hidden while every source fits on one page.
- **The search is on the left**, as the prototype's `list-standard.md` has it;
  the kit's text search fills only the grid's left slot.
- **The sparkline has one scale for the whole table, at least 3**, so a single
  pull request does not draw a full bar. A quiet day is a grey tick, which is
  how a quiet week draws a flat line. The tooltip names the day.
- **Last sync is a day and a time**, "3 Sept, 16:06", with the year only when
  it is not this one, and the relative time as its title.
- **With no sources, the kit's empty state offers Upload documents and Connect
  source**, with no column headers above it: the kit's grid hides the table when
  it has no rows and no filter. A search that matches nothing says so and offers
  Clear search.
- **With no workspace open the rows show**, with no Uploaded files row, and the
  footer's specs from sources are missing. With no organization open the
  section says so.
- **Every Studio document of the project reads as uploaded.** The backend keeps
  no origin for a document, so one written in Studio by another client is in
  the Uploaded files row too (#693).
- **The search and the cells take the kit's sizes**, as Specs does: 40px and
  12px, where the prototype has 32px and 14px. Which one Studio's tables keep is
  open with design (#888).

**Requirements**: `cpt-studio-fr-connections`, `cpt-studio-fr-artifact-ingest`

**Principles**: `cpt-studio-principle-project-is-unit`

### 1.3 Actors

Actor ids are defined in the [PRD](../prd/constructor-studio.md); a gear taking part is cited by its design component id.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** (`cpt-studio-actor-member`) | A signed-in member with the project open. Picks repositories and connects them. |
| **Shell** (`cpt-studio-actor-shell`) | Owns the overlay frame: mounts and unmounts the dialog, draws the scrim, handles Escape and click-outside. Moves to the section the MFE asks for, and shows its notifications. |
| **MFE** (`cpt-studio-actor-mfe`) | projects-mfe. Draws the dialog in one extension and the project screen, with each row's menu, in another; the screen syncs what the dialog attached. |
| **Connector gear** (`cpt-studio-component-connector`) | Lists the organization's connections and each connection's repositories. |
| **Artifact gear** (`cpt-studio-component-artifact-ingest`) | Syncs each new GitHub repository into the graph; answers each repository's node and its week of pull requests and commits. |
| **Documents gear** (`cpt-studio-component-documents`) | Counts each repository's specs, and lists the project's Studio documents. |
| **Event stream** (`cpt-studio-component-events`) | Carries the transitions of each sync the tab follows. |
| **Tasks gear** (`cpt-studio-component-tasks`) | Cancels a source's sync run, and puts a failed or cancelled one back on the queue. |

### 1.4 References

- **PRD**: [PRD](../prd/constructor-studio.md)
- **Design**: [DESIGN](../design/constructor-studio.md), component `cpt-studio-component-projects-mfe`
- **Decomposition**: [DECOMPOSITION](../decomposition/constructor-studio.md), entry `cpt-studio-feature-project-sources`
- **Feature**: [Create a project](project-create.md): the picker this dialog shares, and the config's first write
- **Feature**: [Project artifacts](project-artifacts.md): the import the new repositories join
- **Feature**: [Connect a source host](connection-create.md): the form Add connection opens
- **Feature**: [The project's specs](project-specs.md): the section before this one, and the filter Open specs sets
- **Feature**: [Levels in the shell](shell-levels.md): the section the MFE asks for, written into the address
- **Decomposition entry** `cpt-studio-feature-documents`: the specs counted per repository and the project's Studio documents (no feature spec of its own)
- **Issues**: #643 (the Specs and Sources sections), #687 (Connect source), #685 (the rows), #686 (the row menu), #709 (the config write), #711 (the Specs list's load), #688 (the table), #693 (uploading documents), #852 (Disconnect)

## 2. Actor Flows (CDSL)

Unchecked on purpose, for the reason stated in `project-create.md`: a checked
flow obliges every instruction to carry a code marker, and this one spans two
extensions, the shell's overlay frame and connections-mfe.

**Use case**: attach more repositories to a project.

### Connect repositories to a project

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-sources-connect`

**Actor**: Member

**Success Scenarios**:
- The picked repositories are in the project's config, and the new GitHub ones are syncing beside the project's other repositories.

**Error Scenarios**:
- The organization has no source connection; the dialog says so and offers Add connection.
- The config write is refused; the dialog stays open with the reason and the picks.
- The project's config cannot be read; the dialog says so and offers no Connect source.
- A picked repository is not on GitHub; it is attached and its line says why it is not synced.

**Steps**:
1. [ ] - `p1` - Member activates Connect source in the Sources header - `inst-1`
2. [ ] - `p1` - Mount the dialog's extension in the shell's overlay domain - `inst-2`
3. [ ] - `p1` - Reset the picks, the search and the chosen connection, so no earlier attempt is carried in - `inst-3`
4. [ ] - `p1` - `API: GET /studio-connector/v1/connections?tenant= and GET /studio-connector/v1/providers (a chip per source-code provider with a connection, nothing listed yet)` - `inst-4`
5. [ ] - `p1` - **IF** the organization has no source connection - `inst-5`
   1. [ ] - `p1` - Member activates Add connection - `inst-6`
   2. [ ] - `p1` - **RETURN** unmount the dialog and mount the connection form of connections-mfe - `inst-7`
6. [ ] - `p1` - Member picks a provider; its connections show, one in a line or several as tabs - `inst-4a`
7. [ ] - `p1` - `API: GET /cf/account-management/v1/tenants/{project}/metadata/{project config type} (the repositories already attached)` - `inst-8`
8. [ ] - `p1` - `API: GET /studio-connector/v1/connections/{id}/repositories?search=&limit= (rows for the active connection)` - `inst-9`
9. [ ] - `p1` - Member picks repositories, across providers and connections if needed; the attached ones show picked and cannot be changed - `inst-10`
10. [ ] - `p1` - Member activates Connect source - `inst-11`
11. [ ] - `p1` - Run `cpt-studiofrontend-algo-project-sources-attach` - `inst-12`
12. [ ] - `p1` - **IF** the write is refused - `inst-13`
    1. [ ] - `p1` - **RETURN** the dialog stays open with the reason and the picks - `inst-14`
13. [ ] - `p1` - Unmount the dialog - `inst-15`
14. [ ] - `p1` - The project screen runs `cpt-studiofrontend-algo-project-sources-sync-missing` - `inst-16`
15. [ ] - `p1` - **RETURN** the new repositories' syncs show in the project's import - `inst-17`

**Use case**: see the repositories a project works from, and how each one stands.

### See the project's sources

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-sources-list`

**Actor**: Member

**Success Scenarios**:
- Each source of the project is a row: its provider, name, path and branch, its specs, its pull requests and commits over the last 7 days, and its last sync.

**Error Scenarios**:
- The project's config or its repository nodes cannot be read; the section says so.
- Another read fails; the rows show, and what that read gives is missing.

**Steps**:
1. [ ] - `p1` - Member opens the Sources section of a project - `inst-1`
2. [ ] - `p1` - `API: GET /cf/account-management/v1/tenants/{project}/metadata/{project config type} (the sources)` - `inst-2`
3. [ ] - `p1` - `API: GET /cf/studio-artifact-ingest/v1/nodes?scope={project}&type=repo (each source's repository)` - `inst-3`
4. [ ] - `p1` - `API: GET /studio-connector/v1/connections?tenant={organization} (each source's connection)` - `inst-4`
5. [ ] - `p1` - `API: GET /cf/studio-artifact-ingest/v1/source-activity?scope={project} (pull requests and commits per repository)` - `inst-5`
6. [ ] - `p1` - `API: GET /cf/studio-documents/v1/specs-per-source?scope={project} (specs per repository)` - `inst-6`
7. [ ] - `p1` - `API: GET /cf/studio-documents/v1/workspaces/{workspace}/projects/{project}/documents?limit=200&offset={read so far} (the project's Studio documents, every page)` - `inst-7`
8. [ ] - `p1` - **IF** the config or the repository nodes cannot be read - `inst-8`
   1. [ ] - `p1` - **RETURN** the section says so - `inst-9`
9. [ ] - `p1` - Run `cpt-studiofrontend-algo-project-sources-rows` and `cpt-studiofrontend-algo-project-sources-footer` - `inst-10`
10. [ ] - `p1` - Member searches; the rows whose name or path holds the text stay, and the footer does not change - `inst-11`
11. [ ] - `p1` - A sync of one of the sources settles; read the repository nodes, the activity and the specs again, and build the rows again - `inst-12`
12. [ ] - `p1` - **RETURN** the rows and the footer - `inst-13`

**Use case**: act on one of the project's sources from its row.

### Act on a source from its row

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-sources-row-menu`

**Actor**: Member

**Success Scenarios**:
- The source's sync is requested, retried or cancelled, and the row's Last sync follows it.
- Specs opens, searched by the source's path.
- The repository opens at its provider, in a new tab.

**Error Scenarios**:
- The gear refuses the cancel or the retry; a notification says so, and the row's sync stays as it was.
- The gear refuses the sync request, or the sync fails; the row's second line reads Last attempt failed, with the reason.
- The source cannot be synced now; Sync now is disabled, with the reason.

**Steps**:
1. [ ] - `p1` - Member opens the menu on a source's row - `inst-1`
2. [ ] - `p1` - Run `cpt-studiofrontend-algo-project-sources-row-menu` for the items and what each does - `inst-2`
3. [ ] - `p1` - **IF** Member activates Sync now on a stopped sync whose run can be retried - `inst-3`
   1. [ ] - `p1` - `API: POST /cf/studio-tasks/v1/runs/{id}/retry`, as `cpt-studiofrontend-algo-project-artifacts-run-control` does - `inst-4`
4. [ ] - `p1` - **ELSE IF** Member activates Sync now - `inst-5`
   1. [ ] - `p1` - Run `cpt-studiofrontend-algo-project-artifacts-sync-request` for the source, then `cpt-studiofrontend-algo-project-artifacts-sync-add` with what it returns - `inst-6`
5. [ ] - `p1` - **IF** Member activates Cancel sync - `inst-7`
   1. [ ] - `p1` - `API: POST /cf/studio-tasks/v1/runs/{id}/cancel`, as `cpt-studiofrontend-algo-project-artifacts-run-control` does, without asking first - `inst-8`
6. [ ] - `p1` - **IF** the gear refuses the cancel or the retry - `inst-9`
   1. [ ] - `p1` - The shell shows a notification naming the source, with the gear's reason when it gives one - `inst-10`
7. [ ] - `p1` - **IF** Member activates Open specs from this source - `inst-11`
   1. [ ] - `p1` - Run `cpt-studiofrontend-flow-project-specs-from-source` with the source's `full_path` - `inst-12`
8. [ ] - `p1` - **IF** Member activates `Open in {provider}` - `inst-13`
   1. [ ] - `p1` - Open the repository's address in a new tab, without the opener - `inst-14`
9. [ ] - `p1` - **RETURN** the row's Last sync follows the sync, as `cpt-studiofrontend-state-project-sources-row-sync` says - `inst-15`

## 3. Processes / Business Logic (CDSL)

### Attach the picked repositories

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-sources-attach`

**Input**: the open project and the picked repositories, each with its connection, path, clone URL and default branch

**Output**: the project's sources as written, or the reason the write was refused

**Steps**:
1. [x] - `p1` - Make a source of each pick: its connection, path and clone URL, `branch` set to its default branch when the provider reports one, and `share_mode` `branch` - `inst-1`
2. [x] - `p1` - Record a sync attempt for the project in the tab's session storage, so the screen does not start a first import of every source on its own - `inst-2`
3. [x] - `p1` - `API: GET /cf/account-management/v1/tenants/{project}/metadata/{project config type}`, read fresh - `inst-3`
4. [x] - `p1` - Append the new sources, skipping a repository the project already has through any connection - `inst-4`
   1. [x] - `p1` - **IF** that takes the project past 100 sources, **RETURN** the refusal that says so; nothing is written - `inst-4a`
5. [x] - `p1` - `API: PUT /cf/account-management/v1/tenants/{project}/metadata/{project config type}` with every other field of the config as it was read - `inst-5`
6. [x] - `p1` - **IF** the read or the write fails - `inst-6`
   1. [x] - `p1` - **RETURN** the refusal; the config is as it was - `inst-7`
7. [x] - `p1` - Drop the cached config, so every extension reading it reads it again - `inst-8`
8. [x] - `p1` - **RETURN** the sources as written - `inst-9`

### Sync the sources nothing has pulled in

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-sources-sync-missing`

**Input**: the open project, each time the project screen reads its sources or its repository nodes

**Output**: the syncs requested for the sources the graph does not have yet, or nothing

**Steps**:
1. [x] - `p1` - **IF** the gear has not yet been asked for the project's syncs in flight since the project opened (`cpt-studiofrontend-algo-project-artifacts-sync-resume`) - `inst-13`
   1. [x] - `p1` - **RETURN** nothing for now; a sync another tab started gets its line first - `inst-14`
2. [x] - `p1` - **IF** the project's first import is starting (`cpt-studiofrontend-algo-project-artifacts-first-import`) - `inst-1`
   1. [x] - `p1` - **RETURN** nothing; the first import syncs every source - `inst-2`
3. [x] - `p1` - Read the project's sources from its config - `inst-3`
4. [x] - `p1` - `API: GET /cf/studio-artifact-ingest/v1/nodes?scope={project}&type=repo` for the repositories the graph has - `inst-4`
5. [x] - `p1` - Take the sources with no repository node of the same path and connection, found as `cpt-studiofrontend-algo-project-sources-rows` finds a row's node - `inst-5`
6. [x] - `p1` - Leave out a source that already has a line in the import, whatever its state - `inst-6`
7. [x] - `p1` - Leave out a source a sync was already requested for in this tab, whatever came of it - `inst-7`
8. [x] - `p1` - **IF** none is left - `inst-8`
   1. [x] - `p1` - **RETURN** nothing - `inst-9`
9. [x] - `p1` - Run `cpt-studiofrontend-algo-project-artifacts-sync-request` for them, so only GitHub repositories are asked for and the rest get an unsyncable line - `inst-10`
10. [x] - `p1` - Run `cpt-studiofrontend-algo-project-artifacts-sync-add` with what it returned; it records each repository as requested in this tab - `inst-11`
11. [x] - `p1` - **RETURN** the requested syncs - `inst-12`

The rule reads data, not a change. A source attached in another tab, or while
the project was closed, or just before a reload, has no repository node either,
so it is found the next time the project screen reads the project.

### Build the Sources rows

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-sources-rows`

**Input**: the project's sources; its repository nodes; the organization's connections, the activity, the specs per repository and the project's own Studio documents, each read or not; the import's lines for the project

**Output**: one row per source, in the config's order, and the Uploaded files row after them

**Steps**:
1. [x] - `p1` - **FOR EACH** source in the config, in its order - `inst-1`
   1. [x] - `p1` - Find its repository node: the same path, ignoring case, and a `connector_id` equal to its connection's `secret_ref`; else one of the same path with no `connector_id`, or with any **IF** its connection is not known - `inst-2`
   2. [x] - `p1` - Find its connection by id - `inst-3`
   3. [x] - `p1` - Take the provider from the node, else from the connection, else none - `inst-4`
   4. [x] - `p1` - Name it by the last segment of its path; keep the path and the clone URL, and the config's `branch` when it has one - `inst-5`
   5. [x] - `p1` - **IF** the specs could not be read, the documents gear does not know the files (`files_known` false), or the source has no node, its specs are missing; **ELSE** they are the count listed for its node, 0 when the node is not listed - `inst-6`
   6. [x] - `p1` - **IF** the activity could not be read or the source has no node, its pull requests and commits are missing; **ELSE** they are its node's, none on every day of the window when the node is not listed - `inst-7`
   7. [x] - `p1` - Take its last sync: Not connected **IF** the connections were read and its connection is not among them; **ELSE** unavailable **IF** its provider cannot sync (`cpt-studiofrontend-dod-project-artifacts-syncable-providers`); **ELSE** the node's `synced_at` **IF** it has one; **ELSE** Not synced - `inst-8`
   8. [x] - `p1` - Take the sync this tab follows, from the import's line of the same path: in flight **IF** it is queued or running, with whether a cancel is pending and whether it can be cancelled; stopped **IF** it failed, was cancelled or was lost, with its reason and whether its run can be retried; none otherwise - `inst-9`
2. [x] - `p1` - **RETURN** the rows, and after them the Uploaded files row **IF** the project's own Studio documents were read and there is one: their number as its specs, the newest `created_at` as its last sync - `inst-10`

### Count the Sources footer

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-sources-footer`

**Input**: every row, before the search, the Uploaded files row included; the project's own Studio documents, read or not

**Output**: three counts, each a number or missing

**Steps**:
1. [x] - `p1` - Sources: the number of rows - `inst-1`
2. [x] - `p1` - Specs from sources: the sum of the rows' specs that are not missing; missing **IF** the specs could not be read or `files_known` is false - `inst-2`
3. [x] - `p1` - The Uploaded files row's documents are among them: the specs are missing **IF** the Studio documents could not be read - `inst-3`
4. [x] - `p1` - Open pull requests: the sum of the rows' open pull requests that are not missing; missing **IF** the activity could not be read - `inst-4`
5. [x] - `p1` - **RETURN** the three counts - `inst-5`

### Say what a row's menu offers

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-sources-row-menu`

**Input**: a source's row, and whether the organization's connections were read

**Output**: the menu's items in order, each with what it does, or disabled with the reason

**Steps**:
1. [x] - `p1` - Take the sync item - `inst-1`
   1. [x] - `p1` - **IF** the sync is in flight: Cancel sync; disabled with "Cancelling…" while a cancel is pending, and with "The sync is being requested" while the gear has not given it a run - `inst-2`
   2. [x] - `p1` - **ELSE IF** the row reads Not connected: Sync now, disabled with "Its connection is gone" - `inst-3`
   3. [x] - `p1` - **ELSE IF** its provider cannot sync: Sync now, disabled with `Sync isn't available for {provider} yet` - `inst-4`
   4. [x] - `p1` - **ELSE IF** the sync stopped and its run can be retried: Sync now, retrying that run - `inst-5`
   5. [x] - `p1` - **ELSE IF** the connections could not be read: Sync now, disabled with "The connections could not be read" - `inst-6`
   6. [x] - `p1` - **ELSE**: Sync now, requesting a new sync - `inst-7`
2. [x] - `p1` - Take Open specs from this source, on every source's row - `inst-8`
3. [x] - `p1` - **IF** the row's provider is known and its clone URL is an `http` or `https` address, take `Open in {provider}`, at that address without its user, its password and a trailing `.git` - `inst-9`
4. [x] - `p1` - Take Disconnect, after a separator, disabled with "Disconnect unavailable" - `inst-10`
5. [x] - `p1` - **RETURN** the items - `inst-11`

The order is the design's. A cancel needs no connection, so an in-flight sync
can be cancelled whatever the row reads. Not connected comes before a retry: the
run would pull through a connection the organization no longer has. The
connections matter only to a new sync, which sends the connection's provider,
base URL and credential reference
(`cpt-studiofrontend-algo-project-artifacts-sync-request`); a retry names only
the run. A lost sync and a refused request have no run to retry, and get a new
sync.

## 4. States (CDSL)

### Connect Source Dialog State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-project-sources-connect`

**States**: Choosing, Picking, Writing

**Initial State**: Choosing

**Transitions**:
1. [ ] - `p1` - **FROM** Choosing **TO** Picking **WHEN** a provider is chosen - `inst-1`
2. [ ] - `p1` - **FROM** Picking **TO** Writing **WHEN** Connect source is activated with at least one repository picked - `inst-2`
3. [ ] - `p1` - **FROM** Writing **TO** Picking **WHEN** the write is refused; the reason is shown and the picks are kept - `inst-3`
4. [ ] - `p1` - **FROM** Picking **TO** Choosing **WHEN** Back is used; the picks are kept - `inst-4`

Choosing is the prototype's first step and the card is small: the chips and
the hint (or, with no source connection, the empty state and Add connection),
Back alone, no count and no Connect source. Picking and Writing keep one
height for every connection (a list, an empty state, an error), so the card does
not jump. It is the height the tallest empty state (connection tabs and Try
GitHub sample) needs whole: an empty state never scrolls, only a longer list does. The
viewport less 4rem caps it.

The dialog leaves every state by being unmounted: after a write, on Back from
Choosing, on Escape or on the scrim. Nothing is written once it is gone. Back
from Picking returns to Choosing and keeps the picks; the prototype closes the
dialog there.

### Source Row Sync State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-project-sources-row-sync`

**States**: None, In flight, Cancelling, Stopped

**Initial State**: None

**Transitions**:
1. [ ] - `p1` - **FROM** None **TO** In flight **WHEN** a sync of the source is requested, or is found queued or running when the project opens (`cpt-studiofrontend-algo-project-artifacts-sync-resume`) - `inst-1`
2. [ ] - `p1` - **FROM** In flight **TO** Cancelling **WHEN** Cancel sync is used - `inst-2`
3. [ ] - `p1` - **FROM** Cancelling **TO** In flight **WHEN** the gear refuses the cancel - `inst-3`
4. [ ] - `p1` - **FROM** In flight **TO** None **WHEN** the sync succeeds, or **FROM** Cancelling **TO** None **WHEN** it succeeds before the cancel lands - `inst-4`
5. [ ] - `p1` - **FROM** In flight **TO** Stopped **WHEN** the sync fails, is cancelled or is lost, or **FROM** Cancelling **TO** Stopped **WHEN** the cancel lands - `inst-5`
6. [ ] - `p1` - **FROM** Stopped **TO** In flight **WHEN** Sync now is used: the run is retried when it can be, and a new sync is requested when not - `inst-6`
7. [ ] - `p1` - **FROM** In flight, Cancelling or Stopped **TO** None **WHEN** the project closes - `inst-7`

In flight covers queued and running alike, as the design's one word does. Only
the second line of Last sync follows this state; the first changes when a sync
succeeds and the repository nodes are read again.

A stopped sync is known only while the project stays open in the tab that
followed it. Closing the project ends its import's watch and forgets its lines
(`cpt-studiofrontend-state-project-artifacts-import`), and an opening finds only the
syncs still queued or running, so a reopened project, a reload or a new tab
shows the last successful sync alone.

## 5. Definitions of Done

### Connect source is an overlay extension, opened from the Sources header

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-connect-overlay`

The system **MUST** draw Connect source as an extension of the projects MFE in
the shell's overlay domain, with its own entry and lifecycle, and **MUST** open
it from a Connect source button in the Sources section's header.

The dialog reads the open project from the shell's selected-project property, so
the shell's overlay domain declares that property beside the organization and
the workspace. A domain that does not declare a property an entry requires
refuses the entry, and with it every extension of the MFE.

The header's actions belong to the section: the project screen draws the header
and asks the open section for its actions: Upload documents and Check in
Specs, Upload documents and Connect source in Sources, Upload documents in
Artifacts (#693). The header is the ui-kit page header, and the section's
actions go in its actions slot.

**Implements**:
- `cpt-studiofrontend-flow-project-sources-connect`

**Touches**:
- Entities: `mfe.json` (projects-mfe), `sourcesConnectLifecycle`, `sourcesConnectActions`, `ProjectScreen`, `SourcesActions`, `openOverlay` and `closeOverlay` (mfe-shared)
- Shell: the overlay domain's shared properties (`app/mfe/bootstrap.ts`), the overlay frame's height cap (`app/layout/OverlayDialog.tsx`)

### The dialog and the wizard share one repository picker

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-picker`

The system **MUST** draw the dialog's repositories with the New project wizard's
picker: a chip per source-code provider the organization has a connection to,
with nothing listed until one is chosen,
the chosen provider's connections under it (one named in a line, several as
tabs), the search, the table and its empty states. The picker **MUST NOT** hold state of its own. The picks, the search
and the chosen connection come in through its props, from the wizard's slice in
the wizard and from the dialog's slice in the dialog. The dialog's slice
**MUST** be reset when the dialog mounts.

Both slices **MUST** take the picker's navigation from one set of reducer
helpers: choosing a provider clears the connection and the search, choosing a
connection clears the search, and Back to the providers clears all three and
the error. The picks stay each slice's own, because the cap differs: the wizard
refuses the 101st pick itself, while the dialog has to count the project's
attached sources too, which only the dialog reads.

The wizard takes the picker with everything above, as `project-create.md`
describes: the provider chips first, Back to the providers, no Updated column,
and each pick written with `branch` and `share_mode`
(`cpt-studiofrontend-algo-project-create-repos`,
`cpt-studiofrontend-dod-project-create-many-sources`).

The dialog reuses the wizard's frame, small on its first step and one height after it, its
footer note and its strings, and adds its own: the title, Connect source,
Already attached, Add connection, the full project's footer and its errors. Its secondary button reads Back,
the wizard's string: from the repositories it returns to the providers, and
from the providers it closes the dialog.

**Implements**:
- `cpt-studiofrontend-flow-project-sources-connect`

**Touches**:
- Entities: `RepositoryPicker`, `SelectionNote`, `OverlayFrame.module.css`, `RepositoriesStep`, `RepositoriesFooterNote`, `sourcesConnectSlice`, `createSlice`, `pickerReducers`, `SourcesConnectDialog`

### A repository is attached once, and the project holds at most 100

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-attached`

The system **MUST** show a repository the project already has, through any
connection, as picked and inert, and **MUST NOT** let the attached and the
picked repositories exceed 100 together: at the ceiling the unpicked rows are
inert and the footer says so, also when the attached ones fill it alone.

A repository is the same when its clone URL gives the same key, the one the
config write compares by (`sameRepository`), so the dialog never offers a pick
the write would drop.

Both rest on the config the dialog has read. When that read fails, the dialog
**MUST** say so and offer no Connect source. The read may also be up to 30 s
old, so the write **MUST** check the ceiling again against the config it reads
fresh, and refuse rather than exceed it.

**Implements**:
- `cpt-studiofrontend-flow-project-sources-connect`

**Touches**:
- Entities: `RepositoryPicker`, `SourcesConnectDialog`, `model/projectSources`

### The picks are appended to the config, and only then does the dialog close

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-write`

The system **MUST** append the picks to the project's `sources[]`, reading the
config fresh and writing every other field back as it was, and **MUST** close
the dialog only once the write has succeeded. A refused write **MUST** leave the
dialog open with the reason and the picks.

Each new source carries `branch`, the repository's default branch when the
provider reports one, and `share_mode: branch`.

The write is last-write-wins (#709): AM's metadata carries no version to send
back.

**Implements**:
- `cpt-studiofrontend-algo-project-sources-attach`

**Touches**:
- API: `GET /cf/account-management/v1/tenants/{id}/metadata/{type}`, `PUT /cf/account-management/v1/tenants/{id}/metadata/{type}`
- Entities: `sourcesConnectEffects`, `projectSourcesEffects`, `model/projectSources`

### With no connection, the dialog leads to creating one

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-no-connection`

With no source connection in the organization, the system **MUST** say so in the
dialog and offer Add connection, which **MUST** unmount the dialog and mount the
connection form of connections-mfe in the overlay domain.

Creating a connection inside this dialog is out of scope. The connection form is
the Connections screen's own (`cpt-studiofrontend-dod-connection-create-overlay`);
once it has a connection, the member opens Connect source again. The form's
extension id moves to mfe-shared, as the workspace form's did when
organization-mfe began to open it.

**Implements**:
- `cpt-studiofrontend-flow-project-sources-connect`

**Touches**:
- Entities: `RepositoryPicker`, `SourcesConnectDialog`, `sourcesConnectActions`, `STUDIO_EXTENSION_CONNECTION_CREATE` (mfe-shared)

### The project screen syncs the sources the graph does not have

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-sync-missing`

The system **MUST** request, from the project screen, a sync for every GitHub
source of the open project that has no repository node of its path and
connection in the graph (`cpt-studiofrontend-dod-project-sources-rows`), no line in
the import, whatever that line's state, and for which no sync was requested in
this tab, even one that then failed. It **MUST** decide this from the data each
time it reads the project's sources or repository nodes, not from what changed
in the config, and **MUST NOT** decide before the gear has been asked for the
project's syncs in flight since the project opened
(`cpt-studiofrontend-dod-project-artifacts-sync-resume`), whether that answered
or failed. The syncs **MUST** join the project's import rather than restart it,
and the member **MUST** stay on the section they are on.

The dialog cannot ask for the sync itself: it is another extension, with its own
store and event bus, so whatever it starts the screen never sees. It writes the
config and drops the cached copy; the screen reads it again and finds sources
with no repository node. Deciding from the data is what makes the answer hold
after a reload, for a source attached in another tab and for one attached while
the project was closed: whoever opens the project next starts what is missing.

A request is remembered per repository in the tab's session storage, by every
path that makes one: the first import, Sync repositories and this rule. So a
repository whose sync fails before its node is written is asked for once per
tab, as the first import already is, and not again on every read.

The cost is accepted: such a repository is asked for again in every new tab, by
every member who opens the project, and each request is a run the gear tries up
to five times. In return a repository whose token or path is put right syncs
the next time anyone opens the project, without anyone asking. Leaving out the
repositories whose last run failed would need the failed runs, and the gear
lists only the tenant's newest page of them, so the guard would hold only for
recent failures.

The dialog records the project's attempt before it writes. Otherwise a project
with no artifacts would meet the first import's conditions the moment its new
sources arrive, and the screen would sync every source and move to Artifacts.

Waiting for the gear's syncs in flight is what keeps a second tab from asking
again: a tab that opens the project after another has asked finds that run,
queued or running, and gives it a line before this rule looks. Accepted rather
than prevented: two tabs, or two members, that both look before either has
asked can request the same repository. Each request carries its own
Idempotency-Key, so the gear queues the second behind the first on the same
partition. The cost is one repeated upsert.

**Implements**:
- `cpt-studiofrontend-algo-project-sources-sync-missing`

**Touches**:
- API: `GET /cf/studio-artifact-ingest/v1/nodes?scope={project}&type=repo`
- Entities: `ProjectScreen`, `useSourcesSync`, `importAttempts`, `artifactSyncSlice`, `model/syncRequest`

### Each source in the config is a row, joined to its repository node

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-rows`

The system **MUST** build one row per entry of the project config's `sources[]`,
in the config's order, and **MUST NOT** build one for a repository node the
config does not name. A row **MUST** find its repository node by its path,
ignoring case, and its connection: the node's `connector_id` is the `secret_ref`
its sync was sent, `studio-connection-<connection id>`, or empty for a
connection without a token, whose sync runs without credentials. A node of the
source's connection is taken first; a node without a `connector_id` is matched
by its path alone, and so is any node of the path when the source's connection
is not known, because the connections could not be read or it is gone. A node of
another connection is not matched. Two connections without a token both have an
empty `secret_ref`, so their nodes cannot be told apart.

A row carries what the table's cells need (#688): the provider, the name (the
last segment of the path), the path, the config's branch when it has one, the
specs, the pull requests open and merged with one count per day of the window,
oldest first, the commits, the last sync and the sync this tab follows. For its
menu (#686) it also carries the source's clone URL.

The sync of the missing sources compares by the same key
(`cpt-studiofrontend-algo-project-sources-sync-missing`), so a row that reads Not
synced is a source the screen syncs. Comparing by path alone, a repository
attached again through another connection would show the old connection's node
and never be synced.

**Implements**:
- `cpt-studiofrontend-algo-project-sources-rows`
- `cpt-studiofrontend-flow-project-sources-list`

**Touches**:
- API: `GET /cf/studio-artifact-ingest/v1/nodes?scope={project}&type=repo`, `GET /studio-connector/v1/connections?tenant={organization}`
- Entities: `model/sourceRows`, `model/syncRequest`

### Last sync is the last successful sync, and the sync this tab follows

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-last-sync`

The system **MUST** show a source's last sync in two lines. The first **MUST** be
one of: the time of the last successful sync (the repository node's
`synced_at`); Not synced, when there is no node or it has no `synced_at`; Not
connected, when the source's connection is gone from the organization;
`Sync isn't available for {provider} yet`, for a provider that cannot sync. It
**MUST NOT** change while a sync runs.

The second line **MUST** show the sync this tab follows: Syncing… while it is
queued or running, Cancelling… once a cancel is asked for and the gear has not
recorded it, and Last attempt failed or Last attempt cancelled, with the reason
as the line's title, once it stopped; nothing otherwise. A lost sync, one the
gear stopped answering for, reads Last attempt failed, as Artifacts shows it.

The phase, the counts and the gear's summary that the import's lines hold
(`cpt-studiofrontend-dod-project-artifacts-run-control`) are not shown in the
row, as in the design.

**Implements**:
- `cpt-studiofrontend-algo-project-sources-rows`
- `cpt-studiofrontend-state-project-sources-row-sync`

**Touches**:
- Entities: `model/sourceRows`, `useProjectImport`, `artifactSyncSlice`

### The row says what can be done with its sync

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-row-sync`

The system **MUST** give each row its sync's state and what can be done with it,
for the row menu's one sync item (#686): Cancel sync while the sync is in
flight, which can be sent once the sync has a run and no cancel is pending;
Sync now otherwise, which
retries the stopped run when it can be retried (`canRetry`) and requests a new
sync when not; and no sync for a provider that cannot sync, with the reason.

Retry and a new sync are one item because they do the same for the member, and
a retried run keeps its history. Cancel sync asks no confirmation: what the sync
stored stays, and Sync now starts it again. The item's label and its effects
are the menu's (#686); the row only says which applies.

**Implements**:
- `cpt-studiofrontend-algo-project-sources-rows`
- `cpt-studiofrontend-state-project-sources-row-sync`

**Touches**:
- Entities: `model/sourceRows`, `model/repoImport` (`canCancel`, `canRetry`)

### A missing number is shown as missing, never as zero

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-gaps`

The system **MUST** fail the section only when the project's config or its
repository nodes cannot be read, and **MUST** show the rows when another read
fails, with what that read gives missing:

- the specs per repository cannot be read, or `files_known` is false: every
  source's specs and the footer's specs from sources;
- the activity cannot be read: every source's pull requests and commits, and the
  footer's open pull requests;
- the Studio documents cannot be read: the footer's specs from sources, and
  there is no Uploaded files row;
- the connections cannot be read: no row reads Not connected, and the rows take
  their provider from their node.

A source with no repository node has its specs, pull requests and commits
missing whatever the reads answered. A node the activity does not list had no
pull requests and no commits in the window, and one the specs per repository
does not list has no specs: those are zero.

The table shows missing pull requests as "Pull request activity unavailable", in
the row and in the footer, as the design does, and every other missing number
as `—` (#688).

**Implements**:
- `cpt-studiofrontend-algo-project-sources-rows`
- `cpt-studiofrontend-algo-project-sources-footer`
- `cpt-studiofrontend-flow-project-sources-list`

**Touches**:
- API: `GET /cf/studio-artifact-ingest/v1/source-activity?scope={project}`, `GET /cf/studio-documents/v1/specs-per-source?scope={project}`, `GET /cf/studio-documents/v1/workspaces/{workspace}/projects/{project}/documents`
- Entities: `model/sourceRows`, `shared/useSourcesLoad`, `shared/useProjectDocuments`

### The rows are searched by name and path, in the config's order

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-search`

The system **MUST** keep the rows whose name or path contains the search text,
ignoring case, and **MUST** keep them in the config's order: no column sorts the
table, as in the design. The Uploaded files row is kept by its name, in the
language shown, and stays last. The table pages the rows it keeps (#688).

**Implements**:
- `cpt-studiofrontend-flow-project-sources-list`

**Touches**:
- Entities: `model/sourceRows`, `shared/useSourcesLoad`

### The footer counts the whole project

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-footer`

The system **MUST** count the footer over every row of the project, whatever
the search keeps: the sources; the specs from sources, the sum of the rows'
specs; and the open pull requests, the sum of the rows' open pull requests. The
Uploaded files row is one of the sources and its documents are among the specs,
so the footer no longer says how many were created in Studio (#693). Only the
project's own documents count: the workspace's, which the project also lists,
are not uploaded to it.

**Implements**:
- `cpt-studiofrontend-algo-project-sources-footer`

**Touches**:
- API: `GET /cf/studio-documents/v1/workspaces/{workspace}/projects/{project}/documents`
- Entities: `model/sourceRows`

### The section reads through the shared cache, and the table shows the rows it builds

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-reads`

The system **MUST** read the project's sources, its repository nodes, the
organization's connections, the activity, the specs per repository and the
Studio documents through the shared query cache, build the rows and the footer
from those answers and the import's state, and give the table a load that only
searches and pages the rows built. The table **MUST** load again whenever the
rows change, which a sync's progress does without any read, and **MUST** show
once every read has answered or failed, with the section's loading state until
then.

The system **MUST** read the repository nodes, the activity and the specs per
repository again when a sync of one of the project's sources settles, as
Artifacts does (`cpt-studiofrontend-algo-project-artifacts-sync`). The config is
read again when Connect source drops the cached copy
(`cpt-studiofrontend-algo-project-sources-attach`), and so will it be after
Disconnect. A place that changes another answer drops that query in the
shared cache: a type decided in Specs the specs per repository (#690), an upload
the Studio documents (#693).

The Specs list reads inside its table's load and keeps its own cache (#711). For
Sources that would leave every place above reaching into this section to reload
it. The event stream carries a sync's run, not its repository or its project,
so nothing pushes a repository's new numbers; they are read when the run
settles. A sync started outside this tab is not followed while the project is
open; the next opening finds it if it is still queued or running
(`cpt-studiofrontend-algo-project-artifacts-sync-resume`).

**Implements**:
- `cpt-studiofrontend-flow-project-sources-list`
- `cpt-studiofrontend-algo-project-sources-rows`
- `cpt-studiofrontend-algo-project-sources-footer`

**Touches**:
- API: every read of `cpt-studiofrontend-flow-project-sources-list`
- Entities: `shared/useSourcesLoad`, `model/sourceRows`, `useProjectConfig`, `ConnectorsApiService`, `useProjectImport`

### The row's menu is a component of its own, which the table places

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-menu`

The system **MUST** draw a source's actions as a menu component that takes the
source's row: a ghost icon button named `Actions for {name}`, opening a menu
aligned to its end, with the items of
`cpt-studiofrontend-algo-project-sources-row-menu` in their order. A disabled
item **MUST** say why in its title. The menu's strings **MUST** come from the
Sources section's namespace, `screen.projects.sources`, in English and in
Russian.

The menu is the Artifacts row menu's kind: the kit's dropdown menu, drawn inside
the MFE's themed root. The kit takes the pointer off a disabled item, which would
hide its title, so the menu gives it back; Base UI still does not activate the
item. Sync now carries the design's refresh icon and Open in its external-link
icon. The table (#688) puts the menu in its Actions column,
and the row's Specs number calls what Open specs calls. The Uploaded files row's
menu holds Open uploaded documents, which moves to Artifacts, where they come
first, and Disconnect, disabled; its Specs number does what Open uploaded
documents does (#693).

**Implements**:
- `cpt-studiofrontend-flow-project-sources-row-menu`
- `cpt-studiofrontend-algo-project-sources-row-menu`

**Touches**:
- Entities: `SourceRowMenu`, `model/sourceRowMenu`, `useSourceRowActions`

### Sync now joins the import, and Cancel sync stops the run

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-menu-sync`

The system **MUST** request a new sync of one source by adding it to the
project's import (`cpt-studiofrontend-algo-project-artifacts-sync-add`), **MUST**
retry a stopped run that can be retried instead of requesting another, and
**MUST** cancel a sync in flight without asking first
(`cpt-studiofrontend-algo-project-artifacts-run-control`). Each **MUST** keep the
member on Sources.

Adding rather than asking to sync the project's sources: that replaces the
import's lines and ends the watch of the runs it follows, which is what Sync
repositories in Artifacts is for. The import leaves out a repository already
queued or running, so a second request asks for nothing; the item reads Cancel
sync by then anyway. The request is recorded for the repository in the tab, as
every other request is (`cpt-studiofrontend-dod-project-sources-sync-missing`).

Cancel sync asks no confirmation: what the sync stored stays, and Sync now
starts it again. The gear finishes the work it started before it records the
cancel, so the row reads Cancelling… until the run's terminal event.

**Implements**:
- `cpt-studiofrontend-flow-project-sources-row-menu`

**Touches**:
- Event: `mfe/artifacts/repos-added`, `mfe/artifacts/cancel-requested`, `mfe/artifacts/retry-requested`
- Entities: `useSourceRowActions`, `cancelRepoSync`, `retryRepoSync`, `model/syncRequest`

### A refused cancel or retry is a notification

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-menu-refusals`

The system **MUST** show the shell's notification when the gear refuses to
cancel or to retry a source's sync. It names the repository by its path and
gives the gear's reason when there is one:
`Couldn't cancel the sync of {path}: {reason}`, or
`Couldn't retry the sync of {path}` without one. The system **MUST NOT** show
one for a sync request the gear refuses or a sync that fails: the row's second
line says those (`cpt-studiofrontend-dod-project-sources-last-sync`).

A refused cancel turns Cancelling… back into Syncing…, and a refused retry
leaves Last attempt failed as it was: nothing else tells the member that what
they asked for did not happen. A cancel the gear refuses because the run has
already ended is not a refusal; the run's terminal event says how it ended.

The import's effect hears the refusal, and it has neither the bridge nor the
section's strings. So it emits an event, and the Sources section shows the
notification, as Specs does for a refused type decision. The section listens
once, not each row, so a refusal gives one notification whichever rows the
table shows. The refusal is the answer to the member's click, so it comes back
while they are still on Sources; one that comes after they have left is not
shown.

**Implements**:
- `cpt-studiofrontend-flow-project-sources-row-menu`

**Touches**:
- Event: `mfe/artifacts/cancel-refused`, `mfe/artifacts/retry-refused`
- Entities: `artifactEffects`, `useSyncRefusals`, `SourcesSection`, `notify` (mfe-shared)

### Open specs shows Specs searched by the source's path

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-menu-specs`

The system **MUST** offer Open specs from this source on every source's row, and on it
**MUST** set the Specs list's filter for the source's `full_path`
(`cpt-studiofrontend-dod-project-specs-filter-state`) and ask the shell for the
Specs section.

By the path, not the name, as `project-specs.md` decides. It is on every row, a
source with no specs included: the list then shows there are none. The shell
writes the section into the address without a history entry, and the MFE takes it from
there, as with the first import's move to Artifacts
(`cpt-studiofrontend-flow-shell-levels-section`), so Back does not return to
Sources. Accepted: the shell gives the MFE no other way to change the section.
Nothing shows the filter until the Specs list does (#692).

**Implements**:
- `cpt-studiofrontend-flow-project-sources-row-menu`
- `cpt-studiofrontend-flow-project-specs-from-source`

**Touches**:
- Entities: `useSourceRowActions`, `specsFilterSlice` (`showSourceSpecs`), `announceSection`

### The repository's page opens from its clone URL

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-menu-open-in`

The system **MUST** open the repository's page at its provider in a new tab,
without the opener, at the address the source's clone URL gives: an `http` or
`https` clone URL without its user, its password and a trailing `.git`. It
**MUST** name the item after the provider, as the connector's catalogue names
it, and **MUST** leave the item out for a source whose clone URL is not `http`
or `https`, or whose provider is not known.

Not the connection's `base_url` with the path: for GitHub and Bitbucket that is
the API root, `https://api.github.com` and `https://api.bitbucket.org/2.0`, not
the site. The user comes off because Bitbucket's clone URL carries the user
name of the account the connection signs in with. An SSH clone URL names the
host in another form, and no address is guessed from it. The prototype's
`repoUrl` takes the same address but keeps the user and the password.

**Implements**:
- `cpt-studiofrontend-algo-project-sources-row-menu`

**Touches**:
- Entities: `model/sourceRows` (the clone URL), `model/projectSources` (`repositoryWebUrl`, beside `repositoryKey`), `model/sourceRowMenu`, `SourceRowMenu`

### Disconnect is shown, disabled, until the backend can take a source out

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-sources-menu-disconnect`

The system **MUST** show Disconnect last, after a separator, disabled, with the
title "Disconnect unavailable", and **MUST NOT** take a source out of the config
or call `POST /studio-artifact-ingest/v1/reconcile` from the menu.

Taking a source out removes everything synced from the repository: files, pull
requests, type decisions, findings. From the browser it is two calls, and a
reconcile that fails, or a tab closed between them, leaves those in a project
that no longer names the repository, where no row offers to try again. It
belongs to the backend, as one operation: the config written and the prune
queued durably. The item keeps its place meanwhile, and is not drawn as
destructive, as in the design. Disconnect follows in #852.

**Implements**:
- `cpt-studiofrontend-algo-project-sources-row-menu`

**Touches**:
- Entities: `model/sourceRowMenu`, `SourceRowMenu`

## 6. Acceptance Criteria

- [ ] The Sources section's header shows Connect source, with a plug icon as in the prototype; no other section's header shows it.
- [ ] Activating it opens the dialog over the project; Escape, the scrim and Back on the providers close it and write nothing; Back on the repositories returns to the providers and keeps the picks.
- [ ] Before a provider is chosen the dialog is compact: the chips and the hint, and Back alone, with no count and no Connect source; choosing one grows it to the repositories, the count of the picks and Connect source, at one height for every connection: an empty state shows whole without a scroll, and only a longer list scrolls.
- [ ] The dialog opens on a chip per source-code provider the organization has a connection to, with nothing listed; choosing one shows its connections, its search and its table, the same as the New project wizard.
- [ ] Picking two repositories from two connections and activating Connect source closes the dialog, and the project's config lists both after its earlier sources, each with `branch` and `share_mode: branch`, and every other field unchanged.
- [ ] Their syncs start, and Artifacts shows them beside the project's earlier repositories, whose syncs are not restarted.
- [ ] A repository the project already has, through any connection, shows checked and cannot be unchecked or picked again.
- [ ] With 99 repositories attached, one more can be picked; then the unpicked rows are inert and the footer states the maximum.
- [ ] With 100 repositories attached, every row is inert and the footer says the project holds the maximum.
- [ ] When the project's config cannot be read, the dialog says so and offers no Connect source.
- [ ] A write that would take the project past 100, because its config grew after the dialog read it, is refused with the reason, and the picks are kept.
- [ ] A GitLab or Bitbucket repository is attached, no sync is requested for it, and its line says why.
- [ ] With no source connection, the dialog says so and offers Add connection, which closes it and opens the connection form.
- [ ] A refused config write leaves the dialog open with the reason and the picks.
- [ ] Connecting repositories to a project with no artifacts keeps the member on Sources and syncs only the new repositories.
- [ ] A repository attached in another tab, or just before a reload, is synced the next time the project screen reads the project.
- [ ] A repository whose sync is queued or running is not requested again.
- [ ] A repository whose sync another tab asked for and is still queued is not requested again when the project opens in a new tab, even when the project's other reads answer before the gear's runs.
- [ ] A repository whose sync failed before the graph had its node is not requested again in the same tab; a new tab asks for it once.
- [ ] Reopening a project syncs its GitHub sources that have no repository node of their path and connection and have not been requested in this tab, and no others.
- [ ] The New project wizard's repositories step works as `project-create.md` describes, on the same picker; in both, Back to the providers clears the connection, the search and any error, and keeps the picks.

The rows (#685):

- [ ] A synced GitHub source's row has its node's last sync time on the first line, its specs, its open and merged pull requests with one count per day of the last 7, and its commits.
- [ ] A source with no repository node reads Not synced, with its specs, pull requests and commits missing.
- [ ] A GitLab or Bitbucket source reads "Sync isn't available for GitLab yet" (or Bitbucket), and offers no sync.
- [ ] A source whose connection is gone from the organization reads Not connected, and shows what its node holds.
- [ ] A repository attached again through another connection does not show the old connection's node: it reads Not synced, and the screen requests its sync.
- [ ] A row's name is the last segment of its path, and the path is followed by the config's branch only when the config has one.
- [ ] While a source's sync is queued or running, its first line stays as it was and the second reads Syncing…; after Cancel sync, Cancelling…; once the sync fails or is lost, Last attempt failed, and once it is cancelled, Last attempt cancelled, with the reason as the title.
- [ ] A row whose sync is in flight offers Cancel sync; a row whose last attempt failed offers Sync now, which retries that run.
- [ ] When a source's sync settles, its row's last sync, pull requests, commits and specs are read again, without leaving the section.
- [ ] After a reload, a source whose last attempt failed shows its last successful sync alone.
- [ ] With `files_known` false, every source's specs and the footer's specs are missing; a repository node that specs per repository does not list has 0.
- [ ] When the activity cannot be read, every source's pull requests and commits and the footer's open pull requests are missing, and the rows still show.
- [ ] When the config or the repository nodes cannot be read, the section says so.
- [ ] Searching keeps the rows whose name or path holds the text, ignoring case, in the config's order, and leaves the footer as it was.
- [ ] The footer gives the number of sources and the specs from sources, the Uploaded files row included, and the open pull requests of the whole project.

The row menu (#686):

- [ ] A synced GitHub source's menu, named `Actions for {name}`, lists Sync now, Open specs from this source, Open in GitHub and, after a separator, Disconnect, disabled with the title "Disconnect unavailable".
- [ ] Sync now requests that source's sync and no other: its row's second line reads Syncing…, and the lines of the import's other repositories stay as they were.
- [ ] While the sync is in flight the item reads Cancel sync; using it asks nothing, and the row reads Cancelling…, with Cancel sync disabled, until the cancel lands.
- [ ] After a failed or cancelled sync, Sync now retries the same run; after a lost one, or a request the gear refused, it requests a new sync.
- [ ] A GitLab or Bitbucket source's Sync now is disabled, with "Sync isn't available for GitLab yet" (or Bitbucket); a source whose connection is gone has it disabled, with "Its connection is gone", and an in-flight sync of it can still be cancelled.
- [ ] When the connections could not be read, Sync now is disabled on a source with nothing to retry, with the reason.
- [ ] When the gear refuses a cancel or a retry, a notification names the source and gives the gear's reason, and the row's sync stays as it was; a refused sync request or a failed sync gives no notification.
- [ ] Open specs from this source, on any row, moves to Specs, with the Specs filter set to the source's path, Type confirmed and no document type.
- [ ] Open in opens the repository's page in a new tab: `https://bitbucket.org/<workspace>/<repo>` for the clone URL `https://<user>@bitbucket.org/<workspace>/<repo>.git`; a source with an SSH clone URL offers no Open in.
- [ ] The menu's labels, titles and notifications are in English and in Russian.

The table (#688):

- [ ] The section shows the sources in a table with the columns Source, Role, Specs, Pull requests · 7 days, Commits · 7 days, Last sync and the row menu, in the config's order; no column sorts.
- [ ] A source's Role is its provider.
- [ ] A source's Specs number opens Specs filtered to the source, as Open specs from this source does.
- [ ] Pull requests · 7 days gives the open and merged counts and a bar per day, on one scale for every row; a day with none is a grey tick, and a bar's tooltip names its day.
- [ ] Last sync reads "3 Sept, 16:06", with the year only for another year, and its title gives the relative time.
- [ ] With 25 sources there is no pager; with 26, the table shows 25 and offers 25, 50 or 100 a page.
- [ ] A search that matches nothing says so and offers Clear search, which brings the rows back.
- [ ] With no sources, the section shows an empty state with Upload documents and Connect source, and no column headers.
- [ ] While the organization loads, or the open organization's workspace, the section shows a skeleton; with no organization open it says so.
- [ ] With no workspace open the rows show, with no Uploaded files row, and the footer's specs from sources are missing.
- [ ] When the config or the repository nodes cannot be read, Try again reads both again.
- [ ] The table's labels are in English and in Russian.

Uploaded files (#693):

- [ ] Once the project has a Studio document of its own, the table ends with an Uploaded files row: an upload tile, "Files added to this project", Role `—`, the number of documents as its Specs, Pull requests "Not applicable", Commits `—`, and the newest document's creation as its Last sync.
- [ ] Its Specs number, and Open uploaded documents in its menu, move to Artifacts, where the uploaded documents are on the first page; its Disconnect is disabled.
- [ ] Searching "upload" keeps the row; a search for a repository's path leaves it out.
- [ ] A document of the workspace, which the project also lists, is not counted in the row.
