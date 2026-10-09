---
type: design
status: accepted
owner: studio-team
---

# Technical Design — studio-artifact-ingest

- [x] `p3` - **ID**: `cpt-studio-design-artifact-ingest`

The gear-level design of `cpt-studio-component-artifact-ingest`. The
product-level view, and how this gear sits among the others, is in
[Constructor Studio's design](constructor-studio.md). The code is
[`studio-backend/src/artifact_ingest/`](../../studio-backend/src/artifact_ingest/).

## Table of Contents

- [1. Architecture Overview](#1-architecture-overview)
- [2. Principles & Constraints](#2-principles--constraints)
- [3. Technical Architecture](#3-technical-architecture)
- [4. Additional context](#4-additional-context)
- [5. Traceability](#5-traceability)

## 1. Architecture Overview

### 1.1 Architectural Vision

A repository's meaning is spread across places that answer different
questions: the provider's API knows the issues and pull requests, the checkout
knows the files, and neither knows how they relate. This gear normalizes them
into one typed shape, `gts.cf.studio.artifact.*` nodes with deterministic ids,
so a re-sync upserts rather than duplicates and a consumer traverses one graph
instead of three APIs.

A sync is a durable `artifact.ingest` run. It reads issues and pull requests
from the connector, files from a checkout, and writes nodes and edges to
graph-storage in bounded chunks. While it holds each document's text it hands
the documents to `cpt-studio-component-documents` to classify and counts the
comment threads the IDE committed beside them. It stores what a file is, never
its text.

The graph is the source of truth, but its projection cannot filter or order on
a payload field, and every listing narrows by scope, repository and the
artifact's own `updated_at`. So the listing fields are mirrored into a
Postgres table of this gear's, and scoped reads are one indexed query each.

### 1.2 Architecture Drivers

#### Functional Drivers

| Requirement | Design Response |
|-------------|------------------|
| `cpt-studio-fr-artifact-ingest` | `POST /sync` queues an `artifact.ingest` run that upserts nodes keyed on uuid5 instance ids; `/nodes`, `/edges`, `/activity`, `/source-activity`, `/open-pull-requests`, `/search`, `/quality` and `/files` serve and extend what it wrote. |
| `cpt-studio-fr-repository-documents` | The run hands each prose file's path and text to `documents::port::DocumentClassifier` and forgets the bindings of files the repository no longer has. |

#### NFR Allocation

| NFR ID | NFR Summary | Allocated To | Design Response | Verification Approach |
|--------|-------------|--------------|-----------------|----------------------|
| `cpt-studio-nfr-durable-work` | Runs survive a restart | `ingest_task.rs` | A sync is a `studio-tasks` run, partitioned by provider, credential, scope and repository so two syncs of the same keys never run at once | `service.rs` unit tests |
| `cpt-studio-nfr-credential-isolation` | No secret in a session, a browser or a response | `ingest_task.rs`, `connectors::sdk::git_checkout` (`connectors/clone.rs`) | The run payload carries the credstore reference, not the token; the token reaches `git` through a one-shot credential helper reading an environment variable, never the URL, arguments or a log line | `connectors/clone.rs` unit tests |
| `cpt-studio-nfr-list-pagination` | One paging contract | `/nodes`, `/edges` | `offset` and `limit` (1–200, default 50) | `index_tests.rs` checks the index against the in-process listing over a query matrix |

#### Key ADRs

| ADR ID | Decision Summary |
|--------|------------------|
| `cpt-studio-adr-types-registry-catalogs-meaning-graph-storage-contracts-storage` | The artifact types are cataloged in the types-registry and registered in graph-storage as derivations of its `owned_node` and `static_edge` families. |
| `cpt-studio-adr-studio-events-push-channel` | A sync's progress reaches the portal as `task_run` events. |

### 1.3 Architecture Layers

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| REST | Sync, reconcile, listings, activity, search, findings, files | `OperationBuilder` routes in `rest.rs` |
| Run | One repository into the graph | `ingest_task.rs` over `service.rs` |
| Channels | Connector API, checkout, tree API | `connectors::sdk::ConnectorDriver`, `connectors::sdk::git_checkout` (`connectors/clone.rs`) |
| Normalization | Type ids, instance ids, schemas | `gts.rs`, schemas in [`studio-backend/gts/artifact/`](../../studio-backend/gts/artifact/) |
| Store | Graph writes and reads, the index in step | `graph.rs` (contract and in-memory fallback), `graph_backend.rs`, `index.rs` |
| Storage | Nodes and edges; the listing mirror | graph-storage; PostgreSQL database `studio_artifact_index` |

## 2. Principles & Constraints

### 2.1 Design Principles

#### Read the disk that already holds the repository

- [x] `p2` - **ID**: `cpt-studio-principle-artifact-ingest-file-channels`

Files come from three channels, tried in order, because cloning a repository
twice wastes the disk that already holds it:

1. the studio-session workspace checkout (`STUDIO_WORKSPACES_ROOT`, default
   `~/.cf-studio-workspaces`), when the IDE has already cloned it;
2. the gear's own shallow clone (`STUDIO_ARTIFACT_WORKDIR`, opt-in), `--depth
   1` on a single branch, fast-forwarded when already on disk;
3. the connector tree API, metadata only, when there is no disk to use.

#### The graph keeps what a file is, not what it says

- [x] `p2` - **ID**: `cpt-studio-principle-artifact-ingest-no-file-text`

A sync reads the text of prose files and of comment logs only, to classify
them and count threads, and stores neither. The graph is not a blob store and a
node payload is capped near 64 KiB. The `file_content` nodes earlier syncs
wrote (an 8,000-character excerpt each, for a search nothing called; 19,950 of
them and 136 MB with embeddings on studio-dev, 2026-10-05) are retired by the
next sync of their repository. Whoever needs a document's text reads it from
the checkout through `port::RepoFileReader`.

#### A forgotten node is retired, not deleted

- [x] `p2` - **ID**: `cpt-studio-principle-artifact-ingest-retire`

A file the repository no longer has, or a repository a project detached, is
overwritten with a `studio_artifact_retired` payload and its edges removed,
and readers skip it. Files are forgotten only when the listing of the
repository was complete: a failed walk reads as no files and a truncated one
as fewer, and believing either would forget files that still exist.

#### Every artifact read and write goes through the indexed store

- [x] `p2` - **ID**: `cpt-studio-principle-artifact-ingest-indexed-store`

`IndexedGraphStore` changes the graph first, then the index, in the same call.
A write that bypasses it leaves the index behind the graph. When the index
cannot follow a change, the tenant's fill row is withdrawn: readers fall back
to the graph and the next read refills. Scoped reads use `list_in_scope`,
`count_in_scope`, `files_in_scope` or `page`; `list()` followed by a filter is
the walk the index replaced.

### 2.2 Constraints

#### graph-storage cannot narrow by payload, and cannot page past its caps

- [x] `p2` - **ID**: `cpt-studio-constraint-artifact-ingest-graph-limits`

The projection filters and orders on `node_key`, `name`, `created_at` and
`updated_at` only. Without the index a scoped listing pages the tenant's whole
typed node set: 28,717 nodes, 31 MB and 144 sequential round trips, a p95 of
8.06 s on studio-dev, and 12–20 s per walk when measured again on 2026-09-25.
weftgraph 0.1.1 filters and orders on declared payload paths but has no count,
no offsets and no indexed payload ordering, so the index stays until it does
(request 5 in [`graph-storage-requests.md`](../../docs/upstream/graph-storage-requests.md));
then the index is deleted rather than kept in step.

Relations are read by seeded traversal, 400 seeds per call with a budget of
10,000 nodes, seeds included; a batch that exhausts the budget is halved and
re-read, which finds the node that filled it in about nine steps. It replaced
one node read per seed, which took 8,825 reads for one request and silently
clipped every node past `node_read_max_adjacency`: 27,852 of 79,184 relations,
35%. The residual, 5,944 relations on three nodes, is not this gear's to fix:
`node_read_max_adjacency` validates to 1,000 and `traversal_max_nodes` to
10,000, and neither call pages (request 6). `traversal_max_nodes: 10000` is set
in every config profile, because the default 1,000 truncates a 400-seed chunk.

#### Bounded syncs

- [x] `p2` - **ID**: `cpt-studio-constraint-artifact-ingest-bounds`

Per sync: 10,000 files, 20,000 comments, 20,000 commits, 50 pages of 100 per
API channel, and review threads of at most 200 open pull requests. Nodes and
edges are flushed 1,000 per call (edges went from 5,000 after a large ingest
took part in an OOM kill, studio-web#561), and a process runs one ingest at a
time while other task types proceed. A comment thread beyond the file cap is
not counted, rather than exempting `.studio/` and reopening the memory hole the
cap closes.

## 3. Technical Architecture

### 3.1 Domain Model

- [x] `p2` - **ID**: `cpt-studio-entity-artifact-node`

Node types `gts.cf.studio.artifact.{repo,issue,pull_request,file,user,spec_finding,comment,commit,file_content,mapping_decision}.v1~`;
`repo`, `file`, `issue` and `pull_request` are listed by default and the rest
only when asked for by type. Edge types
`gts.cf.studio.rel.{artifact_of,contains,authored_by,modifies,duplicates,traces_to,finding_on,comment_on,content_of,decision_on,reviewed_by,assigned_to}.v1~`.
Instance ids are uuid5 of a stable key that includes the source scope, so the
same repository attached to two projects is two sets of nodes. A
`spec_finding` is keyed on (detector, subject), so re-running a detector
upserts: one current finding per detector per document. A
`mapping_decision` is keyed on (document, section, capability, gear), so
deciding again replaces the decision; it is written for
`cpt-studio-component-spec-mapping` and linked to a bound file by `decision_on`. A file node carries
`open_threads` and `resolved_threads`, counted from the IDE's append-only
comment logs under `.studio/comments/` with the ordering rules of
`theia/product-ext/src/browser/comment-log.js` mirrored; the repository node
carries `open_document_threads` and, where the provider can say,
`open_review_threads`. A count is kept, never a message.

A `pull_request` node carries, beside what the listing always gave, `draft`,
`requested_reviewers` and `requested_teams` (still owed a review: GitHub drops
a login when its review arrives and puts it back when review is asked for
again), `assignees`, and, for an open pull request whose reviews were read,
`reviews` (each reviewer's last word: `approved`, `changes_requested` or
`commented`, an approval or a request for changes outranking a later comment)
and `review_decision` (`approved`, `changes_requested`, `review_required`;
derived here, because GitHub's own is null without branch protection). They
were added to `pull_request.v1` as optional fields (ADR-0013 §5, additive): a
node written before them reads as having none, and `reviews: null` means "not
read", never "nobody reviewed". `reviewed_by` links a pull request to everyone
asked to review it or who did, and `assigned_to` to its assignees. Edges only
accumulate, since a sync upserts them; who is owed a review now is on the
node. Only the GitHub driver lists pull requests at all
(`cpt-studio-constraint-connector-github-depth`); its listing carries draft,
reviewers, teams and assignees at no extra cost, and the reviews come in the
review-threads GraphQL query the sync already ran, so nothing adds a call.

- [x] `p2` - **ID**: `cpt-studio-algo-artifact-ingest-pull-request-waits`

Who an open pull request is waiting on is one bucket, checked in order, in
`pull_request_waits.rs`: `draft` (the author's); `author` when a request for
changes stands from somebody not asked to look again; `review` when a login or
a team still owes a review; `author` when review conversations are open or it
was only commented on; `merge` when approved with nothing outstanding (the
author's move); otherwise `nobody`, open and not a draft with nobody asked.
`/open-pull-requests` reads the project's `pull_request` and `repo` nodes
through the index and names each login as a member of the project's
organization through `MemberAliases`, only where the member CONFIRMED the
account (ADR-0012). Given `workspace_id` instead, it reads every project of the
workspace and lists a repository two of them sync once; `waiting_on=me` keeps
what waits on the caller, resolved to a person through `PersonResolver`.

### 3.2 Component Model

#### Ingest run

- [x] `p2` - **ID**: `cpt-studio-component-artifact-ingest-run`

##### Why this component exists

Cloning and walking a repository takes seconds to minutes. It was a
`tokio::spawn` beside a `Mutex<HashMap>` that died with the process: a poll
after a redeploy answered "no such sync task" about a sync that had run, and
nothing could be cancelled or seen failing.

##### Responsibility scope

`ingest_task.rs`, task type `artifact.ingest`: resolves the token from the
credstore reference per attempt (a rotated token is picked up by a retry),
runs the pipeline in `service.rs`, reports progress, classifies documents and
forgets gone files. The route resolves the token once before enqueuing so a
malformed reference is a 400 there, but a reference that resolves to nothing
is not refused: a public repository syncs without credentials. Queued syncs of
the same partition coalesce.

##### Responsibility boundaries

Does not decide what a file is; `cpt-studio-component-documents` does.

##### Related components (by ID)

- `cpt-studio-component-tasks` — runs as
- `cpt-studio-component-connector` — reads sources through its drivers
- `cpt-studio-component-documents` — classifies through

#### Artifact index

- [x] `p2` - **ID**: `cpt-studio-component-artifact-ingest-index`

##### Why this component exists

A 60-second per-tenant cache of the projection (budget 40,000 nodes) was not
enough: the node listing and the file listing together exceed it and evict
each other, so the Artifacts and Specs screens paid for a walk nearly every
time.

##### Responsibility scope

`index.rs`: one row per listed node with its narrowing fields as columns. A
tenant is served from it only after a fill copied its graph in and wrote its
`studio_artifact_index_fill` row; the fill runs in the background on the first
read, and a failed fill is retried no sooner than 60 seconds later. `/nodes`
with a `scope` is one `SELECT … LIMIT` with a `COUNT`; `/source-activity`,
`/activity`, `/edges?scope=`, the portfolio counts and the documents gear's
file list are one indexed query each.

##### Responsibility boundaries

Optional: without the gear's `database:` block every listing reads the graph
as before. Never holds file content. The graph still serves search, relations
and unscoped listings.

##### Related components (by ID)

- `cpt-studio-component-graph-storage` — mirrors

### 3.3 API Contracts

- [x] `p2` - **ID**: `cpt-studio-interface-artifact-ingest-rest`

- **Contracts**: `cpt-studio-interface-rest-api`
- **Technology**: REST/OpenAPI through `api_gateway`
- **Location**: [`studio-backend/docs/api-contract.json`](../../studio-backend/docs/api-contract.json)

**Endpoints Overview**:

| Method | Path | Description | Stability |
|--------|------|-------------|-----------|
| `POST` | `/studio-artifact-ingest/v1/sync` | Queue an `artifact.ingest` run; the task id is the run id on `/studio-tasks/v1/runs/{id}` | unstable |
| `POST` | `/studio-artifact-ingest/v1/reconcile` | Forget, in one scope, every synced repository not in `keep`, with its document bindings | unstable |
| `GET` | `/studio-artifact-ingest/v1/nodes` | Ingested nodes by `type`, `scope`, `repo`, `q`, `sort=updated`, `offset`, `limit` | unstable |
| `GET` | `/studio-artifact-ingest/v1/edges` | Relations as endpoint pairs, by `scope` | unstable |
| `GET` | `/studio-artifact-ingest/v1/source-activity` | Pull requests and commits per repository over `days` (default 7, at most 90) | unstable |
| `GET` | `/studio-artifact-ingest/v1/activity` | One project's checks and comments, newest first | unstable |
| `GET` | `/studio-artifact-ingest/v1/open-pull-requests` | One project's (or, by `workspace_id`, a workspace's) open pull requests, each in one bucket (`review`, `author`, `merge`, `draft`, `nobody`) with the people it waits on, longest-quiet first; `members_known` says whether accounts were matched to members; `waiting_on=me` keeps the caller's | unstable |
| `GET` | `/studio-artifact-ingest/v1/repo-files` | Text files of a session checkout | unstable |
| `POST` | `/studio-artifact-ingest/v1/quality` | Upsert `spec_finding` nodes and derived `duplicates`/`traces_to` edges | unstable |
| `POST` | `/studio-artifact-ingest/v1/search` | Hybrid retrieval when embeddings exist, else lexical | unstable |
| `POST` | `/studio-artifact-ingest/v1/files` | Register a file-storage object reference as a `file` node, idempotent by (project, path) | unstable |

Without a connector driver linked the routes stay mounted and answer 503 with
the reason. In process the gear
publishes six ports on the ClientHub (`port.rs`): `RepoFileReader` (a
checkout's text files), `ArtifactFiles` (a scope's file nodes),
`ArtifactCounter` and `ProjectSignalSource` (portfolio and projects-table
rollups), `SpecFindingWriter` (where a Spec Quality run records findings), and
`MappingDecisionStore` (where `cpt-studio-component-spec-mapping` keeps a
member's mapping decisions).

### 3.4 Internal Dependencies

| Dependency Gear | Interface Used | Purpose |
|-------------------|----------------|----------|
| `types_registry` | SDK client | Register the artifact types at init |
| `credstore` | `CredStoreClientV1` | Resolve the connector token per attempt |
| `cpt-studio-component-connector` | `ConnectorDriver` per provider, from the ClientHub; `connectors::sdk::git_checkout` | Issues, pull requests, tree listings; the opt-in shallow clone, its fast-forward and the walk of a checkout |
| `cpt-studio-component-graph-storage` | `GraphStorageClientV1` (feature `graph`), resolved in the REST phase | Nodes and edges; an in-memory store without it |
| `cpt-studio-component-documents` | `DocumentClassifier`, `BindingNames` from the ClientHub | Classify synced files; name findings in the feed |
| `cpt-studio-component-tasks` | `sdk::register`, `TaskQueue` | The `artifact.ingest` task type |
| `cpt-studio-component-user` | `MemberAliases` from the ClientHub, per request | Name a pull request's accounts as the organization's members; without it every account reads as a bare login and `members_known` is false |
| `cpt-studio-component-account-management` | SDK client, per request, as the caller | The organization a project hangs under (project → workspace → organization) |

### 3.5 External Dependencies

#### Source hosts

| Dependency Gear | Interface Used | Purpose |
|-------------------|---------------|---------|
| `cpt-studio-component-artifact-ingest` | `git` over HTTPS for the opt-in clone; the provider API through the connector drivers (`cpt-studio-contract-provider-apis`) | Files, issues, pull requests, comments, commits |

#### PostgreSQL

| Dependency Gear | Interface Used | Purpose |
|-------------------|---------------|---------|
| `cpt-studio-component-artifact-ingest` | `toolkit-db` (raw-SQL migrations) | The index tables of §3.7 |

### 3.6 Interactions & Sequences

`cpt-studio-seq-create-project` shows the portal starting a sync when a
project is created.

#### Sync a repository

**ID**: `cpt-studio-seq-artifact-ingest-sync`

**Actors**: `cpt-studio-actor-member`, `cpt-studio-actor-provider`

```mermaid
sequenceDiagram
    participant P as Portal
    participant R as POST /sync
    participant T as studio-tasks
    participant I as artifact.ingest
    participant C as Connector / checkout
    participant G as IndexedGraphStore
    participant D as studio-documents
    P->>R: provider, secret_ref, repo, scope
    R->>R: resolve the token once (errors are 400/500 here)
    R->>T: enqueue, partition = provider:secret_ref:scope:repo
    T->>I: run
    I->>C: issues, pull requests; files and prose text
    I->>G: upsert nodes and edges in chunks (graph, then index)
    I->>D: classify_ingested(prose files)
    I->>G: retire gone files (complete listing only)
    I->>D: forget_ingested(gone node ids)
```

**Description**: Each attempt resolves its own token and reads its own
checkout; a sync interrupted mid-way is retried by the queue.

### 3.7 Database schemas & tables

- [x] `p3` - **ID**: `cpt-studio-db-artifact-index`

Database `studio_artifact_index`. PostgreSQL only: the listing promises byte
order, spelled `COLLATE "C"` here.

#### Table: studio_artifact_index

**ID**: `cpt-studio-dbtable-artifact-index`

**Schema**:

| Column | Type | Description |
|--------|------|-------------|
| `tenant_id` | UUID | the graph's tenant |
| `instance_id` | TEXT (`COLLATE "C"`) | the node key |
| `type_id` | TEXT | `gts.cf.studio.artifact.*` |
| `workspace_id`, `project_id`, `repo`, `path` | TEXT | payload fields, `''` when absent |
| `is_dir` | BOOLEAN | |
| `updated_at` | TEXT (`COLLATE "C"`) | the artifact's own, ISO-8601 |
| `search_text` | TEXT | what `/nodes?q=` matches |
| `payload` | JSONB | as the graph stores it |

**PK**: `(tenant_id, instance_id)`

**Constraints**: none beyond the key.

**Additional info**: A mirror of the artifact graph for the listings graph-storage cannot narrow (payload filters, [`graph-storage-requests.md`](../upstream/graph-storage-requests.md) §5); rebuilt from the graph whenever it cannot be trusted. `studio_artifact_index_fill` marks the tenants it is complete for. See `studio-backend/src/artifact_ingest/index.rs`. Indexes `studio_artifact_index_workspace` on `(tenant_id, workspace_id, type_id)` and `studio_artifact_index_project` on `(tenant_id, project_id, type_id)`: a scope is a workspace or a project, and the planner combines the two. `COLLATE "C"` keeps the byte order the in-process listing returns, which a locale collation would break by ignoring the dashes in a uuid. A fill clears the tenant's rows and inserts with `ON CONFLICT DO NOTHING` while a sync inserts with `DO UPDATE`, so the newer payload stays whichever lands first.

**Example**:

| type_id | project_id | repo |
|--------|--------|--------|
| `gts.cf.studio.artifact.issue.v1~` | a project id | `acme/web` |

#### Table: studio_artifact_index_fill

**ID**: `cpt-studio-dbtable-artifact-index-fill`

**Schema**:

| Column | Type | Description |
|--------|------|-------------|
| `tenant_id` | UUID | a tenant the index is complete for |
| `filled_at_ms` | BIGINT | when the fill finished |
| `nodes` | BIGINT | how many nodes it copied |

**PK**: `tenant_id`

**Constraints**: none beyond the key.

**Additional info**: Absent means not yet, or no longer, trustworthy; readers
go to the graph until a fill writes the row.

**Example**:

| tenant_id | nodes |
|--------|--------|
| a tenant id | `24000` |

### 3.8 Deployment Topology

In-process in the one `studio-backend` binary: gear `studio-artifact-ingest`,
capabilities `[db, rest]`, config section `gears.studio-artifact-ingest`.

## 4. Additional context

[`studio-backend/AGENTS.md`](../../studio-backend/AGENTS.md) lists the rules
for reading and writing the artifact graph through the index.
[`docs/documents-from-a-repository.md`](../documents-from-a-repository.md)
covers what the documents gear does with the files a sync hands it.

## 5. Traceability

- **PRD**: [Constructor Studio](../prd/constructor-studio.md)
- **Design**: [Constructor Studio](constructor-studio.md)
- **ADRs**: [ADR index](../adr/README.md)
- **Code**: [`studio-backend/src/artifact_ingest/`](../../studio-backend/src/artifact_ingest/)
