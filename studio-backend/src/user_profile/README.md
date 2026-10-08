# studio-user

The canonical user: who a person *is*, independently of how they signed in.

The design — why the gear exists, the person and what binds to it, the alias,
invitation and last-owner rules, the REST surface, the interfaces it publishes
to other gears and the tables — is
[`docs/design/studio-user.md`](../../../docs/design/studio-user.md). This
README is what you need to work in the directory.

## In the assembly

- Gear `studio-user`, capabilities `[rest, db]`, deps `account_management`.
- Config section `gears.studio-user`: database `studio_users`, and
  - `platform_admins` — sign-in subjects that get a membership of the platform
    root at every start; an entry may hold several, comma-separated, and empty
    entries are dropped. With none, the gear warns at boot: nothing else makes
    a platform administrator.
  - `on_first_login` — `{organization, role}` a new person joins on first
    sight; `role` defaults to `member`, and `owner` is refused.
  - `service_account` — Studio's service identity (`subject`, `display_name`,
    `email`); a blank subject means the fixed
    `00000000-0000-4000-8000-00000000057d`.
- **No database configured → the gear stands down**: it publishes no
  interfaces and its routes answer 503 rather than failing the boot, like
  [`../credstore_pg`](../credstore_pg).
- The IdP proof channel and verified addresses come from
  [`../identity_directory`](../identity_directory); without it, brokered
  logins confirm nothing and invitations cannot be accepted.

## Working here

- The rules live in `alias_policy.rs`, `invitations.rs` and `leaving.rs`, with
  no I/O, so they are stated as unit tests there. Change a rule there, not in a
  route.
- Every change to a membership — written, deleted, merged — calls
  `memberships_changed()`, which bumps the generation the PDP's cache watches.
  A new path that skips it leaves the PDP answering from a stale organization
  list.
- A DTO name is global across the assembly's OpenAPI registry, which is why the
  membership DTO is `OrgMembershipDto`: a second `MembershipDto` panics the boot.
- This gear is the only owner of person and membership (ADR-0037). Another
  gear asks through a trait exported from `mod.rs`, never through `service` or
  `store`, and never keeps a copy. The owner grant in the access config is
  written by `sync_owner_grant` and nowhere else; a new path that records a
  membership calls it, and every grant it writes names the person id.
- Grant matching uses `grant_keys_of` (person id, then every login). The login
  arm is the migration seam for grants written before ADR-0037; it can go once
  `POST /grants/backfill` has run everywhere.
- `grants_tests.rs` covers the grant projection on Postgres with an in-memory
  account-management; like `store_tests.rs` it needs Docker
  (`cargo test user_profile`).
