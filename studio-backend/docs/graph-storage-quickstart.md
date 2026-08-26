# Graph Storage — local experiments with docker compose

Branch `feature/graph-storage-gear`. Gets you from a checkout to a populated
knowledge graph you can traverse and search. The API itself is documented in
[graph-storage-api.md](./graph-storage-api.md).

The gear is behind the `graph` Cargo feature, **on by default**, so nothing here
needs a flag. It is off in the k8s release image: it runs only on PostgreSQL 19
with pgvector, which the cluster does not have.

## 1. Create `.env` before the first `up`

**Do this first.** Without it the stack starts, you enter a GitHub token in the
portal, and the token silently dies on the next backend restart — credstore
falls back to an in-memory store and says so only in the log.

```bash
cd studio-web
cp .env.example .env
sed -i "s|^STUDIO_CREDSTORE_KEY=$|STUDIO_CREDSTORE_KEY=$(openssl rand -base64 32)|" .env
```

`.env` is gitignored. Keep the key: a new one makes previously stored values
unreadable, and they have to be re-entered.

## 2. Start the stack

```bash
docker compose up --build -d
```

Two things are slower than they look on a first run: the backend image builds
the gears workspace, and `graph-postgres` compiles pgvector from source (no
released version targets PG19 yet). Subsequent builds hit the BuildKit cache.

What you get:

| Service | Port | Notes |
| --- | --- | --- |
| `studio-frontend` | 8080 | portal |
| `studio-backend` | 8090 | API, `/cf/docs` for OpenAPI |
| `studio-backend-pg` | 5432 | PostgreSQL 16 — every gear except graph-storage |
| `studio-graph-pg` | 5433 | PostgreSQL 19 + pgvector — graph-storage only |
| `studio-keycloak` | 8443 | login (admin/studio, demo/studio) |

Check the gear came up:

```bash
docker logs studio-backend 2>&1 | grep graph-storage
# ... Built database handle for gear gear=graph-storage ... @graph-postgres:5432/graph_storage
# ... graph-storage gear initialized
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
curl -s -H "Authorization: Bearer $TOKEN" "$B/stats"
# {"nodes":0,"edges":0,"graph_revision":0}
```

Tokens last an hour. Re-run the command when you start getting 401s.

## 4. Put something in the graph

### Option A — by hand

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type_id":"cf.demo.thing.v1~","kind":"node"}' "$B/types"
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type_id":"cf.demo.links.v1~","kind":"edge"}' "$B/types"

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "nodes": [
    {"node_key":"a","type_id":"cf.demo.thing.v1~","name":"alpha","search_text":"alpha first"},
    {"node_key":"b","type_id":"cf.demo.thing.v1~","name":"beta","search_text":"beta second",
     "payload":{"note":"attributes are optional"}}
  ],
  "edges": [{"type_id":"cf.demo.links.v1~","from":"a","to":"b"}]
}' "$B/ingest"
```

### Option B — import a real GitHub repository

1. In the portal (`http://localhost:8080`) add a GitHub connection with a PAT.
   A classic token with `repo` reaches private repositories; public ones need no
   scopes.
2. Take the connection id:

```bash
docker exec studio-backend-pg psql -U studio -d studio_account_management -tAc \
  "select value from tenant_metadata where value::text like '%github%';" | head -1
```

3. Import. `tenant` is the tenant whose catalogue holds the connection — the
   `owner_tenant_id` in that row.

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "repo_full_path": "constructorfabric/insight",
  "tenant": "<owner_tenant_id>",
  "max_entries": 800
}' "http://127.0.0.1:8090/cf/studio-connector/v1/connections/<connection-id>/graph-sync"
```

Reference run: 824 nodes, 823 edges (622 files, 178 directories, 23
contributors) in about 2.4 s. Re-running converges — the counts repeat and
`stats` does not move.

The shape written:

```
project ──includes──▶ repository ──contains──▶ directory ──contains──▶ file
                           ▲                        └──contains──▶ directory
                           └──contributed_to── person
```

## 5. Query it

```bash
# find the repository node
ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "$B/nodes?key=repo:constructorfabric/insight" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["items"][0]["id"])')

# what it contains, one hop out
curl -s -H "Authorization: Bearer $TOKEN" "$B/subgraph?seeds=$ID&depth=1&direction=out"

# who contributed to it
curl -s -H "Authorization: Bearer $TOKEN" \
  "$B/neighbours?seeds=$ID&depth=1&edge_types=cf.studio.kg.contributed_to.v1~"

# lexical search
curl -s -H "Authorization: Bearer $TOKEN" "$B/search?q=rs&limit=5"
```

## 6. Look at the SQL/PGQ side directly

The gear declares a property graph over its own tables, so you can query it from
psql without going through the API:

```bash
docker exec -it studio-graph-pg psql -U graph -d graph_storage
```

```sql
-- the property graph is a schema object, relkind 'g'
SELECT relname, relkind FROM pg_class WHERE relkind = 'g';

-- one hop, directly
SELECT * FROM GRAPH_TABLE (kb_pgq
  MATCH (a IS node WHERE a.id = 9) -[e IS edge]-> (b IS node)
  COLUMNS (b.id AS neighbour)) ORDER BY neighbour;
```

Two things worth knowing if you experiment with patterns:

- **Always write an explicit arrow.** The undirected shorthand `-[e]-` measured
  735 ms for one element and 7967 ms for two, against ~1.5 ms directed.
- **A column absent from the DDL's `PROPERTIES` list is invisible to `MATCH`** —
  not an error, just unfilterable. See
  `m20260818_000002_property_graph.rs` for what is exposed.

## 7. Which traversal backend served a request

`traversal_hop: pgq` is configured, so hops run as `GRAPH_TABLE` statements. A
request whose scope cannot be reduced to a set of tenants falls back to the
portable two-query hop, and says so:

```bash
docker logs studio-backend 2>&1 | grep 'two-query hop'
# empty output = every request was served by the pattern backend
```

`two_query` and `cte` are the other two values, so the three can be compared on
the same data.

## Troubleshooting

**`the token for connection '…' is not readable`** — the credstore key was
missing when the token was entered, so the value never persisted. Fix `.env`
(step 1), restart the backend, re-enter the PAT.

```bash
docker exec studio-backend-pg psql -U studio -d studio_credstore_values -tAc \
  "select reference from studio_credstore_values;"
```

**Nothing under `/cf/graph-storage/…`, 404** — the running image was built
without the gear. Check the branch is `feature/graph-storage-gear` and rebuild:
`docker compose build backend && docker compose up -d backend`.

**Backend restarts in a loop after a fresh volume** — unrelated to graph
storage; see the `bootstrap` profile note in `docker-compose.yml`.

**Start over on graph data only** — the graph lives in its own volume, so
dropping it leaves the rest of the stack alone:

```bash
docker compose rm -sf graph-postgres && docker volume rm studio_studio_graph_pg_data
docker compose up -d graph-postgres && docker compose restart backend
```
