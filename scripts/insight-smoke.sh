#!/usr/bin/env bash
# Smoke-test the Constructor Insight integration.
#
# Two halves, both optional-by-configuration:
#
#   1. The UPSTREAM, hit directly — proves the token is live and that Insight
#      still behaves the way src/insight/client.rs documents. Needs
#      STUDIO_INSIGHT_API_KEY (the .env next to docker-compose.yml has it).
#   2. The GEAR, through the running backend — proves the route, the gateway
#      prefix and the error mapping. Needs STUDIO_TOKEN (a portal JWT); skipped
#      with a note when it is absent.
#
#   STUDIO_INSIGHT_API_KEY=<token> scripts/insight-smoke.sh
#   STUDIO_INSIGHT_API_KEY=<token> STUDIO_TOKEN=<jwt> scripts/insight-smoke.sh
#
# Reads .env automatically when it is there, so in the usual case:
#   scripts/insight-smoke.sh
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `.env` is edited on Windows as often as not, and a CRLF line ending turns
# every value into one with a stray CR — source a stripped copy instead.
if [[ -f "$root/.env" ]]; then
  env_clean="$(mktemp)"; trap 'rm -f "$env_clean"' EXIT
  tr -d '\r' < "$root/.env" > "$env_clean"
  set -a; . "$env_clean"; set +a
fi

BASE_URL="${STUDIO_INSIGHT_BASE_URL:-https://insight.cfabric.org}"
SQL_URL="${BASE_URL%/}/api/sql/query"
BACKEND="${STUDIO_BACKEND_URL:-http://127.0.0.1:8090}"

pass=0 fail=0
# Some curl builds trip over Cloudflare's HTTP/2 in front of Insight
# ("stream was not closed cleanly: PROTOCOL_ERROR") — HTTP/1.1 is plenty here.
CURL_OPTS=(--http1.1)
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
note() { printf '  --   %s\n' "$1"; }

# Run a statement against the upstream; echo the body, then the status on its
# own last line. The statements below are literals with no double quote and no
# backslash in them, so they need no JSON escaping — keep it that way.
upstream() {
  curl -sS "${CURL_OPTS[@]}" --max-time 60 -w '\n%{http_code}' \
    -X POST "$SQL_URL" \
    -H "Authorization: Bearer ${STUDIO_INSIGHT_API_KEY}" \
    -H 'Content-Type: application/json' \
    --data-binary "{\"sql\":\"$1\"}"
}

echo "== upstream: $SQL_URL"
if [[ -z "${STUDIO_INSIGHT_API_KEY:-}" ]]; then
  note "STUDIO_INSIGHT_API_KEY is not set — upstream checks skipped"
