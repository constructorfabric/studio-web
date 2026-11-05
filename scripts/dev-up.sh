#!/usr/bin/env bash
# One-command local bring-up; an empty Postgres volume needs nothing extra.
#
# `backend-bootstrap` (a one-shot the backend waits for) creates and migrates
# the gear databases; the backend then seeds the platform root tenant in its
# serve phase. oagw >= 0.6 keeps its registry in a database and reconciles it
# in the background once that root exists, so a fresh volume no longer needs
# the no-LLM seeding run this script used to start first.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> backend + frontend (the database bootstrap runs first, on its own)"
# Built by name rather than with `up --build`: the backend now waits for the
# session-image service, and `--build` would rebuild the Theia image — ten
# minutes — on every single run. `up` still builds it when the tag is missing,
# which is the first run and after `docker compose build session-image`.
docker compose build backend backend-bootstrap frontend
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
