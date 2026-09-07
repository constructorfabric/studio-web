# ADR-0012: Identity resolution is self-service, and only a proof of control binds

Status: **proposed** · Date: 2026-09-07 · Amends ADR-0001 · Builds on ADR-0011

## Context

ADR-0001 decided that Studio needs a gear owning `external identity (system, ref) →
platform user`, and left three follow-ups open, one of them "the connector contract
that feeds `proposed` links". Nothing was built.

Meanwhile the need became concrete. `connectors/graph_sync.rs:292` keys
knowledge-graph person nodes as `person:{login}` — a provider login string, with the
provider not even in the key. So today:

- the same human is a different person node in every provider,
- a GitHub `alice` and a GitLab `alice` are silently the **same** node,
- and no person node connects to a Studio identity at all.

The neighbouring product (Insight, `services/identity-resolution`) has a mature
implementation of this problem — ~28k lines, an append-only observation journal, a
derived review queue, operator verbs. But its trust model is the inverse of ours, and
that is not a UI difference. From its `domain/provenance.rs`:

> `Resolved` — *"Matched on an address, or reused from an earlier run. The address is
> the evidence, so nothing is left to confirm."*

Insight treats an e-mail match as a settled fact and lets automation bind on it,
because an operator stands behind the whole dataset and can correct it. Studio has no
such operator, and cannot have one: nobody but the person knows which GitLab account
is theirs, and the person is the party with the interest in getting it right.

An e-mail match is also *not evidence* in our setting. A commit author address is
whatever the committer put in `git config user.email` — unauthenticated, trivially
spoofed. Under Insight's rule that value binds; under ours it can only be a guess
shown to a human.

## Decision

### 1. Only a proof of control binds. Everything else is a proposal.

Three strengths of observation, and only the strongest attributes anything:

| strength | meaning | attributes? |
|---|---|---|
| `verified` | the provider confirmed the caller controls the account | **yes** |
| `claimed` | the subject asserted the account is theirs, unproven | no |
| `suggested` | the system noticed a similarity (address, login) | no |

A `suggested` row exists to be shown to the person it is about. A `claimed` row
records intent and survives until a ceremony upgrades it. Neither ever reaches the
knowledge graph, an authorization decision, or a report.

### 2. The ceremony already exists — it was being thrown away

`ConnectorDriver::test()` (`connectors/driver.rs`) asks the provider "who am I?" using
the **caller's own credential** and returns `DriverIdentity { account, display_name }`:

- `connectors/github.rs:205` → `GET /user` → `login`
- `connectors/gitlab.rs:59` → `GET /api/v4/user` → `username`
- `connectors/bitbucket.rs:99` → `GET /user`

