# ADR-0010: A project is an AM tenant — the client mirrors the retired gear's rules

Status: accepted · 2026-08-23 · Retires ADR-0005 for every client

**ID**: `cpt-studiofrontend-adr-projects-as-am-tenants`

## Context

ADR-0005 (`studio-backend/docs/adr/`) is still marked **accepted** and describes
projects as a dedicated in-crate gear `studio-project`: its own database
`studio_projects`, a `CHECK` constraint for the shape invariant, a unique
`(tenant_id, name)`, REST at `/studio-project/v1`, and `GET /stages` so the UI
renders the same catalogue the gear validates against.

None of that exists any more. `studio-backend/src/` has no `project/` module,
the gear is absent from `registered_gears.rs`, and the only trace left in code
is a comment:

```rust
// studio_authz_plugin.rs:378
// studio-project (the portal's "Work") has been retired — projects are now
// AM tenants and their access is governed by tenant membership, not by a
// Studio privilege grant.
```

The retirement was never recorded as a decision, so the newest accepted ADR
describes an API no client can call. Two clients have already been written
against the real model by reading the code instead
(`studio-frontend-prototype/src/api.ts` and `projects-mfe`), each rediscovering
the same rules independently.

## Decision

The frontend treats a project as an **account-management tenant**. Concretely:

- **Type** `gts.cf.core.am.tenant_type.v1~cf.studio.tenant.project.v1~`, child of
  a **workspace** tenant. Hierarchy: Platform → Organization → Workspace → Project.
- **Attributes** (`mode`, `stages[]`, `status`, `brief` / `sources[]` / `source_git_url`) live in
  tenant metadata `gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~`
  — free-form, `override_only`.
- **Creation** is `POST /cf/account-management/v1/tenants` followed by
  `PUT /tenants/{id}/metadata/{type}`. Two writes, not one, and not atomic.
- **The gear's server-side rules are now client-side data** and every client
  must mirror them by hand:
  - the journey-stage catalogue (`intent` mandatory, canonical order:
    `intent, brd, prd, prd_spec, architecture, ui_design, user_stories, testing`)
    — was `GET /studio-project/v1/stages`, now `JOURNEY_STAGES` in
    `projects-mfe/src/model/project.ts` and in the prototype;
  - the forward-only status ladder `draft → active → archived` with `archived`
    terminal — was checked in the gear's service layer, and is currently
    mirrored **only in the prototype**. `projects-mfe` reads status
    (`projectStatus`, `statusTone`) but never writes it, so the ladder arrives
    with the first write path;
  - the shape invariant (greenfield carries a brief and no source; modernize
    carries at least one source) — was a `CHECK` constraint. **Amended
    2026-08-24:** the gear's rule was *exactly* one. With the constraint gone
    the count is a product choice, and the New project wizard now takes one or
    more, capped at 100 — see the `many-sources` DoD in
    `studio-frontend/docs/sdlc/FEATURE/project-create.md`. The wire shape gained
    `sources[]` (`{connection_id, full_path, clone_url}`); `source_git_url` is
    still written when exactly one repository is picked, since the prototype and
    the project list read it;
  - name uniqueness inside the workspace — was a unique index.

The canonical wire vocabulary is `projects-mfe/src/api/types.ts`
(`TENANT_TYPES`, `PROJECT_CONFIG_TYPE`).

## Consequences

- **Four invariants moved from the database to the client, which means they are
  advisory.** A second client, a curl, or a retried request can write a project
  with a duplicate name, a backwards status transition, or a greenfield project
  carrying a repository. AM validates nothing: the metadata type is free-form.
- **Name collisions are a race, not an error.** The client can only check by
  listing siblings first, and `/tenants/{id}/children` is cursor-paginated and
  clamped to 200 rows — so the check is both non-atomic and incomplete on a
  large workspace.
- **Creation is two requests.** A tenant whose metadata write failed is a
  project with no attributes; the UI has to render it rather than pretend it
  does not exist. Ordering is chosen so that this is the recoverable state.
- **No lifecycle events.** The gear was going to emit them as the trigger for
  the agent pipeline; nothing does now.
- **The rules are duplicated in two codebases** (prototype and `projects-mfe`)
  and will drift. Consolidating them is a follow-up, not part of this decision.
- **Positive:** no gear to build, no second database, and project access falls
  out of tenant membership — `studio_authz_plugin::privilege_for` returns `None`
  and every request is handled by the caller's tenant-scoping branch.

## Confirmation

- `grep -rn "studio-project" studio-backend/src` returns only the retirement
  comment.
- `projects-mfe/src/api/types.ts` is the single place naming the two GTS ids;
  no other client-side literal repeats them.
- The stage catalogue has unit tests asserting the canonical order and that
  `intent` is the only required stage (`model/project.test.ts`, `orderedStages`).
- Any code path that writes `status` must be covered by a test asserting the
  forward-only transition. No such path exists yet.

## Notes

- **Local stacks:** the project tenant type and its metadata type are registered
  in `studio-backend/config/docker.yaml` only. `oidc.yaml` (line 452) carries a
  comment and no entity; `dev.yaml`, `k8s.yaml` and `postgres.yaml` have
  neither. AM runs a GTS tenant-type check, so creating a project tenant is
  refused on those profiles until the two blocks are copied over.
- ADR-0005 should have its status line changed to
  `superseded by ADR-0010`. That file is backend-owned; this ADR does not edit it.
- `studio_projects` is still created by `docker/initdb/01-create-databases.sql`
  as a leftover of the retired gear.
