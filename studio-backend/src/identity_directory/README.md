# studio-identity-directory

A platform-admin view of the identities that exist in Keycloak, including the
ones that belong to no organization yet.

The design — why the gear exists, what an attribute does and does not prove,
the order an assignment is written in, the REST surface and the interface it
serves `studio-user` — is
[`docs/design/studio-identity-directory.md`](../../../docs/design/studio-identity-directory.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-identity-directory`, capabilities `[rest]`, deps
  `account_management`.
- No config section. The Keycloak admin connection comes from the environment:
  `STUDIO_IDP_ADMIN_BASE_URL` and `STUDIO_IDP_ADMIN_SECRET` (realm `studio`,
  client `studio-admin`). Without either, the routes answer 503 rather than
  failing the boot, and [`../user_profile`](../user_profile) loses its IdP
  proof channel and its verified addresses.
- Membership is recorded through `studio-user`; without its database the
  assignment still writes the IdP side and the backfill answers 503.

## Working here

- The projection's decisions — who is listed, which status, the sort, the page
  offsets — are unit tests in `service.rs`, built from the JSON Keycloak
  actually sends, so a renamed field is caught there.
- Keycloak ships no federated identities on a user representation; they come
  only from `GET /users/{id}/federated-identity`, one user at a time.
