# ADR-0018: An identity proves it is you; the person decides everything else

Status: **proposed** · Date: 2026-09-11 · Supersedes ADR-0011 §3 and §4 · Extends ADR-0014

## Context

ADR-0006 gave Studio a canonical person, ADR-0014 made it reachable from any
gear, ADR-0015 confirmed brokered logins onto it, ADR-0016 gave membership a
writer and a reader. Each of those fixed one consumer that had been keyed on the
sign-in method instead of the human.

Mapping the subsystem afterwards showed the pattern was not a series of
oversights but a missing rule. Three examples, all live:

- **Settings.** The platform's settings gear files a row under
  `(ctx.subject_id(), ctx.subject_tenant_id())`. Its field is called `user_id`
  and it holds an identity. The name is what hid the defect: nobody noticed that
  *user* and *identity* had come apart, so a person signing in the other way
  silently lost their theme. ADR-0017 took the gear over.
- **Administrative rights.** `config/oidc.yaml` maps the Keycloak user attribute
  `tenant_id` into `subject_tenant_id`, and three comparisons against the
  platform root — guarding eight administrative routes between them — decide
  from it whether the caller is a platform administrator. The
  attribute belongs to a Keycloak user — that is, to a *login*. A person with
  two logins can be a platform administrator through one and an ordinary member
  through the other.
- **Which organizations you see.** Same claim, same consequence, on the portal's
  organization list.

That last pair is the sharp end: **rights that depend on which way you signed
in.** Nobody decided that; it is what happens when no rule says otherwise.

A second question arrived with it. Studio ships two ways — a cloud service where
people arrive with no organization, and an installation inside one company where
exactly one organization exists. The obvious move is a deployment mode flag with
branches behind it, and the obvious move is wrong: it doubles the state space of
every screen and every authorization path, and one of the two branches ends up
being the untested one.

## Decision

### 1. The rule

**An identity establishes that it is you. Everything you can see and do follows
from the person.**

Three layers, with owners that do not overlap:

| Layer | Owns |
|---|---|
| **Identity** (a login) | the provider, credentials, whether it is verified, when it was last used. Facts about *signing in* — and no product state. |
| **Person** (a user) | settings, profile, attributions, authorship. Everything the product is about. |
| **Membership** | `(person, organization) → role`. The only source of what a person can reach. |

The rule is not "identities own nothing". A security audit has to be able to say
*how* an action arrived, and that is an identity's fact. The line is that
product state hangs off the person, never off the way they got here.

This makes the earlier ADRs one thing rather than four: they were each moving a
consumer across that line.

### 2. Onboarding: a person arrives with no organization, and that is normal

Three states, none of which depends on how somebody signed in:

1. **No organization.** Create your own, or accept an invitation.
2. **Owner of their own.** They created it; they assign roles in it.
3. **Member of somebody else's.** By invitation; their role came from the owner.

**Creating an organization is self-service.** A person who can sign in can
create one and becomes its owner. In the cloud they may create as many as they
need — a personal one, a work one, one per client is a normal shape and the
organization switcher already handles it.

**Invitations ship with creation, not after it.** An owner who cannot invite
anyone has built a product for one. This also retires the dead end the
no-membership screen currently points at: it tells people to ask an
administrator, and there is no mechanism behind that sentence.

ADR-0011 §6 — single-use expiring invitation tokens bound to a verified
identity — stands unchanged. It stops being the *only* way in and becomes the
second one.

**The platform administrator resolves conflicts.** Enumerated, because an
unenumerated administrator becomes the answer to everything:

- take ownership of an organization whose last owner is gone;
- merge two persons who turn out to be one human;
- settle an external identity that two people claim (ADR-0012 follow-up 3);
- suspend an organization.

And explicitly **not**: create organizations for people, or appoint the owner of
every organization. Nobody's first day waits on an administrator.

The role is **per installation, not per vendor**. In the cloud it is us; in a
company's own installation it is their IT. The bootstrap that already seeds the
platform root seeds the first administrator with it.

### 3. Administrative rights become a property of the person

Platform administrator stops meaning "this token's tenant is the root" and
starts meaning **"this person holds a membership of the platform root"**.

