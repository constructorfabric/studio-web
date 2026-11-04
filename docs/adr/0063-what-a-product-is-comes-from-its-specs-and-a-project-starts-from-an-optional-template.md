---
type: adr
status: proposed
date: 2026-11-04
---

# ADR-0063: What a product is comes from its specs, and a project starts from an optional template

**ID**: `cpt-studio-adr-product-kind-from-specs`

Status: **proposed** · Date: 2026-11-04 · Uses `cpt-studio-adr-process-from-specs-and-domain-model` (ADR-0058) · Uses `cpt-studio-adr-project-sources-and-versions` (ADR-0060) · Uses `cpt-studio-adr-component-passports` (ADR-0061)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. What the product is, proposed after the specs are read](#1-what-the-product-is-proposed-after-the-specs-are-read)
  - [2. Project types become optional project templates](#2-project-types-become-optional-project-templates)
  - [3. Creating a project asks what it starts with](#3-creating-a-project-asks-what-it-starts-with)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

A project was created as a kind: `new_gears`, `product` or `existing` (`ProjectKind`). The kind decided what creation provisioned (a gear repository with a starter gear, a product repository with an empty `product.gdl`, nothing) and was kept as `project.config.kind`. Project types (`cf.studio.project.types.v1~`) let an organization name its own kinds, each with a "recipe", which was one of those three.

The 2026-11-04 build of Studioweb showed the kind is decided too early, by the wrong person, from too little:

- What a product is built on -- the platform's gears and a FrontX frontend, gears alone, screens over gears that already run, or its own Dockerfiles -- decides how it is built and rolled out. That is known once its specs say what is wanted, not when somebody clicks New project.
- A kind chosen at creation told the build nothing. Build, registry and deploy were wired to the gear path whatever the kind said.
- The three recipes mixed two questions: where the project's code lives, and what the product is.

## Considered Options

1. Keep the kinds, and add more of them.
2. Drop the kind, and let the build infer everything from the sources.
3. Propose the kind once the specs are read, with its reasons, and have a member confirm it. A template fills in only what a project starts with.

Option 3 is chosen. Option 1 keeps the decision at the wrong time. Option 2 leaves nobody accountable for what the product is, and gives nothing to show before there is code.

## Decision Outcome

### 1. What the product is, proposed after the specs are read

A product is one of four kinds:

- **Full product on gears**: gears for the backend and a FrontX shell with micro-frontends. Gearbox assembles it from `product.gdl`, and Studio builds and deploys it.
- **Gear service**: gears and their APIs, no screens.
- **FrontX app**: screens in a FrontX shell over gears the platform or the organization already runs.
- **Built from its own source**: its own services and Dockerfiles or CI, not composed from gears.

Studio proposes one, with the reasons it read:

- the project's brief;
- the capabilities and the non-functional requirements its documents declare;
- the components its own repositories hold, by passport (`gear.gdl`, `frontx.gdl`, `service.gdl`, ADR-0061);
- the product record: gears picked, a frontend.

A member confirms the proposal or picks another. The choice is kept in the project's configuration as `product_kind: { kind, proposed, confirmed_by, confirmed_at }`. Keeping `proposed` shows a decision taken against the reading.

The Product page opens on this step, and the project's path on Overview shows it after the findings. No backend route proposes a kind yet, so the portal reads the proposal itself, by word matches and counts, and marks the step experimental. A server-side proposal, and build, registry and deploy modelled per kind, come later.

### 2. Project types become optional project templates

A template no longer has a recipe and does not say what the product is. It is optional and fills in the New project card:

- the sources it starts with: a new repository, one attached, or none yet;
- whether a starter gear is written there;
- a brief;
- the kits ticked;
- the tabs its projects show, and the one they open on.

The metadata type stays `cf.studio.project.types.v1~`, so what was saved still reads. A stored type with a recipe is read as the sources that recipe created:

- `new_gears`: a new repository with a starter gear;
- `product`: a new repository;
- `existing`: a repository attached.

A list that names no template offers none. Nothing set anywhere offers the built-in three, whose keys are the old kinds', so a project created as one still finds its tabs.

### 3. Creating a project asks what it starts with

The card's pages are:

1. **Project**: a name, and a template or none.
2. **Sources**: no repository yet, a new one, or an existing one, and optionally a starter gear in it.
3. **Brief**.
4. **Components**: the kits.

Creation writes:

- no `kind` and no empty `product.gdl`;
- the template's key as `config.type`, when one was picked;
- the brief as the PRD's first answer, for any project without a starter gear (a starter gear writes its own PRD).

A repository created or attached becomes a source. A starter gear's source is marked `gears_here` (ADR-0060). Writing the sources, here or on the Sources tab, asks for a project catalogue sync (`POST /project-catalogue/sync`, ADR-0061 §6), so the components in them are found without waiting for the hourly walk.

## Consequences

- A project created after this has no `kind`. The rollups' `project_kind` is empty for it, and its row reads "Project".
- A project created before keeps its `kind` and its template key. Neither decides anything now beyond its tabs.
- The Product page's Save writes a project's first `product.gdl` revision. Creation no longer writes an empty one.
- The four kinds do not change the build yet: Build, registry and deploy still take the gear path.

## More Information

- ADR-0058: stages are a computed status, and the capability vocabulary comes from gears. The kind is read from the same specs.
- ADR-0060: one list of sources. A template fills in the first one.
- ADR-0061: passports in the project's own repositories are among what the proposal reads.

## Traceability

- `studio-frontend-prototype/src/product-kind.ts`: `PRODUCT_KINDS`, `proposeKind`, `kindStatus`, `readKindChoice`, `withKind`. `product-kind-view.tsx`: `ProductKindStep`, `readKindFacts`.
- `studio-frontend-prototype/src/project-path.ts`: the `kind` step. `project-path-view.tsx`: `readPathFacts`.
- `studio-frontend-prototype/src/project-types.ts`: `ProjectTemplate`, `BUILTIN_TEMPLATES`, `parseTemplates`, `templateDefaults`, `templateOfProject`. `project-types-editor.tsx`: the Project templates tab.
- `studio-frontend-prototype/src/project-form.ts`: `RepoRoad`, `createFormLayout`, `createSteps`, `repoBlocker`, `createMode`.
- `studio-frontend-prototype/src/App.tsx`: `WorkspaceProjects` (the New project card) and `saveSources`.
