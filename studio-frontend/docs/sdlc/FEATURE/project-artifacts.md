# Feature: Project artifacts

<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [Browse a project's artifacts](#browse-a-projects-artifacts)
  - [Create a project from repositories and land on its artifacts](#create-a-project-from-repositories-and-land-on-its-artifacts)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
  - [Build the artifact rows](#build-the-artifact-rows)
  - [Decide whether this is a first import](#decide-whether-this-is-a-first-import)
  - [Sync the project's repositories](#sync-the-projects-repositories)
- [4. States (CDSL)](#4-states-cdsl)
  - [Import State Machine](#import-state-machine)
- [5. Definitions of Done](#5-definitions-of-done)
  - [The project's rail lives inside the project frame](#the-projects-rail-lives-inside-the-project-frame)
  - [The table is the prototype's five columns](#the-table-is-the-prototypes-five-columns)
  - [Filtering, ordering and paging belong to the gear](#filtering-ordering-and-paging-belong-to-the-gear)
  - [The header counts the project, not the filter](#the-header-counts-the-project-not-the-filter)
  - [Updated shows a time or says where the row came from](#updated-shows-a-time-or-says-where-the-row-came-from)
  - [Reads are scoped to the project](#reads-are-scoped-to-the-project)
  - [A repository is the unit of sync and of retry](#a-repository-is-the-unit-of-sync-and-of-retry)
  - [A first import is recognised from data](#a-first-import-is-recognised-from-data)
  - [A created project opens](#a-created-project-opens)
  - [Nothing is invented where the gear is silent](#nothing-is-invented-where-the-gear-is-silent)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-project-artifacts`

## 1. Feature Context

### 1.1 Overview

What a project works on, as one table: the repositories attached to it and the
issues, pull requests and files pulled out of them by the artifact-ingest gear.
The table is the project's second section, reached from the project's own
navigation rail — a 48px icon rail inside the project frame that widens into a
labelled flyout on hover or keyboard focus. A project created from existing
repositories lands here directly, and the table fills while the import runs.

### 1.2 Purpose

`project-create.md` ends at a created tenant with its repositories written into
`cf.studio.project.config.v1~`. Nothing then reads them: the project screen has
one working section (Settings) and six placeholders, and the portal has never
called the artifact gear at all. This feature is the first of those six, and the
first frontend caller of `studio-artifact-ingest`.

It also closes the create flow. Today the wizard writes the project, refreshes
the list and closes; the member is returned to the list they started from, with
no indication that anything is being fetched — because nothing is: no sync is
ever requested. Here the created project opens, lands on this section, and the
sync of its repositories starts.

**Assumptions fixed here**, because the mockups promise data the gear does not
have and the choice changes the code:

- **The unit of sync is a repository.** `POST /sync` takes one
  `repo_full_path`, and nothing anywhere records which individual files failed:
  a failed file phase is a warning plus an empty list and a *successful* task,
  both truncations of a large repository — the gear's own ten-thousand-file
  ceiling and the provider's truncation of the tree it answers with — leave no
  trace, and a missing file is simply a node that does not exist. Re-syncing a
  repository is therefore the only recovery the system can express, and it is
  cheap — a file node's identity is `uuid5(connector, repo, "file", path)`, so a
  repeat upserts.
- **The files come from the connector's tree API.** `POST /sync` chooses its
  file source in three steps: the IDE's shared checkout when it is told where to
  look, then its own shallow clone when a volume is configured for one, then the
  provider's tree API. This feature does not tell it where to look, so the third
  is what runs — and it is the only one of the three that is reachable today
  anyway: the first needs a directory name that a project's stored sources do
  not have (they are `connection_id`, `full_path`, `clone_url`, and nothing in
  this portal yet opens an IDE session that would establish the convention), and
  the second is off unless a work directory is configured, which no deployment
  here configures. Two consequences are accepted rather than worked around.
  Files arrive as metadata — path, size, sha — with no text and no commit, so
  nothing in this table quotes a file's contents; and the file phase costs two
  provider calls per repository rather than one per file, which is why it is not
  what the concurrency bound below is protecting.
- **The table's columns are the prototype's, not the mockup's.** Name,
  repository, path, sync, updated. The mockup's `KIND` column — Architecture,
  Specification, Service, Release, Test run, Review — has no source: the gear
  stores eight node types (`repo`, `file`, `issue`, `pull_request`, `user`,
  `comment`, `commit`, `spec_finding`) and nothing that classifies a document.
  Type survives as the row's leading icon, where being approximate costs
  nothing.
- **Which node types are rows is the gear's to decide, not the client's to
  enumerate.** Four of the eight belong in this table — `repo`, `file`,
  `issue`, `pull_request`. The other four are not artifacts a member browses: a
  `user` is an author, a `spec_finding` is a judgement *about* an artifact, and
  `comment` and `commit` are pulled and stored on every sync with nothing to
  gate them, in numbers that dwarf the rows they attach to. But naming that set
  on the wire would make it the client's list to keep correct, and a ninth node
  type would then land in a row with no name and no path on the day the gear
  adds it. So the listing asks for no type at all: `GET /nodes` answers with the
  kinds it holds for browsing, narrowed before it pages, which is the only place
  a narrowing and a `total` can agree. `type` survives on one call only — the
  repository lookup below, which asks a different question ("which repositories
  does this project have"), not a filter over the table.
- **The page comes from the gear, and so does everything a page depends on.**
  `GET /nodes` takes `offset`, `limit`, `repo`, `q` and `sort`, and answers with
  `total` beside the page. That closes the earlier arrangement, where the table
  paged what it held: the client never saw past the gear's default first fifty
  nodes, which left rows unnamed once their repository node fell off the end and
  made a project look half-synced. A page of an unordered set is not a page and
  a filter over one page is not a filter, so ordering and filtering moved with
  it rather than after it. What stays on the client is where the member is —
  which page, which repository, what they typed.
- **The header counts the project, the table counts the filter.** They are
  allowed to disagree while a filter is on; the search field next to them is the
  explanation.
- **A first import is recognised from data, not from a flag.** The screen does
  not need to be told that a project was just created; it asks whether the
  project has sources and no artifacts yet. One thing is remembered outside the
  data: which projects this tab has already asked a sync for, in the tab's
  session storage. The store forgets on reload, the gear's tasks do not, and
  nothing lets the screen list them — so without it a reload before the first
  object lands would enqueue every repository a second time.
- **The import runs in an effect, and it talks to the gear.** Effects in this
  MFE otherwise carry no HTTP; reads go through `useApiQuery` and writes through
  `useApiMutation`. An import is the exception because it outlives the component
  that asked for it: the member may leave the section or the project while the
  tasks run, and a mutation hook would be unmounted with them.
- **The rows algorithm stays unchecked.** Its findings step has no source yet,
  so the algorithm is not marked implemented and carries no code markers; the
  rest of it is what `buildArtifactRows` does.
- **No progress stepper.** The gear reports phases and a `stored` count, so a
  five-stage stepper is buildable for four of its five stages — but the row
  count in the header climbs from the same data, and one moving number is enough
  for the first cut.

### 1.3 Actors

Named, not identified — a FEATURE may only define `algo`, `dod`, `featstatus`,
`flow` and `state` ids. See the same note in `project-create.md`.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** | A signed-in member with the project in scope. Browses the artifacts, filters them, and re-runs a sync. |
| **Artifact gear** | `studio-artifact-ingest`. Pulls repositories into the graph as typed GTS nodes and reports the progress of each pull. |

### 1.4 References

- **ADR**: [ADR-0008 — simplified navigation shell](../../../../docs/adr/0008-simplified-navigation-shell.md) — the project's rail lives inside the project frame, not in the shell
- **ADR**: [ADR-0010 — a project is an AM tenant](../../../../docs/adr/0010-projects-are-am-tenants.md) — what `scope` addresses
- **Feature**: [Create a project](project-create.md) — writes the sources this feature syncs
- **Feature**: [Workspaces in scope](workspace-scope.md) — the parent tenant tagged onto every synced node
- **Feature**: [Connect a source host](connection-create.md) — holds the `secret_ref` a sync needs
- **Dependencies**: `studio-artifact-ingest` (`/cf/studio-artifact-ingest/v1`), account-management (`/cf/account-management/v1`), studio-connector (`/cf/studio-connector/v1`)
- **Prerequisite**: `@gears-frontx/ui-kit` at `0.4.0-alpha.1` or later, for `DataTable` and `Sidebar`

## 2. Actor Flows (CDSL)

Unchecked on purpose, for the reason stated in `project-create.md`: a checked
flow obliges every instruction to carry a code marker, and these span the
wizard, the shell's context channel and the project frame. Their evidence is the
acceptance criteria in section 6; the implementation claims they rest on are the
Definitions of Done, which are traced.

**Use case**: see what a project works on.

### Browse a project's artifacts

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-artifacts-browse`

**Actor**: Member

**Success Scenarios**:
- The artifacts of the open project are listed, with their repository, path and sync state, newest first.

**Error Scenarios**:
- The gear is unreachable or refuses; the section says so and offers a retry, and the rail keeps working.
- The project has sources but nothing ingested and no import running; the section says the sources have not been synced and offers to sync them.
- The project has no sources at all; the section says so and does not offer a sync.

**Steps**:
1. [ ] - `p1` - Member opens a project and hovers or focuses the navigation rail - `inst-1`
2. [ ] - `p1` - The rail widens to its labelled width without displacing the content behind it - `inst-2`
3. [ ] - `p1` - Member activates Artifacts - `inst-3`
4. [ ] - `p1` - Run `cpt-studiofrontend-algo-project-artifacts-rows` for the project in scope - `inst-4`
5. [ ] - `p1` - **IF** the read fails - `inst-5`
   1. [ ] - `p1` - **RETURN** the section reports the failure and offers a retry - `inst-6`
6. [ ] - `p1` - **IF** there are no artifacts - `inst-7`
   1. [ ] - `p1` - **RETURN** the section distinguishes "no sources", "sources not synced" and "import running" - `inst-8`
7. [ ] - `p1` - Show the project's totals in the header and the rows in the table - `inst-9`
8. [ ] - `p1` - Member narrows the rows by repository or by text, or asks for another page - `inst-10`
9. [ ] - `p1` - **RETURN** the gear answers with that page of the narrowed set, and a narrowing starts again from the first page - `inst-11`

### Create a project from repositories and land on its artifacts

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-artifacts-import`

**Actor**: Member

**Success Scenarios**:
- The created project is open on its Artifacts section, and rows appear as the repositories are pulled in.

**Error Scenarios**:
- The project is created but never opens; it is in the list and opening it by hand reaches the same state, because the state is derived from data rather than from the creation.
- A repository's sync fails; its rows are absent and the failure is reported against it, while the other repositories finish.
- Every repository's sync fails; the section reports it and offers a sync, and does not retry on its own.

**Steps**:
1. [ ] - `p1` - Member picks repositories in the wizard and confirms - `inst-1`
2. [ ] - `p1` - Run the write in `project-create.md` - `inst-2`
3. [ ] - `p1` - Announce the created project to the shell as opened, then unmount the wizard - `inst-3`
4. [ ] - `p1` - The shell publishes the project as selected and the project frame opens it - `inst-4`
5. [ ] - `p1` - Run `cpt-studiofrontend-algo-project-artifacts-first-import` - `inst-5`
6. [ ] - `p1` - **IF** this is not a first import - `inst-6`
   1. [ ] - `p1` - **RETURN** the project opens on its first section and nothing is synced - `inst-7`
7. [ ] - `p1` - Select the Artifacts section - `inst-8`
8. [ ] - `p1` - Run `cpt-studiofrontend-algo-project-artifacts-sync` for the project's sources - `inst-9`
9. [ ] - `p1` - **RETURN** the table fills as nodes reach the graph, and stops changing when every task has settled - `inst-10`

## 3. Processes / Business Logic (CDSL)

### Build the artifact rows

- [ ] `p2` - **ID**: `cpt-studiofrontend-algo-project-artifacts-rows`

**Input**: the project tenant in scope, the chosen repository, the search text and the wanted page

**Output**: the rows of that page, the project's totals, or the reason the read failed

**Steps**:
1. [ ] - `p1` - `API: GET /cf/studio-artifact-ingest/v1/nodes?scope={project}&sort=updated&limit&offset(&repo&q)` for the wanted page - `inst-1`
2. [ ] - `p1` - **IF** the gear refuses or is unavailable - `inst-2`
   1. [ ] - `p1` - **RETURN** the refusal; no partial table is shown - `inst-3`
3. [ ] - `p1` - `API: GET /cf/studio-artifact-ingest/v1/nodes?scope={project}&type=repo` for the repositories in scope, so a row can name its repository and the filter can offer it - `inst-4`
4. [ ] - `p1` - Take the kinds the gear answered with as the rows; no type is asked for and none is dropped once the page is cut - `inst-5`
5. [ ] - `p1` - Index the findings by the node they are about, so a row knows how many are open - `inst-6`
6. [ ] - `p1` - For each artifact node, derive its name, repository, path, sync state, and either a timestamp or the label naming where the row came from - `inst-7`
7. [ ] - `p1` - Keep the order the gear answered in; it is global across pages and the client has no standing to re-sort it - `inst-8`
8. [ ] - `p1` - `API: GET /cf/studio-artifact-ingest/v1/nodes?scope={project}&limit=1` for the project's own total, which no filter may move - `inst-9`
9. [ ] - `p1` - **RETURN** the page's rows, the filtered total the paginator counts against, and the project's total - `inst-10`

### Decide whether this is a first import

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-artifacts-first-import`

**Input**: the project tenant in scope

**Output**: whether the project's sources have yet to be pulled in

**Steps**:
1. [x] - `p1` - Read the project's configured sources - `inst-1`
2. [x] - `p1` - **IF** there are none - `inst-2`
   1. [x] - `p1` - **RETURN** no; there is nothing to import - `inst-3`
3. [x] - `p1` - Read the project's artifacts, reusing the answer the section needs anyway - `inst-4`
4. [x] - `p1` - **IF** any artifact exists - `inst-5`
   1. [x] - `p1` - **RETURN** no; the sources have been pulled in at least once - `inst-6`
5. [x] - `p1` - **IF** a sync for this project has already been attempted in this tab, by the store or by its session storage - `inst-7`
   1. [x] - `p1` - **RETURN** no; an attempt that produced nothing is not repeated on its own - `inst-8`
6. [x] - `p1` - **RETURN** yes - `inst-9`

### Sync the project's repositories

- [x] `p2` - **ID**: `cpt-studiofrontend-algo-project-artifacts-sync`

**Input**: the project's configured sources, the project tenant and its workspace

**Output**: the outcome of each repository's pull

**Steps**:
1. [x] - `p1` - Resolve each source's connection, for the provider, the installation root and the credential reference the gear needs - `inst-1`
2. [x] - `p1` - **IF** a source's connection cannot be resolved - `inst-2`
   1. [x] - `p1` - Record that repository as unsyncable and continue with the rest - `inst-3`
3. [x] - `p1` - `API: POST /cf/studio-artifact-ingest/v1/sync (provider, base_url, secret_ref, repo_full_path, project, workspace)` for each source, a bounded number at a time - `inst-4`
4. [x] - `p1` - `API: GET /cf/studio-artifact-ingest/v1/tasks/{id}` for the tasks not yet settled, on an interval - `inst-5`
5. [x] - `p1` - Report each task's stored count onward, so a reader can tell that what is queryable has grown - `inst-6`
   1. [x] - `p1` - **IF** it has grown, the read that displays it re-issues itself; the import does not reach into its cache - `inst-7`
6. [x] - `p1` - **IF** the gear no longer knows a task, or three polls in a row go unanswered - `inst-8`
   1. [x] - `p1` - Treat it as lost rather than pending, and stop asking about it - `inst-9`
7. [x] - `p1` - **IF** a task failed - `inst-10`
   1. [x] - `p1` - Keep its reason against its repository, and do not resubmit it - `inst-11`
8. [x] - `p1` - **RETURN** when no task is left unsettled, or when the watch window ends; a task still running then is left to the gear and shown as no longer watched - `inst-12`

## 4. States (CDSL)

### Import State Machine

- [ ] `p2` - **ID**: `cpt-studiofrontend-state-project-artifacts-import`

**States**: Idle, Running, Settled, Failed

**Initial State**: Idle

**Transitions**:
1. [ ] - `p1` - **FROM** Idle **TO** Running **WHEN** the section opens on a project whose sources have not been pulled in - `inst-1`
2. [ ] - `p1` - **FROM** Idle **TO** Running **WHEN** the member asks for a sync - `inst-2`
3. [ ] - `p1` - **FROM** Running **TO** Settled **WHEN** every task has succeeded - `inst-3`
4. [ ] - `p1` - **FROM** Running **TO** Failed **WHEN** every task has failed or been lost - `inst-4`
5. [ ] - `p1` - **FROM** Running **TO** Settled **WHEN** some tasks succeeded and some failed; the failures are reported against their repositories - `inst-5`
6. [ ] - `p1` - **FROM** Failed **TO** Running **WHEN** the member asks for a sync again - `inst-6`
7. [ ] - `p1` - **FROM** Running **TO** Idle **WHEN** the project in scope changes; the tasks outlive the screen on the server and are simply no longer watched. The attempt stays recorded, so returning does not restart it - `inst-7`

## 5. Definitions of Done

### The project's rail lives inside the project frame

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-artifacts-rail`

The system **MUST** render the project's section navigation inside the project
frame as an icon rail that widens into a labelled flyout on pointer hover **and**
on keyboard focus, **MUST** overlay the content rather than displace it, and
**MUST NOT** extend past the frame into the shell's own chrome.

ADR-0008 puts this rail inside the project, not in the shell, so it is this
MFE's to draw — and its geometry is the prototype's, not ADR-0008's: the ADR
describes a 232px column that is always open, while the design has moved to a
48px icon rail that widens to 240px, with 40px rows, 20px icons and a rule
between the six sections a member browses and the settings below them. Those
numbers are measured off the prototype, not taken from the ADR's prose.

The kit's sidebar gives the two widths and the collapsed-only tooltips for free,
but two of its properties have to be answered here:

- Its panel is `position: fixed`, which resolves against the viewport. Inside a
  bounded box — which the project frame is, and a shadow root at that — it
  escapes the box unless an ancestor establishes a containing block for fixed
  descendants. Without that the rail covers the top bar.
- It offers a click trigger and no hover mode. Hover and focus are wired here,
  over the same open state the trigger would have used, so there is one source
  of truth for whether the rail is open.

A third property is not a hover mode but a layout one: expanding grows the panel
*and* the spacer that reserves its width in flow, which would displace the
content this DoD requires it to overlay. The column is therefore pinned to the
icon width and clips the spacer, leaving only the out-of-flow panel free to grow.

Retuning it to the prototype goes through the kit's own tokens wherever one
exists — `--sidebar-width`, `--control-height-sm`, `--radius-md`, `--sidebar`,
`--sidebar-accent` — because an inherited custom property cannot lose a
specificity race. Where a rule is unavoidable its selector is one step more
specific than the kit's, since a tie is settled by load order and nothing
guarantees that order. One difference from the prototype is accepted rather
than fought: the kit reveals a label with `display: none`, so it appears at once
where the prototype fades it in, and reproducing the fade would mean targeting
the kit's own hashed class names.

The sections are the seven the navigation state already declares. Only the
section changes; the open project does not, so widening the rail never re-reads
anything.

**Implements**:
- `cpt-studiofrontend-flow-project-artifacts-browse`

**Touches**:
- Entities: `ProjectRail`, `ProjectScreen`, `navSlice`

### The table is the prototype's five columns

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-artifacts-table`

The system **MUST** show name, repository, path, sync state and updated, and
**MUST** render the page it was handed without reordering or re-filtering it.

The table is built on the kit's `Table` primitives rather than on its
`DataTable`, and that is what makes the rest of this DoD reachable. `DataTable`
passes nothing but a `key` to its `TableHead`, so no column can carry a width —
and without a width a long repository name pushes the whole table into a
horizontal scroll instead of truncating. The projects list next door settles the
same question the same way: `table-layout: fixed`, the width on each column's
own class, `nowrap` on the narrow columns, and truncation on the content
element rather than on the cell.

Owning the markup also buys the footer the design asks for: numbered pages and
the row-range line beside them, both beyond `DataTable`'s prev/next. The table
holds no page state of its own — it is given the offset and the total and
reports which page was asked for, so the one component that knows the filter is
the one that decides where the paging starts.

Two columns carry a decision rather than a field:

- **Repository** is a join. A node names its repository by instance id, not by
  name; the name is on the repository's own node in the same answer.
- **Sync** is, on today's data, one value for every row. Its other values need
  spec-quality findings, which nothing in this portal produces yet. The column
  stays because the mockup has it and it costs nothing, and because it lights up
  the day the detectors run — the same treatment the projects list gives its
  columns without a source.

**Implements**:
- `cpt-studiofrontend-algo-project-artifacts-rows`

**Touches**:
- API: `GET /cf/studio-artifact-ingest/v1/nodes`
- Entities: `ArtifactsSection`, `artifactColumns`, `artifactRow`

### Filtering, ordering and paging belong to the gear

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-artifacts-page`

The system **MUST** ask the gear for one page and render exactly that, **MUST**
send the repository filter, the search text and the sort with the request rather
than applying them after it, **MUST** count the paginator against the `total`
the gear returns, and **MUST** return to the first page whenever the filter or
the search changes.

The earlier arrangement read "everything in scope" and paged it on the client.
It never did: `GET /nodes` defaults to fifty and the request carried no `limit`,
so the client held the first fifty nodes by instance id and paged those. The
damage was not just a short table. A row names its repository by instance id and
the name lives on the repository's own node, so once a repository node fell past
the cut its rows went nameless; and a shortfall check that compared those fifty
rows against the project's configured sources reported repositories as never
pulled in. A page of an unordered set is not a page, and a filter over one page
is not a filter — which is why the order and the filters had to move with the
page rather than after it.

Three reads serve the section, and each answers a question the others cannot:
the page itself; the repository nodes, because the page need not contain the
repository a row points at and the filter must offer every repository, not the
ones that happen to be on screen; and a `limit=1` read whose only purpose is
`total`, so a search can narrow the table without moving what the header says
the project holds. That last one is the same read that decides a first import,
so it is one request, not two.

The search waits for the typing to settle before it becomes a request. Ordering
is `sort=updated` and only that: the gear offers newest-first or its own stable
order by instance id, and "by instance id" is not an order a member asked for.
Re-sorting the page on the client is the one thing this DoD forbids outright —
it would order the fifteen rows in hand and silently disagree with every other
page. The offset is clamped as well as reset, because a filtered set can shrink
under a member who is standing on its last page.

**Implements**:
- `cpt-studiofrontend-algo-project-artifacts-rows`

**Touches**:
- API: `GET /cf/studio-artifact-ingest/v1/nodes`
- Entities: `ArtifactIngestApiService`, `useArtifacts`, `ArtifactsSection`, `ArtifactsTable`

### The header counts the project, not the filter

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-artifacts-counters`

The system **MUST** state the project's artifact total and the number of
repositories those artifacts came from, **MUST** compute both over the whole
project rather than over the searched rows, **MUST** restate itself around a
chosen repository — that repository's own total, named — and **MUST NOT** state
how many artifacts are complete or need attention.

A search does not change what the project holds, so it must not move these
numbers; the footer's range is what reports it, and the two disagreeing is
intended. Keeping that true once the gear does the filtering costs a second
read: the page's `total` is the filtered count, so the project's own count is
asked for separately and is the one the header uses. Choosing a repository is
different in kind: the member has said which repository they are looking at, and
a project-wide total is then answering a question nobody asked. The prototype
makes the same split — `1,286 artifacts · 97 repositories` with nothing chosen,
`96 artifacts in trust-center` once one is. How many of those are on screen is
the footer's sentence, not the header's.

The repository count is what the graph holds, not a "reached out of
configured" pair. The pair was specified here first, to keep a failed sync
visible — a repository's node is written *during* its sync, so one that failed
is absent from the graph entirely. Two things retired it. The prototype states a
plain count, and this header follows the prototype; and the configured half is
not reliably there to divide by — a project can hold artifacts whose
repositories were never written into its config, which made the pair render as
"1 of 0". A failed sync now surfaces where it is actually actionable: against
its own repository in the import state, not as a subtraction in a header.

The repository read feeds the filter, and for the same reason: its options are
every repository node in scope, so the filter can never miss one whose rows
happen to sit on a page the member has not opened. Its value is the repository
node's instance id, because that is what the gear filters on; the name is for
the member to read.

The two counters the mockup adds — complete, and needing attention — are not
shown. Both are derived from spec-quality findings, and nothing calls the
detector endpoint, so both would read zero forever. Zero artifacts needing
attention is not a missing number; it is a false assurance.

**Implements**:
- `cpt-studiofrontend-algo-project-artifacts-rows`

**Touches**:
- API: `GET /cf/studio-artifact-ingest/v1/nodes`
- Entities: `ArtifactsSection`, `useArtifacts`, `useArtifactCount`

### Updated shows a time or says where the row came from

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-artifacts-updated`

The system **MUST** show a relative time for rows that have one, **MUST** name
the row's provenance for rows that do not, **MUST** order by the underlying
instant rather than by the rendered text, and **MUST** keep the rows without an
instant at the end.

Issues and pull requests are the only rows with an instant: their nodes carry a
created and an updated timestamp. Nothing else does. A repository node is
`connector_id`, `provider` and `full_path` — the gear records no moment of
cloning, syncing or ingesting, for any node type. File nodes carry no timestamp
either, neither the ones walked out of a checkout nor the ones listed from the
tree API nor the ones registered from an upload — and files are most of the
table. So provenance is not the file column's special case; it is what every
row but an issue or a pull request shows. Formatting an absent instant as an age
would be an invention; naming where the row came from is not.

Ordering therefore reads a hidden instant, and rows without one are pinned last.
The gear does the ordering, and it offers one direction: `sort=updated` is
newest first, and its timestampless nodes land at the end because an absent
`updated_at` compares as the empty string. So the column states the order rather
than offering to change it — a static newest-first mark, no toggle. The
alternative reads worse than it sounds: oldest-first would have to be faked by
paging the set backwards and reversing each page, which puts the least
informative rows on the first screen and breaks this DoD's own last clause.
**Oldest-first is left to the gear** — one more branch in its `sort` match — and
until then the direction is not offered rather than being approximated.

**Implements**:
- `cpt-studiofrontend-algo-project-artifacts-rows`

**Touches**:
- Entities: `artifactColumns`, `artifactRow`, `UpdatedCell`

### Reads are scoped to the project

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-artifacts-scope`

The system **MUST** read artifacts with the open project's tenant as the scope,
and **MUST NOT** show a workspace-wide or unscoped answer in a project's section.

The gear accepts either level and matches a node whose workspace *or* project
tag equals the scope. Passing the workspace would list every sibling project's
artifacts under one project's heading; passing nothing would list the whole
installation's.

A repository attached to two projects is two graphs, not one moving between
them. Every deterministic node id the gear writes takes the attachment scope —
the project, or the workspace for a workspace-level source — as its first
component, so pulling `acme/example` into a second project cannot overwrite or
empty the first project's copy of it. This is why the section no longer draws a
shortfall banner naming repositories with nothing pulled in: the case it existed
for cannot happen, and the check behind it could only ever compare the page in
hand against the project's configured sources, which reported a false shortfall
for every repository past the first page. A sync that genuinely failed is still
reported, against its own repository, in the import state.

**Implements**:
- `cpt-studiofrontend-algo-project-artifacts-rows`

**Touches**:
- API: `GET /cf/studio-artifact-ingest/v1/nodes`
- Entities: `ArtifactIngestApiService`, `useArtifacts`

### A repository is the unit of sync and of retry

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-artifacts-sync-unit`

The system **MUST** request a sync per repository, **MUST** bound how many run at
once, and **MUST NOT** offer to re-sync an individual artifact.

Per-file retry is not expressible. The request takes one repository path, and
nothing records which files did not make it: a failed file phase logs a warning
and leaves a successful task, the ten-thousand-file ceiling truncates silently,
and an absent file is indistinguishable from a file that was never there.
Identifying the gap would mean listing the repository from its provider and
diffing it against the graph — the same call the sync itself makes, paid twice.

The bound on concurrency is not tidiness. Each request spawns its own background
task on the gear with nothing throttling it, and the provider's rate limit is a
few thousand calls an hour with no backoff anywhere in the chain. What spends it
is the per-object phases: a call per pull request to reach its files, and paged
listings of comments and commits that keep asking until a page comes back empty.
The file phase is not among them — it is two calls for the whole tree. A project
with tens of repositories can exhaust the limit in a single unbounded import.

A failed repository is reported and left alone. It is not resubmitted on its
own, and re-entering the section does not restart it, because an import that
produced nothing would otherwise burn the same rate limit on every visit.

One unanswered poll is not a failure. The gear is asked again, and only a task
it says it does not know, or three unanswered polls in a row, ends the watch
for that repository. Leaving the project ends the watch for all of them, and
the tasks run on. Every poll asks the gear, never the shared fetch cache.

**Implements**:
- `cpt-studiofrontend-algo-project-artifacts-sync`

**Touches**:
- API: `POST /cf/studio-artifact-ingest/v1/sync`, `GET /cf/studio-artifact-ingest/v1/tasks/{id}`
- Entities: `artifactEffects`, `artifactSync`, `artifactSyncSlice`

### A first import is recognised from data

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-artifacts-import-detect`

The system **MUST** decide whether to start an import by asking whether the
project has sources and no artifacts, and **MUST NOT** carry a "just created"
signal from the wizard to the project frame.

The wizard and the project frame are separate extensions of this MFE, and each
loaded entry gets its own module realm and its own store — so anything the
wizard learns has to cross through the shell to reach the frame. Deriving the
answer from data removes that crossing entirely: no task ids to hand over, no
shared property to widen, no shell-side schema to change. It also gives the
correct answer in the cases a one-shot flag gets wrong — a reload during the
import, and a member opening the project who did not create it.

The consequence is accepted rather than worked around: any project with sources
and an empty graph opens on this section, whoever opens it and whenever. That is
the section worth seeing for such a project.

The attempt itself is remembered in the tab's session storage as well as in the
store, because a reload mid-import empties the store while the gear's tasks run
on. A remembered attempt only stops the import from starting on its own; the
member can still ask for a sync.

The same derivation chooses the section, so the landing is decided inside the
project frame and not announced to it.

**Implements**:
- `cpt-studiofrontend-algo-project-artifacts-first-import`
- `cpt-studiofrontend-flow-project-artifacts-import`

**Touches**:
- Entities: `useArtifactImport`, `ProjectScreen`, `navSlice`

### A created project opens

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-artifacts-open-after-create`

The system **MUST** announce a created project to the shell as the open one
before the wizard is unmounted, and the shell **MUST** publish it so the project
frame opens it.

This is the one thing that still crosses the realm boundary, and the channel
already exists: the action the project frame executes when a member opens a row
from the list, and the shared property the shell answers with. The wizard sends
the same action at the same target, the screen domain, from its own bridge. The
mediator resolves a handler by the action's target, not by the sending entry,
and an entry's `domainActions` is not enforced — so no manifest or bootstrap
change is needed, and none is made. If `domainActions` ever becomes a permission
list, the wizard entry is where it would have to be declared.

The list that travels with the announcement is the switcher's list for as long
as the project is open, so it is the workspace's projects read fresh, with the
new one among them — not the one row the wizard knows.

Announcing before unmounting, not after: the wizard is what holds the created
project's identity, and the shell's overlay closes on Escape and on the scrim
without asking.

**Implements**:
- `cpt-studiofrontend-flow-project-artifacts-import`

**Touches**:
- Action: `constructor_studio.context.projects.publish.v1~` (`kind: opened`)
- Entities: `NewProjectWizard`, `projectsActions`

### Nothing is invented where the gear is silent

- [ ] `p1` - **ID**: `cpt-studiofrontend-dod-project-artifacts-no-invented`

The system **MUST NOT** render a value the gear cannot answer for. Specifically
absent, and absent on purpose:

- **A document kind.** Architecture, Specification, Service, Release, Test run
  and Review are not node types and are not derivable from one. A row's type
  reaches the member as its icon and nothing more.
- **A readiness percentage**, and the per-artifact card built on it. There is no
  score in the graph, and the items such a card would list come from findings
  that are never written.
- **A moved-and-synced state.** A file node's identity is keyed on its path, so
  a rename is an unrelated node appearing and another going quiet. The move
  cannot be seen.
- **A per-file ingest status.** The gear reports one count of stored objects per
  task; whether a particular file is queued or done is not in it.
- **A progress stepper.** Four of its five stages map onto phases the gear
  reports, but the fifth is the detector pass that nothing runs. The header's
  moving totals carry the same information without the missing stage.

Each of these returns as its source arrives. None of them returns as a
placeholder, a dash or a zero dressed as an answer.

**Implements**:
- `cpt-studiofrontend-flow-project-artifacts-browse`

**Touches**:
- Entities: `artifactRow`, `artifactColumns`, `ArtifactsControlStrip`

## 6. Acceptance Criteria

- [ ] With a project open, the rail shows seven icons and no labels, and the content starts to its right.
- [ ] Hovering the rail widens it to show the labels, over the content rather than pushing it, and it narrows again when the pointer leaves.
- [ ] Tabbing into the rail widens it the same way, and every section can be reached and activated from the keyboard alone.
- [ ] The widened rail never covers the top bar, and never extends below the project frame.
- [ ] While the rail is narrow, hovering an icon names its section; while it is wide, no such tooltip appears.
- [ ] Activating Artifacts shows the artifacts table; the open project does not change and the list behind it is not re-read.
- [ ] The table has exactly the columns Name, Repository, Path, Sync and Updated, in that order.
- [ ] Every row names the repository it came from by name, not by an identifier.
- [ ] Rows for issues and pull requests show a relative time in Updated; every other row — files and repositories alike — names where it came from instead.
- [ ] Updated is marked as newest-first, offers no way to reverse it, and rows without a time sit at the bottom.
- [ ] The header states the number of artifacts and the number of repositories they came from, each in the singular when there is one.
- [ ] Narrowing by text changes the table and the footer, and leaves the header's totals as they were.
- [ ] Choosing a repository restates the header as that repository's own total, names it, and starts the table again from the first page.
- [ ] Narrowing by text while on a later page shows the matching rows from the first page, not an empty page.
- [ ] A project with more artifacts than one page holds lists them all across the paginator, and the footer's total is the gear's, not the page's.
- [ ] The repository filter offers every repository in the project, including ones whose rows are not on the page in view.
- [ ] Every row on every page names its repository; none is left blank.
- [ ] The header states nothing about artifacts being complete or needing attention.
- [ ] A project with no sources shows an empty state that says so and offers no sync.
- [ ] A project with sources and nothing ingested shows an empty state that offers a sync.
- [ ] Creating a project from selected repositories leaves the wizard closed, the project open, and the Artifacts section showing.
- [ ] Rows appear in that table while the import is still running, without a reload and without the member acting.
- [ ] The header's totals climb as the import proceeds and stop when it finishes.
- [ ] Opening the same project by hand from the list, before its import has been run, reaches the same section and starts the same import.
- [ ] Opening a project that already has artifacts lands on its first section and requests no sync.
- [ ] Reloading the page during an import does not start a second import.
- [ ] One repository failing to sync leaves the other repositories' rows in the table, and the failure is reported against that repository.
- [ ] Every repository failing to sync is reported, and re-entering the section does not start the import again.
- [ ] Leaving Artifacts for another section and returning shows the rows that arrived while it was away.
- [ ] Pulling a repository into another project leaves this project's rows for it untouched, and no banner claims a repository was never pulled in.
- [ ] No request for artifacts is made without the open project as its scope.
- [ ] No row shows a document kind, a readiness percentage, or a per-file ingest status.
