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
docker compose up -d --build backend frontend

echo
echo "==> done."
echo "    Portal:   http://localhost:8080   (sign in: studio-admin-token)"
echo "    API/docs: http://localhost:8090/cf/docs"
