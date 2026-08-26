# ADR-0004: User onboarding, provisioning, and roles

Status: accepted · 2026-08-03

## Context

The domain model (v0.9.25) wants Members as control-plane citizens
provisioned through AM's pluggable IdP contract, Teams as grantees, and
access arriving as Role Grants (member × role × scope). Today the OIDC
profile validates Keycloak tokens, but user provisioning ran through the
static echo plugin — an "Invite" created an AM-side record and nobody in
the IdP, so invited people could not actually sign in. Authorization is
static allow-all; the Studio PDP is a parked milestone.

## Decisions

1. **Invite-first onboarding.** Admins invite by username/email from the
   Members view. Self-registration with an approval queue (Keycloak
   self-reg → pending sign-in without `tenant_id` → admin approves) is
   phase 2 — it needs an approval surface and SMTP, and adds nothing the
   demo scenarios require now.
2. **Provisioning via `keycloak-idp-plugin`** (in-crate,
   `studio-backend/src/keycloak_idp_plugin.rs`), implementing AM's
   `IdpPluginClient` against the Keycloak Admin API:
   - invite → realm user with the `tenant_id` attribute and a temporary
     password (`UPDATE_PASSWORD` forced at first sign-in);
   - remove → realm delete (404 folds to success per the contract);
   - list → attribute-query snapshot + the same OData filter/cursor walk
     as the static plugin (copied, attributed);
   - tenant provision/deprovision succeed with no metadata: tenants map
     to an attribute, not to realm resources;
   - `update_user` stays `UnsupportedOperation` until the portal grows a
     user-edit surface.
   Selection: same vendor (`cf`), priority 50 beats the echo plugin's
   100; with no `client_secret` configured the plugin self-deprioritizes
   to 10000 so static-token profiles keep their echo behavior.
   Admin API access uses the confidential client `studio-admin`
   (service account, `realm-management`: manage/view/query-users) from
   the imported dev realm.
3. **Roles wait for the PDP.** No role UI until enforcement exists — a
   role picker backed by allow-all authz would be an illusion of access
   control. The Members view keeps naming Role Grants as the coming
   model; grants storage lands together with the Studio PDP.

## Phases

- **P1 (this ADR):** invite-first, Keycloak provisioning, no roles.
- **P2:** self-registration + approval queue (pending users = realm users
  without `tenant_id`; approval assigns the tenant), SMTP invite mails,
  `update_user`.
- **P3:** Role Grants + Studio PDP (authz plugin replacing allow-all),
  layered over the tenant model (roles narrow within tenant isolation, never
  across it — ADR-0009), Teams as grantees (RG user-group containers).

## Consequences

- An invite is now atomic across AM and the IdP via AM's provisioning
  saga; duplicate usernames surface as canonical 409s.
- The dev realm gains a service account able to manage users — dev-only
  credentials, rotate for any shared deployment.
- Deleting a member in the portal deprovisions the Keycloak user (their
  sessions die with it).
