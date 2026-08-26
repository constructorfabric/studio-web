# Constructor Studio — custom Keycloak image.
# The image contains only the optimized Keycloak runtime. Environment realms
# and every credential are supplied at runtime; a public image must never carry
# a usable bootstrap realm or client secret.
ARG KEYCLOAK_VERSION=26.7

# ---- optimized build stage ----
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION} AS builder
ENV KC_DB=postgres
ENV KC_HEALTH_ENABLED=true
ENV KC_METRICS_ENABLED=true
ENV KC_VAULT=file
ENV KC_HTTP_RELATIVE_PATH=/auth
ENV KC_HTTP_MANAGEMENT_RELATIVE_PATH=/
RUN /opt/keycloak/bin/kc.sh build

# ---- runtime stage ----
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}
COPY --from=builder /opt/keycloak/ /opt/keycloak/
# Files-plaintext vault: secrets live in files at KC_VAULT_DIR (mounted Secret),
# referenced by the runtime realm mounted by the deployment.
ENV KC_VAULT=file
ENV KC_VAULT_DIR=/opt/keycloak/data/vault
# The realm JSON, hostname, proxy, DB connection and bootstrap admin are all
# supplied at runtime by the Helm chart and existing Kubernetes Secrets.
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
