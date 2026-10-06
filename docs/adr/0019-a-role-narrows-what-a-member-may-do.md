---
type: adr
status: proposed
date: 2026-09-14
---

# ADR-0019: A role narrows what a member may do, and nothing else

**ID**: `cpt-studio-adr-a-role-narrows-what-a-member-may-do`

Status: **proposed** · Date: 2026-09-14 · Closes ADR-0018 follow-up 9 · Meets ADR-0011 §7

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Decision Outcome](#decision-outcome)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

ADR-0018 shipped eight of its nine follow-ups and left the ninth open on
purpose. This is that ninth one, and the first thing worth recording is that the
open item was mis-stated. It read as though the work were a table to fill in:

> `privilege_for` maps no resource type, so the Studio PDP answers every request
> with the tenant clamp and the grant evaluation beside it is unreachable.

That is true and it is not the obstacle. `privilege_for` returns `None` for
everything, but filling it in changes nothing, because **nothing would ever call
it with a Studio resource type.**

In this platform a gear is its own policy enforcement point. It declares a
`ResourceType` constant and calls the enforcer itself — account-management does
this for tenants and metadata, ledger does it for every one of its REST
surfaces. `studio-backend` does it nowhere: `PolicyEnforcer`, `access_scope` and
`ResourceType` appear in this assembly only inside the PDP plugin that answers
such calls. Our gears authorize by asking account-management for the tenant
(`get_tenant`), which enforces the tenant clamp transitively and asks nothing
about a privilege.

So the roles model has been half-built from both ends: the PDP can evaluate
grants against roles, and the access config already carries roles, grants and
scopes — but no request in this assembly is ever shaped as a question about a
privilege. The missing piece is the path, not the table.

### What is actually left of ADR-0011 §7

§7 names six properties that must hold before the membership-management UI is
released. Five of them are already true, which is worth stating plainly because
the open follow-up implied otherwise:

| §7 requirement | Where it stands |
| --- | --- |
| a non-member cannot discover or access an organization by id | Enforced by the tenant clamp (ADR-0018 follow-up 1) |
| a member cannot cross into another organization | Enforced by the same clamp |
| suspended and revoked memberships take effect without a new login | Enforced — `membership.status`, and the generation that invalidates the clamp cache |
| the last-owner invariant cannot be bypassed concurrently | Enforced in one place, for removal, demotion and suspension alike |
| **each role is denied operations outside its privilege set** | **Not enforced. This ADR.** |
| organization selection is validated on every security-context creation | Enforced by the clamp; the scope a context names is one the person reaches or the request fails |

One row. The rest of §7 was met by the work ADR-0018 already landed.

### The catalogue is older than the product

`studio-frontend-prototype/src/access.ts` carries a privilege catalogue marked
"concept → P1", and it predates two decisions that have since landed:

- `project.view|create|edit|delete|studio` and `work.*` describe a
  `studio-project` gear that no longer exists. Projects are account-management
  tenants (ADR-0010) and workspaces are tenants under them, so **access to a
  project is membership, not a privilege**. Granting `project.view` inside an
  organization would be a second, weaker answer to a question tenancy already
  answers.
- The documents gear arrived after the catalogue was written and appears in it
  nowhere.

A catalogue that names things the product does not have is worse than a short
one: every entry is a promise the PDP cannot keep.

## Decision Outcome

### 1. The rule

**Tenant membership decides which organizations you reach. A role decides what
you may do inside one.** Roles only ever narrow. No grant reaches across a
tenant boundary, and a member with no matching grant is denied rather than
falling back to what membership alone would have allowed.

This is the layering ADR-0009 described and the prototype's `access.ts` header
already stated; it has simply never been executed.

### 2. Privileges name what the product does

The catalogue is rewritten against the gears that exist. Each privilege is one
`(resource type, action)` pair the PDP can actually be asked about:

| Privilege | Gates |
| --- | --- |
| `people.view` | Reading an organization's members and invitations |
| `people.invite` | Creating and revoking invitations |
| `people.manage` | Membership writes — role changes, suspension, removal |
| `access.manage` | Editing the roles and grants themselves, and switching the access model |
| `connector.view` / `connector.manage` | Listing connections; creating, editing and deleting them |
| `secret.view` / `secret.manage` | The credentials a connection holds |
| `document.view` / `document.edit` | The documents gear |
| `session.open` | Opening a workspace in the IDE |

`people.manage` and `access.manage` are deliberately not one privilege. Running
an organization — inviting people, changing their roles, suspending somebody who
left — is the daily work of an administrator. Redefining what the roles
themselves mean is the act that decides who may do any of it, and the seeded
ladder is the difference between the two: `admin` holds everything except
`access.manage`, so an administrator can run the organization without being able
to rewrite the rules they are administered by.

The seeded ladder is therefore:

| Role | Holds |
| --- | --- |
| `owner` | Every privilege, by definition rather than by enumeration (§7) |
| `admin` | Every privilege except `access.manage` |
| `editor` | `people.view`, `document.view`, `document.edit`, `connector.view`, `secret.view`, `session.open` |
| `viewer` | The `.view` privileges |

Owner and admin differ in one more way that is not a privilege at all: ownership
governs handing the organization over and disposing of it (ADR-0018 §6), and
that comes from being an owner, never from a grant somebody was given.

`project.*` and `work.*` are retired rather than reassigned: their subject is
governed by tenancy, and saying so once is better than carrying an entry that
must be granted to everyone in order not to break them.

### 3. Two questions, two places — and only one of them is the PDP's

Building the first slice showed that "route every privilege through the PDP" is
wrong, and wrong in the dangerous direction. The two questions are not the same
shape:

- **May this person administer this organization?** — manage its people, its
  invitations, its roles. There is one answer per organization and it filters no
  rows.
- **Which rows of this resource may this person see?** — documents, connections,
  issues. The answer is a filter, and the tenant clamp is the outer bound of it.

The PDP answers the second. Asking it the first is a category error with teeth:
for an organization on the `tenant` model the PDP answers every mapped request
with the tenant clamp, which admits **every member of the organization**. A
gear that took that as "yes, you may administer" would let any member change
memberships — where today it requires an owner. Routing administration through
the clamp does not narrow authority, it widens it, which is the opposite of
what enforcement is for.

So administrative authority is answered **in the gear, from the access config**,
which is where it already lives: `is_org_owner` reads that document through the
shared `access_config` module today, and holding a privilege is the same
question asked with a different word. No second copy of the document, no PEP
round trip, and the tenant-model path keeps exactly the owner gate it has.

Row-level access — follow-ups 2 and 3 — is the PDP's, and that is where a gear
declares a `ResourceType` and calls the enforcer the way account-management
does. `privilege_for` maps those types when their gears start asking. It stays
empty until then, and the test that says so stays with it.

### 4. "No roles" and "cannot tell" are different answers

Today the PDP treats both as the tenant clamp — that is, as permission. They are
not the same, and conflating them is the one place this change can go wrong
quietly:

- **`model: "tenant"`, or no access config at all.** The organization has not
  opted into roles. Tenant behaviour is the correct and intended answer.
- **The config read failed.** We do not know what the organization decided.
  For a role-gated resource this now **denies**, matching account-management's
  DESIGN §4.3 rather than our present fail-open.

The second case is today indistinguishable from the first, which means a
transport failure silently grants `access.manage` to anybody who reaches the
organization. That is the defect this ADR fixes, and it exists whether or not
anything is role-gated.

### 5. Owner stops being a special case

`require_org_authority` — "a platform administrator or the organization's
owner" — becomes a check for `access.manage`. The seeded owner role holds every
privilege, so owners keep exactly what they had, and an `admin` role becomes
able to manage people without first being made an owner, which is what the
member-management UI needs and cannot express today.

Platform administrator remains the separate axis ADR-0018 §3 made it: a
membership at the root, not a privilege inside an organization.

### 6. Nothing that works today stops working

The access config's `model` defaults to `"tenant"`, and every organization that
exists is on that default. A role-gated resource in a `tenant`-model
organization is answered by the clamp exactly as it is now.

So enforcement arrives switched off, per organization, and an organization turns
it on by choosing role-based access. This is what makes the change releasable at
all: the risk ADR-0018 named — "getting any of it wrong denies requests that
work today" — is bounded to organizations that have deliberately opted in.

### 7. Switching to roles must not be able to lock an organization out

Writing this ADR found a live trap in the half-built model, and it is the reason
§6's "nothing stops working" is not the whole safety story.

`set_owner_grant` seeds a fresh access config as
`{"model": "tenant", "roles": [], "grants": []}` and then appends the owner
grant — `roleKey: "owner"`, `scopeType: "org"`. It never writes the role ladder;
`roles` stays empty. Only the prototype's `normalizeAccessConfig` fills the
ladder in, and it does so **on read, in the browser**, so the stored document
never gains it.

The PDP resolves a grant by finding the role it names and asking whether that
role carries the privilege. With `roles: []` there is no role called `owner`, so
the lookup fails and the grant carries nothing. The moment an organization sets
`model: "roles"`, every role-gated request denies — `access.manage` among them,
which is the only privilege that could set the model back. The organization
locks itself out of its own access settings, irreversibly, through the supported
path.

Nothing exposes that switch today, which is why it has never happened. Three
rules keep it from happening when something does:

- **The writer seeds the ladder, not an empty list.** `roles` is written with
  the owner/admin/editor/viewer definitions when the document is created, so a
  grant always names a role that exists.
- **The owner role is not resolved through the document.** An org-scoped grant
  with `roleKey: "owner"` carries every privilege by definition, whatever the
  document's `roles` array says. The owner ladder is a convenience for editing,
  never the thing that decides whether an owner is an owner.
- **A model switch is refused unless some live grant would still hold
  `access.manage` afterwards** — the same shape of question the last-owner rule
  already asks about the room as it would be after the write.

### 8. The config read gets a cache

Once a resource type is mapped, the access-config read happens on every request
to it. It is cached the way the reachable-tenant list already is: keyed on a
generation that every access-config write moves, with an age limit as a
backstop. The existing test that asserts no request reaches the config read is
the tripwire for this, and it is replaced rather than deleted.

### 9. Only an owner may say who owns an organization

Added after the fact, because building §7 found the hole it closes.

The access config is the document this whole ADR decides from, and it is stored
as account-management tenant metadata. Every tenant-metadata request is answered
by our PDP with the tenant clamp: the family is short-circuited there because
deciding who may *read* the access config means reading the access config, and
that recursion has to stop somewhere. The clamp's answer is "is this caller
inside this tenant", and every member of an organization is.

So any member could write the document an owner grant naming themselves, and
then administer and delete the organization. Demonstrated on a stand, not
inferred.

The escape was too wide. Reads keep the guard — the recursion is real. Writes do
not have that problem: the decision reads the document, and that read is still
clamped, so it terminates. Writes to this one schema are decided by ownership,
with a platform administrator's arm (ADR-0011 §4) and, under the roles model,
`access.manage`. Two openings, both narrow: a document that does not exist yet
is an organization being created, and a document nobody owns cannot be gated by
ownership without wedging the organization forever.

This is not a workaround around the platform. Account-management already passes
the schema id on every authorize call so that a PDP can decide per schema, and
its DESIGN's "Metadata steward" row already says per-schema grants are explicit.
What is missing is a way for a PDP to read its own policy document without that
read being a decision — which is what makes the family-wide escape necessary in
the first place. That is written up for the platform in
`docs/upstream/account-management-requests.md`, together with a second,
smaller ask: a schema that names its owning gear, so a document with one writer
is not reachable through a generic route at all.

### Consequences

- The member-management UI ADR-0011 §7 gates becomes releasable, for
  organizations on the roles model.
- Every role-gated route costs one PDP call. The cache keeps it off
  account-management, not out of the process.
- A fail-closed role path means a PDP or account-management outage denies
  role-gated operations in roles-model organizations instead of silently
  allowing them. That is the intended trade and it is a behaviour change.
- The prototype's catalogue and the backend's table must agree. They are two
  files in two languages; §2 is the contract between them until the privileges
  are registered as GTS permission instances in types-registry.
- §7's lockout is fixed ahead of the surface that could trigger it. The ladder
  now lives in the stored document, so an organization's roles become data the
  backend wrote rather than a default the browser supplied — which also means
  the two implementations of "the default ladder" have to stop being two.

## More Information

### Follow-ups

1. **The people surface. Shipped**, and it is what found §3: `people.manage` on
   the membership write and delete, `people.invite` on inviting and revoking,
   `people.view` on listing invitations. `require_org_authority` takes the
   privilege it needs; ownership and the platform arm are unchanged, so every
   organization — all of them on the `tenant` model — behaves exactly as it did.
   `access.manage` is named in §2 and gates nothing yet: the screen that edits
   roles and grants lives in the prototype and writes through
   account-management's metadata route, so gating it is that surface's own
   piece of work.
2. **Connections and secrets**, which is where a privilege is worth the most,
   because a connection holds a credential.
3. **Documents and sessions.**
4. **Retire the prototype catalogue** in favour of the registered one, once
   types-registry carries the permission instances.
5. **The platform root in the clamp** — the one thing ADR-0018 left open besides
   this: a token naming the root still reaches the tenant tree, and telling a
   person from a service account apart is a question about the platform's
   subject model rather than Studio's.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-component-authz-plugin`
* `cpt-studio-component-access-config`
* `cpt-studio-principle-tenant-clamp-first`
* `cpt-studio-fr-org-administration`
* `cpt-studio-fr-authz-row-roles`
