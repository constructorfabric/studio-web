---
type: adr
status: accepted
date: 2026-08-27
---

# ADR-0011: Authentication does not grant organization membership

**ID**: `cpt-studio-adr-authentication-does-not-grant-organization-membership`

Status: accepted · 2026-08-27 · Amends ADR-0004 · §3 and §4 superseded by [ADR-0018](0018-an-identity-proves-it-is-you-and-decides-nothing-else.md)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Decision Outcome](#decision-outcome)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

Constructor Studio now accepts GitHub identities through Keycloak. The GitHub
broker correctly answers **who the person is**, but its current
`github-tenant-id` mapper also assigns every accepted GitHub user the hard-coded
tenant `00000000-0000-0000-0000-000000000002`. This combines authentication
with authorization and assumes that the mapped tenant exists.

The first shared dev deployment exposed the failure directly: a GitHub login
succeeded, but the portal reported that the user's home tenant no longer
existed. The account-management database contained the platform root and a
separately generated organization, but not the hard-coded tenant. Pointing all
GitHub users at the generated organization would remove the error while
creating a more serious policy problem: every person accepted by the external
identity provider would silently become an organization member.

An authenticated person, an organization member, and an organization owner are
different domain concepts. They must have separate lifecycles. This also
follows ADR-0009: tenant isolation is the outer boundary and roles only narrow
access inside a tenant. A role or membership UI must not imply protection while
the runtime authorization path is still allow-all.

## Decision Outcome

### 1. External login establishes identity only

A successful GitHub/Keycloak login creates or links a stable Studio identity.
It does **not** create organization membership, select a home organization, or
grant a Studio role.

The GitHub organization check remains an admission policy for this deployment:
only active members of `constructorfabric` may complete GitHub authentication.
Passing that check means "this identity may reach Studio onboarding", not
"this identity belongs to every Constructor Fabric Studio organization".

The external IdP must not be the authority for Studio tenant ids. The
hard-coded `github-tenant-id` mapper is removed. In particular, neither the
platform root nor a shared organization is assigned merely because a user
authenticated successfully.

### 2. Organization access comes from explicit membership

Studio stores an explicit membership between a stable identity and an
organization:

```text
OrganizationMembership
  identity_id
  organization_tenant_id
  status: invited | active | suspended | revoked
  roles[]
  invited_by
  invited_at
  accepted_at
```

An identity may have memberships in more than one organization. The server
derives the organizations visible to the identity from active memberships; it
does not derive them from GitHub organization membership, email domain, or an
unvalidated tenant id supplied by the browser.

For an organization-scoped request, the client selects an active organization
and the server validates that selection against current membership before
constructing the tenant security context. The transport for that selection may
be a Studio session or an explicit request field/header, but it is never trusted
without the membership lookup. A Keycloak access token remains proof of
identity, not proof of Studio organization access.

### 3. A user with no membership gets a valid no-access state

An authenticated identity with no active memberships sees an onboarding state,
not the platform tree and not a missing-tenant error:

> You do not have access to an organization yet. Ask a Studio administrator or
> an organization owner for an invitation.

This state may show pending invitations and sign-out/account information. It
must not expose organization names, workspaces, projects, member directories,
or organization creation controls.

There is no synthetic "pending" tenant whose subtree might accidentally become
an access scope. Endpoints required for the no-membership state are explicitly
identity-scoped and narrowly authorized.

### 4. The installation bootstraps a default organization

Every Studio installation creates one configurable default organization as an
idempotent deployment/bootstrap operation. It is not created by the first
ordinary user to open the portal. The default name may include the environment
(for example, `Constructor Fabric Dev`) and the organization initially has no
ordinary members.

A platform administrator configures that default organization and appoints its
first `organization_owner`. The platform administrator may also create
additional organizations and appoint an owner for each one. Authentication
alone can never produce ownership or membership.

Only a platform administrator can appoint, replace, or revoke an organization
owner. This guarantees a recovery path if the owner leaves and prevents an
organization administrator from escalating to ownership. The platform must
reject removal of the final active owner unless a replacement is committed in
the same operation.

The initial platform administrator is a deliberately provisioned administrative
identity, not the first person to log in. Shared deployments must not use
first-login-wins bootstrap semantics.

### 5. Owners manage membership and non-owner roles

An organization owner can:

- view active, invited, suspended, and revoked users in that organization;
- invite a person by verified email or supported external identity;
- resend or revoke a pending invitation;
- activate, suspend, and remove organization members;
- assign and revoke non-owner organization roles;
- create and manage the organization's workspaces.

An owner cannot browse identities or users belonging only to another
organization. Inviting an existing Studio identity creates a membership; it
does not duplicate the identity or the Keycloak account.

The initial organization role vocabulary is:

- `organization_owner` — ownership and full organization administration;
- `organization_admin` — membership and workspace administration, excluding
  owner appointment and other platform-only operations;
- `member` — normal product use inside granted scope;
- `viewer` — read-only access.

Project/workspace roles may narrow these organization roles later. They never
widen access beyond an active organization membership, as required by
ADR-0009.

### 6. Invitations and login are joined safely

An invitation has a single-use, expiring acceptance token and is bound to an
organization, intended role set, and normalized verified identity attribute.
After authentication, Studio accepts the invitation only when the verified IdP
identity matches the invitation. Email matching must use a verified email; a
GitHub login name alone is not a durable security identifier.

Owners may invite a person before their first Studio login. A person who logs in
before being invited remains in the no-access state. When their invitation is
accepted, the existing identity gains a membership without recreating the
Keycloak user.

### 7. Enforcement precedes role-management UI

Membership and roles are enforced server-side for list, read, create, update,
and delete operations. Filtering only in the frontend is not authorization.

The current allow-all authorization path cannot support production membership
or role claims. The organization member-management UI and non-admin shared
access are released only after automated tests prove:

- a non-member cannot discover or access an organization by id;
- a member cannot cross into another organization;
- suspended and revoked memberships take effect without waiting for a new
  external login;
- each role is denied operations outside its privilege set;
- the last-owner invariant cannot be bypassed concurrently;
- organization selection is validated on every security-context creation.

Deployment rights are separate from Studio product roles. Kubernetes and
GitHub Actions deployment permissions remain controlled by GitHub Environments,
repository permissions, and namespace-scoped Kubernetes credentials.

### Consequences

- A successful external login no longer implies product access. This is an
  intentional separation of authentication and authorization.
- The deleted-home-tenant failure disappears because unassigned identities are
  a supported state, not identities carrying fabricated tenant ids.
- Organization discovery and user administration become tenant-scoped and
  auditable.
- Multi-organization users become possible without encoding one mutable home
  organization in the external IdP token.
- The change requires backend identity/membership APIs and real PDP enforcement;
  it cannot be completed safely as a Keycloak mapper or frontend-only patch.
- Existing GitHub-created users require migration because their current
  `tenant_id` attribute is not an authoritative membership.

## More Information

### User experience

```text
GitHub / Keycloak login
          |
          v
     Studio identity
          |
          +-- no active membership --> Waiting for access / invitations
          |
          +-- one membership --------> Open that organization
          |
          +-- several memberships ---> Organization selector
                                          |
                                          v
                                Server-validated active scope
```

> **Changed by later records.** ADR-0018 superseded §3 and §4: creating an
> organization became self-service, the person who creates it owns it, and an
> owner may appoint another owner ("What this changes in ADR-0011"). ADR-0051
> then made creation an installation setting (`open`, `request`, `off`), gave
> the platform administrator the approval of requested organizations, and kept
> creating an organization and appointing its owner available to the platform
> administrator as one option among them. The bullets below on
> creating organizations and appointing owners hold in that
> narrower sense only.

Platform administrators have a separate administration surface for:

- creating organizations;
- viewing every identity created after a successful Keycloak login, including
  identities that are not yet assigned to an organization;
- appointing or replacing organization owners;
- suspending an organization or recovering ownership.

The identity directory records successful identity establishment, not every
rejected OAuth attempt. A login rejected before Keycloak creates or links an
identity belongs in the security audit/event stream and is not presented as a
Studio user. The directory is platform-admin-only; organization owners receive
only their organization's member and invitation views.

Organization owners have a tenant-scoped People surface. They never receive
the platform-wide identity directory.

### Migration and implementation plan

#### Phase 0 — stop the incorrect grant

1. Remove `github-tenant-id` from the realm and partial-import configuration.
2. Stop treating a missing hard-coded tenant as an instruction to recreate it.
3. Add an idempotent installation bootstrap that creates the configurable
   default organization under the platform root.
4. Remove the frontend bootstrap fallback once every supported deployment path
   creates the default organization. During migration, the fallback is allowed
   only for the validated platform-root administrator; it must never run for a
   normal user's first session.
5. Render the explicit no-membership state instead of the deleted-home-tenant
   message.
6. Keep the local bootstrap administrator as the only platform administrator
   during this phase.

#### Phase 1 — identity and membership contracts

1. Define stable identity, invitation, membership, and role-grant persistence.
2. Add identity-scoped `me`, invitation-list, and invitation-accept endpoints
   that work before an organization is selected.
3. Add a platform-admin-only identity directory backed by Keycloak, including
   authenticated identities with no valid organization assignment.
4. Add platform-admin organization creation and owner appointment APIs.
5. Add organization-scoped member list/invite/suspend/remove and role APIs.
6. Add audit events for invitations, acceptance, role changes, suspension,
   owner replacement, and denied cross-tenant access.

#### Phase 2 — authorization

1. Replace allow-all with the Studio PDP path for every organization resource.
2. Resolve active membership before constructing tenant constraints.
3. Layer role grants over the tenant clamp as specified by ADR-0009.
4. Add negative integration tests and concurrency tests for the invariants in
   this ADR.

#### Phase 3 — administration and onboarding UI

1. Add the platform-admin organization/owner management surface.
2. Add the no-access and pending-invitations screens.
3. Add the owner People and role-management surface.
4. Add organization switching for identities with multiple memberships.

#### Phase 4 — dev migration and promotion

1. Configure the bootstrapped organization as `Constructor Fabric Dev` (or
   create it idempotently when upgrading an installation that predates the
   bootstrap).
2. Appoint the chosen GitHub-backed identity as its first owner through the
   platform-admin path.
3. Convert any legitimate existing users into explicit memberships and remove
   stale `tenant_id` attributes from broker-created Keycloak users.
4. Verify non-member, owner, admin, member, suspended, and cross-organization
   denial scenarios in dev.
5. Promote the same schema and behavior to test; create `Constructor Fabric
   Test` independently and appoint its owner explicitly.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-component-identity-directory`
* `cpt-studio-fr-invitations-membership`
* `cpt-studio-fr-identity-directory`
