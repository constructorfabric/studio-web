#!/usr/bin/env bash
# Build the `studio-alerts` ConfigMap from the files in this directory and apply
# it. Called by `make alerts`; a script rather than a Makefile recipe because
# the conditional below is three lines of shell and a recipe would spell it as
# one line of backslashes.
#
#   CONTEXT=<kube context> NS=<namespace> [ALERT_WEBHOOK_URL=https://...] install.sh
#
# ALERT_WEBHOOK_URL is a Discord incoming webhook. Check it reaches the channel
# first with ./test-delivery.sh — a wrong URL and a rule that never fires are
# the same silence from where you are sitting.
#
# Rules always install. Routing installs only with a webhook URL: a notification
# policy naming a receiver that was never provisioned makes Grafana fail
# provisioning at startup, so contactpoints.yaml and policies.yaml travel
# together or not at all.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
context="${CONTEXT:?CONTEXT is required}"
namespace="${NS:?NS is required}"
webhook="${ALERT_WEBHOOK_URL:-}"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cp "$here/rules.yaml" "$stage/"

if [ -n "$webhook" ]; then
  # `|` is safe as the delimiter: a URL cannot contain one unescaped.
  sed "s|\${ALERT_WEBHOOK_URL}|$webhook|" \
    "$here/contactpoints.yaml.template" > "$stage/contactpoints.yaml"
  cp "$here/policies.yaml" "$stage/"
  echo "  alerts: rules + routing to the Discord webhook in ALERT_WEBHOOK_URL"
else
  echo "  alerts: RULES ONLY. ALERT_WEBHOOK_URL is unset, so a firing alert is"
  echo "          visible in Grafana and delivered NOWHERE."
  echo "          Re-run as: make alerts ALERT_WEBHOOK_URL=https://..."
fi

kubectl --context "$context" -n "$namespace" create configmap studio-alerts \
  --from-file="$stage" \
  --dry-run=client -o yaml \
  | kubectl --context "$context" -n "$namespace" apply -f -
