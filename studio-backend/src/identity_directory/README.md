# studio-identity-directory

A platform-admin view of the identities that exist in Keycloak, including the
ones that belong to no organization yet.

## Why it exists

Account Management lists users only *inside* one tenant. That is the right
answer for almost everything and the wrong answer for onboarding: someone who
has signed in successfully but has not been assigned to an organization is, by
construction, in no tenant — so no tenant-scoped list can show them, and the
administrator who is supposed to place them cannot see that they are waiting.

ADR-0011 (authentication does not grant organization membership) makes that gap
deliberate rather than accidental. This gear is the view it needs.

## What it does not do

It keeps the Keycloak Admin API and its credential **server-side** and exposes a
root-scoped, read-only projection. The portal never talks to Keycloak, and the
directory is a projection rather than a second user store — the canonical user
record is [`../user_profile`](../user_profile)'s.

## REST

| Method + path | Does |
|---|---|
| `GET /studio-identity/v1/users` | every identity, with whether it is assigned |
| `POST /studio-identity/v1/users/{identity_id}/assignment` | place an identity into an organization |

## In the assembly

- Gear `studio-identity-directory`, capabilities `[rest]`, deps
  `account_management`.
- Config section `gears.studio-identity-directory`; without Keycloak admin
  credentials the routes answer that the directory is unavailable rather than
  failing the boot.
- See the repository-root `docs/adr/0011-authentication-does-not-grant-organization-membership.md`
  and `docs/adr/0012-self-service-identity-resolution.md`.
