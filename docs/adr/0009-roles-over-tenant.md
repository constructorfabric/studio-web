# ADR-0009: Role-based access is layered over the tenant model

Status: accepted · 2026-08-19

## Context

ADR-0004 parked the Studio PDP (P3): an org picks an access `model` — `tenant`
or `roles` — stored as AM tenant metadata (`cf.studio.access.config.v1`), and
`studio-authz-plugin` enforces it. The first `roles` implementation treated the
two models as an either/or: for a mapped Studio resource it took a pure
role-based branch and returned a constraint of `OWNER_TENANT_ID IN [scopes]`,
**replacing** the tenant clamp rather than composing with it.

That replacement had two problems:

- a `project`-scoped grant pushed the raw `scope_id` as an `OWNER_TENANT_ID`
  with no check that it belongs to the caller's tenant — in principle a grant
  could name a scope outside the tenant and the constraint would honour it,
  crossing tenant isolation;
- an `org`-scoped grant lost the `InTenantSubtree` branches the tenant clamp
  adds, so role-based orgs silently stopped respecting the tenant hierarchy.

The tenant model is the platform's isolation invariant. Access control should
build on it, not swap it out.

## Decision

**Roles sit on top of the tenant model; they never replace it.** In the
`studio-authz-plugin` role path the tenant clamp is the invariant outer
boundary, and every allow the role path emits is AND-ed with tenant isolation.
A grant can therefore only ever *narrow* access within the caller's tenant
subtree — it can never widen it or reach across tenants.

Concretely, for a mapped Studio resource under `model = "roles"`:

1. Map `(resource_type, action)` to a privilege; match the subject's grants
   (member today, teams in step 4) whose role carries that privilege.
2. An **org-scoped** matching grant ⇒ the full tenant clamp (owner-tenant `tid`
   plus the hierarchy subtree) — the whole tenant, exactly the tenant model.
3. Otherwise, **project-scoped** grants ⇒ start from the tenant clamp and AND
   the granted scope ids into every branch of it. Because the clamp already
   bounds owner-tenant to `tid` and its subtree, intersecting with the scope
   ids keeps only those inside the tenant; a scope id outside the subtree drops
   out at evaluation.
4. **No matching grant ⇒ deny.** Roles narrow: being a member of the tenant
   does not by itself confer access to a mapped Work resource.

Unchanged and deliberately preserved: only explicitly mapped Studio resources
are role-gated; every other resource (AM tenants/metadata, RG, unmapped Studio
types) and every first-party / `*`-scoped caller takes the tenant clamp, so
selecting this PDP never breaks platform operations. The org-config surface
stays a single choice (`tenant` vs `roles`); the layering is about how `roles`
is *enforced*, not a third model.

## Consequences

- Tenant isolation holds unconditionally under `roles`; a mis-entered grant can
  under-grant (deny) but never leak across tenants — the fail-safe direction.
- A role-based org that gives a member no matching grant returns `deny` on the
  mapped Work actions (list included → 403, not an empty list). That is the
  intended "roles narrow" semantics, not a regression from the tenant model.
- Project-scoped narrowing currently intersects on `OWNER_TENANT_ID`, which is
  correct when a Project maps to a child (workspace) tenant in the subtree. Step
  4 refines this to key off the real Studio project GTS resource ids and to
  resolve Team (RG group) grants; both are called out as TODOs in the plugin.
- `tenant_clamp` was refactored to expose `tenant_constraints() -> Vec<Constraint>`
  so the role path can fold narrowing predicates into each OR-branch of the
  clamp; `tenant_clamp` now wraps it. No behavioural change for the tenant model.
