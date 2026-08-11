# Constructor Studio — Keycloak image

Custom, self-contained Keycloak for the DMZ deployment (INFRA-3767 → real SSO).

- **Optimized build** (`kc.sh build --db=postgres`) + the `studio` realm baked for
  first-boot `--import-realm`, so deploy is "just run it".
- **Native social login**: GitHub for now (Keycloak built-in provider). Google
  and Microsoft are built-in too and can be re-added to the realm later — the
  realm currently defines only `github`.
- **Secrets stay out of the image**: the social client id/secret are `${vault.*}`
  references resolved at runtime by the files-plaintext vault (`KC_VAULT=file`,
  `KC_VAULT_DIR`) from a mounted Secret. Files are named `studio_<key>`, e.g.
  `studio_github-client-secret`.
- Built and pushed by `release.yml` on `v*` tags (same as backend/frontend/theia),
  consumed in-cluster via the Harbor GHCR proxy.

Env-specific, non-secret values (`KC_HOSTNAME`, `KC_PROXY_HEADERS`, DB connection,
`KC_BOOTSTRAP_ADMIN_*`) are supplied by the Helm chart at runtime, not baked.

## Realm seeds
- `admin` — platform superadmin (root tenant `…0001`), temp password + forced change.
- `demo` — test user (root tenant for now; a separate-tenant regular user needs
  app-side tenant provisioning — follow-up).
- `mini-chat`, `studio-admin` — s2s clients (baked dev secrets; backend reads the
  same defaults). Harden by moving to kcadm-set secrets later.

## Social self-registration — app dependency
Brokered users are mapped to a non-root **sandbox** tenant (`…0002`), never root.
End-to-end self-signup still needs the app to JIT-provision a real per-user tenant;
until then social users share the sandbox tenant. Tracked as a follow-up.

## Callback URI (GitHub OAuth App)
`https://idp.dev.dmz.cnstr.me/realms/studio/broker/github/endpoint`
