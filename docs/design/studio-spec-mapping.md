---
type: design
status: proposed
owner: studio-team
---

# Technical Design — studio-spec-mapping

- [ ] `p1` - **ID**: `cpt-studio-design-spec-mapping`

The gear-level design of `cpt-studio-component-spec-mapping`. The product-level
view, and how this gear sits among the others, is in
[Constructor Studio's design](constructor-studio.md). The code is
[`studio-backend/src/spec_mapping/`](../../studio-backend/src/spec_mapping/).

## Table of Contents

- [1. Architecture Overview](#1-architecture-overview)
- [2. Principles & Constraints](#2-principles--constraints)
- [3. Technical Architecture](#3-technical-architecture)
- [4. Additional context](#4-additional-context)
- [5. Traceability](#5-traceability)

## 1. Architecture Overview

### 1.1 Architectural Vision

A project's specification says what the product has to do. The catalogue says
which gears exist and what the Gearbox engine knows they do. This gear is the
path between the two: it reads what the specification needs, proposes the
gears that cover each need, records what a member decides about each proposal,
and says where the product runs. Its answer is what a product is composed from
(`cpt-studio-usecase-compose-product`).

Every rule of that path lives here, and no data does. Before this gear the
rules were spread over three gears: the matching in the components catalogue,
the reading of a document in the documents gear, and the decisions in the
artifact graph's routes. A change to how a specification maps to gears had to
touch all three, and two screens asked four routes to assemble one answer.

The data stays with its owner. The documents gear indexes what each document
needs on every write and sync. The catalogue keeps the gears and the engine's
facts about them. The artifact graph keeps the decisions beside the documents
they are about. This gear reads each through the port its owner publishes on
the ClientHub.

### 1.2 Architecture Drivers

#### Functional Drivers

| Requirement | Design Response |
|-------------|------------------|
| `cpt-studio-fr-spec-gear-mapping` | `reading.rs` reads what a specification needs as it is written; `plan.rs` maps each need contract first, evidence second, gap last (`cpt-studio-principle-spec-mapping-contract-first`). |
| `cpt-studio-fr-mapping-decisions` | `POST /decisions` records a `mapping_decision` node through `artifact_ingest::port::MappingDecisionStore`; a project's plan ranks its proposals by them. |
| `cpt-studio-fr-nfr-to-profile` | `reading::declared_requirements` collects the non-functional statements; `plan::deployment_profile` turns them into a profile, and a `nonfunctional` capability is offered no gear. |
| `cpt-studio-fr-gearbox-product` | The plan is what the Components tab composes `product.gdl` from; resolving it is `cpt-studio-component-product`'s. |

### 1.3 Architecture Layers

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| REST | The plan, a project's needs, conformance, decisions | `OperationBuilder` routes in `rest.rs` |
| Rules | Reading a specification; matching, ranking, profile | `reading.rs`, `plan.rs`, pure functions |
| Ports | The data, read from the gears that own it | `SpecNeeds`, `ComponentCatalog`, `MappingDecisionStore` on the ClientHub |

## 2. Principles & Constraints

### 2.1 Design Principles

#### A specification is read as it is written

- [ ] `p1` - **ID**: `cpt-studio-principle-spec-mapping-as-written`

Nothing in the mapping asks a document to be changed. A `capabilities:` line in
the front matter is the author's statement and is used when present. Otherwise
the capabilities are inferred from the document's Functional Requirements:
- each requirement (a heading and the text up to the next one) is matched
  against the workspace vocabulary's keys and terms;
- requirement ids, comments and fenced code are not read;
- each inferred capability keeps the headings of the requirements behind it,
  so the proposal can be argued with.

A repository document the classifier proposed and nobody has confirmed counts
too, marked `confirmed: false`. On a real repository nobody has confirmed
anything yet: constructorfabric/insight on Dev had 11 PRDs, none with a
`capabilities:` line and none confirmed, and the old rule gave it nothing.
Noise from a broad term is fixed in the vocabulary or by a decision, never in
the document.

#### Contract first, evidence second, gap last

- [ ] `p1` - **ID**: `cpt-studio-principle-spec-mapping-contract-first`

A gear that *declares* a capability's contract is a different kind of answer
from a gear whose words *mention* the capability, and the mapping never mixes
the two in one ranking.
- **Contract matches** come from data the engine checks: the vocabulary's
  contracts for the capability against what the engine reports each gear
  doing for others. That is a contract it provides (`<gear>/<Trait>@v<N>`,
  from `#[toolkit::provides]`), the GTS spec of an extension point it hosts,
  or the spec of the point it implements. A vocabulary entry without a version
  takes any version, and a GTS segment matches a chain that ends with it. The
  same request gives the same answer every time.
- **Evidence matches** come from search: the vocabulary's terms in the
  catalogue's text about the gear, and, only when that finds nothing, in the
  opening of the gear's own PRD and DESIGN, which the match `cites`. Each
  quotes its passage, and all of them rank below every contract match. A
  gear's PRD and DESIGN are found by name under its `docs/`, not at one path:
  `PRD.md`, `PERMISSION_PRD.md` or `prd/overview.md` (`principal_doc` in
  the catalogue's repository scan).
- **A gap** is reported as a gap, never filled by the nearest keyword. It is
  the input of a new gear.

#### Built first within a step

- [x] `p2` - **ID**: `cpt-studio-principle-spec-mapping-built-first`

A well-written stub is mostly prose and prose is what keywords match, so within
each step candidates are sorted built first, then by what the engine can run,
then by how many terms they match, and the shortlist is cut after that sort.
Components never built are labelled rather than dropped, because a design may
name a component that is still only a design.

#### A decision ranks, and expires with what it was about

- [ ] `p1` - **ID**: `cpt-studio-principle-spec-mapping-decisions-rank`

A confirmed gear ranks first within its step and a rejected one last; neither
crosses a step. A decision records the gear version and the document revision
it was taken against. When either has moved on, it is reported as
`needs_review` and ranks as if undecided, because it no longer says anything
about now.

#### Where it runs is a profile, not a gear

- [ ] `p2` - **ID**: `cpt-studio-principle-spec-mapping-profile-not-gear`

The non-functional statements choose the deployment profile Studio's
`product.gdl` declares: `dev` (`embedded`), `local` (`self_hosted`) or `prod`
(`kubernetes`). Each statement counts toward every kind whose words it
mentions; the kind most statements point to wins, and on a tie the one the
documents mention first. No statement naming a kind is no advice, not a
default. A capability the vocabulary marks `nonfunctional` (the built-in
`deploy`) is offered no gear and is not a gap.

### 2.2 Constraints

#### The rules own no data

- [x] `p2` - **ID**: `cpt-studio-constraint-spec-mapping-no-data`

The gear has no database and writes nothing itself. A decision is stored by the
artifact graph through its port, and a document's needs are indexed by the
documents gear when the document is written or synced. A change to the
vocabulary or to the inference therefore reaches a repository document on its
next sync.

#### The same project, two tenants

- [x] `p2` - **ID**: `cpt-studio-constraint-spec-mapping-two-contexts`

The documents and the decisions are read as the caller, in the project's
workspace. The catalogue is read in the organization on screen
(`?organization_id=`, `crate::org_scope`), because the catalogue is kept per
organization. A project the caller cannot reach answers 404.

## 3. Technical Architecture

### 3.1 Domain Model

- **Need**: a capability key a project's documents need, with the documents
  that say so. Each source says whether the capability was `inferred` (with the
  requirement headings `because`) and whether the document is `confirmed`.
- **Requirement**: one non-functional statement and its document.
- **Vocabulary**: per capability key, its `terms`, its `contracts` and whether it
  is `nonfunctional`; the documents gear's catalogue, built-ins overlaid by the
  organization and the workspace.
- **Plan row**: one capability, its `sources`, its candidates, and whether it is
  a `gap`, `unbuilt` or `nonfunctional`.
- **Candidate**: a gear with the `step` that proposed it (`contract` or
  `evidence`), the `contracts` it provides or the `passage` it was found by
  (and the document it `cites`), its build state, what the engine says, its
  `version`, and an earlier `decision`.
- **Decision**: (document, section, capability, gear) → `confirmed` or
  `rejected`, with who, when, the step, the gear version and the document
  revision.
- **Profile advice**: the profile, its engine kind, and the statements behind it.

### 3.2 Component Model

```mermaid
flowchart LR
    portal[Portal] -->|/studio-spec-mapping/v1| rest
    subgraph spec-mapping[studio-spec-mapping]
        rest[rest.rs] --> plan[plan.rs]
        rest --> reading[reading.rs]
    end
    rest -->|SpecNeeds| docs[studio-documents]
    rest -->|ComponentCatalog| catalog[studio-components-catalog]
    rest -->|MappingDecisionStore| graph[studio-artifact-ingest]
    docs -.->|indexes with reading.rs| docs
```

`reading.rs` is called by the documents gear when it indexes a document, and
by nothing else: what a document needs is computed once, when its text
changes.

### 3.3 API Contracts

- [ ] `p1` - **ID**: `cpt-studio-interface-spec-mapping-rest`

- **Contracts**: `cpt-studio-interface-rest-api`
- **Technology**: REST/OpenAPI through `api_gateway`
- **Location**: [`studio-backend/docs/api-contract.json`](../../studio-backend/docs/api-contract.json)

**Endpoints Overview**:

| Method | Path | Description | Stability |
|--------|------|-------------|-----------|
| `GET` | `/plan?project_id=` | A project's plan, read on the server: needs with their documents, candidates ranked by decisions, and the profile | unstable |
| `POST` | `/plan` | The same rules for capabilities and a vocabulary sent by value (the App Spec's Compose button) | unstable |
| `GET` | `/capabilities?project_id=` | What the project's documents need, with the documents saying so | unstable |
| `GET` | `/requirements?project_id=` | The project's non-functional statements | unstable |
| `POST` | `/conformance` | For a project's capabilities, which components its code depends on, what is unaccounted for, and what the engine says | unstable |
| `POST` | `/decisions` | Confirm or reject one mapping; `201` with the decision | unstable |
| `GET` | `/decisions?project_id=` | The project's decisions, newest first | unstable |

The paths are under `/studio-spec-mapping/v1`. The plan and conformance read
the catalogue of `?organization_id=` when one is named. Every list answers
`{items, total}` and is read whole.

### 3.4 Internal Dependencies

| Port | Owner | What it answers |
|------|-------|-----------------|
| `documents::port::SpecNeeds` | `cpt-studio-component-documents` | The project's workspace after checking the caller reaches it; the workspace's vocabulary; the project's needs and requirements from the document index |
| `components_catalog::port::ComponentCatalog` | `cpt-studio-component-components-catalog` | Every component and its profile (`gdl_contracts`, `doc_text`, build state); a project's code dependencies; what the engine would change about a set of gears (the catalogue asks studio-product's engine; this call is to move to `cpt-studio-component-product`) |
| `artifact_ingest::port::MappingDecisionStore` | `cpt-studio-component-artifact-ingest` | Record a decision; list a project's decisions |

A port that is not on the ClientHub makes the routes that need it answer 503;
a project's plan without the decision store is the plan without ranking.

### 3.5 External Dependencies

None directly. What the engine says reaches this gear as catalogue facts.

### 3.6 Interactions & Sequences

#### Map a specification to gears

**ID**: `cpt-studio-seq-spec-mapping-plan`

**Use cases**: `cpt-studio-usecase-compose-product`

**Actors**: `cpt-studio-actor-member`

```mermaid
sequenceDiagram
    participant P as Portal (Components tab)
    participant M as studio-spec-mapping
    participant D as studio-documents
    participant G as studio-artifact-ingest
    participant C as studio-components-catalog
    P->>M: GET /plan?project_id=&organization_id=
    M->>D: SpecNeeds: workspace, vocabulary, needs, requirements
    M->>G: MappingDecisionStore: the project's decisions
    M->>C: ComponentCatalog: components and profiles
    M->>M: contract → evidence → gap, ranked by decisions; profile
    M-->>P: rows with sources and candidates, profile
    P->>M: POST /decisions (✓ or ✗ on a candidate)
    M->>G: record mapping_decision
```

**Description**: One read assembles everything; a decision is recorded and the
plan read again.

### 3.7 Database schemas & tables

None of its own. The index it reads is `capabilities`, `inferred_capabilities`
and `requirements` on `studio_documents` and `studio_document_bindings`
([studio-documents](studio-documents.md#37-database-schemas--tables)); the
vocabulary is `studio_process_capabilities` (`contracts`, `nonfunctional`).
Decisions are `mapping_decision` nodes with `decision_on` edges in the artifact
graph ([studio-artifact-ingest](studio-artifact-ingest.md)).

### 3.8 Deployment Topology

In-process in the one `studio-backend` binary: gear `studio-spec-mapping`,
capabilities `[rest]`, no config, no database.

## 4. Additional context

What is not done yet:
- Decisions rank proposals within the project they were recorded in. Ranking
  across an organization needs the organization on the decision node.
- `config` in `product.gdl` is not derived from the requirements; only the
  profile is.
- Requirement-driven resolution in the engine (`requires = [...]` in
  `product.gdl`) would move the choice of gear into Gearbox; it is an open
  question of the PRD.

## 5. Traceability

- **PRD**: [Constructor Studio](../prd/constructor-studio.md) — `cpt-studio-fr-spec-gear-mapping`, `cpt-studio-fr-mapping-decisions`, `cpt-studio-fr-nfr-to-profile`
- **Design**: [Constructor Studio](constructor-studio.md)
- **ADRs**: [ADR index](../adr/README.md)
- **Code**: [`studio-backend/src/spec_mapping/`](../../studio-backend/src/spec_mapping/)