A PAT is issued by the account it authenticates as, so a successful `test()` is a
proof of control — a stronger one than any operator assertion. The result is already
persisted in `Connection.account` ("Account the credential resolved to when it was
verified"). What was missing is only that the connection record does not name the
**person**: it carries `owner_tenant_id` and no `created_by`. So a verified
`(provider, account)` pair sat in the catalogue with nothing to attach it to.

Keycloak `federated_identities` (already read by `identity_directory/service.rs:58`)
is a second free channel: logging in through the GitHub broker is itself a proof of
control over that GitHub account.

### 3. Verification-wins, and nothing else blocks

For one `(tenant, provider, account)`:

1. take each subject's newest observation;
2. drop subjects whose newest observation is a revocation;
3. the binding is the subject whose newest observation is `verified`, most recent
   first;
4. every other live subject is a proposal, never a binding.

An unverified claim therefore blocks nothing — it cannot deny, delay or contest a
verification. Two live verifications on one account do not block either: the most
recent one wins and the account is flagged `contested` for reporting.

**Accepted consequence:** a credential shared by two people (a team bot PAT typed in
twice) will flap between them. That is the price of "nothing blocks", and it is
bounded by §4: a shared credential is not supposed to travel this path at all.

### 4. Only a personal credential is a self-claim

A `workspace`- or `organization`-scoped connection is a team or bot credential:
`test()` proves control of *an* account, not of the caller's own. The fold therefore
skips it. That is what keeps bot commits from being attributed to whoever configured
the bot — an unclaimed account is unbound, and unbound attributes nothing.

The model still carries a reserved **excluded subject** (`ffffffff-…-ffffffff`,
unmintable because no UUID version produces all-ones) meaning "not a human", a direct
lift of Insight's `EXCLUDED_PERSON` (`domain/resolution.rs:17`). It is what
distinguishes *decided* not-a-human from merely unclaimed — the graph sync drops an
excluded account's person node entirely rather than writing an unresolved one.

But v1 never *writes* it automatically. Marking an account as a bot from the mere
presence of a shared connection would let a later org-scoped connection override an
earlier personal verification (§3 says the newest verification wins), quietly turning a
real person into "not a human" because they lent their PAT to a workspace. Recording
an exclusion stays an explicit act, and the endpoint for it is a follow-up.

A personal connection whose creator is unknown — a catalogue row written before
`Connection.created_by` existed — is skipped for the same family of reason: there is a
proof, but nothing says whose.

Editing a personal connection is also restricted to its creator, which it was not
before. The record is now evidence, and rotating a token re-stamps `Connection.account`
while `created_by` stays put; without that guard a tenant member could point somebody
else's personal connection at an account of their choosing and have the verification
recorded against that person.

### 5. Journal, not status column

One append-only table. A claim, a verification and a revocation are separate rows;
nothing is updated in place. `UNIQUE (tenant, provider, account, subject, kind)`
collapses a repeat of the *same* act into a touch of `observed_at`, which is what
makes re-running suggestion generation idempotent.

This is Insight's shape and it survives the trust inversion intact, because a
self-service flow has *more* transitions to audit than an operator one
(`suggested → claimed → verified → revoked → verified`), and "who claimed what, when,
and on what evidence" is precisely the question a dispute asks. It also means a
verification outlives the connection that produced it: deleting a PAT does not
silently un-attribute a year of commits.

The trade-off: with one row per `(account, subject, kind)`, a verify → revoke → verify
cycle keeps two rows and two timestamps, not four events. Full event history would
drop the unique constraint and need Insight's `observation_slot.rs` collision
allocator; that is deliberately not taken in v1.

### 6. Tenant-scoped

Claims are scoped by the organization tenant, like every other row in this backend.
A human in two organizations claims twice.

Rejected the alternative (a global claim store keyed by Studio identity) for three
reasons: SecureConn is the outer boundary per ADR-0009 and this would need a
deliberate cross-tenant authority; "this person also has this GitHub account" is a
disclosure that should not cross an organization boundary; and the graph the claims
feed is per-tenant regardless. Verification is cheap enough to repeat.

## What is taken from Insight, and what is not

**Taken (as ideas, re-implemented on Postgres):**

- the append-only observation journal;
- "derived, never stored" for the queue — an item exists only while its condition
  holds, so a decision removes it with no item lifecycle to maintain
  (`domain/review_queue.rs`);
- the excluded-subject sentinel for bots and service accounts;
- one vocabulary owned in both directions so the write and read sides cannot disagree
  (`domain/provenance.rs`).

**Not taken:**

- e-mail matching as a binding rule — inverted to `suggested` (§1);
- operator verbs `bind`/`merge`/`detach`/`exclude` — replaced by
  `claim`/`verify`/`revoke` by the subject. `merge` has no self-service form: it is an
  assertion about a second person;
- `login_bootstrap` / person minting — unnecessary. Per ADR-0011 a Keycloak login
  already establishes a stable identity, so the platform subject always exists and the
  only open question is which external accounts attach to it;
- `observation_slot.rs` — see §5;
- roles, visibility, org-chart, subchart — Insight's own domain;
- MariaDB DDL, ClickHouse ingestion, `insight_tenant_id` tenancy, and the separate
  service host with its own pinned toolkit.

## Consequences

- (+) The person with the knowledge and the interest does the work; no operator queue
  on the main path.
- (+) The strongest evidence available (provider-confirmed control) replaces the
  weakest (an unauthenticated commit header).
- (+) The knowledge graph gets one person node per human across providers.
- (−) Attribution is incomplete until people claim. Historic commits from unclaimed
  accounts stay unattributed rather than being guessed at — the deliberate trade.
- (−) Changing the graph person key orphans existing `person:{login}` nodes; they are
  re-created under the new key on the next sync and the old ones need a one-off sweep.
- (−) A contested account needs somewhere to be seen. v1 only flags it; the admin view
  is a follow-up.

## Follow-ups

1. Suggestion sources. v1 generates no `suggested` rows at all — the kind exists, is
   resolved and is rendered, but nothing writes one yet, so the only way onto the list
   is to claim or to verify. The sources to add: commit author addresses from the graph,
   Keycloak e-mail, `federated_identities`, login equality across providers.
2. An explicit "this is a bot" act, writing the excluded subject (§4).
3. An admin view for `contested` accounts.
4. Sweep orphaned `person:{login}` graph nodes.
5. Two verified accounts of one person contributing to the same repository collapse
   onto one person node, so their two `contributed_to` edges collide on
   `(src, dst)` and the commit count of whichever lands last wins. Needs either an edge
   discriminator or a summed count.
6. Decide whether a verified claim should also be usable for authorization (today it is
   attribution only).
