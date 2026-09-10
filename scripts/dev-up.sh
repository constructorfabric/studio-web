#!/usr/bin/env bash
# One-command local bring-up that survives a FRESH / empty Postgres volume.
#
# Why this exists: on a brand-new database the LLM chain's `oagw` gear deadlocks
# in its post_init — it resolves the ROOT tenant, but account-management only
# seeds the root later, in its serve phase (after every gear's post_init). So a
# clean first boot with the llm chain on dies before the root can be created.
#
# We break the cycle in two steps, no manual hacks:
#   1) run a no-LLM backend (built --no-default-features, `bootstrap` profile) —
#      it has NO oagw, reaches serve, and seeds the root tenant;
#   2) stop it and start the normal stack (llm chain on), which now finds the
#      root and boots cleanly.
# Idempotent: on a warm volume the root already exists, so step 1 is a fast no-op
# and step 2 works on its own too.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> infra: postgres + keycloak"
docker compose up -d postgres keycloak

echo "==> step 1/2: seeding root tenant via a no-LLM backend (bootstrap profile)"
# --wait blocks until the bootstrap backend is healthy; healthy == it reached the
# serve phase == account-management's bootstrap saga has seeded the root tenant.
docker compose --profile bootstrap up -d --build --wait backend-bootstrap

echo "==> root seeded — removing the bootstrap backend"
docker compose --profile bootstrap rm -sf backend-bootstrap

echo "==> step 2/2: full stack (backend + frontend, llm chain on)"
# Built by name rather than with `up --build`: the backend now waits for the
# session-image service, and `--build` would rebuild the Theia image — ten
# minutes — on every single run. `up` still builds it when the tag is missing,
# which is the first run and after `docker compose build session-image`.
docker compose build backend frontend
docker compose up -d backend frontend

# The session image is the one thing `up` does not rebuild once it exists —
# deliberately, it is a ten-minute build — so say when it has fallen behind
# the checkout instead of letting a session start on yesterday's agents. This
# is exactly how a session came up without the `claude` CLI while the fix sat
# in the working tree.
image_built=$(docker image inspect cf-studio-theia:local --format "{{.Created}}" 2>/dev/null || true)
if [ -n "$image_built" ]; then
    head_at=$(git log -1 --format=%cI 2>/dev/null || true)
    if [ -n "$head_at" ] && [ "$(date -d "$image_built" +%s 2>/dev/null || echo 0)" -lt "$(date -d "$head_at" +%s 2>/dev/null || echo 0)" ]; then
        echo
        echo "==> NOTE: cf-studio-theia:local was built $image_built, before HEAD ($head_at)."
        echo "    A new session would start on the older image. Refresh it with:"
        echo "      docker compose build session-image"
    fi
fi

echo
echo "==> done."
echo "    Portal:   http://localhost:8080   (sign in: studio-admin-token)"
echo "    API/docs: http://localhost:8090/cf/docs"