The data already exists: ADR-0016's backfill wrote exactly that row for every
identity whose `tenant_id` attribute named the root. This also removes the last
reader of that attribute in an organization sense, which is what ADR-0016's
first follow-up was blocked on.

Migration, in the order that never leaves a gap — the same shape used for the
organization list:

1. the installation bootstrap seeds a root membership for the configured first
   administrator;
2. the server accepts **either** signal — a root membership or the token's
   tenant;
3. the token reading is deleted, and with it the `tenant_id` attribute's last
   purpose.

### 4. One product, two provisioning profiles

The domain model does not differ between cloud and a single-company
installation. Person, login, membership, role are identical, and so is every
authorization path. What differs is **how a person acquires their first
organization** — a provisioning policy, not a mode.

```yaml
organizations:
  self_service: true          # may a person create one?
  on_first_login: none        # or: join(<organization>, <role>)
```

- **Cloud:** `self_service: true`, `on_first_login: none`.
- **Inside one company:** `self_service: false`,
  `on_first_login: join(the_organization, member)`.

**Whether the organization switcher appears is derived from data, not
configured**: a person with one organization has nothing to switch to. One fewer
flag is one fewer untested path.

#### Automatic membership is not access derived from authentication

In a single-company installation, the first successful login creates a
membership of the one organization. That looks like the thing ADR-0011 §1
forbids, and it is not, for a reason worth stating precisely:

- an **auto-provisioned membership** is a row. It can be revoked — suspending a
  person in Studio without removing them from the corporate directory, which is
  frequently what the company actually wants. It is auditable: `membership.source`
  records that it came from a first login rather than from an invitation or an
  operator. Roles come from it.
- **access derived from authentication** follows the token, forever, and cannot
  be taken away short of deleting the account.

The deployment is making a statement — *the users of this identity provider are
the members of this organization* — and the statement is recorded as data.
ADR-0011 §1 stands: authentication still grants nothing by itself.

This matters more than it looks: today's single-company story rests on the
`tenant_id` attribute giving everyone the same home tenant. That attribute is
what §3 above deletes. Auto-provisioned membership is its replacement, and a
strictly better one, because an attribute cannot be revoked and a row can.

### 5. An organization has a name, not an address

Three things hide behind "organization name", and only one of them is in
question:

- the **id** — the account-management tenant uuid. It is already what the portal
  puts in its URLs. Not in question.
- the **display name** — "Constructor Fabric". Human-facing, freely editable.
- a **handle** — `…/acme/…` in a URL. If one exists it must be unique and
  *stable*.

**There is no handle.** Display names are free text and are not unique.

The case for a handle is real — readable URLs, links that survive being pasted
into a ticket, invitations that look trustworthy. The case against is that a
global namespace brings squatting, disputes, a reserved-word list and
confusables (`асme` with a Cyrillic а is a different string and the same
picture), and that a handle in a URL is a permanent commitment: renaming then
breaks links and needs a redirect history.

The asymmetry decides it. **A handle can be added later** — derived from the
names that exist, disambiguated where they collide. **It cannot be removed
later**, because by then it is in people's links. And the thing that usually
forces one, publicly shared URLs, does not exist here yet.

Two guards are worth having from the start, and only two: trim surrounding
whitespace and cap the length; and when a person creates an organization whose
name matches one they already belong to, **warn rather than refuse** — two
organizations called "Acme" is their business, and a refusal would be us
pretending to know better.

In a single-company installation the question does not arise: one organization,
named in configuration.

### 6. Leaving removes access, and takes the leaver's credentials with it

"Leaving" hides five different acts. Separated:

1. **A member leaves.** Always allowed; their membership row goes.
2. **An owner removes a member.** ADR-0011 §5, unchanged.
3. **The last owner leaves.** Refused until ownership transfers. The last-owner
   invariant from ADR-0011 §4 stands, and now has a self-service path into it —
   so **an owner may appoint another owner in their own organization**. (That
   sentence of §4 is superseded with the rest of it: without it, transfer would
   require an administrator and every departure would become a support ticket.)
4. **The last person leaves.** Leaving *is* deleting, said plainly and
   confirmed: "you are the only person here — leaving deletes this
   organization". The alternative is ownerless organizations accumulating for an
   administrator to sweep, which is the manual work this ADR exists to remove.
