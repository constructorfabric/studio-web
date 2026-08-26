# Constructor Studio — Keycloak image

Custom Keycloak runtime for the DMZ and Kubernetes deployments (INFRA-3767 → real SSO).

The public image deliberately contains no realm or credentials. Kubernetes must
mount an environment-specific `realm-studio.json` from a Secret at
`/opt/keycloak/data/import/realm-studio.json` before starting with
`--import-realm`.

- **Optimized build** (`kc.sh build --db=postgres`) with `/auth` baked into the
  runtime; the environment realm is mounted separately for first-boot import.
- **Native social login**: Google / GitHub / Microsoft are Keycloak's built-in
  identity providers; the realm defines all three.
- **Secrets stay out of the image**: social client id/secret are `${vault.*}`
  references resolved at runtime by the files-plaintext vault (`KC_VAULT=file`,
  `KC_VAULT_DIR`) from a mounted Secret. Files are named `studio_<key>`, e.g.
  `studio_google-client-secret`.
- Built and pushed by `release.yml` with the same immutable tags as the other
  runtime images and pulled directly from public GHCR.

Env-specific, non-secret values (`KC_HOSTNAME`, `KC_PROXY_HEADERS`, DB connection,
`KC_BOOTSTRAP_ADMIN_*`) are supplied by the Helm chart at runtime, not baked.

## Realm seeds

The source realm file is development/reference material only and is not copied
into the image. A deployed realm must be generated independently per environment:

- keep only the required human `admin` and technical service-account identity;
- generate a temporary random admin password and force its change on first login;
- generate independent confidential-client secrets;
- store the complete realm JSON in an environment-local Kubernetes Secret.

## Social self-registration — app dependency
Brokered users are mapped to a non-root **sandbox** tenant (`…0002`), never root.
End-to-end self-signup still needs the app to JIT-provision a real per-user tenant;
until then social users share the sandbox tenant. Tracked as a follow-up.
