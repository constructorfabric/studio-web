---
type: feature
status: draft
owner: studio-team
---

# Feature: The project's specs


- [ ] `p1` - **ID**: `cpt-studiofrontend-featstatus-project-specs`

- [ ] `p1` - `cpt-studio-feature-project-specs`

## Table of Contents

<!-- toc -->

- [1. Feature Context](#1-feature-context)
  - [1.1 Overview](#11-overview)
  - [1.2 Purpose](#12-purpose)
  - [1.3 Actors](#13-actors)
  - [1.4 References](#14-references)
- [2. Actor Flows (CDSL)](#2-actor-flows-cdsl)
  - [Open a repository's specs from Sources](#open-a-repositorys-specs-from-sources)
- [3. Processes / Business Logic (CDSL)](#3-processes--business-logic-cdsl)
- [4. States (CDSL)](#4-states-cdsl)
- [5. Definitions of Done](#5-definitions-of-done)
  - [Specs is a section of the project, after Artifacts](#specs-is-a-section-of-the-project-after-artifacts)
  - [The list's filter belongs to the project, not to the section](#the-lists-filter-belongs-to-the-project-not-to-the-section)
- [6. Acceptance Criteria](#6-acceptance-criteria)

<!-- /toc -->

## 1. Feature Context

### 1.1 Overview

The Specs section of a project. It lists every document the project holds: the
files its repositories bring in and the Studio documents, written or uploaded,
whose Source reads Uploaded to project: the backend keeps no origin for a
document, so it cannot tell the two apart, and the workspace's documents the
project also lists read the same (#693). Each row
shows its type and review state. The section offers the actions the API has for
them: confirm or change a type, check with Spec Quality, upload documents.

This spec starts with the part that the Sources section depends on: the section
itself, and the list's filter as state another section can set. The rows, the
filters' meaning, the table and the actions are added with #689–#694.

### 1.2 Purpose

The project had a Findings section that said no endpoint served it yet. The
design has Specs in its place, and the data behind the list exists:
`spec-rows`, the document types, the binding decisions and the Spec Quality
runs. Findings goes. The review queue it stood for is out of #643's scope.

**Assumptions fixed here**, because the design is silent and each changes the
code:

- The filter is **a slice, not the section's own state**, because a second
  section writes it: Sources opens the list searched by one repository's path (#686).
- Opening a repository's specs **searches by its `full_path`**, not by its name.
  A name like `web` also matches the paths of other repositories' files, and two
  organizations can each have a repository by that name. A repository whose path
  begins with another's path still matches both. The search box shows what was
  searched, so the reader can see why.
- The filter **belongs to the open project**. Opening another project, or
  leaving the project, resets it. Moving between sections of the same project
  keeps it.

**Requirements**: `cpt-studio-fr-documents`, `cpt-studio-fr-repository-documents`, `cpt-studio-fr-spec-quality`

**Principles**: `cpt-studio-principle-prove-before-show`

### 1.3 Actors

Actor ids are defined in the [PRD](../prd/constructor-studio.md); a gear taking part is cited by its design component id.

| Actor | Role in Feature |
|-------|-----------------|
| **Member** (`cpt-studio-actor-member`) | A signed-in member of the project's organization. Reads the list and narrows it. |
| **Shell** (`cpt-studio-actor-shell`) | Draws the project's tabs and relays the chosen section to the projects MFE. |
| **MFE** (`cpt-studio-actor-mfe`) | projects-mfe. Holds the filter, draws the section, and asks the shell for it when another section opens it. |

### 1.4 References

- **PRD**: [PRD](../prd/constructor-studio.md)
- **Design**: [DESIGN](../design/constructor-studio.md), component `cpt-studio-component-projects-mfe`
- **Decomposition**: [DECOMPOSITION](../decomposition/constructor-studio.md), entry `cpt-studio-feature-project-specs`
- **Feature**: [Project artifacts](project-artifacts.md): the section before this one, and the import that brings the files in
- **Feature**: [Levels in the shell](shell-levels.md): the project's tabs
- **Issues**: #643 (the Specs and Sources sections), #683 (this part), #689–#694 (the list and its actions), #650 (`spec-rows` review fields)

## 2. Actor Flows (CDSL)

Unchecked on purpose, for the reason stated in `project-create.md`: a checked
flow obliges every instruction to carry a code marker, and this one spans two
sections and the shell.

**Use case**: review a project's specs.

### Open a repository's specs from Sources

- [ ] `p1` - **ID**: `cpt-studiofrontend-flow-project-specs-from-source`

**Actor**: Member

**Success Scenarios**:
- The member opens a repository's specs from its Sources row. Specs shows the documents matching the repository's path with a confirmed type, and the search box reads that path.

**Steps**:
1. [ ] - `p1` - Member asks for a repository's specs on its Sources row - `inst-1`
2. [ ] - `p1` - Set the search to the repository's `full_path`, *Filter specs* to *Type confirmed*, and clear the document type, so a type chosen earlier hides none of the repository's documents - `inst-2`
3. [ ] - `p1` - Ask the shell for the Specs section - `inst-3`
4. [ ] - `p1` - **RETURN** the Specs section, filtered to the repository - `inst-4`

## 3. Processes / Business Logic (CDSL)

None yet. The rows and what each filter keeps are added with #689.

## 4. States (CDSL)

None yet. The list's states are added with #692.

## 5. Definitions of Done

### Specs is a section of the project, after Artifacts

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-specs-section`

The system **MUST** register Specs as a project-level section of projects-mfe,
right after Artifacts, on the entry the other project sections share, with its
own section token. The section **MUST** load its strings from a namespace of its
own, `screen.projects.specs`.

Its own namespace, so the Specs list and the Sources section never edit the same
locale files. Specs takes the place of Findings.

**Implements**:
- `cpt-studiofrontend-flow-project-specs-from-source`

**Touches**:
- Entities: `mfe.json` (projects-mfe), `navSlice`, `ProjectScreen`, `SpecsSection`

### The list's filter belongs to the project, not to the section

- [x] `p1` - **ID**: `cpt-studiofrontend-dod-project-specs-filter-state`

The system **MUST** keep the Specs list's search, its *Filter specs* value and
its document type in a slice of the projects MFE. Another section **MUST** be
able to set all three at once for one repository. The system **MUST** reset them
when another project opens or the project closes.

A slice because two sections write it. Reset on a project change because a
repository's path means nothing in another project.

*Filter specs* takes one of: all specs, with findings, check needed, type not
set, type to confirm, type confirmed, not specifications. What each keeps is the
rows algorithm's (#689).

**Implements**:
- `cpt-studiofrontend-flow-project-specs-from-source`

**Touches**:
- Entities: `specsFilterSlice`, `model/specsFilter`, `navSlice`

## 6. Acceptance Criteria

- [ ] The project's tabs read Overview, Artifacts, Specs, Sources, Activity, Timeline, Team and Settings; Findings is not among them.
- [ ] Opening Specs shows its title and a note that the list is being built, in English and in Russian.
- [ ] Opening a repository's specs from Sources shows Specs with the repository's path in the search, *Type confirmed* chosen and no document type chosen.
- [ ] After opening another project, Specs shows no search and every document.
