---
type: adr
status: superseded
date: 2026-08-07
superseded_by: cpt-studiofrontend-adr-projects-as-am-tenants
---

# ADR-0005: Projects — a domain gear (supersedes the v0.1 decision in ADR-0002)

**ID**: `cpt-studio-adr-projects-domain-gear`

Status: **superseded** by [ADR-0010](0010-projects-are-am-tenants.md) · Date: 2026-08-07 · Supersedes: ADR-0002 (Decision, v0.1)

**Superseded on 2026-08-23.** The `studio-project` gear this record decides was
retired: a project is an AM tenant, and the portal mirrors the gear's rules
(ADR-0010).

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

ADR-0002 put Projects on Resource Group groups, with the whole layer as data and
no Rust, and laid out a graduation path: **Step 2** move to
`simple-resource-registry` when it ships, **Step 3** a dedicated gear "only if
logic outgrows CRUD".

Two things have changed since.

**Step 2 is not available.** `gears/simple-resource-registry` in the pinned
gears-rust revision still contains only `docs/` (PRD, DESIGN, ADR) and an empty
`plugins/` — no crate, no code. There is nothing to migrate to.

**The logic outgrew CRUD.** A project is now created through a two-option flow:
either it starts from a description ("Build Something New") or from an existing
codebase ("Modernize Legacy Code"), and it carries a selection of journey stages
(Intent, BRD, PRD, PRD-Spec, Architecture, UI Design, User Stories, Testing) of
which Intent is mandatory. Those are two different shapes, not one shape with a
flag: a greenfield project has nothing to import, and a modernization must have
exactly one source.

We also re-examined whether RG could carry this after all, because ADR-0002
undersold it. RG types accept a `metadata_schema` (a JSON Schema), and
`group_service.rs` really does validate group metadata against it on both create
and update — so the "validated payload" that ADR-0002 attributed to Step 2 is
already available at Step 1. A JSON Schema can express the two shapes (`oneOf`)
and the mandatory stage (`contains`/`const`).

What it cannot express is the rest:

- **A project name must be unique inside its workspace.** There is no unique
  index over group metadata.
- **The status ladder only moves forward** (`draft → active → archived`, and
  archived is terminal). JSON Schema validates a document, not a transition.
- **Lifecycle events.** RG emits none, and project transitions are the obvious
  trigger for the agent pipeline.

ADR-0002 also named its own trigger for graduating: RG scopes a group to the
*caller's* tenant, so with dev static tokens projects landed in the root tenant
and the workspace binding was metadata-only. Real OIDC login now exists, which
the ADR names as the fix — so that particular limitation is no longer the
blocker it was, and it is not the reason for this decision.

## Considered Options

**Extend the RG type with a `metadata_schema` and stay at Step 1.** Cheapest by
far — one script change, no new database, no new Rust — and it would have covered
the two shapes and the mandatory stage. Rejected for the three things above
(name uniqueness, transition rules, events), each of which would otherwise have
to be enforced client-side, which is to say not enforced.

**Wait for `simple-resource-registry`.** No code exists and no date does either.

**Put the payload in `cf.studio.workspace.settings.v1~` tenant metadata.**
Rejected: AM metadata is one row per tenant with whole-row inheritance, so a
list of projects would fight the inheritance policy the connector catalogue
already relies on.

## Decision Outcome

A Project is a record in a new in-crate gear, **`studio-project`**.

- Own database (`studio_projects`), one table, with the shape invariant as a
  `CHECK` constraint and `(tenant_id, name)` unique.
- Domain types make the invalid states unrepresentable rather than merely
  rejected: `ProjectSource` is a sum type with one variant per mode, so there is
  no way to construct a greenfield project carrying a repository.
- REST at `/studio-project/v1`, including `GET /stages` so the UI renders the
  same catalogue the gear validates against.
- Status transitions are checked in the service; a repeated transition is a
  no-op rather than a conflict, so a retried `PATCH` is safe.

**Membership stays on Resource Group.** ADR-0002 explicitly permits this
("Project membership can stay on RG"), and RG already carries memberships,
closure tables and their authorization. Each project gets an RG group of type
`gts.cf.core.rg.type.v1~cf.studio.project.v1~` and records its id. The gear
registers that RG type at `start`, which retires the manual
`demo/setup-projects.sh`.

**Uploaded codebases stay in file-storage.** The portal uploads over REST and
hands us a file id; only the reference is stored — the same split as connector
tokens, where credstore holds the value and the connection row holds the
reference. This is also forced: `FileStorageClientV1` is still a stub with a
single `module_name()` method, so there is no in-process path to storage. When
the P1 operations land upstream, nothing here changes.

### Consequences

- A project lives in two places (our table, RG's group). The link is
  `rg_group_id`, and it is nullable on purpose: if RG is unreachable at creation
  the project is still created, the DTO reports `members_available: false`, and
  the group can be attached later. The alternative — failing project creation
  because the members half is down — is worse.
- The two writes are not atomic and cannot be: there is no transaction spanning
  our database and RG. Ordering is chosen so the recoverable state is the one
  that happens: project-without-group is fixable, group-without-project is
  invisible junk.
- `demo/setup-projects.sh` becomes redundant. Kept for now so an operator can
  still register the type by hand against an older backend.
- Projects already created as RG groups are not migrated. They remain readable
  through RG; the new API does not see them. A migration is a follow-up, and
  cheap, since the payload is a superset of what the groups carry.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-component-account-management`
* `cpt-studio-fr-workspace-project-tenants`
