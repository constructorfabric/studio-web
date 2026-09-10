# studio-user

The canonical user: who a person *is*, independently of how they signed in.

## Why it exists

Keycloak authenticates. It does not answer "is the person who just logged in
with GitHub the same person who logged in with email last week", and neither
does account-management, whose users are scoped to one tenant. Without an
answer, the same human becomes several users, their work is split across the
copies, and nothing can be merged afterwards because nothing recorded that they
were the same.

So this gear owns a Studio-owned `user` record — the profile, deliberately
role-free — and the mapper that turns a token subject into a stable user id.

## Four things bind to that record

| Record | Is |
|---|---|
| `user` | the person; profile only, no roles |
| `login` | a sign-in method that resolves to them |
| `membership` | an organization plus the role held **there** |
| `alias` | a non-login identifier (an email, a handle) they claim |

Roles live on the membership, not on the user, because a role is a fact about a
person *in an organization* — ADR-0009. Aliases are claimed and confirmed
rather than asserted (`alias_policy.rs`), so an unconfirmed alias cannot be used
to absorb someone else's account.

## Storage, and why it is not a graph

Its own relational database (SeaORM). The records are looked up and
constrained — unique logins, one membership per `(user, org)` — not traversed.
A graph projection for visualization and path-finding is a later, derived
concern; ADR-0006 says so explicitly.

**No database configured → the gear stands down**, and its routes answer 503
rather than failing the boot. Same stance as
[`../credstore_pg`](../credstore_pg).

## REST

| Method + path | Does |
|---|---|
| `GET`/`POST /me` | the caller's own profile |
| `GET /me/logins`, `GET /me/memberships`, `GET /me/aliases` | what binds to them |
| `POST /me/aliases[/confirm\|/revoke]` | claim, confirm or drop an alias |
| `POST /resolve` | token subject → stable user id (the mapper) |
| `POST /merge` | fold one user into another, moving logins, aliases and memberships |
| `GET /users/{id}`, `GET /users/{id}/memberships` | the administrative view |
| `PUT`/`DELETE /users/{id}/memberships/{org}` | grant or remove a role in an organization |

## In the assembly

- Gear `studio-user`, capabilities `[rest, db]`, deps `account_management`.
- Config section `gears.studio-user`.
- The unassigned-identity view is [`../identity_directory`](../identity_directory);
  see `docs/adr/0001-identity-mapping.md` and
  `docs/adr/0006-canonical-user-and-identity-mapper.md`.
