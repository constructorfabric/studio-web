# Graph Storage — local experiments with docker compose

Gets you from a checkout to a populated knowledge graph you can traverse and
search, semantically and lexically. The API is summarised in
[graph-storage-api.md](./graph-storage-api.md) and documented in full by the
gear itself (`gears/graph-storage/docs/DESIGN.md` in gears-rust) and by the
OpenAPI document at `http://localhost:8090/cf/docs`.

## How the gear gets into this binary

The gear is a crate, `cf-gears-graph-storage`, linked behind the `graph` Cargo
feature (**on by default**) exactly like every other gear in
`registered_gears.rs`; consumers reach it through the SDK's
`GraphStorageClientV1` from the ClientHub. Two things are temporary and both
are marked in `Cargo.toml`:

- the crate is pulled from the fork `vasylcf/gears-rust` at the release tag
  `cf-gears-graph-storage-v0.1.0`, because upstream `main` does not yet carry
  the SQL/PGQ layer it needs (gears-rust PR #4639);
- a `[patch]` block moves every other gears-rust crate to the same tag, so the
  binary links one toolkit.

When the gear lands on gears-rust `main`, the dependency moves to
`constructorfabric/gears-rust`, the patch block goes, and `cargo update`
records the new lockfile. Nothing in `src/` changes.

## 1. Create `.env` before the first `up`

**Do this first.** Without it the stack starts, you enter a GitHub token in the
portal, and the token silently dies on the next backend restart — credstore
falls back to an in-memory store and says so only in the log.

```bash
cd studio-web
[ -f .env ] || printf 'STUDIO_CREDSTORE_KEY=%s\n' "$(openssl rand -base64 32)" > .env
grep -q '^STUDIO_CREDSTORE_KEY=.\+' .env || echo "STUDIO_CREDSTORE_KEY=$(openssl rand -base64 32)" >> .env
```

`.env` is gitignored. Keep the key: a new one makes previously stored values
unreadable, and they have to be re-entered.

### Choosing how vectors are computed

One embedding provider per deployment. The default needs nothing in `.env`:

| `STUDIO_EMBEDDING_PROVIDER` | What computes the vectors | Needs |
| --- | --- | --- |
| `onnx` (default) | `all-MiniLM-L6-v2` in the backend process | nothing — the `embedding-model` service fetches the pinned model into the `studio_models` volume |
| `remote` | an OpenAI-compatible `/embeddings` endpoint | `STUDIO_EMBED_API_KEY`, optionally `STUDIO_EMBED_BASE_URL` and `STUDIO_EMBED_MODEL` (defaults: `https://api.openai.com/v1`, `text-embedding-3-small`) |
| `fake` | a deterministic hash | nothing; vectors carry no meaning |

The width is fixed at 384 by the schema. `text-embedding-3-*` models honour the
requested width; a fixed-width remote model needs `embedding_dimension` changed
in `config/docker.yaml` **and** a fresh graph database.

**Switching provider over a populated graph is safe and visible:** the gear
records the embedding space it wrote with and, on a boot with a different
provider, logs `stored vectors belong to a different embedding space` and
answers `mode: vector`/`hybrid` searches with `400 EMBEDDING_SPACE_MISMATCH`.
Lexical search, traversal and ingest keep working. To re-embed, drop the graph
volume (see Troubleshooting) and re-import.

## 2. Start the stack

```bash
docker compose up --build -d
```

Slow on a first run: the backend image builds the gears workspace, and
`graph-postgres` compiles pgvector from source (no released version targets
PG19 yet). Subsequent builds hit the BuildKit cache.

| Service | Port | Notes |
| --- | --- | --- |
| `studio-frontend` | 8080 | portal |
| `studio-backend` | 8090 | API, `/cf/docs` for OpenAPI |
| `studio-graph-pg` | 5433 | the single PostgreSQL 19 + pgvector: every gear database **and** `graph_storage` |
| `studio-keycloak` | 8443 | login (admin/studio, demo/studio) |
| `studio-embedding-model` | — | one-shot: fetches the ONNX model into the `studio_models` volume, then exits |

Check the gear and its provider came up:

```bash
docker logs studio-backend 2>&1 | grep -E 'graph-storage|embedding'
# ... loaded the in-process ONNX embedding provider model=model.onnx@sha256:6fd5d72f…
# ... embedding space active epoch=1 identity=…
# ... graph-storage gear initialized pgq_available=true
```

## 3. Get a token

The docker profile authenticates through Keycloak, so the static dev tokens
from `config/postgres.yaml` do not work here.

```bash
TOKEN=$(curl -sk -X POST 'https://localhost:8443/realms/studio/protocol/openid-connect/token' \
  -d grant_type=password -d client_id=studio-portal \
  -d username=admin -d password=studio -d scope=openid \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')

B=http://127.0.0.1:8090/cf/graph-storage/v1
H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
curl -s "${H[@]}" "$B/revision"
# {"source_epoch":…,"revision":0}
```

Tokens last an hour. Re-run the command when you start getting 401s.

## 4. Put something in the graph

### Option A — by hand

Every producer type derives from one of the gear's families and says, in its
schema, which payload paths are searched and embedded. Registration is a batch
and converges on a byte-identical re-registration.

```bash
curl -s -X POST "${H[@]}" "$B/types" -d '{
  "types": [
    { "type_id": "gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~cf.demo.thing.v1~",
      "schema": {
        "$id": "gts://gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~cf.demo.thing.v1~",
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "allOf": [{ "$ref": "gts://gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~" }],
        "x-gts-traits": { "full_text_search": ["/payload/note"], "vector_search": ["/payload/note"] }
      } },
    { "type_id": "gts.cf.core.graph.edge.v1~cf.core.graph.static_edge.v1~cf.demo.links.v1~",
      "schema": {
        "$id": "gts://gts.cf.core.graph.edge.v1~cf.core.graph.static_edge.v1~cf.demo.links.v1~",
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "allOf": [{ "$ref": "gts://gts.cf.core.graph.edge.v1~cf.core.graph.static_edge.v1~" }]
      } }
  ]
}'

T=gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~cf.demo.thing.v1~
E=gts.cf.core.graph.edge.v1~cf.core.graph.static_edge.v1~cf.demo.links.v1~
curl -s -X POST "${H[@]}" "$B/ingest" -d "{
  \"nodes\": [
    {\"node_key\":\"a\",\"type_id\":\"$T\",\"name\":\"alpha\",\"payload\":{\"note\":\"a plaintext password was committed\"}},
    {\"node_key\":\"b\",\"type_id\":\"$T\",\"name\":\"beta\",\"payload\":{\"note\":\"the kitchen renovation is next spring\"}}
  ],
  \"edges\": [{\"type_id\":\"$E\",\"src_node_key\":\"a\",\"dst_node_key\":\"b\"}],
  \"options\": {\"embed\": true}
}"
# {"revision":{…},"replayed":false,"counts":{"nodes_inserted":2,…,"edges_inserted":1,…}}
```

### Option B — import a real GitHub repository

1. In the portal (`http://localhost:8080`) add a GitHub connection with a PAT.
   A classic token with `repo` reaches private repositories; public ones need no
   scopes.
2. Take the connection id and its owner tenant from the connector API (or
   create the connection there: `POST /connections` with `provider`, `label`
   and `token`):

```bash
curl -s "${H[@]}" http://127.0.0.1:8090/cf/studio-connector/v1/connections \
  | python3 -c 'import json,sys; [print(c["id"], c["owner_tenant_id"], c["provider"]) for c in json.load(sys.stdin)["items"]]'
```

3. Import. `tenant` is the connection's `owner_tenant_id`. The import runs in
   the background — the gear embeds every node it writes, which for a few
   hundred files takes longer than the gateway's 30 s deadline — so the call
   returns a task id and you poll it:

```bash
TASK=$(curl -s -X POST "${H[@]}" -d '{
  "repo_full_path": "constructorfabric/insight",
  "tenant": "<owner_tenant_id>",
  "max_entries": 800
}' "http://127.0.0.1:8090/cf/studio-connector/v1/connections/<connection-id>/graph-sync" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')

# status: queued | running (message = current phase) | succeeded (outcome) | failed (message)
curl -s "${H[@]}" "http://127.0.0.1:8090/cf/studio-connector/v1/graph-sync/tasks/$TASK"
```

`"wait": true` in the body runs the import inline and answers with the outcome;
fine for a small repository, a 504 for a large one.

Reference run: 824 nodes, 823 edges (622 files, 178 directories, 23
contributors). Re-running converges — the counts come back as `unchanged` and
the revision does not move.

The shape written (every node is embedded on write):

```
project ──includes──▶ repository ──contains──▶ directory ──contains──▶ file
                           ▲                        └──contains──▶ directory
                           └──contributed_to── person
```

## 5. Query it

Node keys carry `/` and `:`; URL-encode them in a path.

```bash
R='repo:constructorfabric/insight'
RK=$(python3 -c "import urllib.parse;print(urllib.parse.quote('$R', safe=''))")

# the repository node, with its bounded adjacency
curl -s "${H[@]}" "$B/nodes/$RK"

# every file, page by page (OData: $top, $filter on node_key/name/created_at/updated_at)
curl -s "${H[@]}" "$B/nodes?type_pattern=gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~cf.studio.kg.file.v1~&\$top=5"

# what it contains, one hop out
curl -s -X POST "${H[@]}" "$B/graph/traverse" -d "{\"seeds\":[\"$R\"],\"depth\":1}"

# who contributed to it
curl -s -X POST "${H[@]}" "$B/graph/traverse" -d "{\"seeds\":[\"$R\"],\"depth\":1,
  \"edge_type_patterns\":[\"gts.cf.core.graph.edge.v1~cf.core.graph.static_edge.v1~cf.studio.kg.contributed_to.v1~\"]}"

# the neighbourhood drawn around it
curl -s -X POST "${H[@]}" "$B/graph/neighborhood" -d "{\"root\":\"$R\",\"depth\":2}"

# lexical, vector, or both fused (mode: lexical | vector | hybrid)
curl -s -X POST "${H[@]}" "$B/search" -d '{"mode":"hybrid","query":"rust source files","limit":5}'
```

A semantic check that needs no vocabulary overlap, against Option A's nodes:

```bash
curl -s -X POST "${H[@]}" "$B/search" -d '{"mode":"vector","query":"a hardcoded secret in source control","limit":1}'
# hits[0].node_key == "a"
```

## 6. Look at the SQL/PGQ side directly

The gear declares a property graph over its own tables, so you can query it from
psql without going through the API:

```bash
docker exec -it studio-graph-pg psql -U studio -d graph_storage
```

```sql
-- the property graph is a schema object, relkind 'g' (named `kb`)
SELECT relname, relkind FROM pg_class WHERE relkind = 'g';

-- which nodes carry a current vector, and in which embedding space
SELECT node_key, embedding_epoch, embedding IS NOT NULL AS has_vector FROM node LIMIT 5;
SELECT identity_hash, model_artifact, status FROM embedding_space;

-- one hop, directly. Only the columns the DDL lists as PROPERTIES are
-- addressable inside MATCH (ids, tenant, type), so resolve keys outside it.
SELECT b.node_key FROM GRAPH_TABLE (kb
  MATCH (a IS node WHERE a.id = (SELECT id FROM node WHERE node_key = 'repo:constructorfabric/insight'))
        -[e IS edge]-> (x IS node)
  COLUMNS (x.id AS nid)) g JOIN node b ON b.id = g.nid ORDER BY 1 LIMIT 10;
```

Two things worth knowing if you experiment with patterns:

- **Always write an explicit arrow.** The undirected shorthand `-[e]-` measured
  735 ms for one element and 7967 ms for two, against ~1.5 ms directed.
- **A column absent from the DDL's `PROPERTIES` list is invisible to `MATCH`** —
  not an error, just unfilterable.

## 7. Which traversal backend served a request

`traversal_hop: pgq` is configured, so hops run as `GRAPH_TABLE` statements. A
request whose scope cannot be carried by the pattern falls back to the
portable two-query hop, and says so:

```bash
docker logs studio-backend 2>&1 | grep 'two-query hop'
# empty output = every request was served by the pattern backend
```

## Troubleshooting

**`the token for connection '…' is not readable`** — the credstore key was
missing when the token was entered, so the value never persisted. Fix `.env`
(step 1), restart the backend, re-enter the PAT.

**Backend exits with `cannot read model at /app/models/minilm/model.onnx`** —
the `embedding-model` service did not fill the volume (offline, or a checksum
mismatch: it refuses to install a file that does not match its pin). Look at
`docker logs studio-embedding-model`; the backend restarts on its own once the
files are there. To run without a model, `STUDIO_EMBEDDING_PROVIDER=fake`.

**`ONNX Runtime did not load within 30s`** — `ORT_DYLIB_PATH` points at a
library the process cannot load. In the image it is
`/opt/onnxruntime/lib/libonnxruntime.so`; rebuild the image if it is missing.

**`400 EMBEDDING_SPACE_MISMATCH` on vector search** — the graph was embedded by
a different provider or model than the one now configured. Either switch back,
or re-embed by starting the graph over (below).

**Nothing under `/cf/graph-storage/…`, 404** — the running image was built
without the `graph` feature (the `backend-bootstrap` seeder is, on purpose).
`docker compose build backend && docker compose up -d backend`.

**Start over on graph data only** — the graph has its own database on the shared
server; dropping and recreating it leaves the rest of the stack alone:

```bash
docker exec studio-graph-pg psql -U studio -d studio -c 'DROP DATABASE graph_storage;' \
  -c 'CREATE DATABASE graph_storage OWNER studio;'
docker compose restart backend
```
