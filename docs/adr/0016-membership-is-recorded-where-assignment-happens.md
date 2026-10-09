---
type: adr
status: proposed
date: 2026-09-10
---

# ADR-0016: Membership is recorded where assignment happens, and read where access is decided

**ID**: `cpt-studio-adr-membership-is-recorded-where-assignment-happens`

Status: **proposed** · Date: 2026-09-10 · Implements ADR-0023 follow-up 1 · Phase 0 of ADR-0011 §2 · Narrowed by ADR-0040

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Decision Outcome](#decision-outcome)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

ADR-0011 §2 makes explicit membership the authority for organization access, and
ADR-0023 gave it a table. Neither is what the product reads. Today the portal
derives the organizations a person can see from `me.subject_tenant_id` plus that
tenant's children (`appContextEffects.ts:126-143`) — the single-home assumption
ADR-0011 §1 ruled out — and the only thing that writes a Keycloak `tenant_id`
attribute is `identity_directory.assign`.

`identity_membership` therefore exists, is indexed, is read by `/me/memberships`,
and has exactly one writer: its own admin REST route, which nothing calls.

The obvious move is to point the portal at `/me/memberships`. Done first, it
breaks every existing environment: no identity assigned before today has a
membership row, so everyone would read as having no organization. And ADR-0011 §7
is explicit that membership must be enforced server-side before a membership UI
ships — which it is not, because `studio_authz_plugin::privilege_for` returns
`None` unconditionally, leaving the entire grant-matching branch unreachable.

So the order is: make the record exist, then read it — §1-§4 below and then
§5-§6, in that sequence, because the read is only safe once the rows are there.
That ordering turned out to matter more than expected: the backfill migrates what
the old data *said*, and what it said is not what the portal needs (§5).

## Decision Outcome

### 1. `AssignmentRecorder` — one narrow write, in the direction that already exists

ADR-0023 follow-up 1 left the choice open between "the portal calls
`PUT …/memberships/{org}` after assignment" and "`identity_directory` depends on a
studio-user client". Neither quite fits: there is no People screen in the main
portal to do the calling, and a full SDK dependency is more coupling than the one
call needs.

`studio-user` publishes a single-method interface on the ClientHub instead:

```text
record_assignment(subject, org_id, role)
```

*(ADR-0040: it is now `record_assignment(ctx, subject, org_id, role,
display_name, email)`, with `record_creation` beside it, and it writes the owner
grant too.)*

`identity_directory` hands over the Keycloak subject it already holds and never
learns what a person id is; `studio-user` resolves the subject to its canonical
person and upserts the membership with `source = "assignment"` (as against
`manual` for the REST route). Removing a membership, changing a role and reading
anybody's memberships all stay on the REST surface behind their own gates.

This makes the two identity gears mutually dependent — `studio-user` reads
`FederatedIdentityReader` from the directory (ADR-0015), the directory now reads
this. That is safe here and not by luck: both publish in `init` and both consume
in `register_rest`, and every gear's `init` runs before any gear's REST phase.
The recorder is *borrowed* into `assign`, not stored on the service, for the same
reason the connector guard borrows its resolver (ADR-0025): two services owning
each other are constructible in neither order.

### 2. Recorded last, and required

The membership write happens after the three IdP-side writes (`tenant_id`
attribute, owner grant, tenant group). Recording a membership when those failed
would leave the new authority saying "member" while everything else says
otherwise — a half-assignment in the direction that grants access.

*(ADR-0040: the owner grant is no longer an IdP-side write. studio-user writes
it together with the membership inside `record_assignment`, which now takes the
caller's `SecurityContext`.)*

It is not optional, though. Since §5 the portal reads this row to build a
person's organization list, so an assignment that writes the Keycloak
representations and loses the membership produces somebody who is assigned as
far as Keycloak is concerned and has no organization as far as Studio is
concerned. Reporting that as success would hide it from the only person able to
fix it. There is no transaction across the two systems, so the failure is
reported with what to do about it, and every write on the path is idempotent:
the repair is to call the assignment again.

### 3. A backfill, because history has no rows

`POST /studio-identity/v1/memberships/backfill` (platform-admin) walks the
directory listing and records a membership for every identity whose home-tenant
attribute names an organization that still exists. This is ADR-0011 Phase 4
item 3.

It lives in `identity_directory` because that gear owns the attribute being
migrated from, and it writes through the same narrow interface. Idempotent —
`record_assignment` upserts — and it reports `(recorded, failed)` rather than
stopping at the first failure: a partial backfill that names its casualties in the
log is more useful than an all-or-nothing one that leaves nothing behind.

Identities whose attribute names a deleted tenant are skipped, not recorded as
members of nothing: `list()` already resolves `home_tenant_id` to `None` when the
tenant cannot be fetched.

### 4. A platform admin may write a membership

`require_org_owner` becomes `require_org_authority`: the organization's owner, or
a platform administrator.

Not a convenience. Assignment from the identity directory is a platform act —
ADR-0011 §4 gives only a platform administrator the power to appoint an
organization's first owner — so an owner-only gate makes the very first
membership of a fresh organization unwritable, because there is nobody yet who
could write it. Everyone else is still refused with `ORG_OWNER_REQUIRED`.

### 5. The portal reads membership — except for the platform administrator

`appContextEffects` built the organization list from `me.subject_tenant_id` plus
that tenant's organization children. It now asks `/me/memberships` and resolves
each organization's name through account-management, because `studio-user` stores
ids and roles, not tenant names.

**A platform administrator is the exception, and has to be.** The migration
cannot simply be "read the new table", because the old data does not mean what
the new table means: `tenant_id` is a *home tenant*, and in every environment so
far that home is the platform root — whose type is `cf.core.am.platform.v1~`, not
organization. So the backfill above records these people as members of the
*platform* tenant, which the switcher filters out as not an organization. Read
naively, every administrator would lose their entire organization list.

The resolution is not a compatibility shim but the distinction ADR-0011 §1 draws:
a platform administrator reaches every organization by virtue of the role, not by
membership. So the home tenant still decides one thing — whether this caller is
the platform administrator, which is a fact about the token — and nothing else.
Administrators keep the tree walk; everybody else gets their memberships. Making
the root's own membership stand for "member of everything" would be exactly the
conflation ADR-0011 §1 forbids.

An organization whose tenant cannot be read is dropped rather than shown
nameless: from outside a self-managed organization's subtree the backend answers
404 by design, and that is isolation working.

### 6. No organization is a state, not an empty screen

An empty list renders `OrganizationAccessGate` (ADR-0011 §3) instead of the
mounted screen. It names nothing about the installation — no organizations, no
workspaces, no member directory, no create control — because naming one to
somebody with no membership hands the tenant tree to anybody who can
authenticate.

A *failed* resolve deliberately does not enter that state: a timeout must not
tell somebody with an organization that they have none.

### Consequences

- (+) The membership table has a real writer on the real assignment path, so the
  data the portal will need starts accumulating before anything depends on it.
- (+) Existing environments get their history migrated by one idempotent call.
- (−) Two identity gears now depend on each other. Mechanically fine (§1), and
  a smell worth watching: the third such link is the one to redesign around.
- (−) Assignment is now four writes across two systems with no transaction. The
  membership row is the one allowed to lag, and the backfill is the repair.
- (−) `source` distinguishes `assignment` from `manual`, and nothing reads it
  yet.
- (−) The portal now depends on a table whose only writers are the assignment
  path and the backfill. An environment that upgrades without running the
  backfill shows its people the onboarding screen — visible and repairable, but
  it is a deployment step that did not exist before.
- (−) The organization list costs one request per membership to resolve names.
  Fine at the present cardinality; a batch tenant read is the fix if it is not.

### Confirmation

On an isolated stand (own Postgres, own Keycloak 26.7 with the Studio realm; the
shared dev stack untouched):

- three realm identities carrying a `tenant_id` attribute and one without;
  `POST …/memberships/backfill` → `{recorded: 3, failed: 0}`, the unassigned one
  skipped; re-run → `{recorded: 3, failed: 0}` and no duplicate rows.
- the backfilled row carries the role from the IdP attribute
  (`role: "owner"`, `source: "assignment"`).
- assigning the previously unassigned identity through
  `POST …/users/{id}/assignment` → 204, and its membership appears as
  `role: "member"`, `source: "assignment"`.
- the authority gate: a caller outside the root tenant is refused `PUT` and
  `DELETE` on a membership and the backfill route (403, `ORG_OWNER_REQUIRED` /
  `PLATFORM_ADMIN_REQUIRED`); a platform administrator's `PUT` succeeds and is
  recorded with `source: "manual"`.

Frontend: `type-check:app` clean, the app suite 153/153, and five new tests in
`appContextEffects.test.ts` — a file that did not exist, for the function whose
meaning this changes — pinning both paths (member list, administrator tree walk),
the unassigned state, the unreadable-organization drop, and that a failed resolve
does not show the onboarding screen.

Two pre-existing failures surfaced on the way and are worth recording: `assign`
requires a `tenants` group to exist in the realm and fails the whole assignment
with "Keycloak tenant group root does not exist" when it does not. On a realm
that AM has not provisioned through its Keycloak IdP plugin, assignment cannot
succeed at all. Not caused by this change — the membership write is downstream of
it — and not fixed here.

And the frontend workspace does not build from a clean `npm ci`:
`@gears-frontx/frontx-template-shell` is published as source with
`types: ./dist-lib/index.d.ts` and no `dist-lib`, so `packages/framework` cannot
emit declarations and every suite that imports `@gears-frontx/react` fails to
resolve it. Running `npm run build:package` inside that dependency unblocks the
whole chain. Separately, `connections-mfe` fails 8 tests when its suite runs
whole and passes them file-by-file, and `overlayContract.test.ts` needs a
generated MFE manifest. None of these are touched by this change.

## More Information

### What is deliberately not here

- **The `tenant_id` attribute still exists and is still written**, and still
  decides who the platform administrator is (§5). It stops being the authority
  for *organization access* here; retiring it entirely needs a separate answer
  for the administrator question.
- **Nothing is enforced differently.** `privilege_for` still maps no resource, so
  the PDP's grant branch is still unreachable and this changes no access
  decision — the organization list is what the UI *offers*, not what the server
  permits. ADR-0011 §7 is satisfied in the sense that matters: no membership
  *management* UI ships here, and nothing new is granted.
- **The prototype portal is untouched.** Its `me.subject_tenant_id` use is a
  tenant-tree explorer rooted at the home tenant, not an organization selector,
  and membership does not replace it. Its assignment flow needs no change: the
  membership is recorded server-side by §1.

### Follow-ups

1. **Decide how a platform administrator is recognised without `tenant_id`**
   (§5). Until then the attribute cannot be retired, whatever else stops reading
   it.
2. **Stop reading the `tenant_id` attribute as membership.** Done — ADR-0040
   §4: Studio never reads it back; it stays written as the IdP's projection for
   the platform (token `subject_tenant_id`, account-management's tenant user
   listing).
3. **Enforcement** — ADR-0023 follow-up 2, gated on a Studio resource actually
   being role-mapped in `privilege_for`.
4. **`assign` needs the tenant group to exist**; either provision it or stop
   requiring it.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-component-user`
* `cpt-studio-fr-invitations-membership`
