#!/bin/sh
# Fresh-DB seeder entrypoint for the `backend-bootstrap` compose service.
#
# WHY THIS EXISTS
# On a brand-new Postgres volume the LLM chain's oagw gear aborts boot in its
# post_init phase: it resolves the platform root tenant, but account-management
# only seeds that root later, in its serve phase (see the toolkit phase order
# init -> post_init -> start). oagw therefore never sees a root and the whole
# process exits non-zero — a first-boot chicken-and-egg the main (llm-on)
# backend cannot break on its own, so it just crash-loops on a fresh volume.
#
# This wrapper runs the SAME image built --no-default-features (no oagw, no
# graph), which reaches its serve phase and seeds the root, then exits 0. The
# main backend is gated on `service_completed_successfully`, so it starts only
# once this has finished — against an already-seeded database. Idempotent: on a
# warm volume the root already exists, health flips green almost immediately,
# and this returns in seconds. No long-lived seeder container is left behind.
set -u

HEALTH_URL="http://127.0.0.1:8090/cf/health"
MAX_WAIT_SECS="${SEED_MAX_WAIT_SECS:-360}"

echo "bootstrap: provisioning configured PostgreSQL databases and applying migrations"
/app/studio-backend --config /app/config/docker.yaml bootstrap --apply

echo "seed: starting no-LLM backend to seed the platform root tenant"
/app/studio-backend --config /app/config/docker.yaml run &
BACKEND_PID=$!

# Poll the gateway health endpoint. It serves 200 only once the runtime has
# passed its serve phase — exactly when account-management's bootstrap saga has
# finished seeding (and, with the Keycloak IdP plugin, realm-binding) the root
# tenant. Give account-management's own retry loop time to ride out a Keycloak
# that is still importing its realm.
elapsed=0
while [ "$elapsed" -lt "$MAX_WAIT_SECS" ]; do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo "seed: backend exited before becoming healthy (see its logs above)" >&2
        wait "$BACKEND_PID" 2>/dev/null || true
        exit 1
    fi
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
        echo "seed: backend healthy — platform root tenant seeded; stopping seeder"
        kill "$BACKEND_PID" 2>/dev/null || true
        wait "$BACKEND_PID" 2>/dev/null || true
        exit 0
    fi
    elapsed=$((elapsed + 2))
    sleep 2
done

echo "seed: timed out after ${MAX_WAIT_SECS}s waiting for backend health" >&2
kill "$BACKEND_PID" 2>/dev/null || true
wait "$BACKEND_PID" 2>/dev/null || true
exit 1
