---
type: adr
status: proposed
date: 2026-10-28
---

# ADR-0051: Anybody with a verified identity may sign in; an owner asks for an organization, and a platform administrator approves the organization, not the person

**ID**: `cpt-studio-adr-organization-requests`

Status: **proposed** · Date: 2026-10-28 · Issue #896 · Extends `cpt-studio-adr-an-identity-proves-it-is-you-and-decides-nothing-else` (ADR-0018 §4) · Keeps `cpt-studio-adr-authentication-does-not-grant-organization-membership` (ADR-0011) · Uses `cpt-studio-adr-one-owner-for-people-and-membership` (ADR-0040) · Delivers the approval queue `cpt-studio-adr-users-onboarding-roles` (ADR-0004 §1) left for phase 2

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. Admission is the installation's policy, and a cloud admits any verified identity](#1-admission-is-the-installations-policy-and-a-cloud-admits-any-verified-identity)
  - [2. Organization creation has three settings: open, request, off](#2-organization-creation-has-three-settings-open-request-off)
  - [3. An organization request is a record studio-user keeps](#3-an-organization-request-is-a-record-studio-user-keeps)
  - [4. Approval creates the organization on the requester's behalf](#4-approval-creates-the-organization-on-the-requesters-behalf)
  - [5. What the person without an organization sees](#5-what-the-person-without-an-organization-sees)
  - [6. Members are still the owner's business](#6-members-are-still-the-owners-business)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

The owner of a company wants to start using Studio: sign up, get an
organization, and invite their people. Today they cannot, and the reason is
not in Studio.

**Studio already has the path.** ADR-0018 §4 made "how a person comes by
their first organization" a provisioning policy. With
`studio-organizations.self_service: true` (the default, and what `k8s.yaml`
runs) a signed-in person with no membership sees `OrganizationAccessGate`,
creates an organization and owns it; `record_creation` writes the owner
membership and the owner grant (ADR-0040 §2). Nothing is derived from
authentication, so ADR-0011 holds.

**Admission stops them first.** The realm's only enabled broker is GitHub, and
its provider (`keycloak/extensions/github-org-authenticator`) admits only
active members of the GitHub organization `constructorfabric`, on every
login. Google and Microsoft are in the realm but disabled; password
registration is allowed with `verifyEmail: false`. So "approval by an
administrator" today means somebody adding the person to our GitHub
organization. That is the right gate for dev and test, and a closed door to
anybody outside the company.

**Opening the door as Studio is now would be too wide.** With admission open
and `self_service: true`, anybody on the internet can create organizations,
and an organization spends money: model calls through the LLM proxy, IDE
sessions, builds, and with ADR-0049 a Research tenant's hardware. A free
signup is fine; a free consumer of resources needs somebody's yes, at least
until there is billing and quotas.

The question this record answers: where does an administrator's yes belong,
if not on the person?

## Considered Options

1. **Approve the person.** Keycloak self-registration lands in a pending
   state, and an administrator approves each account (ADR-0004 §1's original
   phase 2). Every member of every organization waits for the platform
   administrator, although only the organization's owner should decide who
   joins it. Approval at the login also makes the IdP the place where Studio's
   decisions are kept, which ADR-0011 moved away from.
2. **Open: admit and create freely.** `self_service: true` in a cloud with
   open admission, with a per-person limit. Simplest, and right once there is
   billing. Before that, nothing stands between a stranger and our spend.
3. **Approve the organization.** Anybody with a verified identity signs in. A
   person without an organization asks for one; a platform administrator
   approves the request, and the organization is created with the requester as
   its owner. The owner invites their people, and nobody else waits for the
   platform.
4. **The platform administrator creates the organization and appoints the
   owner** (ADR-0011 §4, works today). Fine for a handful of customers; every
   customer is a manual act with no record of who asked.

## Decision Outcome

Chosen option: **3**, built so that **2** is a configuration change once
billing exists, and **4** stays available to the platform administrator.

### 1. Admission is the installation's policy, and a cloud admits any verified identity

Signing in proves who the person is (ADR-0018) and nothing else, so the IdP
should keep out only identities that cannot be trusted to be anybody in
particular:

- **The GitHub organization check becomes a switch** on the provider,
  `requireOrganization` (default `true`, so no deployment opens by
  accident). dev and test keep it on with `constructorfabric`. A cloud
  installation turns it off. A blank organization with the check on stays an
  error, as now: a mistyped value must not mean "everybody".
- **Email must be verified** wherever a password registration is allowed
  (`verifyEmail: true`); it is what an invitation is matched against
  (ADR-0011 §6). A brokered login's email is taken as verified only from a
  provider that says it is.
- **Google and Microsoft are enabled per installation**, by the same vault
  mechanism as GitHub. A company owner is more likely to have either than a
  GitHub account.

Admission still grants nothing: a newly admitted person has no membership and
sees §5.

### 2. Organization creation has three settings: open, request, off

`studio-organizations.self_service` becomes a three-valued setting:

```yaml
studio-organizations:
  config:
    self_service: request   # open | request | off
    max_owned: 1            # organizations one person may own through this path
```

| value | the person without an organization may | used by |
|---|---|---|
| `open` | create one at once and own it | a cloud with billing; local and desktop |
| `request` | ask for one; a platform administrator decides | a cloud before billing |
| `off` | nothing; they are joined on first login or invited | an installation inside one company |

`true` and `false` keep reading as `open` and `off`, so no existing
configuration changes meaning. `max_owned` counts active `owner` memberships
whose `source` is a creation or an approved request; a platform
administrator's appointment (option 4) does not count against it.

`GET /studio-organizations/v1/capabilities` answers
`organization_creation: "open" | "request" | "off"` and keeps
`self_service: bool` (true only for `open`) for clients that read it today,
the portal's gate and the desktop's landing widget.

### 3. An organization request is a record studio-user keeps

A request is a person asking to become the owner of an organization that
does not exist yet: a fact about a person and a membership to be, so its
owner is studio-user (ADR-0040 §1), next to invitations, which are the same
kind of thing in the other direction.

```text
organization_request
  id                 uuid — also the id the organization will have
  requested_by       person id (ADR-0025)
  name               the organization's name, cleaned as create cleans it
  note               free text: who they are, what they want it for
  status             pending | approved | rejected | withdrawn
  decided_by         person id of the platform administrator
  decided_at, reason
  created_at
```

- A person has **at most one pending request**, and none at all while they own
  `max_owned` organizations. A second request is a 409 naming the first.
- The requester may **withdraw** a pending request.
- A rejection carries a reason the requester sees. A rejected person may ask
  again; there is no ban list here. Keeping somebody out is admission's job
  (§1) or the account's suspension.

Routes, under studio-user:

| route | who |
|---|---|
| `POST /studio-user/v1/me/organization-requests` | the person; refused unless creation is `request` |
| `GET /studio-user/v1/me/organization-requests` | the person; their own, newest first |
| `POST /studio-user/v1/me/organization-requests/{id}/withdraw` | the person, while pending |
| `GET /studio-user/v1/organization-requests?status=pending` | platform administrator |
| `POST /studio-user/v1/organization-requests/{id}/reject` | platform administrator |

Approval is §4's, because it creates an organization.

### 4. Approval creates the organization on the requester's behalf

`POST /studio-organizations/v1/organization-requests/{id}/approve`, platform
administrator only. studio-organizations is what creates organizations, so it
approves; it reads and settles the request through a studio-user interface on
the ClientHub (`OrganizationRequests`), never its tables.

- The organization is created with **the request's id as its id**. Approval
  then resumes the way `create` already resumes with `organization_id`: a
  repeated approve after a partial failure finishes the same organization and
  can never make a second one.
- The owner is **the requester, not the caller**. `record_creation` today makes
  the caller the owner; it gains a form that names the owner person, used only
  here. The membership's `source` is `request`, and the owner grant is written
  by `sync_owner_grant` as ADR-0040 §2 requires.
- The administrator may correct the name on approval. The request keeps what
  was asked for; the organization gets what was approved.
- The request is marked `approved` with the organization's id only after the
  membership exists. Until then it reads as pending, and approve can be
  repeated.

### 5. What the person without an organization sees

`OrganizationAccessGate` (and the desktop's landing) reads
`organization_creation`:

- **`open`**: as today, "create your own".
- **`request`**: a form with the name and a note, then the request's state:
  pending (with withdraw), or rejected with the reason and a way to ask again.
  When it is approved the organization is simply there: the gate re-reads the
  context, as it does after accepting an invitation.
- **`off`**: no control at all, as today.

Invitations addressed to the person are shown in every mode, above the rest.
An invitation is the faster way in, and accepting one does not withdraw a
pending request (the person may want both).

The platform administrator gets a **requests** list in the administration
view: who asked (name, verified email, how they signed in), the name and the
note, and approve or reject.

### 6. Members are still the owner's business

Approval is needed once per organization, not once per person. After it, the
owner invites people (ADR-0011 §5), and an invited person signs in, accepts
and works, without the platform administrator. This is the point of approving
the organization rather than the person.

## Consequences

- (+) A company owner signs up, asks, and after one yes runs their
  organization themselves; their people never wait for us.
- (+) The yes is a record: who asked, for what, who decided, when, why.
- (+) Moving to open signup is a setting (`request` → `open`), not a project.
- (+) ADR-0011 holds: admission and approval both grant nothing implicitly;
  the owner membership is a row with a source.
- (−) A cloud with open admission lets anybody create a person record. Persons
  without a membership hold no resources, but they accumulate; a sweep of
  never-active, membership-less persons is a follow-up.
- (−) The administrator learns about a request from the list, not a message,
  until §More Information step 5 is done. A request can sit unnoticed.
- (−) `record_creation` gains an "on behalf of" form. It is the one path where
  a caller makes somebody else an owner, and it must stay reachable only from
  approval.

## More Information

**Work, in order** (each one can merge alone):

1. **Admission switch.** `requireOrganization` on the GitHub provider, with
   tests; `verifyEmail: true`; Google and Microsoft wired to the vault per
   environment. dev and test configuration unchanged in effect.
2. **Creation setting.** `self_service: open | request | off` with the boolean
   compatibility, `max_owned`, `organization_creation` in capabilities;
   `create` refuses past `max_owned`.
3. **Requests in studio-user.** Table and migration, the `/me` and
   administrator routes of §3, the `OrganizationRequests` interface.
4. **Approval in studio-organizations.** The approve route, creation with the
   request's id, `record_creation` on behalf of the requester, `source:
   request`.
5. **Notifications.** A studio-events message to platform administrators on a
   new request, and to the requester on a decision; email when the
   installation has SMTP.
6. **Portal and desktop.** The gate's `request` mode (§5); the administrator's
   requests list.

**Later, not decided here:**

- **A Constructor IdP tenant as a reason to approve.** A person who signs in
  through the shared Constructor IdP and owns a Research tenant (ADR-0049) is
  a known customer; their request could be approved automatically, recorded as
  an approval by a rule rather than a person. That needs the Constructor IdP as
  a way to sign in to Studio, which ADR-0049 does not make it (it is a
  connection there), and its own record.
- **Quotas and billing**, after which a cloud may run `open`.

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-adr-users-onboarding-roles`
* `cpt-studio-adr-authentication-does-not-grant-organization-membership`
* `cpt-studio-adr-an-identity-proves-it-is-you-and-decides-nothing-else`
* `cpt-studio-adr-one-owner-for-people-and-membership`
