#!/usr/bin/env bash
# Constructor Studio Backend — domain-model demonstration scenario.
# Proves the three goals of the `studio-domain-model` gear:
#   1. create objects of the domain types,
#   2. extend a type by adding a new field,
#   3. read the model back so the frontend can be regenerated from it.
#
# Prereqs: server running (`cargo run -- --config config/dev.yaml run`), curl, jq.
# Live contract: http://127.0.0.1:8090/cf/docs (the source of truth for paths).

set -euo pipefail

BASE="http://127.0.0.1:8090/cf"
API="${BASE}/studio-domain-model/v1"
TOKEN="studio-admin-token"
AUTH=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")

step() { echo; echo "━━━ $1 ━━━"; }

step "0. Health"
curl -sf "http://127.0.0.1:8090/healthz" && echo "OK"

step "1. The stored domain model (goal 3: the frontend-regen source)"
curl -sf "${AUTH[@]}" "${API}/types" \
  | jq '{bucket: .ontology.bucket, entities: (.ontology.entities | length), types: [.ontology.entities[].id]}'

step "1b. The relation catalog (relations synced with endpoint typing)"
curl -sf "${AUTH[@]}" "${API}/relations" \
  | jq '{relations: [.relations[] | {relation, src: .src_types|length, dst: .dst_types|length}], cross_bucket_pending: (.unresolved | length)}'

step "1c. Sync the model as a graph (object-type nodes + inherits/declares edges)"
curl -sf "${AUTH[@]}" -X POST "${API}/model/sync" | jq .

step "2. Create a Team object (goal 1)"
TEAM=$(curl -sf "${AUTH[@]}" -X POST "${API}/objects" -d '{
  "type": "team",
  "key": "studio-core",
  "value": { "name": "Studio Core", "slug": "studio-core", "acquisition": "authored" }
}' | jq -r '.instance_id')
echo "team instance: ${TEAM}"

step "3. Create a Person object (goal 1)"
PERSON=$(curl -sf "${AUTH[@]}" -X POST "${API}/objects" -d '{
  "type": "person",
  "key": "ada",
  "value": { "name": "Ada Lovelace" }
}' | jq -r '.instance_id')
echo "person instance: ${PERSON}"

step "4. Relate them: Team -member-> Person"
curl -sf "${AUTH[@]}" -X POST "${API}/relations" -d "{
  \"relation\": \"member\",
  \"from\": \"${TEAM}\",
  \"to\": \"${PERSON}\"
}" | jq .

step "5. Extend the Team type with a new field (goal 2)"
curl -sf "${AUTH[@]}" -X POST "${API}/types/team/fields" -d '{
  "name": "cost_center",
  "type": "string",
  "description": "Finance cost center",
  "required": false
}' | jq '{id: .entity.id, added: (.entity.properties | map(.name) | contains(["cost_center"]))}'

step "6. The type now carries the new field (read back for regen)"
curl -sf "${AUTH[@]}" "${API}/types" \
  | jq '.ontology.entities[] | select(.id=="team") | {id, fields: [.properties[].name]}'

step "7. List the stored Team objects"
curl -sf "${AUTH[@]}" "${API}/objects?type=team" | jq '{total, objects: [.objects[] | {instance_id, name: .value.name}]}'

echo
echo "Next: regenerate the model-UI file set from the stored model:"
echo "  curl -s ${AUTH[*]} ${API}/types > /tmp/types.json"
echo "  node scripts/regen-domain-frontend.mjs /tmp/types.json --out regen-out \\"
echo "    --validate ../../studio-internal/domain-model-ui/schema-validator.js"
