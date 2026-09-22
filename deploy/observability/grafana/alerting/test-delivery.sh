#!/usr/bin/env bash
# Post one notification straight at a Discord webhook, shaped exactly like the
# ones Grafana sends, and say what Discord answered.
#
#   ./test-delivery.sh https://discord.com/api/webhooks/.../...
#   ALERT_WEBHOOK_URL=https://... ./test-delivery.sh
#
# This exists because the two halves fail differently and it is worth knowing
# which half is broken. Grafana reports a delivery failure in its own logs and
# nowhere else — no message arrives, and the first person to notice is whoever
# was waiting for an alert that never came. Running this BEFORE wiring the URL
# into `make alerts` separates "the webhook is wrong" from "the rules never
# fired", which are otherwise the same silence.
#
# The payload is the real shape, captured from grafana/grafana:12.3.1 posting
# through the contact point in contactpoints.yaml.template: `content` for the
# body, one `embeds` entry carrying the title and the colour. If Discord takes
# this, it will take a real alert.
set -euo pipefail

url="${1:-${ALERT_WEBHOOK_URL:-}}"
if [ -z "$url" ]; then
  echo "usage: test-delivery.sh <discord-webhook-url>" >&2
  echo "   or: ALERT_WEBHOOK_URL=<url> test-delivery.sh" >&2
  exit 2
fi

body='{
  "content": "1 firing\n\n**Delivery test — not a real alert** · `dev` · `studio-dev`\nIf this arrived, the webhook works and Grafana can reach the channel.\nhttps://studio.monitoring.cfabric.org/alerting/list",
  "embeds": [
    {
      "title": "[FIRING:1] Delivery test (Studio page)",
      "type": "rich",
      "color": 14037554,
      "footer": { "text": "studio-web · alerting/test-delivery.sh" }
    }
  ]
}'

out="$(mktemp)"
trap 'rm -f "$out"' EXIT
code="$(curl -sS -o "$out" -w '%{http_code}' \
  -H 'Content-Type: application/json' -X POST "$url" --data-binary "$body")"

case "$code" in
  204|200)
    echo "  delivered (HTTP $code) — look in the channel."
    ;;
  400)
    echo "  HTTP 400: Discord rejected the payload." >&2
    echo '  Usually content over 2000 characters; Grafana truncates to fit,' >&2
    echo "  so a 400 here points at this script rather than at the rules." >&2
    cat "$out" >&2; exit 1
    ;;
  401|403)
    echo "  HTTP $code: the webhook exists but will not accept this." >&2
    echo "  A webhook URL carries its own token — check it was copied whole." >&2
    cat "$out" >&2; exit 1
    ;;
  404)
    echo "  HTTP 404: no such webhook. It was deleted, or the channel was." >&2
    echo "  Discord → channel → Edit Channel → Integrations → Webhooks." >&2
    cat "$out" >&2; exit 1
    ;;
  429)
    echo "  HTTP 429: rate limited. Discord allows roughly 30 posts a minute" >&2
    echo "  per channel; Grafana's grouping stays well under it, a loop does not." >&2
    cat "$out" >&2; exit 1
    ;;
  *)
    echo "  HTTP $code from Discord." >&2
    cat "$out" >&2; exit 1
    ;;
esac
