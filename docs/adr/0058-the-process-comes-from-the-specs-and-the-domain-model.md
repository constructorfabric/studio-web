---
type: adr
status: proposed
date: 2026-11-04
---

# ADR-0058: The process comes from the specs and the domain model, not a hand-edited catalogue

**ID**: `cpt-studio-adr-process-from-specs-and-domain-model`

Status: **proposed** · Date: 2026-11-04 · Supersedes `cpt-studio-adr-document-types-are-components` (ADR-0014) §7 and the hand-edited part of §5

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. The workspace Process catalogue is retired from the UI](#1-the-workspace-process-catalogue-is-retired-from-the-ui)
  - [2. Stages are a computed status of what a project has](#2-stages-are-a-computed-status-of-what-a-project-has)
  - [3. The capability vocabulary is derived from what gears declare](#3-the-capability-vocabulary-is-derived-from-what-gears-declare)
  - [4. The server keeps the endpoints and the tables](#4-the-server-keeps-the-endpoints-and-the-tables)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

ADR-0014 §5 and §7 made two lists catalogue data that an organization or a workspace could edit:

- **Journey stages.** The built-ins are `builtin_stages` in `studio-backend/src/documents/model.rs`. Overrides are rows of `studio_process_stages`, resolved by `resolve_stages`.
- **The capability vocabulary.** The built-ins are `builtin_capabilities` in the same file. Overrides are rows of `studio_process_capabilities`.

Workspace › Process (`process-catalog.tsx`) was the one screen that wrote either list. What the two lists turned out to be used for:

- **Stages** are read only by the documents module: `stage_status` and the project stage-status route. Nothing in product, build or deploy reads them. On the portal they are display only, as the chips on a project's Overview and the journey panel on Specs. A project's `config.stages` gated nothing; it only filtered those chips.
- **Capabilities** are read by the questionnaire, `inferred_for`, the spec-mapping plan, the conformance check and the registry's suggestions. They match by lexical `terms`. The project's domain model (GTS `owned_node` types in Graph Storage) takes no part in the matching.

So a person was asked to maintain, by hand and per workspace, a vocabulary that Studio already has better sources for: the specs a project writes, the domain model it keeps, and what its gears declare. Nobody kept the catalogue, and an edited one would only drift from those sources.

## Considered Options

1. **Keep the Process screen.** It costs a screen, two override tables to reason about, and a vocabulary that drifts from the gears and the domain model.
2. **Retire the screen, and derive the process from the specs, the domain model and the gears.** The built-in lists answer until the derivation exists.
3. **Retire the screen and drop the tables now.** Overrides already saved would stop resolving, and nothing is gained by dropping them before the derivation replaces them.

## Decision Outcome

Chosen option: **2.**

### 1. The workspace Process catalogue is retired from the UI

- Workspace › Process is removed: the section, its screen and the client calls only it made (`upsertStage`, `deleteStage`, `upsertCapability`, `deleteCapability`).
- An old address to it (`/workspaces/{ws}/process`) opens the workspace's default section.
- This supersedes ADR-0014 §7, which moved the stage catalogue to the server so that an organization could configure it, and the hand-edited part of §5: stages and capabilities are no longer entries a workspace overrides.

### 2. Stages are a computed status of what a project has

- A stage is a question Studio answers from the project's documents and repositories, not a step someone sets up.
- The Overview chips and the Specs journey panel read the server's built-in stages and `stage_status`, unchanged. They show every stage.
- A project does not pick its stages. New project no longer writes `config.stages`, and a list an older project carries is ignored.

### 3. The capability vocabulary is derived from what gears declare

- **The target.** The vocabulary is derived from what gears declare: the capabilities in `gear.toml` and `gear.gdl`, their contracts, and the registry. Its terms come from the gears' descriptions and from the project's domain model, the GTS `owned_node` types in Graph Storage (ADR-0024).
- Specs coverage matching then uses the domain model's entities as well as the terms, so a requirement that names an entity of the model finds the gear that owns it.
- ADR-0014's follow-ups 6 (semantic matching) and 7 (the platform catalogues become published data), and the `rel.realizes` edge of its §5, are how this is carried.
- **Until then** the built-in vocabulary in code is the platform's. It is not editable per workspace.

### 4. The server keeps the endpoints and the tables

The stage and capability routes, `studio_process_stages` and `studio_process_capabilities` stay, so overrides already saved keep resolving and nothing that exists breaks. A comment at the upsert handlers says that no Studio screen writes them any more.

## Consequences

- One screen and one set of hand-kept lists fewer. The process a project sees is the same in every workspace until it is derived.
- A workspace that saved overrides keeps them, but nothing in the portal shows or changes them. They go when the derivation replaces the lists, or when the tables are dropped by a later record.
- Every project's Overview shows all stages, including projects created with a `stages` list.
- ADR-0056 §6 layer 1 (Specs above the screens) builds on capabilities and stays valid: it reads the same vocabulary, now built in and later derived.

## More Information

- ADR-0014: a document type is a component. Its §7 and the hand-edited part of §5 are superseded; the rest stands, the document-type catalogue included.
- ADR-0024: the Studio domain model lives in Graph Storage and the type registry. It is the domain-model source §3 names.
- ADR-0056: places, environments and releases. Its product map draws the capabilities the specs declare.

## Traceability

- `studio-frontend-prototype/src/App.tsx`: `WORKSPACE_TABS` has no Process section; the New project config step writes no `stages`.
- `studio-frontend-prototype/src/place-url.ts`: `RETIRED_WORKSPACE_TABS` opens `/process` on the default section.
- `studio-frontend-prototype/src/project-overview.tsx`: the stage chips show the whole catalogue.
- `studio-frontend-prototype/src/api.ts`: no stage or capability writes; `stages()` and `capabilities()` stay.
- `studio-backend/src/documents/rest.rs`: `upsert_stage_at` and `upsert_capability_at` carry the note of §4.