5. **Everybody is gone, or the owner vanished.** The platform administrator's
   break-glass, per §2.

**Access goes; authorship does not.** Documents, projects and workspaces belong
to the organization and stay. Attribution in the knowledge graph stays with the
person who earned it. History is not rewritten because somebody left.

**But the leaver's credentials go with them.** This is not a refinement — it is
a leak in what exists today. `remove_membership` deletes one row and does
nothing else, while a *personal* connection the leaver created lives in the
organization's catalogue with their token in credstore. Today they leave and the
token stays, working, in an organization they are no longer part of. Under
ADR-0012 that same record is their proof of control over the external account,
so the organization also keeps holding their credential in the evidentiary
sense.

So leaving deletes the personal connections that person created in that
organization, and their secrets with them. The organization loses a working
integration and has to create its own — which is the correct outcome, because it
never owned that one.

**Suspension is not leaving.** An owner suspending somebody is a different act
with a different result: access stops, the row stays. `identity_membership` has
no `status` column today, though ADR-0011 §2 described one
(`invited | active | suspended | revoked`). Deleting the row is the right
implementation of *leaving*; suspension needs the status and is a separate
piece of work, gated with the rest of membership management by §7.

## What this changes in ADR-0011

**Superseded:**

- **§3** — "It must not expose … organization creation controls." The
  no-organization screen now offers exactly that.
- **§4** — "A platform administrator … may also create additional organizations
  and appoint an owner for each one", and "Only a platform administrator can
  appoint, replace, or revoke an organization owner." Ownership arises from
  creating an organization, and an owner may appoint another owner in their own
  organization — without which no owner could ever hand over and leave (§6).
- **§4's bootstrapped default organization** goes with them. The bootstrap seeds
  the platform root and the first administrator; people create their own. (A
  consequence of the model rather than a separate decision — flagged as such
  because it removes something a deployment may be relying on.)

**Unchanged, and load-bearing:**

- **§1** — authentication does not grant organization membership. Self-service
  creation does not make anybody a member of anybody else's organization, and
  §4's sentence "Authentication alone can never produce ownership or membership"
  survives in substance: it is the *act of creating* that produces ownership.
- **§2** — explicit membership is the authority for organization access.
- **§6** — invitations.
- **§7** — membership and roles are enforced server-side before a
  membership-management UI ships. Still the gate, and still not met:
  `privilege_for` returns `None` unconditionally, so the PDP's grant branch
  remains unreachable.

## Consequences

- (+) One rule replaces a pattern of individual defects, and says where the next
  piece of state belongs without another argument.
- (+) The no-organization state stops being a waiting room. Nobody's first day
  depends on an operator.
- (+) Cloud and single-company stop being two products. Two settings and one
  derived UI rule cover the difference.
- (+) `membership.source` acquires its first real reader: an owner's member list
  can show how each person got in.
- (−) Creating an organization is three writes across two systems — the AM
  tenant, the owner's membership, and the access-config grant the PDP reads. It
  must be one server-side operation and idempotent on retry, or a failure leaves
  an organization nobody owns. Today the portal calls account-management's
  `createTenant` directly from the browser, which cannot do this.
- (−) In a single-company installation the no-organization state becomes
  unreachable on the happy path, so it risks being untested exactly where most
  customers run. It stays reachable through a revoked or suspended membership,
  and must be tested there.
- (−) Auto-join means a new hire reaches Studio the moment IT adds them to the
  directory. That is the intent, and it means membership grows without anyone in
  Studio acting — which is why the owner's member list showing `source` is part
  of the deal, not a nicety.
- (−) Leaving has to delete the leaver's personal connections and secrets, which
  nothing does today — `remove_membership` deletes one row and stops. Until that
  lands, "leave" would look done while the credential stayed behind.
- (−) Self-service creation is safe while admission is gated (today: active
  members of the `constructorfabric` GitHub organization). If sign-up ever
  opens, a per-person quota becomes a precondition, not an improvement.

## Follow-ups

Numbered in the order they were built, which is the order each one unblocked the
next. Eight of the nine have shipped; what each note says is what it turned out
to mean once it was built, because several of them meant more than they looked
like from here.

