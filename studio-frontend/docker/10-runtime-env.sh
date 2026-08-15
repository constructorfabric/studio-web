#!/bin/sh
# Regenerates /usr/share/nginx/html/env.js from STUDIO_* environment
# variables at container start. nginx:alpine runs every /docker-entrypoint.d
# script before starting nginx — no custom ENTRYPOINT needed.
#
# The generated file sets window.__STUDIO_ENV__ (see src-app/app/config/env.ts): runtime
# values beat the build-time VITE_* fallbacks, so one image serves any
# environment.
set -eu

HTML_DIR="${HTML_DIR:-/usr/share/nginx/html}"

js_escape() {
  # Escape backslashes and double quotes for a JS string literal.
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

{
  echo "// Generated at container start by 10-runtime-env.sh — do not edit."
  echo "window.__STUDIO_ENV__ = {"
  [ -n "${STUDIO_OIDC_ISSUER:-}" ]    && echo "  OIDC_ISSUER: \"$(js_escape "$STUDIO_OIDC_ISSUER")\","
  [ -n "${STUDIO_OIDC_CLIENT_ID:-}" ] && echo "  OIDC_CLIENT_ID: \"$(js_escape "$STUDIO_OIDC_CLIENT_ID")\","
  [ -n "${STUDIO_DISCORD_URL:-}" ]    && echo "  DISCORD_URL: \"$(js_escape "$STUDIO_DISCORD_URL")\","
  echo "};"
} > "$HTML_DIR/env.js"

echo "[runtime-env] wrote $HTML_DIR/env.js (issuer=${STUDIO_OIDC_ISSUER:-<unset>})"
