# Constructor Insight — integration quickstart

`studio-insight` is the seam to [Constructor Insight](https://insight.cfabric.org),
the decision-intelligence platform. This page records what its API actually is
(discovered against the live deployment on 2026-09-11), how to wire the gear,
and how to check the wiring end to end.

## The upstream contract

Insight's REST root is `/api`. The one endpoint it exposes to us today is a
**read-only SQL query** over its ClickHouse warehouse:

```http
POST https://insight.cfabric.org/api/sql/query
Authorization: Bearer <instance token>
Content-Type: application/json

{"sql": "SELECT 1"}
```

```json
{"columns":[{"name":"1","type":"UInt8"}],"row_count":1,"rows":[{"1":1}],"truncated":false}
```

Things worth knowing before writing a query:

* **One statement, `SELECT` or `WITH` only.** `SHOW TABLES`, a second statement
  after a `;`, and every write are refused with a 400 whose `context.field_violations`
  says `query must be a single SELECT or WITH statement`.
* **Auth is the instance token as a bearer.** No key, or the token in an
  `X-API-Key` header instead, is a 401 with `reason: INVALID_INSTANCE_TOKEN`.
* **There is no `/api/v1`, no schema endpoint and no OpenAPI document.** Every
  other path under `/api` falls through to Insight's SPA and answers `200
  text/html` — so a "200" from a probe proves nothing unless it is JSON. Use
  ClickHouse's own catalog for discovery: `system.tables`, `system.columns`.
* **`truncated: true` means the rows are a prefix.** An aggregate computed over
  a truncated page is not the aggregate over the warehouse — aggregate in SQL,
  not in the caller.

### The warehouse

Layered `bronze_<source> → staging → silver → insight`, plus `identity` and
`config`. As of the date above the populated ones are `insight` (~1.15M rows),
`silver`, `bronze_github`, `staging`, `identity` and `config`; the other ~28
`bronze_*` databases (Jira, Slack, Salesforce, Figma, …) exist with zero rows,
so a query against them returns an empty page rather than an error.

The `insight` database holds both the fact tables (`git_metric_observations`,
`ci_metric_evidence`, `task_status_spans`, …) and the gold **views**
(`exec_summary`, `people`, `ic_kpis`, `commits_daily`, `ai_person_period`, …).
The views read empty for a token whose tenant has no resolved identities — the
fact tables underneath still answer, keyed by `tenant_id` / `metric_date` /
`measure_key`.

## Configuring the gear

The host is named in the config profiles; a deployment supplies only the
**token**, so the credential is never in the repository:

```dotenv
# .env next to docker-compose.yml (gitignored)
STUDIO_INSIGHT_API_KEY=<instance token>
#STUDIO_INSIGHT_BASE_URL=https://insight.cfabric.org   # only for another deployment
```

`config/{dev,docker,oidc,k8s}.yaml` carry the rest; `postgres.yaml` omits the
section:

```yaml
studio-insight:
  config:
    base_url: "https://insight.cfabric.org"
    base_url_env: "STUDIO_INSIGHT_BASE_URL"
    api_key_env: "STUDIO_INSIGHT_API_KEY"
    api_path: "/api"
    sql_resource: "sql/query"
```

Precedence is env over YAML for the base URL, and a literal `api_key` over the
env var for the token. A profile that omits the section entirely resolves to no
host and no key, which is a valid state: every call then answers **503** (not
500 — the integration is unavailable, the caller did nothing wrong) and `health`
reports `configured: false` with the variables to set.

### In the cluster

The Helm chart reads the token from the app Secret (`backend.appSecrets.existingSecret`,
default `studio-web-app`) under the key **`insight_api_key`**, and injects it as
`STUDIO_INSIGHT_API_KEY`:

The Secret already exists and holds other keys, so add to it rather than
recreate it — `create --dry-run | apply` would replace the whole object and take
`llm_api_key` and `fs_signing_seed` with it:

```bash
kubectl -n <ns> patch secret studio-web-app --type merge \
  -p '{"stringData":{"insight_api_key":"<instance token>"}}'
# the env var is read at boot, so the pods have to come back for it
kubectl -n <ns> rollout restart deploy -l app.kubernetes.io/component=backend
```

The reference is `optional: true`, deliberately: a namespace without the key
still starts the pod, and the gear reports itself unconfigured instead. That is
also why the key alone is not enough — `config/k8s.yaml` must carry the
`studio-insight` gear section, or the gear stands down and every route under it
answers 503 whatever the Secret holds.

`deploy/k8s/` is the legacy kustomize path and is not wired for this (see
`deploy/FILE_STORAGE_S3.md`); the chart is the deployed one.

## The REST surface

All routes sit behind the gateway prefix `/cf` and require a bearer token from
the portal's IdP.

| Route | Purpose |
| --- | --- |
| `POST /cf/studio-insight/v1/query` | Run one read-only statement; returns `columns`, `rows`, `row_count`, `truncated`. |
| `POST /cf/studio-insight/v1/components/metrics` | Delivery metrics for one repository, sliced by component. |
| `POST /cf/studio-insight/v1/pull` | Generic GET on `{base}{api_path}/{resource}` — the escape hatch for endpoints Insight has yet to publish. |
| `POST /cf/studio-insight/v1/push` | Generic POST on the same. |
| `GET /cf/studio-insight/v1/health` | `configured`, `base_url`, `instance_id`, and a live `SELECT 1` probe (`reachable`, `probe_ms`, `detail`). |

Errors are mapped by fault, not by convenience: a statement Insight rejects
comes back as **400** with the upstream's own message in a field violation on
`sql`; an unconfigured or unreachable upstream is **503**; anything else is
**500**. That distinction is the point — otherwise every SQL typo reads as "the
platform is broken".

In-process consumers skip the network hop entirely:

```rust
let insight = ctx
    .client_hub()
    .get_scoped::<dyn InsightClient>(&ClientScope::gts_id(INSIGHT_INSTANCE_ID))?;
let page = insight.query("SELECT count() FROM insight.git_metric_observations").await?;
```

## Metrics per component (gear)

Insight keys its git and CI observations by `repository` and nothing finer, but
a repository here is not a component: `gears-rust` alone holds ~90 gear crates
under `gears/<area>/<name>/`, and `studio-web` holds the backend assembly, the
portal and the prototype. `components/metrics` closes that gap by grouping the
per-file commit records (`insight.git_commit_file_changes`, joined to
`insight.git_authored_commits` for the author) underneath the repository.

**Derived components** — group by the first `depth` path segments, for a repo
nobody has mapped yet:

```bash
curl -sS -X POST http://127.0.0.1:8090/cf/studio-insight/v1/components/metrics \
  -H "Authorization: Bearer $STUDIO_TOKEN" -H 'Content-Type: application/json' \
  -d '{"repository":"constructorfabric/gears-rust","from":"2026-08-01","depth":2,"limit":15}'
```

```text
component                 commits  files        +       -  authors
gears/bss                      46    858   381968    4806       10
gears/system                  169   1031   212746   46875       18
testing/e2e                    16    288    34611   29216        8
libs/toolkit-db                61     75    15018    1425        6
gears/graph-storage            40     37     6613     870        1
```

`depth: 3` walks down to the individual gear.

**Declared components** — name them, and every file is attributed to the
longest matching rule. A component is named either by a **path prefix** or by a
**directory name** (`path_segment`, which defaults to the `key`):

```json
{
  "repository": "constructorfabric/studio-web",
  "components": [
    {"key": "insight",       "path_prefix": "studio-backend/src/insight/"},
    {"key": "graph-storage", "path_prefix": "studio-backend/src/graph_storage/"},
    {"key": "backend",       "path_prefix": "studio-backend/"},
    {"key": "frontend",      "path_prefix": "studio-frontend/"}
  ]
}
```

```json
{
  "repository": "constructorfabric/gears-rust",
  "components": [{"key": "api-gateway"}, {"key": "credstore"}, {"key": "credstore-sdk"}],
  "include_other": false
}
```

The second form is what a caller that knows component *names* but not their
paths wants — the portal's gear catalogue knows `api-gateway`, the warehouse
holds `gears/system/api-gateway/src/…`. Matching is whole-segment, so
`credstore` does not swallow `credstore-sdk`, and the longest matcher is tested
first so a nested component beats the one containing it. 47 gear directories
matched in one request against the live warehouse in well under a second.

Everything that matches no rule is reported as **`other`** rather than dropped —
a component map that silently loses half the diff is worse than one that shows
the hole. Pass `include_other: false` when only the declared components matter.

**A trend for a chart.** Add `bucket` (`day`, `week` or `month`) and the answer
carries a `series` alongside the totals — one point per component per bucket,
restricted to the components the ranking kept, so asking for a chart over a big
repository does not quietly become a query over all of it. The series is
**sparse**: a bucket in which a component saw no commits has no point, which is
what lets a chart tell "quiet" from "outside the window". It costs one extra
query upstream, so omit it when no chart is being drawn.

Two limits worth knowing before building a dashboard on this:

* **No PR or CI metrics at this granularity.** Cycle time, review latency and
  pipeline outcomes exist only per repository, because that is the entity a PR
  and a pipeline run belong to. Read those from `git_metric_observations` /
  `ci_metric_observations` through `/query` with a `repository` dimension filter.
* **Churn is not delivery.** `lines_added` counts generated files, vendored
  code and lockfiles exactly like hand-written logic. Declare components with
  prefixes that exclude what you do not mean, rather than reading the raw
  ranking as productivity.

Everything interpolated into the generated statement is validated (repository
charset, `YYYY-MM-DD` dates, depth 1–6, limit ≤ 500) *and* escaped. A malformed
`repository` is a 400 with a field violation, not an upstream error.

### In the portal

The prototype's **Components** page is the first consumer
(`studio-frontend-prototype/src/gear-activity.tsx`). It groups the catalogue by
the `repository` each crate publishes from, sends the gear names as components
(one request per repository, `include_other: false`, `bucket: "week"`), and gets
back a row and a weekly series per gear. Nobody maintains a crate → directory
map: 47 of the gears in `gears-rust` resolve on name alone.

Each list card then carries a 12-week churn sparkline and the headline numbers,
and a gear's page gets a **Delivery activity** panel: five stat tiles, a weekly
bipolar column chart (lines added above the zero rule, removed below, one scale
for both arms), a table view of the same numbers, and a 30 / 90 / 365-day window
switch. The two data colours are the validated diverging pair (blue ↔ red) —
ΔE 21.6 light / 19.2 dark under simulated protanopia, ≥3:1 on both surfaces.

The panel says plainly when it has nothing: the upstream is off, the request
failed, or no directory named after the gear changed in the window — which
happens when a gear's sources live under a different directory name, and is a
finding rather than a zero.

## Checking it

`scripts/insight-smoke.sh` exercises the upstream directly (no backend needed)
and then, if given a portal token, the same query through the gear:

```bash
STUDIO_INSIGHT_API_KEY=<token> scripts/insight-smoke.sh
STUDIO_INSIGHT_API_KEY=<token> STUDIO_TOKEN=<portal jwt> scripts/insight-smoke.sh
```

It asserts the four behaviours that actually break: `SELECT 1` succeeds, a
missing token is a 401, a non-`SELECT` is a 400, and the catalog query returns
the databases.