1. **The tenant clamp comes from membership, not from the token.** Moved to the
   front by what building §2's create operation found: the PDP clamps every
   request to the subtree of `subject_tenant_id`, the home tenant of the
   *login*, so a person who creates an organization under the platform root
   cannot then read or administer it — the tenant and the membership are
   written and the owner grant fails with "tenant not found". Administrative
   rights were the visible half of the rule; the clamp is the other half, and
   nothing self-service works until it moves. **Shipped.**
2. **One server-side "create my organization" operation**, idempotent, writing
   the tenant, the owner membership and the owner grant together. Built and
   verified; it cannot be released to ordinary people before (1). **Shipped**,
   and since reached from the portal: the no-organization screen offers creating
   one and accepting an invitation waiting for you, and asks this installation
   which of the two it allows before offering either. Accepting from that screen
   needed one change the backend had not anticipated — the token is never
   stored, so the portal had nothing to send, and an acceptance now takes the
   invitation's id as well. It is no weaker: that listing exists because the
   server matched the invitation to an address the person has proven.
3. **Invitations** (ADR-0011 §6), shipped with it — and, like it, gated on (1).
   **Shipped.**
4. **Platform administrator as a root membership**, in the three migration steps
   of §3 above. **Shipped.**
5. **`on_first_login` provisioning** for the single-company profile. **Shipped.**
6. **Leaving**, with the credential cleanup of §6 in the same operation, and
   owner-to-owner transfer so the last owner can hand over. **Shipped.** The
   last-owner rule turned out to belong in one place rather than on the leaving
   route: removal, demotion and later suspension can each end the last
   ownership, so all of them ask one question about the room as it would be
   afterwards. `remove_membership` was deleted rather than left beside it — a
   second door that skipped the rule and left the credentials behind is what the
   piece existed to close. The other end of §6.4 followed: deleting an
   organization undoes creating one in reverse — every membership and every
   member's personal connections first, the tenant last, because the catalogue
   holding those connections lives inside it.
7. **Retire the `tenant_id` attribute** once §3 lands — the last thing keeping
   ADR-0016's follow-up open. **Shipped.** Two gates read the token, and with
   both readings gone the compiler found that the platform-root constant in each
   file had no other user, which is the cleanest evidence the step was complete.
   Removing a signal can lock people out, so every profile now names its
   administrator: an installation that names nobody has none, and says so at
   boot. The token's tenant still bounds what a request may *reach* — that is
   context, not authority, and it is what a service account has instead of a
   membership.
8. **`membership.status`** for suspension (ADR-0011 §2), when membership
   management ships. **Shipped.** `active | suspended`; the other two states
   ADR-0011 listed are covered elsewhere — `invited` is a row in the invitation
   table, and `revoked` is the absence of the membership. A suspended membership
   grants nothing while it stands and still records where somebody belongs and
   in what role, so a suspended owner is not an owner who can act, and the rule
   from (6) refuses a suspension exactly where it would refuse a removal.
9. **Enforcement** — ADR-0011 §7 is still unmet, and the membership-management
   UI this ADR describes is exactly what it gates. **Open, and deliberately
   not attempted with the rest.** Everything above is enforced today by the
   gears themselves: an organization write needs an owner or a platform
   administrator, membership decides the tenant clamp, and a suspended
   membership reaches nothing. What is still missing is the *policy* half —
   `privilege_for` maps no resource type, so the Studio PDP answers every
   request with the tenant clamp and the grant evaluation beside it is
   unreachable. Turning that on means naming the privileges, the roles that
   carry them and the grants that hold them, and getting any of it wrong denies
   requests that work today. It is a piece of work with its own risk and its own
   ADR, not a coda to this one.

## What is left after all of this

Two things, both named above and neither blocking what shipped:

- **(9)**, the policy half of enforcement.
- **The clamp still admits the platform root from a token.** A service account
  has a tenant and no memberships, and creating an organization happens under
  the root before any membership exists, so the root cannot simply be dropped
  from what a token may reach. It grants nothing administrative any more — (7)
  saw to that — but somebody whose identity provider puts them in the root can
  still *see* the tenant tree. Closing it means telling a person from a service
  apart, which is a question about the platform's subject model rather than
  about Studio's.
