---
type: adr
status: proposed
date: 2026-10-08
---

# ADR-0040: One owner for people and membership

**ID**: `cpt-studio-adr-one-owner-for-people-and-membership`

Status: **proposed** · Date: 2026-10-08 · Settles ADR-0023 follow-up 2 and ADR-0025 follow-up 3 (grants keyed by the person) · Narrows ADR-0016 (the IdP attributes are a projection) · Corrects `PRODUCT.md` ("Editor = Resource Group membership")

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

An architecture review counted six or seven places that hold a fact about a
person, their membership or their rights, and two past bugs that came from the
spread: one human with two ids — the canonical person (`GET /studio-user/v1/me`)
and the token subject (`ctx.subject_id()`) — so a grant written under one never
matched a question asked under the other; and
`PUT /studio-user/v1/users/{id}/memberships/{org}` taking the person id while
the owner grant that the same call writes was keyed by a login.

Before deciding anything, the map of what the code actually does on `main`
(2026-10-08). "Reads" means "decides or displays from it".

### The map

| Fact | Where it is stored | Who writes it | Who reads it |
|---|---|---|---|
| **Person** (profile, role-free) | `identity_user`, studio-user | studio-user only: `/me` and `PersonResolver::resolve_caller` (JIT), `record_assignment`, `record_creation`, `/resolve`, the platform-admin and service-account seeds, merge | every gear through studio-user's ClientHub interfaces |
| **Login** (`provider, subject → person`) | `identity_login`, studio-user | studio-user only | studio-user; every other gear through `PersonResolver` and `OrganizationReader::subjects_of` |
| **Membership** (`person, org → role, status, source`) | `identity_membership`, studio-user | studio-user only — its REST routes, invitation acceptance, the first-login join, the platform-admin seed, merge, and two interfaces other gears call: `AssignmentRecorder` (directory `assign` and its backfill; organizations `create`) and `MembershipEvictor` (organizations `delete`) | the PDP's tenant clamp and platform-admin test (`OrganizationReader`), the directory's listing (`memberships_of_subject`), organization rollups and reports (`OrganizationRoster`), artifact ingest (`MemberAliases`), the portals (`/me/memberships`, `/organizations/{id}/members`, `/me/colleagues`) |
| **Owner grant** — `{member, subjectId, owner, org}` in the access config (AM tenant metadata) | account-management | **three writers**: studio-user `sync_owner_grant` (membership PUT/DELETE, leaving), organizations `create` (`access_config::set_owner_grant` directly) and the directory's `assign` (the same, directly); plus the prototype's Access screen ("grant myself owner") | studio-user `may_administer`, organizations `may_delete` (reads the document itself), the PDP (its own parse), rollups (`team_of`) |
| **Role grants** (admin/editor/viewer, org- or project-scoped) | the same document | the prototype's Access and Team screens, through account-management's metadata route | the PDP, studio-user `may_administer`, rollups |
| **Grant subject key** | `subjectId` in each grant | a Keycloak subject everywhere: the backend writers use the token subject; the prototype picks it from account-management's `/tenants/{id}/users` (AM user id = Keycloak subject) and `me.subject_id` | matched against `subjects_of(subject)` — every login of the person, **never the person id** (rollups alone also match the person id) |
| **Home tenant** — Keycloak `tenant_id` and `organization_role` attributes, and the per-tenant Keycloak group | Keycloak | the directory's `assign`; account-management's `POST /tenants/{id}/users` (the prototype's People screen "invite") | the platform: the token's `subject_tenant_id` and account-management's `/tenants/{id}/users`. In Studio: the directory's listing (shown as the IdP's attributes) and its one-off membership backfill — **and the prototype**, which reads `/tenants/{id}/users` as "who is in this organization / project" on its People, Team, Access-picker, Projects and Project-overview screens |
| **Resource-group membership** | platform `resource_group` | **nobody**: no backend code writes or reads it; the prototype's `createGroup`, `addMembership`, `memberships` and `deleteGroup` have no caller | the prototype lists groups (not memberships) as "teams" for a team grant; the PDP's team resolution is a `TODO` that never resolves a team, so a team grant matches nobody |
| **Team membership in a roadmap plan** — domain-model `person` and `membership` (`scope_kind: team`) objects | the domain model (graph storage) | `studio-reports`, mirroring a plan's units, teams and people (`reports/mirror.rs`) | the domain-model query and its screens. A person in a plan's team, keyed by plan login — a different fact from organization membership, and not read as one |
| **Platform administrator** | a membership of the platform root, studio-user | studio-user (config seed, backfill) | studio-user, the directory and organizations through `OrganizationReader::is_platform_admin`; the PDP |
| **Preferences** | `identity_user.ui_preferences`, studio-user | studio-user | the portal. The platform's `simple_user_settings` is registered in the assembly and nothing in Studio reads or writes it any more |
| **Actor columns** — `created_by`, `requested_by`, `edited_by`, presence ids | each gear's own storage | each gear, from `ctx.subject_id()` | each gear; `connectors` reads its column as a person through `PersonResolver::resolve_recorded_subject` (ADR-0025 §3) |

So the membership itself is **not** stored twice in the way the review feared:
`identity_membership` already has one writer and every gear already reads it
through studio-user's interfaces. The duplication is in the facts *derived*
from membership:

1. **The owner grant has three writers**, two of which bypass studio-user and
   call the access-config writer directly, and one gear (organizations) also
   re-derives ownership from the document instead of asking studio-user.
2. **Grants are keyed by a login, memberships by a person.** The bridge is
   `subjects_of`, which every grant matcher must remember to call; one of
   them (rollups) also matches the person id and the others do not, so a grant
   that names the person — which is what the membership routes speak — counts
   a person onto a team and grants them nothing.
3. **The prototype has a second membership answer**: account-management's
   per-tenant user listing, which is the Keycloak home-tenant attribute — the
   single-home projection ADR-0011 §1 ruled out and ADR-0016 stopped the main
   portal reading. The prototype still builds its People list, its Team picker
   and its Access picker from it, and keys the grants it writes by it.
4. **`PRODUCT.md` says the Editor role is derived from resource-group
   membership.** No code does that; resource groups hold no membership anybody
   reads.

## Considered Options

- **Keep the status quo and document it.** Every gear already reads membership
  through studio-user, so on paper the item is closed. It leaves the owner
  grant with three writers and grants on a different key from everything else,
  which is exactly where the two past bugs came from.
- **Make the AM resource group the membership, and studio-user a cache.** The
  platform's PDP plugins could read it, but nothing in this assembly does, a
  resource group has no role or standing, and the last-owner rule, invitations,
  suspension and merge all live in studio-user's tables and transactions.
- **`identity_membership` is the truth; studio-user writes every projection of
  it; the resource group becomes one more projection.** The recommended shape.
  Taken except for the resource-group projection — see §3.
- **Re-key grants to the person and drop login matching at once.** Clean, but a
  grant written before the backfill would stop matching the moment the code
  ships, and a deployment that has not run the backfill would lock its owners
  out of their own organizations.

## Decision Outcome

### 1. `identity_membership` is the only answer to "who belongs, as what"

studio-user owns the person, their logins and their memberships, and nothing
else in Studio keeps or derives a copy. Every other gear asks through the
interfaces studio-user publishes on the ClientHub (`crate::user_profile`'s
exported traits: `PersonResolver`, `OrganizationReader`, `OrgAuthority`,
`OrganizationRoster`, `MemberAliases`, `AssignmentRecorder`,
`MembershipEvictor`, `AliasResolver`) and never reads the tables, the
access-config owner grant or the IdP attributes as a second answer.

### 2. studio-user is the only writer of the owner grant

The owner grant is a projection of an active `owner` membership into the
document the PDP evaluates. It is written in one place, `sync_owner_grant`,
whenever a membership is recorded or changes standing — including the two
paths that used to write it themselves:

- `AssignmentRecorder::record_assignment` and `record_creation` take the
  caller's `SecurityContext` and write the grant along with the membership.
  The directory's `assign` and organizations' `create` stop calling
  `access_config::set_owner_grant`.
- Organizations asks `OrgAuthority::may_dispose` whether the caller may delete
  an organization (owner, or a platform administrator) instead of reading the
  access config itself.

Merge carries a person's grants with their memberships: after the logins,
aliases and memberships move, every grant in those organizations that named the
merged-away person names the surviving one.

### 3. The resource group is not a projection — there is nobody to project to

The recommendation was to keep the platform resource group in step as a
projection, "so platform authz that reads resource groups keeps working".
The code says there is no such reader: the Studio PDP decides tenant clamps
from `OrganizationReader` and roles from the access config, its team
resolution is a `TODO`, no gear calls the resource-group SDK, and the prototype
neither writes nor reads a group membership. Writing one would create the
second copy of membership this ADR exists to remove, with no reader to keep it
honest.

A resource group stays what the prototype already uses it for — a *team*, the
subject of a team grant — which is a different fact from organization
membership. When team grants are enforced, who belongs to a team needs an owner
of its own; that decision is not made here. `PRODUCT.md`'s "Editor = Resource
Group membership" is corrected: the Editor role comes from a grant.

### 4. The IdP attributes are a projection for the platform, never read back

The directory's `assign` keeps writing Keycloak's `tenant_id` and
`organization_role` attributes and the tenant group, because the platform needs
them — the token's `subject_tenant_id` and account-management's per-tenant user
listing come from there. They are written *from* the assignment and never read
by Studio as membership. The prototype's People, Team and Access screens read
members from `/studio-user/v1/organizations/{id}/members` instead of
account-management's `/tenants/{id}/users`, and invite through studio-user's
invitations instead of creating an IdP user in a home tenant.

### 5. One person id: a grant names the person

- Every grant studio-user writes names the canonical person id.
- Every grant matcher asks studio-user for the person's **grant keys** —
  `OrganizationReader::grant_keys_of(subject)`: the person id, then every
  sign-in subject of that person (the legacy keys), then the subject itself.
  This replaces `subjects_of`; one function, so no matcher can forget the
  person.
- The prototype writes grants with the person id (`user_id` from the members
  listing; the caller's own from `/studio-user/v1/me`).
- `POST /studio-user/v1/grants/backfill` (platform administrator) rewrites the
  member grants of every organization that has a membership so that each one
  naming a known login names its person instead, dropping the duplicates that
  produces. Idempotent; it reports `(organizations, rewritten, failed)`.

Login keys stay matchable until a later change removes them, so the order of
deploying the code and running the rekey does not matter: before the rekey
every old grant still matches through the login, after it every grant matches
through the person.

### Consequences

- (+) A membership and the grant derived from it are written by one gear, in
  one call, on one key. The two past bugs — a grant under one id and a question
  under another, and a membership route and a grant on different ids — have no
  code path left that can produce them.
- (+) The directory and organizations no longer touch the access config: one
  fewer place that has to know the grant's JSON shape.
- (+) The prototype stops presenting the single-home IdP attribute as
  membership, so a person in two organizations appears in both.
- (−) `AssignmentRecorder` grows a `SecurityContext` parameter: writing the
  grant is an account-management call made as the caller, and the PDP decides
  it (ADR-0019 §9).
- (−) The rekey is a deployment step. Skipping it is safe (logins still match)
  but leaves the prototype unable to name a grant written before it, because
  the members listing carries person ids.
- (−) The presence dot leaves the prototype's People list: presence is keyed by
  the sign-in subject (an actor column) and the list is now keyed by person.
- (−) Organization creation reports one fewer step (`Grant` folds into
  `Membership`), since the two writes are now one call.

### Confirmation

Implemented in #682 (first opened as #679). The backend gates passed on the
combined tree, and `user_profile/grants_tests.rs` covers the writes, the merge
and the rekey. A stand has not yet shown creation, assignment, a membership
change, merge and the rekey end to end. That check comes with the first Dev
deploy and its `grants/backfill` run, and this ADR stays proposed until then.

## More Information

### Migration

1. Deploy the backend. Nothing stops matching: old grants match through their
   login.
2. As a platform administrator, `POST /studio-user/v1/grants/backfill` once per
   environment. Re-running it is a no-op.
3. Deploy the prototype. Its screens read members and write grants by person.

### Follow-ups

1. **Stop matching login keys** once every environment has run the rekey, and
   delete the subject arm of `grant_keys_of`.
2. **Actor columns** (`documents`, `kit_registry`, `reports`, `domain_model`,
   `scheduler`, `tasks`, `studio_session`, presence) still record the token
   subject — ADR-0025 follow-up 5. Presence is the visible one: until it is
   keyed by person the prototype cannot light a dot on a person-keyed row.
3. **The prototype's project avatars** (Projects table, Project overview) still
   read account-management's per-tenant users for a workspace or project
   tenant. They should show the team the rollups already count (`team_of`).
4. **Team grants**: whoever enforces them decides who owns team membership
   (§3).
5. **The PDP's own access-config parse** duplicates `access_config.rs`; folding
   it in is worth doing with the next change to either.
6. **`simple_user_settings`** can leave the assembly: nothing reads it.
7. **The official portal (`studio-frontend`, FrontX) is not changed here.** Its
   shared accounts service still looks a user up through account-management's
   `/tenants/{id}/users` (`tenantUserPath`); moving that onto studio-user's
   members listing is that portal's own change.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-component-user`
* `cpt-studio-component-identity-directory`
* `cpt-studio-component-organizations`
* `cpt-studio-component-authz-plugin`
* `cpt-studio-component-access-config`
* `cpt-studio-fr-canonical-user`
* `cpt-studio-fr-invitations-membership`
