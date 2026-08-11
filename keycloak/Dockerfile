# Constructor Studio — custom Keycloak image.
# Optimized build (baked provider/db config) + the studio realm baked for
# --import-realm, so deploy is "just run it". Social-provider secrets are NOT
# baked: the realm references ${vault.*} and the files-plaintext vault reads
# them from a Secret mounted at KC_VAULT_DIR at runtime.
ARG KEYCLOAK_VERSION=26.7

# ---- optimized build stage ----
# Build-time options (db, health, metrics, vault provider) MUST be set here so
# `start --optimized` accepts them at runtime without re-augmentation.
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION} AS builder
ENV KC_DB=postgres
ENV KC_HEALTH_ENABLED=true
ENV KC_METRICS_ENABLED=true
ENV KC_VAULT=file
RUN /opt/keycloak/bin/kc.sh build

# ---- runtime stage ----
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}
COPY --from=builder /opt/keycloak/ /opt/keycloak/
# Realm baked for first-boot import (idempotent: skipped if realm exists).
COPY realm-studio.json /opt/keycloak/data/import/realm-studio.json
# Files-plaintext vault: secrets live in files at KC_VAULT_DIR (mounted Secret),
# referenced from the realm as ${vault.<key>} -> file <realm>_<key>, e.g.
# studio_github-client-secret. KC_VAULT (provider) is baked above; the dir is a
# runtime path.
ENV KC_VAULT_DIR=/opt/keycloak/data/vault
# Non-secret, env-specific values (hostname, proxy, db conn, admin bootstrap)
# are supplied at runtime by the Helm chart, not baked here.
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
