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
- **Restricted GitHub provider**: login is accepted only for active members of
  `constructorfabric`; see [`GITHUB_SSO.md`](GITHUB_SSO.md).
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

## Can somebody sign in as somebody else?

`keycloak/tests/account-takeover.test.mjs` asks a live Keycloak. Studio finds
a person by the token's `sub` alone and never by e-mail, so a caller becomes
somebody else only if Keycloak hands them that person's `sub`. The test makes
Keycloak do the logins that could:

- an external IdP account with the victim's e-mail, verified and unverified
  (nOAuth). The IdP is configured as the realm's google/github/microsoft are:
  `trustEmail=true` and the stock `first broker login`. The outcome must be
  that Keycloak asks for the existing account's password. A code for the
  victim's `sub` fails the test.
- a browser left signed in as the victim. Without `prompt=login`, the next
  sign-in in that browser is the victim's, with no form shown. That is browser
  SSO, and it is recorded rather than asserted: a client opts out by sending
  `prompt=login`, and the test asserts that this works.

It creates its own IdP realm, broker and victim under a random suffix and
deletes them afterwards. It skips when no admin API answers.

```bash
NODE_EXTRA_CA_CERTS=docker/keycloak/certs/dev-ca.pem node --test keycloak/tests/account-takeover.test.mjs
```

`KC_PUBLIC`, `KC_ADMIN`, `KC_BACKCHANNEL`, `KC_ADMIN_USER` and
`KC_ADMIN_PASSWORD` point it at another Keycloak.