else
  body=$(upstream 'SELECT 1 AS one'); code=${body##*$'\n'}; body=${body%$'\n'*}
  [[ "$code" == 200 && "$body" == *'"row_count":1'* ]] \
    && ok "SELECT 1 answers 200 with one row" \
    || bad "SELECT 1 -> $code $body"

  # The contract this integration leans on: read-only, one statement.
  body=$(upstream 'SHOW TABLES'); code=${body##*$'\n'}; body=${body%$'\n'*}
  [[ "$code" == 400 && "$body" == *'single SELECT or WITH'* ]] \
    && ok "a non-SELECT is refused with 400" \
    || bad "SHOW TABLES -> $code $body (expected 400 'single SELECT or WITH')"

  code=$(curl -sS "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' --max-time 30 \
    -X POST "$SQL_URL" -H 'Content-Type: application/json' -d '{"sql":"SELECT 1"}')
  [[ "$code" == 401 ]] \
    && ok "an unauthenticated call is refused with 401" \
    || bad "no-token call -> $code (expected 401)"

  body=$(upstream "SELECT count() AS n FROM system.tables WHERE database = 'insight'")
  code=${body##*$'\n'}; body=${body%$'\n'*}
  [[ "$code" == 200 && "$body" != *'"n":0'* ]] \
    && ok "the warehouse catalog is readable ($(printf '%s' "$body" | grep -o '"n":[0-9]*'))" \
    || bad "catalog query -> $code $body"
fi

echo "== gear: $BACKEND/cf/studio-insight/v1"
if [[ -z "${STUDIO_TOKEN:-}" ]]; then
  note "STUDIO_TOKEN is not set — gear checks skipped (see docs/insight-quickstart.md)"
else
  auth=(-H "Authorization: Bearer $STUDIO_TOKEN" -H 'Content-Type: application/json')

  body=$(curl -sS "${CURL_OPTS[@]}" --max-time 90 -w '\n%{http_code}' "${auth[@]}" \
    "$BACKEND/cf/studio-insight/v1/health")
  code=${body##*$'\n'}; body=${body%$'\n'*}
  [[ "$code" == 200 && "$body" == *'"reachable":true'* ]] \
    && ok "health reports the upstream reachable" \
    || bad "health -> $code $body"

  body=$(curl -sS "${CURL_OPTS[@]}" --max-time 90 -w '\n%{http_code}' "${auth[@]}" \
    -d '{"sql":"SELECT 1 AS one"}' "$BACKEND/cf/studio-insight/v1/query")
  code=${body##*$'\n'}; body=${body%$'\n'*}
  [[ "$code" == 200 && "$body" == *'"row_count":1'* ]] \
    && ok "query passes a statement through" \
    || bad "query -> $code $body"

  # The mapping that matters: Insight's rejection must reach the caller as a
  # 400, not as "the platform is broken".
  body=$(curl -sS "${CURL_OPTS[@]}" --max-time 90 -w '\n%{http_code}' "${auth[@]}" \
    -d '{"sql":"DROP TABLE insight.people"}' "$BACKEND/cf/studio-insight/v1/query")
  code=${body##*$'\n'}; body=${body%$'\n'*}
  [[ "$code" == 400 ]] \
    && ok "a rejected statement comes back as 400" \
    || bad "DROP -> $code $body (expected 400)"

  body=$(curl -sS "${CURL_OPTS[@]}" --max-time 120 -w '\n%{http_code}' "${auth[@]}" \
    -d '{"repository":"constructorfabric/gears-rust","depth":2,"limit":5}' \
    "$BACKEND/cf/studio-insight/v1/components/metrics")
  code=${body##*$'\n'}; body=${body%$'\n'*}
  [[ "$code" == 200 && "$body" == *'"components"'* ]] \
    && ok "component metrics answer for gears-rust" \
    || bad "components/metrics -> $code $body"

  # What the portal actually sends: component NAMES, no path map, plus a weekly
  # series to draw. `api-gateway` lives at gears/system/api-gateway/.
  body=$(curl -sS "${CURL_OPTS[@]}" --max-time 120 -w '\n%{http_code}' "${auth[@]}" \
    -d '{"repository":"constructorfabric/gears-rust","components":[{"key":"api-gateway"},{"key":"credstore"}],"include_other":false,"bucket":"week"}' \
    "$BACKEND/cf/studio-insight/v1/components/metrics")
  code=${body##*$'\n'}; body=${body%$'\n'*}
  [[ "$code" == 200 && "$body" == *'"api-gateway"'* && "$body" == *'"bucket":"week"'* ]] \
    && ok "named components resolve to their directories, with a weekly series" \
    || bad "components by name -> $code $body"

  # Pull requests, the same slice: named gears, all three states, and the mean
  # merge time. `api-gateway` lives at gears/system/api-gateway/.
  body=$(curl -sS "${CURL_OPTS[@]}" --max-time 180 -w '\n%{http_code}' "${auth[@]}" \
    -d '{"repository":"constructorfabric/gears-rust","from":"2026-05-01","components":[{"key":"api-gateway"},{"key":"credstore"}],"include_other":false}' \
    "$BACKEND/cf/studio-insight/v1/components/pull-requests")
  code=${body##*$'\n'}; body=${body%$'\n'*}
  [[ "$code" == 200 && "$body" == *'"api-gateway"'* && "$body" == *'"merged"'* ]] \
    && ok "pull requests answer per named gear, in every state" \
    || bad "components/pull-requests -> $code $body"

  body=$(curl -sS "${CURL_OPTS[@]}" --max-time 60 -w '\n%{http_code}' "${auth[@]}" \
    -d '{"repository":"a/b/c"}' "$BACKEND/cf/studio-insight/v1/components/metrics")
  code=${body##*$'\n'}; body=${body%$'\n'*}
  [[ "$code" == 400 ]] \
    && ok "a malformed repository is refused with 400" \
    || bad "bad repository -> $code $body (expected 400)"

  body=$(curl -sS "${CURL_OPTS[@]}" --max-time 60 -w '\n%{http_code}' "${auth[@]}" \
    -d '{"repository":"constructorfabric/gears-rust","bucket":"fortnight"}' \
    "$BACKEND/cf/studio-insight/v1/components/metrics")
  code=${body##*$'\n'}; body=${body%$'\n'*}
  [[ "$code" == 400 ]] \
    && ok "an unknown bucket is refused with 400" \
    || bad "bad bucket -> $code $body (expected 400)"

  # The quickstart prints worked queries WITH their answers. Numbers in a doc
  # rot silently, so every ```sql block in it is run here: not to check the
  # figures (the warehouse moves) but to catch a statement that stopped being
  # valid — a renamed table, a dropped measure, a tightened upstream.
  doc=studio-backend/docs/insight-quickstart.md
  if ! command -v python3 >/dev/null && ! command -v python >/dev/null; then
    note "no python — the documented queries were not re-run"
  elif [[ ! -f "$root/$doc" ]]; then
    note "$doc not found — the documented queries were not re-run"
  else
    py=$(command -v python3 || command -v python)
    dir=$(mktemp -d); trap 'rm -f "$env_clean"; rm -rf "$dir"' EXIT
    blocks=$("$py" - "$root/$doc" "$dir" <<'EXTRACT'
import io, re, sys
doc, out = sys.argv[1], sys.argv[2]
blocks = re.findall(r'```sql\n(.*?)```', io.open(doc, encoding='utf-8').read(), re.S)
for i, b in enumerate(blocks):
    io.open(f'{out}/{i}.sql', 'w', encoding='utf-8').write(b.strip())
print(len(blocks))
EXTRACT
    )
    note "re-running $blocks documented queries from $doc"
    for f in "$dir"/*.sql; do
      [[ -e "$f" ]] || { note "no sql blocks in $doc"; break; }
      payload=$("$py" -c 'import json,sys; print(json.dumps({"sql": open(sys.argv[1], encoding="utf-8").read()}))' "$f")
      body=$(curl -sS "${CURL_OPTS[@]}" --max-time 120 -w '\n%{http_code}' "${auth[@]}" \
        -d "$payload" "$BACKEND/cf/studio-insight/v1/query")
      code=${body##*$'\n'}; body=${body%$'\n'*}
      [[ "$code" == 200 ]] \
        && ok "documented query $(basename "$f" .sql) still runs" \
        || bad "documented query $(basename "$f" .sql) -> $code $body"
    done
  fi
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
