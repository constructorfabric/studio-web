---
type: design
status: accepted
owner: studio-team
---

# Technical Design — studio-documents

- [x] `p3` - **ID**: `cpt-studio-design-documents`

The gear-level design of `cpt-studio-component-documents`. The product-level
view, and how this gear sits among the others, is in
[Constructor Studio's design](constructor-studio.md). The code is
[`studio-backend/src/documents/`](../../studio-backend/src/documents/).

## Table of Contents

- [1. Architecture Overview](#1-architecture-overview)
- [2. Principles & Constraints](#2-principles--constraints)
- [3. Technical Architecture](#3-technical-architecture)
- [4. Additional context](#4-additional-context)
- [5. Traceability](#5-traceability)

## 1. Architecture Overview

### 1.1 Architectural Vision

A specification is not free text. An organization has opinions about what a
PRD contains, what stage a project is at, and whether a document is finished.
This gear makes those opinions data: a document **type** carries a markdown
template, a section checklist and structural conformance rules, so "is this
document complete" has an answer that is not a person reading it.

How complete depends on what the document is for. Its front matter may
declare a `maturity`, the level a gear declares in its `gear.gdl`
(gears-rust #5275), and the check follows it. At `design` or `experimental`,
a required section may be missing or short. At `preview`, every section has to
be written, but `TODO` and `TBD` may stay, because an open question is closed
with a spike or a follow-up change, not with another review round. At `stable`
or `deprecated`, and when nothing is declared, the full check applies. An
unedited template (`{{…}}`, `<…>`) fails at every level. What a level lets
stand is still listed in the report's `open` and shown in the checklist; it
just does not count against `conforms`.

Documents reach a project two ways. Somebody writes one in Studio, and its
content is a column here; or the repository already had one, and a sync binds
the file to a type. The binding records a verdict and a path, never the text:
the text is read from the checkout when it is needed. Both kinds are folded
into one list of specs per project, and both are judged by the same template
check and the same Spec Quality detectors.

Storage scope is always the **workspace** tenant. A document's or binding's
`project_id` distinguishes project-owned from inherited (`NULL` is
workspace-level, visible to every project in it), so inheritance is a column
filter rather than a cross-tenant read, and a project's document list is one
query.

### 1.2 Architecture Drivers

#### Functional Drivers

| Requirement | Design Response |
|-------------|------------------|
| `cpt-studio-fr-document-catalogue` | Types, stages and capabilities are rows keyed `(tenant_id, key)` at organization or workspace level, overlaid on built-ins in that order; a `hidden` row is a tombstone. |
| `cpt-studio-fr-documents` | Workspace- and project-level documents with create-from-template, questionnaire composition (`intake.rs`), structural validation (`validate.rs`) and per-project stage status. |
| `cpt-studio-fr-repository-documents` | `classify.rs` decides a file's type from its front matter, then from four scored signals; the verdict is a row in `studio_document_bindings` keyed on the file's graph node. |
| `cpt-studio-fr-spec-domain-model` | Planned, in `documents/spec_model/`: a project's facts extracted per document revision on the caller's key, merged into one model with every fact's passage and status ([spec-domain-model.md](../spec-domain-model.md)). |
| `cpt-studio-fr-spec-contradictions` | Planned, in `documents/spec_model/`: deterministic rules over the merged model propose, a model call confirms, and the findings are recorded as `spec_finding` nodes beside the detectors'. |
| `cpt-studio-fr-spec-quality` | Detector verdicts are recorded per document in `studio_document_analyses`; a stage can gate on them. Analysis of a project's documents is queued as a `spec_quality.analyze_batch` run. |

#### NFR Allocation

| NFR ID | NFR Summary | Allocated To | Design Response | Verification Approach |
|--------|-------------|--------------|-----------------|----------------------|
| `cpt-studio-nfr-tenant-isolation` | Every allow stays in the caller's tenant subtree | `DocumentsService::authorize` | Every route resolves the workspace or project tenant through account-management under the caller's `SecurityContext` before touching a row; reads use the secure ORM scoped to that tenant | `repo_tests.rs` against the shared test PostgreSQL (`test_pg.rs`) |
| `cpt-studio-nfr-list-pagination` | One paging contract | REST layer | Document, binding and analysis lists take `PageQuery` (`offset`/`limit`) | `api_contract` drift test |

#### Key ADRs

| ADR ID | Decision Summary |
|--------|------------------|
| `cpt-studio-adr-document-types-are-components` | A catalogue key is an instance of one document-type GTS type, not a type of its own; organization and workspace overrides sit on the built-ins; stages move to the backend. |
| `cpt-studio-adr-types-registry-catalogs-meaning-graph-storage-contracts-storage` | The document GTS types are cataloged in the types-registry; the rows are this gear's. |

### 1.3 Architecture Layers

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| REST | Catalogue, documents, bindings, analyses, spec rows, review criteria | `OperationBuilder` routes in `rest.rs` |
| Service | Catalogue overlay, authorization, classification, sync analysis | `service.rs` |
| Domain | Types, templates, stages, capabilities; classification, validation, intake, review guides | `model.rs`, `classify.rs`, `validate.rs`, `intake.rs`, `review_guide.rs`, `spec_rows.rs` |
| Ports | What other gears may ask of this one | `port.rs`, published on the ClientHub |
| Storage | Six tables | PostgreSQL database `studio_documents`, SeaORM entities in `entity.rs` |

## 2. Principles & Constraints

### 2.1 Design Principles

#### Workspaces own documents; projects inherit them

- [x] `p2` - **ID**: `cpt-studio-principle-documents-workspace-scope`

Every document and binding is stored against the workspace tenant. A project
reads its own rows plus the workspace's (`project_id IS NULL OR project_id =
?`). A route given a project resolves the workspace it hangs from, and a
project that hangs from nothing is refused rather than read against the wrong
rows.

#### Inheriting a catalogue needs no permission on the level that published it

- [x] `p2` - **ID**: `cpt-studio-principle-documents-catalogue-overlay`

A workspace's effective catalogue is the built-ins, overlaid by its
organization's rows, overlaid by its own, read in one query with
`AccessScope::for_tenants([organization, workspace])`. The organization is taken
from the workspace's own `parent_id`, never from a second `get_tenant`:
account-management answers `NotFound` outside the caller's subtree, and an
ordinary workspace member has no scope on the organization. A level hides an
inherited entry with a tombstone (`hidden`) rather than deleting what is not
its own; deleting its own row reverts to what it inherits.

**ADRs**: `cpt-studio-adr-document-types-are-components`

#### A verdict that cost something is never re-guessed

- [x] `p2` - **ID**: `cpt-studio-principle-documents-keep-verdicts`

Classifying again after a re-sync updates the same rows (the binding id is a
uuid5 of workspace, project and node). A binding a person ruled on keeps its
type, and so does one Spec Quality typed: that answer cost an LLM round trip,
and the offline scoring already had its turn and did not settle it. Only the
conformance is refreshed against the current text. A file whose front matter
declares its type and whose text passes that type's template is bound as
`confirmed` without a person; either one missing, it stays a proposal.

#### The server joins the specs and their text

- [x] `p2` - **ID**: `cpt-studio-principle-documents-server-joins`

Which files are specs is this gear's; their text is whoever holds the
checkout's (`artifact_ingest::port::RepoFileReader`). The browser used to join
the two, reading every file out through REST and posting it back to be
analysed, and folding bindings, authored documents and every ingested file into
the Specs list. Both joins happen here now (`quality.rs`, `spec_rows.rs`), so a
second portal cannot fold them differently. Which documents deserve a detector
stays the caller's decision; only the reading moved.

### 2.2 Constraints

#### The gear stands down without a database

- [x] `p2` - **ID**: `cpt-studio-constraint-documents-optional-database`

With no `database:` block the gear logs it, registers no routes and publishes
no ports, rather than failing the boot. Every consumer treats an absent port
as "do not classify" or "no names", never as an error. Registration of the
document GTS types is best-effort for the same reason: the gear has its own
storage and does not need the registry to work.

#### Classification is offline and bounded

- [x] `p2` - **ID**: `cpt-studio-constraint-documents-offline-classify`

`classify.rs` uses nothing but the file and the type definitions: a winner
needs a score of at least `0.45` and a lead of `0.08` over the runner-up, and
anything else comes back undetermined with its candidates. Only prose paths
(`md`, `markdown`, `txt`, `rst`, `adoc`, `asciidoc`, outside `.cf-studio`,
`.claude` and `.github`, and not `CLAUDE.md` or `AGENTS.md`) can be
documents; any other path is recorded as `not_a_document`. Asking the
`purpose` detector about the leftover set is the caller's step, recorded with
source `spec_quality`.

## 3. Technical Architecture

### 3.1 Domain Model

- [x] `p2` - **ID**: `cpt-studio-entity-documents-catalogue`

A **document type** couples a key to a template specification: a markdown
skeleton, an ordered section checklist, structural rules, an optional
questionnaire and an optional review guide. The built-ins are the five types
Spec Quality analyses (`prd`, `adr`, `design`, `decomposition`, `feature`),
with templates in [`templates/`](../../studio-backend/src/documents/templates/)
and review criteria vendored under
[`review/`](../../studio-backend/src/documents/review/README.md). A **stage**
is a step of the journey (built-ins `intent` through `testing`, spaced by ten)
that may require document types and detector gates. A **capability** is a
word a document may declare, with the terms that find components providing it.

A **document** is authored in Studio, with a status ladder `draft` → `review`
→ `approved` that never moves back. A **binding** is a repository file bound to
a type, in state `detected`, `confirmed`, `manual`, `unknown` or
`not_a_document`. An **analysis** is one detector's gate verdict (`pending`,
`passed`, `failed`) on exactly one document or binding.

The four GTS types registered for discovery are
`gts.cf.studio.doc.document_type.v1~`, `gts.cf.studio.doc.document.v1~`,
`gts.cf.studio.process.stage.v1~` and `gts.cf.studio.process.capability.v1~`.

### 3.2 Component Model

#### Classifier

- [x] `p2` - **ID**: `cpt-studio-component-documents-classifier`

##### Why this component exists

A file pulled from an existing repository names no type, and it cannot be
validated until something decides which template applies.

##### Responsibility scope

`classify.rs` and `DocumentsService::classify_ingested`: the declared type
from front matter (`type`, `doc_type`, `document_type` or `kind`), else a
score from the required sections the file contains, its path, its title and
the front-matter keys it fills. Scores derive from each type's own definition,
so a workspace's type is detected on the same terms as a built-in. Writes the
bindings in one upsert, with the validation report, the declared capabilities
and a `content_sha` per file. `forget_ingested` deletes the bindings of files
a repository no longer has, in the same `(tenant, project)` scope.

##### Responsibility boundaries

Does not read the repository; the caller hands it paths and text. Does not
call a detector to classify.

##### Related components (by ID)

- `cpt-studio-component-artifact-ingest` — called by, through `port::DocumentClassifier`

#### Sync analysis

- [x] `p2` - **ID**: `cpt-studio-component-documents-sync-analysis`

##### Why this component exists

A sync already reads every file and compares each binding's `content_sha`, so
it is the one place that knows for free which documents are new or changed.
Analysing those then is what makes findings exist without anybody pressing a
button; analysing only those is what makes a re-sync of an unchanged
repository cost nothing.

##### Responsibility scope

`DocumentsService::analyze_synced`: queues `spec_quality.analyze_batch` runs,
`purpose` and `leak` over the changed typed documents (then those never given
a `purpose` verdict) and `bloat` over every typed document the sync read when
there are at least two, each capped at `analyze_on_sync_max_documents`. Each
run carries a `record` block so it records its own results.

##### Responsibility boundaries

Never fails the sync, and does nothing while Spec Quality has no key or
studio-tasks has no queue.

##### Related components (by ID)

- `cpt-studio-component-tasks` — enqueues runs on
- `cpt-studio-component-spec-quality` — runs the batch handler of

#### Spec fold

- [x] `p2` - **ID**: `cpt-studio-component-documents-spec-fold`

##### Why this component exists

A reader wants one answer to "what specs do we have, and are they any good",
not two lists merged by eye.

##### Responsibility scope

`spec_rows.rs`: `/spec-rows` folds bindings, authored documents and the
ingested files (`artifact_ingest::port::ArtifactFiles`) into rows with an
`origin` (`repository` or `authored`) and the queues each row is in
(`not-scanned`, `needs-review`, `bound`, `not-documents`). Each row also
carries its review summary — `checked_at` and `findings`, folded from the
recorded `spec_finding` verdicts by the same rule as the rollup's
`open_findings` — the binding's `confidence` and the repository's
`repo_full_path`; `/spec-pipeline`
answers what a project has of each type it declares; `/specs-per-source`
counts per repository. `port::DocumentCounter` gives the portfolio rollup the
same counts.

##### Responsibility boundaries

The ingested-file list is optional: without the ingest gear the rows still
carry authored documents and bindings, and say so through `files_known`;
when the verdicts cannot be read, `reviews_known` is false and no row's review
summary means "never checked"; when the repositories cannot be read,
`repos_known` is false and an empty `repo_full_path` means unknown, not gone.
The rollup's `open_findings` is the rows' `findings` summed because a
document's `spec_finding` verdicts go with it: the sync's gone-files pass,
`reconcile` and deleting a Studio document each forget them before the
document, so a failure keeps the document for a retry. Verdicts orphaned
before that are swept by each repository sync of the project.

##### Related components (by ID)

- `cpt-studio-component-artifact-ingest` — reads files from

### 3.3 API Contracts

- [x] `p2` - **ID**: `cpt-studio-interface-documents-rest`

- **Contracts**: `cpt-studio-interface-rest-api`
- **Technology**: REST/OpenAPI through `api_gateway`
- **Location**: [`studio-backend/docs/api-contract.json`](../../studio-backend/docs/api-contract.json)

**Endpoints Overview** (prefix `/studio-documents/v1`; `{level}` is
`organizations/{organization_id}` or `workspaces/{workspace_id}`):

| Method | Path | Description | Stability |
|--------|------|-------------|-----------|
| `GET` `POST` | `/{level}/types`, `/{level}/stages`, `/{level}/capabilities` | The effective catalogue; define, replace or hide an entry at that level | unstable |
| `DELETE` | `/{level}/types/{key}`, `/{level}/stages/{key}`, `/{level}/capabilities/{key}` | Revert the level's own entry to what it inherits | unstable |
| `GET` `POST` | `/workspaces/{workspace_id}/documents`, `/workspaces/{workspace_id}/projects/{project_id}/documents` | List (a project's own plus inherited) and create from a type | unstable |
| `GET` `PUT` `DELETE` | `/workspaces/{workspace_id}/documents/{id}` | One document | unstable |
| `POST` | `/workspaces/{workspace_id}/documents/{id}/validate` | Re-run the structural check | unstable |
| `PUT` | `/workspaces/{workspace_id}/documents/{id}/analyses/{detector}`, `/workspaces/{workspace_id}/document-bindings/{id}/analyses/{detector}` | Record a detector's verdict | unstable |
| `GET` | `/workspaces/{workspace_id}/projects/{project_id}/analyses` | Every verdict for a project's documents | unstable |
| `GET` | `/workspaces/{workspace_id}/projects/{project_id}/stage-status` | Where a project stands against its stages | unstable |
| `POST` | `/workspaces/{workspace_id}/document-bindings/classify`, `/workspaces/{workspace_id}/projects/{project_id}/document-bindings/classify` | Classify the files given in the body | unstable |
| `GET` | `/workspaces/{workspace_id}/document-bindings`, `/workspaces/{workspace_id}/projects/{project_id}/document-bindings` | List bindings | unstable |
| `PUT` `DELETE` | `/workspaces/{workspace_id}/document-bindings/{id}` | Confirm, correct, reject or reset; forget | unstable |
| `GET` | `/document-bindings/{id}/text?project_id=` | A bound file's text, from the checkout | unstable |
| `POST` | `/workspaces/{workspace_id}/projects/{project_id}/quality/{detector}` | Queue a detector over named bindings, documents and inline texts | unstable |
| `GET` | `/spec-rows`, `/spec-pipeline`, `/specs-per-source` | The folded spec views | unstable |
| `GET` | `/review-criteria?type_key=&project_id=` | The semantic criteria a type is judged by, with ids a verdict can cite | unstable |
| `POST` `GET` | `/review-requests` | Ask people to review one version of a document; a project's (`?project_id=`, `&subject_id=`) or a workspace's (`?workspace_id=`) requests, `&waiting_on=me` for the caller's own queue | unstable |
| `POST` | `/review-requests/{request_id}/approvals` | A reviewer's verdict, recorded and never edited | unstable |
| `POST` | `/review-requests/{request_id}/cancel` | Withdraw a request you asked for | unstable |
| `GET` | `/review-requests/reviewer-suggestions?project_id=&subject_id=&type_key=` | Whom to ask, from who was asked before | unstable |
| `GET` | `/spec-model/requirements?project_id=` | The requirements the documents define and the basis each states ([spec-domain-model.md](../spec-domain-model.md#requirements-and-their-basis)) | unstable |
| `GET` | `/spec-model/decisions?project_id=` | Every ✓/✗ on the project's findings, the model's and Spec Quality's | unstable |
| `GET` | `/spec-model/related`, `/spec-model/trace`, `/spec-model/questions`, `/spec-model/term-drift`, `/spec-model/experts` | Requirements of other projects alike or opposite; requirement → documents, code, tests; what a document leaves out of the domain and whom to ask ([spec-domain-model.md](../spec-domain-model.md)) | unstable |
| `POST` | `/review-brief` | A brief of one document for its reviewers | unstable |
| `GET` `POST` | `/remarks`, `/remarks/replies` | Review threads on a document from its pull requests; a reply to one | unstable |
| `GET` `POST` | `/decisions` | Decisions recorded on requirements | unstable |
| `POST` | `/pull-request-checks` | Check the documents open pull requests change; set a commit status | unstable |
| `GET` `POST` `PATCH` `DELETE` | `/delivery-scopes`, `/delivery-scopes/{scope_id}`, `/delivery-scopes/{scope_id}/history`, `/delivery-scopes/{scope_id}/limits[/{limit_id}]` | Delivery scopes of a project, their limits and history (#784) | unstable |
| `GET` `PUT` | `/application-parts` | Configuration, storage and deployment parts found in the repositories, with what people recorded about each (#786) | unstable |

A quality request may carry at most 20 inline documents of 256 KiB each and
1 MiB in total (`quality.rs`).

**Reviews and approvals** (`approvals.rs`, issue #731). A review request names
one version of one document (a Studio document or a repository binding), the
people asked and which of them are required, and an optional due date. A newer
request on the same document supersedes the open one. A verdict is a row of
`studio_approvals`: inserted, never updated; the latest per reviewer counts,
and it keeps the detectors that had passed on the document when it was given.
`stage-status` folds the current request (the newest open or approved one) into
each requirement as `approvals_outstanding`: the required reviewers who have
not approved. A stage is complete only when that is empty, so a review gates a
stage once somebody asks for it, and never before. How much it gates follows
the document's `maturity`, as the structural check reads it (gears-rust
#5275): review strictness follows the level, and only a security issue blocks
at every level. A verdict asking for changes may say `security: true`. At
`stable` or `deprecated`, and when nothing is declared, the gate is the one
above, plus anybody, required or not, whose latest verdict is a security
concern. At `design`, `experimental` or `preview` the review is advice: the
request still waits for its required reviewers and still closes as `approved`
only when they approve, but the stage waits only on a security concern. An open
question closes with a spike or a follow-up change, not another review round.
A request whose latest verdicts include a security concern is not `approved`,
since an approved request takes no more verdicts and the concern could never be
lifted. Each request answers its `maturity`, read from the text it was asked
about, and `advisory` when that is below `stable`. The stage holds a review to
that maturity, or to a stricter one the document declares since
(`governing_maturity`): a level lowered mid-review does not turn a gate into
advice.

A reviewer may speak for a **stakeholder**, an organization the document
answers to (as a gear's demand names its consumers: Acronis, Constructor,
Virtuozzo). One approval answers for its stakeholder, so the other required
reviewers of the same one are no longer awaited. A request may also name the
stakeholders that must approve (`stakeholders`, migration m0027); one that
nobody of theirs approved for keeps the request from closing as `approved` and,
at `stable`, holds the stage, listed in `approvals_outstanding` by name. Each
request answers every stakeholder with who approved for it and who was asked.

A review is judged by the **rules it started with**. The request keeps its
type's review guide and a digest of that guide and the template
(`rules_snapshot`); `GET /review-criteria?review_request_id=` serves the
criteria kept, and the request says `rules_changed` when the type's rules moved
since. Asking again reviews against the new ones. Reviewer suggestions are the
reviewers of earlier requests on the document, then on its type, ranked by how
often they were asked. Each request change is announced on `studio-events` as
`review_request.created`, `.decided` or `.cancelled`
([events catalogue](../../studio-backend/docs/events-catalog.md)), which the portal's inbox reads
again. Reminders before the due date are not sent yet: an overdue request is
marked `overdue` and leads the reviewer's inbox.

A finding a member dismissed (✗) is not counted on the Specs list: `spec-rows`
passes the dismissed fingerprints to `ArtifactFiles::reviews` (issue #729).

**Review briefs** (`brief.rs`, `POST /review-brief`, issue #736). Which
requirements were added, removed or reworded since a base version (`base_ref`,
or the document before its latest commit, read through the project's
repository connection) is computed from the labelled requirements of both
versions. A model on the caller's key (ADR-0039) writes the problem, roles,
scope, assumptions and open decisions, and says for each computed change
whether it changes what is required. A claim about a change the comparison did
not find is dropped; an added or removed requirement always counts as meaning.
Nothing is stored.

**Remarks and decisions** (`remarks.rs`, issue #735). `GET /remarks` asks the
repository host, in one GraphQL query per repository, for the review threads on
a document in the pull requests its last twenty commits came from and in the
open pull requests that change it; unresolved threads of pull requests no
longer open are `left_open`: what a merge left behind. A reply
(`POST /remarks/replies`) is posted to the thread through the project's
connection. A decision (`POST /decisions`, table `studio_decisions`) records
what was decided, the requirement identifiers it closes, where it was taken
and by whom; insert only.

**For the review card and document comparisons** (`m0023`). A review request
keeps the text it was asked about (`reviewed_text`, at most 256 KiB); a request
without a `version` is about the document as it is now. Every request carries
`current_version` (a binding's content digest, a Studio document's content digest),
`stale` when the document changed since, and `recorded_checks` (the detectors
that pass on it now); the list adds `open`, `overdue` and `stale` counts.
`GET /review-requests/{id}/diff` answers the reviewed text, the text now and
`base`, the newest earlier approved request on the same document, for a
Before / Proposed diff. A domain-model finding's sides carry `binding_id`, and a
reference to something missing names it as `target`. A decision takes an
optional `note` and keeps the finding as it stood; `/spec-model/decisions`
answers `present: false` for a decided finding the documents no longer show
(resolved), with its rule, message and sides.

**Stage checks beyond documents** (issue #782). A stage may declare `checks`,
each `code`, `tests` or `review`, next to the document types it `requires`.
`stage-status` answers each per stage as `{kind, passed, detail}`: `code` passes
when a synced commit or merged pull request names one of the requirements the
project's documents label (any commit when they label none); `tests` when the
latest completed CI run on the mainline concluded `success`
(`artifact_ingest::port::DeliveryEvidence`); `review` when no open pull request
waits on a reviewer and no review request awaits a required approval.
`passed` is `null` when the deployment cannot read the evidence (no sync), and
a stage with a null or failed check is not complete. The built-in catalogue is
the journey plus the delivery stages the portal shows: `prd` requires a `prd`,
`architecture` a `design`, and `code`, `testing` and `review` carry the three
checks. Table `studio_process_stages` gains `checks` (`m0020`).

**Delivery scopes** (`delivery.rs`, issue #784). A scope is one outcome a
project promises: title, outcome, owner, target date, the requirement
identifiers it delivers (as decisions name them), the gears it pins, its
acceptance and state (`planned`, `in_progress`, `delivered`, `dropped`). A
limit is a limitation, an open question or a dependency (on another scope's id,
or a decision record); a blocking limit that is unresolved — and, for a
dependency on a scope, while that scope is not delivered — blocks the scope.
Every change keeps the version it replaced (`/history`). Tables
`studio_delivery_scopes`, `studio_delivery_limits`,
`studio_delivery_scope_history` (`m0021`).

**Application parts** (`parts.rs`, issue #786). Found in the project's
repositories by what the files are: Helm charts and values, Dockerfiles,
compose files, Kubernetes and Terraform directories, deployment workflows,
configuration files and directories, migrations and schemas. The owner,
describing document, boundary and related parts are recorded beside each,
keyed by repository, kind and reference (table `studio_application_parts`,
`m0022`); a recorded part the repositories no longer show is listed as not
present. `product.gdl` stays the Gearbox composition language.

**Checks on pull requests** (`pr_checks.rs`, `POST /pull-request-checks`,
issue #734). Every open pull request of the project's repositories that changes
a settled document is checked, on the version in the pull request, against its
type's template, and the result is set as a `studio/documents` commit status on
the head commit (`ConnectorDriver::set_commit_status`). A commit status, not a
check run, because a personal token can set one. The run is asked for by a
member; a webhook that runs it on every push is the next step.

In process the gear publishes four ports on the ClientHub (`port.rs`):
`DocumentClassifier` and `BindingNames` for the ingest gear,
`DocumentCounter` for the portfolio rollup, and `AnalysisRecorder` for a Spec
Quality run recording its own verdicts.

### 3.4 Internal Dependencies

| Dependency Gear | Interface Used | Purpose |
|-------------------|----------------|----------|
| `account_management` | SDK client | Authorize the workspace or project tenant; read the workspace's parent |
| `types_registry` | SDK client | Register the four document GTS types, best-effort |
| `cpt-studio-component-artifact-ingest` | `RepoFileReader`, `ArtifactFiles` from the ClientHub, resolved per request | A bound file's text; the ingested file list |
| `cpt-studio-component-tasks` | `TaskQueue` from the ClientHub | Queue Spec Quality batch runs |
| `cpt-studio-component-spec-quality` | `spec_quality::sdk` | Queue and read analyses |

It publishes `port::SpecNeeds` for `cpt-studio-component-spec-mapping`: a
project's workspace, the vocabulary, and what its documents need. What a
document needs is computed here when it is written or synced, with the rules of
`spec_mapping::sdk`, and stored beside it.

### 3.5 External Dependencies

#### PostgreSQL

| Dependency Gear | Interface Used | Purpose |
|-------------------|---------------|---------|
| `cpt-studio-component-documents` | `toolkit-db` (SeaORM, raw-SQL migrations) | The six tables of §3.7 |

### 3.6 Interactions & Sequences

`cpt-studio-seq-classify-documents` is the product-level view of a member
classifying a project's documents.

#### A sync classifies and analyses what changed

**ID**: `cpt-studio-seq-documents-sync-classify`

**Use cases**: `cpt-studio-usecase-classify-documents`

**Actors**: `cpt-studio-actor-member`

```mermaid
sequenceDiagram
    participant I as artifact.ingest run
    participant D as studio-documents
    participant DB as studio_documents
    participant Q as studio-tasks
    participant B as spec_quality.analyze_batch
    I->>D: classify_ingested(workspace, project, files)
    D->>DB: read bindings in scope (and purpose verdicts)
    D->>D: keep settled verdicts, classify the rest, validate
    D->>DB: upsert bindings
    D->>Q: enqueue purpose, leak (changed), bloat (all typed)
    Q->>B: run
    B->>D: AnalysisRecorder.record_detector_verdict
```

**Description**: The sync hands the text it already read; the documents gear
decides and records, and the runs it queues record their own verdicts, so a
stage gate is answered for an analysis nobody watched.

### 3.7 Database schemas & tables

- [x] `p3` - **ID**: `cpt-studio-db-documents`

Database `studio_documents`. PostgreSQL only: the migrations are raw SQL so
the `CHECK` and `UNIQUE` constraints are kept verbatim.

#### Table: studio_document_bindings

**ID**: `cpt-studio-dbtable-document-bindings`

**Schema**:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | uuid5 of tenant, project and node; re-classifying is an upsert |
| `tenant_id` | UUID | the workspace tenant |
| `project_id` | UUID | the project, or `NULL` at workspace level |
| `node_id` | TEXT | the `artifact.file` graph node of the file |
| `path` | TEXT | repository path |
| `type_key` | TEXT | the bound type, `NULL` while undetermined |
| `state` | TEXT | `detected`, `confirmed`, `manual`, `unknown` or `not_a_document` |
| `confidence` | REAL | 0.0–1.0 |
| `source` | TEXT | `front_matter`, `heuristic`, `spec_quality` or `manual` |
| `candidates` | TEXT | other types it might be, with reasons |
| `conforms` | BOOLEAN | the validation verdict |
| `validation` | TEXT | the full validation report |
| `capabilities` | TEXT | JSON list the file's front matter declares, re-derived on every classification |
| `requirements` | TEXT | JSON list of the file's non-functional statements (`m0013`) |
| `inferred_capabilities` | TEXT | JSON list of what its functional requirements imply, with the requirements behind each, when its front matter declares none (`m0014`) |
| `content_sha` | TEXT | digest, so a stale verdict is distinguishable |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**PK**: `id`

**Constraints**: `CHECK` on `state` and on `source`.

**Additional info**: Indexes on `(tenant_id, project_id)` and `(tenant_id,
state)`. The primary key is the uniqueness constraint, since a `UNIQUE` over
the nullable `project_id` would treat every `NULL` as distinct. See
[`docs/documents-from-a-repository.md`](../documents-from-a-repository.md).

**Example**:

| path | state | source |
|--------|--------|--------|
| `docs/prd/constructor-studio.md` | `detected` | `front_matter` |

#### Table: studio_document_types

**ID**: `cpt-studio-dbtable-document-types`

**Schema**:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | uuid5 of owner tenant and key |
| `tenant_id` | UUID | organization or workspace that defines it |
| `key`, `name`, `description` | TEXT | `key` is 1–80 characters |
| `gts_type_id` | TEXT | |
| `template` | TEXT | the template specification |
| `hidden` | BOOLEAN | a tombstone hiding the inherited entry of this key |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**PK**: `id`

**Constraints**: `UNIQUE (tenant_id, key)`.

**Additional info**: A row shadows the built-in or inherited entry of its key
rather than sitting beside it. `m0009` narrowed the catalogue to five types,
moving `app_spec` and `upstream_reqs` documents, bindings and stage
requirements to `prd`; `m0010` deletes the rows `m0009` re-keyed.

**Example**:

| key | name |
|--------|--------|
| `prd` | Product Requirements (PRD) |

#### Table: studio_process_stages

**ID**: `cpt-studio-dbtable-process-stages`

**Schema**:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | uuid5 of owner tenant and key |
| `tenant_id` | UUID | organization or workspace that defines it |
| `key`, `label` | TEXT | `key` is 1–80 characters |
| `required` | BOOLEAN | cannot be dropped from a project's selection |
| `ordinal` | INTEGER | position in the sequence |
| `requires` | TEXT | JSON list of document-type keys |
| `gates` | TEXT | JSON list of detectors every required document must pass |
| `hidden` | BOOLEAN | tombstone |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**PK**: `id`

**Constraints**: `UNIQUE (tenant_id, key)`.

**Additional info**: A table of its own rather than a discriminator on the
type table: the two catalogues share resolution rules, not columns.

**Example**:

| key | label | required |
|--------|--------|--------|
| `intent` | Intent | `true` |

#### Table: studio_process_capabilities

**ID**: `cpt-studio-dbtable-process-capabilities`

**Schema**:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | uuid5 of owner tenant and key |
| `tenant_id` | UUID | organization or workspace that defines it |
| `key`, `label` | TEXT | `key` is 1–80 characters |
| `terms` | TEXT | JSON list of words that make a component a candidate |
| `contracts` | TEXT | JSON list of contracts the Gearbox engine can report a gear providing (`m0012`) |
| `nonfunctional` | BOOLEAN | answered by the deployment profile, never by a gear (`m0013`) |
| `hidden` | BOOLEAN | tombstone |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**PK**: `id`

**Constraints**: `UNIQUE (tenant_id, key)`.

**Additional info**: An empty `terms` matches the key itself.

**Example**:

| key | terms |
|--------|--------|
| `auth` | `["auth","oidc","keycloak",…]` |

#### Table: studio_documents

**ID**: `cpt-studio-dbtable-documents`

**Schema**:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | |
| `tenant_id` | UUID | the workspace tenant |
| `project_id` | UUID | the project, or `NULL` at workspace level |
| `type_key`, `title`, `content` | TEXT | |
| `status` | SMALLINT | `0` draft, `1` review, `2` approved |
| `conforms` | BOOLEAN | the structural verdict |
| `validation` | TEXT | the full validation report |
| `capabilities` | TEXT | JSON list the front matter declares, re-derived on every write |
| `requirements` | TEXT | JSON list of its non-functional statements (`m0013`) |
| `inferred_capabilities` | TEXT | as for a binding (`m0014`) |
| `created_by` | TEXT | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**PK**: `id`

**Constraints**: none beyond the key.

**Additional info**: Index on `(tenant_id, project_id)`. `capabilities` is an
index over the document's own front matter, not a second place to store them,
so a hand edit cannot drift from it. `requirements` and `inferred_capabilities` are
indexes the same way, computed by `spec_mapping::sdk` on every write; they
are read through `port::SpecNeeds` by `cpt-studio-component-spec-mapping`.

**Example**:

| type_key | status |
|--------|--------|
| `prd` | `0` |

#### Table: studio_document_analyses

**ID**: `cpt-studio-dbtable-document-analyses`

**Schema**:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | |
| `tenant_id` | UUID | the workspace tenant |
| `document_id` | UUID | `studio_documents.id`, `ON DELETE CASCADE` |
| `binding_id` | UUID | `studio_document_bindings.id`, `ON DELETE CASCADE` |
| `detector` | TEXT | 1–80 characters |
| `state` | TEXT | `pending`, `passed` or `failed` |
| `task_id` | TEXT | the upstream task the verdict was read from |
| `summary` | TEXT | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**PK**: `id`

**Constraints**: `CHECK` that exactly one of `document_id` and `binding_id` is
set; `UNIQUE (document_id, detector)`; unique index on `(binding_id, detector)`
where `binding_id` is set.

**Additional info**: Index on `(tenant_id, document_id)`. The cascade is in the
schema so a verdict about a deleted document goes with it on every path that
deletes one.

**Example**:

| detector | state |
|--------|--------|
| `purpose` | `passed` |

#### Table: `studio_review_requests`

**ID**: `cpt-studio-dbtable-review-requests`

**Schema**:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | |
| `tenant_id` | UUID | the workspace tenant |
| `project_id` | UUID | |
| `subject_kind` | TEXT | `document` or `binding` |
| `subject_id` | UUID | the document or binding |
| `type_key` | TEXT | the document's type, when known |
| `title` | TEXT | what the request is shown as |
| `version` | TEXT | the version asked about: a content sha or a revision |
| `requested_by`, `requested_by_name` | TEXT | the canonical person who asked (ADR-0025) |
| `reviewers` | JSONB | `[{person, name, required}]` |
| `due_at` | TIMESTAMPTZ | optional |
| `state` | TEXT | `open`, `approved`, `superseded` or `withdrawn` |
| `created_at` | TIMESTAMPTZ | |

**PK**: `id`

**Additional info**: Index on `(tenant_id, project_id, subject_id)`.

#### Table: `studio_decisions`

**ID**: `cpt-studio-dbtable-decisions`

**Schema**:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | |
| `tenant_id` | UUID | the workspace tenant |
| `project_id` | UUID | |
| `statement` | TEXT | what was decided, 1–4000 characters |
| `requirements` | JSONB | the requirement identifiers it closes |
| `source_url`, `source_kind` | TEXT | where it was taken: `review_thread`, `meeting`, `chat` or `other` |
| `path` | TEXT | the document it is about, when one |
| `decided_by`, `decided_by_name` | TEXT | the canonical person |
| `decided_at` | TIMESTAMPTZ | |

**PK**: `id`

**Additional info**: Insert only. Index on `(tenant_id, project_id, decided_at)`.

#### Table: `studio_approvals`

**ID**: `cpt-studio-dbtable-approvals`

**Schema**:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | |
| `tenant_id` | UUID | the workspace tenant |
| `project_id`, `request_id`, `subject_id` | UUID | `request_id` references `studio_review_requests`, `ON DELETE CASCADE` |
| `version` | TEXT | the version the verdict is about |
| `approver`, `approver_name` | TEXT | the canonical person |
| `verdict` | TEXT | `approved` or `changes_requested` |
| `security` | BOOLEAN | the changes asked for are a security concern, which holds the stage at any maturity (`m0026`); `false` on an approval |
| `note` | TEXT | optional |
| `checks` | JSONB | the detectors that had passed on the document then |
| `decided_at` | TIMESTAMPTZ | |

**PK**: `id`

**Additional info**: Insert only; there is no update path. Index on
`(tenant_id, request_id)`.

### 3.8 Deployment Topology

In-process in the one `studio-backend` binary: gear `studio-documents`,
capabilities `[db, rest]`, config section `gears.studio-documents`.

## 4. Additional context

[`docs/documents-from-a-repository.md`](../documents-from-a-repository.md)
explains why a binding is kept instead of a copy of the file, and
[`docs/spec-findings.md`](../spec-findings.md) how the findings a sync records
reach the editor. [`docs/spec-domain-model.md`](../spec-domain-model.md) is the
planned domain model read from a project's documents and the disagreements
found in it.

## 5. Traceability

- **PRD**: [Constructor Studio](../prd/constructor-studio.md)
- **Design**: [Constructor Studio](constructor-studio.md)
- **ADRs**: [ADR index](../adr/README.md)
- **Code**: [`studio-backend/src/documents/`](../../studio-backend/src/documents/)
