# Constructor Insight — integration quickstart

`studio-insight` is the seam to [Constructor Insight](https://insight.cfabric.org),
the decision-intelligence platform. This page records what its API actually is
(discovered against the live deployment on 2026-09-11), **what can be got out of
it** — with worked queries and their real answers — how the gear serves a
request, how to wire it, and how to check the wiring end to end.

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
Most of the views read empty and the facts underneath do not — the next two
sections are what a row actually holds, and why that split exists.

## The data model — what one row means

Almost everything useful sits in three shapes, repeated per domain (`git_`,
`ci_`, `task_`, and the still-empty `ai_`, `collab_`, `wiki_`):

**`*_metric_observations` — the measured facts.** One row is *one person, one
day, one measure, one set of dimensions*:

| column | what it holds |
| --- | --- |
| `tenant_id` | the Insight tenant; every table is keyed by it |
| `entity_type` / `entity_id` | **always `person`** in the git domain, and the id is the raw source handle (a GitHub noreply address), not a resolved person |
| `metric_date` | the day the measure belongs to |
| `measure_key` | *what* was measured — `commit_count`, `pr_cycle_hours`, … |
| `value` | the number |
| `dimensions` | `Array(Tuple(key, value, label))` — the slice: `repository`, `project`, `source`, `branch_scope`, `file_extension`, `change_type`, `category`, `hour_block`, `destination_branch` |

The consequence is worth stating plainly: **the entity is the person and the
repository is a dimension.** Any "per repository" number is an aggregate over
people, reached with `ARRAY JOIN dimensions`, and there is no dimension below
the repository — which is the gap `/components/metrics` fills.

**`*_metric_evidence` — what backs an observation.** Same keys plus
`record_id`, `record_kind`, `record_label`, `contribution` and a `details` map.
Use it to answer "which commits made this number", not to aggregate: a single
observation fans out into many evidence rows.

**Raw records** — `git_commit_file_changes` (commit, path, extension, lines,
`committer_date`), `git_authored_commits` (author, message, dates),
`git_review_events`, `task_status_spans`, `ci_metric_evidence`. These carry the
detail the observations have already rolled up, and they are the only place a
*file path* exists.

`insight.task_issue_current_state` is a materialized view, and the gold views
(`exec_summary`, `people`, `ic_kpis`, `commits_daily`, `ai_person_period`, …)
are views over all of the above — see below for why most of them read empty.

### The measures that exist

Discovered from the live warehouse (2026-09-11); `SELECT DISTINCT measure_key`
re-derives any of these lists.

**git (37)** — volume: `commit_count`, `commit_day`, `commit_change_size`,
`lines_added`, `lines_removed`, `code_lines_added`, `test_lines_added`,
`test_and_code_lines_added`; the same four again as `default_*` and
`non_default_*` (default branch vs everything else). Pull requests:
`pr_created`, `pr_merged`, `pr_created_merged`, `pr_abandoned`,
`pr_change_size`, `pr_commit_count`, `pr_cycle_hours`,
`pr_first_review_hours`, `pr_review_to_merge_hours`,
`pr_approval_to_merge_hours`, `pr_review_wait_share`, `pr_reviewer_count`,
`pr_multi_reviewed`, `pr_merged_without_approval`, `pr_reviewed`, `pr_comment`,
`review_submitted`.

**ci (10)** — `runs`, `run_duration_min`, `run_hours`, `gate_runs`,
`gate_passed`, `gate_first_try_passed`, `gate_retried`, `runs_matched_commit`,
`commits_observed`, `deployments`.

**task (8)** — `tasks_closed`, `close_events`, `closed_non_bug`, `bugs_fixed`,
`pickup_days`, `resolution_days`, `stale_in_progress`, `reopened_within_14d`.

`ai_*`, `ai_cost_*`, `collab_*` and `wiki_*` exist with the same shape and zero
rows: the connectors behind them (Claude, ChatGPT, Cursor, Slack, Zoom,
Confluence, Outline) have not been ingested for this tenant.

## What you can get — a cookbook

Every query below was run against the live deployment on 2026-09-11 through
`POST /cf/studio-insight/v1/query`; the numbers are the real answers, kept so a
reader can tell a working query from a plausible-looking one.

### Delivery per repository

```sql
SELECT d.label AS repository,
       sumIf(value, measure_key = 'commit_count')  AS commits,
       sumIf(value, measure_key = 'lines_added')   AS lines_added,
       sumIf(value, measure_key = 'pr_created')    AS prs_opened,
       round(avgIf(value, measure_key = 'pr_cycle_hours'), 1) AS pr_cycle_h
FROM insight.git_metric_observations
ARRAY JOIN dimensions AS d
WHERE d.key = 'repository' AND metric_date >= today() - 89
GROUP BY repository ORDER BY commits DESC LIMIT 10
```

```text
repository                      commits  lines_added  prs_opened  pr_cycle_h
constructorfabric/insight       3510      879593       939          20.8
constructorfabric/Kitsoki       1070      302174         3         149.4
constructorfabric/gears-rust     915     1229721       297         124.4
constructorfabric/gears-frontx   564      229398        96         112.8
constructorfabric/studio-web     514      695190       105           4.8
constructorfabric/fabric-pass    430       37420        98           1.1
constructorfabric/studio         389      145493        76          60.4
```

`ARRAY JOIN dimensions AS d` + `WHERE d.key = …` is the idiom for every slice:
without the `WHERE` each observation is counted once per dimension it carries.

### CI health

```sql
SELECT d.label AS repository,
       sumIf(value, measure_key = 'gate_runs') AS gate_runs,
       round(100 * sumIf(value, measure_key = 'gate_passed')
                 / nullIf(sumIf(value, measure_key = 'gate_runs'), 0), 1) AS pass_pct,
       round(100 * sumIf(value, measure_key = 'gate_first_try_passed')
                 / nullIf(sumIf(value, measure_key = 'gate_runs'), 0), 1) AS first_try_pct,
       round(avgIf(value, measure_key = 'run_duration_min'), 1) AS avg_run_min
FROM insight.ci_metric_observations
ARRAY JOIN dimensions AS d
WHERE d.key = 'repository' AND metric_date >= today() - 89
GROUP BY repository HAVING gate_runs > 0 ORDER BY gate_runs DESC LIMIT 8
```

```text
repository                      gate_runs  pass_pct  first_try_pct  avg_run_min
constructorfabric/insight           18280      94.0           93.8          7.4
constructorfabric/gears-rust        13125      93.2           91.3         11.3
constructorfabric/gears-frontx       1400      69.8           69.6          9.9
constructorfabric/studio              839      91.2           89.5          7.5
constructorfabric/studio-web          639      79.8           78.4         10.9
constructorfabric/cargo-gears         251      89.2           82.5          5.5
```

The gap between `pass_pct` and `first_try_pct` is retries — a green pipeline
that needed a second run. `nullIf(…, 0)` keeps a repository with no gate runs
out of the percentage instead of dividing by zero.

### Review latency, week by week

```sql
SELECT toMonday(metric_date) AS week,
       round(avgIf(value, measure_key = 'pr_first_review_hours'), 1)    AS first_review_h,
       round(avgIf(value, measure_key = 'pr_review_to_merge_hours'), 1) AS review_to_merge_h,
       round(avgIf(value, measure_key = 'pr_reviewer_count'), 2)        AS reviewers
FROM insight.git_metric_observations
ARRAY JOIN dimensions AS d
WHERE d.key = 'repository' AND d.label = 'constructorfabric/studio-web'
  AND metric_date >= today() - 55
GROUP BY week ORDER BY week
```

```text
week        first_review_h  review_to_merge_h  reviewers
2026-07-27             0.2                8.9       0.50
2026-08-03             0.2               23.6       2.00
2026-08-10            NULL               NULL       0.00
2026-08-17             2.7                5.8       0.67
2026-08-24            11.2                8.8       2.25
2026-08-31            40.5               24.2       1.00
2026-09-07             3.4               58.7       0.25
```

A `NULL` week is a week with no reviewed PR, not a zero-hour review — an
average over no rows. Worth keeping distinct in anything that charts this.

### Language mix

```sql
SELECT ext.value AS extension, sum(value) AS lines_added
FROM insight.git_metric_observations
ARRAY JOIN dimensions AS ext
WHERE measure_key = 'lines_added' AND ext.key = 'file_extension'
  AND metric_date >= today() - 89
GROUP BY extension ORDER BY lines_added DESC LIMIT 10
```

```text
rs 2414338 · md 534102 · py 387343 · json 356863 · ts 280338
tsx 255880 · js 223559 · yaml 196383 · go 82550 · mjs 72902
```

Churn counts generated files and lockfiles exactly like hand-written code, so
read this as "where the bytes went", not as effort.

### Pull requests, by state and by gear

A PR belongs to a repository, so there is no `component` dimension to group it
by. But a PR touches files, and files have paths — so a PR can be **attributed**
to every gear it touched. The chain is:

```text
silver.class_git_pull_requests          state, author, branches, timestamps
  └─ pr_id ─► class_git_pull_requests_commits ─► commit_hash
                                                    └─► insight.git_commit_file_changes ─► file_path
```

Three things have to be right or the answer is quietly wrong.

**Deduplicate by `_version`.** The PR table keeps every ingested version of a
row — 2 702 rows for 2 111 distinct PRs — and a row carries the state it had
when it was ingested. So a PR that was opened and later merged appears both as
OPEN and as MERGED, and a bare `GROUP BY state` reports it twice. Collapsing to
the current state first (`argMax(col, _version) … GROUP BY pr_id`) is what makes
the three counts add up to the PR count instead of exceeding it by a quarter.

**Join on the merge commit *and* the PR's commits.** Which one carries the files
depends on how the repository merges, and getting this wrong silently drops most
of a repo:

| repository | merges via | `merge_commit_hash` has files | PR commits have files |
| --- | --- | --- | --- |
| `gears-frontx` | squash | 70 of 75 merged | 4 of 75 |
| `gears-rust` | merge commit | 0 of 314 | 309 of 314 |

A squash leaves one new commit that the PR's own commits never became; a merge
commit has an empty diff of its own. `UNION DISTINCT` of the two covers both.

**Unmerged PRs are only partly attributable**, and that is structural rather
than a gap to fix. `git_commit_file_changes` is built from the repository's
history; a closed-without-merge PR's commits usually never entered it:

| current state | PRs | attributable to files | |
| --- | --- | --- | --- |
| MERGED | 1 428 | 1 391 | **97%** |
| CLOSED | 560 | 164 | 29% |
| OPEN | 123 | 57 | 46% |

So: PR-per-gear is dependable for what shipped, indicative for what was
abandoned. Say which one a dashboard means.

#### The query

```sql
WITH prs AS (
  SELECT pr_id,
         argMax(state, _version)             AS state,
         argMax(merge_commit_hash, _version)  AS merge_sha,
         argMax(created_on, _version)         AS created_on,
         argMax(closed_on, _version)          AS closed_on
  FROM silver.class_git_pull_requests
  WHERE project_key = 'constructorfabric' AND repo_slug = 'gears-rust'
  GROUP BY pr_id
),
pr_commit AS (
  SELECT pr_id, commit_hash FROM silver.class_git_pull_requests_commits
  WHERE project_key = 'constructorfabric' AND repo_slug = 'gears-rust'
  UNION DISTINCT
  SELECT pr_id, merge_sha FROM prs WHERE merge_sha != ''
),
touched AS (
  SELECT DISTINCT pc.pr_id AS pr_id,
         arrayJoin(arrayFilter(g -> has(splitByChar('/', f.file_path), g),
           ['api-gateway','credstore','chat-engine','mini-chat','file-storage',
            'types-registry','account-management','graph-storage'])) AS gear
  FROM pr_commit AS pc
  INNER JOIN insight.git_commit_file_changes AS f ON f.commit_hash = pc.commit_hash
  WHERE f.project_key = 'constructorfabric' AND f.repo_slug = 'gears-rust'
)
SELECT t.gear AS gear,
       countIf(p.state = 'OPEN')   AS open,
       countIf(p.state = 'MERGED') AS merged,
       countIf(p.state = 'CLOSED') AS closed,
       count() AS total,
       round(avgIf(dateDiff('hour', p.created_on, p.closed_on), p.state = 'MERGED'), 1) AS merged_cycle_h
FROM touched AS t INNER JOIN prs AS p ON p.pr_id = t.pr_id
GROUP BY gear ORDER BY total DESC
```

```text
gear                open  merged  closed  total  merged_cycle_h
account-management     1      53       4     58           110.9
api-gateway            1      36      15     52           149.7
mini-chat              1      37      13     51           140.1
credstore              1      35      13     49           168.0
types-registry         1      33      10     44            96.2
chat-engine            1      35       2     38           100.2
file-storage           1      23       0     24           121.0
graph-storage          0       2       0      2           274.5
```

`has(splitByChar('/', file_path), g)` is the same whole-segment match
`/components/metrics` uses, so a gear is found without anybody maintaining a
crate → directory map, and `credstore` does not swallow `credstore-sdk`.

All of this is also a typed operation —
[`POST /components/pull-requests`](#pull-requests-per-component-the-typed-operation)
— so a caller does not have to get the three traps above right. The statement is
here because knowing what it does is the difference between reading the numbers
and believing them.

**A PR that touches three gears counts in all three.** The column does not sum
to the repository's PR count, and it should not: the question is "how much pull
request traffic passes through this gear", not "how were the PRs divided up".

Grouping by path depth instead — `arrayStringConcat(arraySlice(splitByChar('/',
f.file_path), 1, 3), '/')` — works too, but on a Rust workspace the top of that
ranking is `Cargo.lock`, `Cargo.toml` and `CHANGELOG.md`: the root files nearly
every PR touches. Naming the gears avoids it.

#### Review load, the same way

`insight.git_review_events` carries `pr_id`, so the same `touched` CTE answers
who reviewed what:

```sql
WITH prs AS (
  SELECT pr_id, argMax(merge_commit_hash, _version) AS merge_sha
  FROM silver.class_git_pull_requests
  WHERE project_key = 'constructorfabric' AND repo_slug = 'gears-rust'
  GROUP BY pr_id
),
pr_commit AS (
  SELECT pr_id, commit_hash FROM silver.class_git_pull_requests_commits
  WHERE project_key = 'constructorfabric' AND repo_slug = 'gears-rust'
  UNION DISTINCT
  SELECT pr_id, merge_sha FROM prs WHERE merge_sha != ''
),
touched AS (
  SELECT DISTINCT pc.pr_id AS pr_id,
         arrayJoin(arrayFilter(g -> has(splitByChar('/', f.file_path), g),
           ['api-gateway','credstore','chat-engine','mini-chat','file-storage',
            'types-registry','account-management'])) AS gear
  FROM pr_commit AS pc
  INNER JOIN insight.git_commit_file_changes AS f ON f.commit_hash = pc.commit_hash
  WHERE f.project_key = 'constructorfabric' AND f.repo_slug = 'gears-rust'
)
SELECT t.gear AS gear,
       countIf(e.event_kind = 'review')  AS reviews,
       countIf(e.event_kind = 'comment') AS comments,
       countDistinct(e.actor_person_id)  AS reviewers
FROM touched AS t
INNER JOIN insight.git_review_events AS e ON e.pr_id = t.pr_id
GROUP BY gear ORDER BY reviews DESC
```

```text
gear                reviews  comments  reviewers
mini-chat               595       804         18
account-management      583       831         22
credstore               555       711         19
chat-engine             507       684         12
file-storage            467       648         13
types-registry          333       511         13
api-gateway             304       550         14
```

**The PR window is shorter than the git window.** Pull requests start
2026-05-26 in this warehouse while commits go back to 2025-12, so a 12-month
PR chart is mostly empty by construction. Check `min(created_on)` before
choosing a range.

### Everything a component did

That one is a typed operation rather than a statement — see
[Metrics per component](#metrics-per-component-gear) below.

## Why the gold views read empty

`exec_summary`, `people`, `ic_kpis` and the other person-level views answer with
zero rows for this token, while the facts underneath answer fine. That is not a
broken deployment; it is two missing joins:

**Identity resolution is thin.** Git observations are keyed by the raw author
handle. Turning that into a person goes through `identity.account_assignment`
(178 rows) and `identity.person_map` (146), and of the **179 distinct git
authors only 27 are assigned to a person** — `identity.aliases` is empty
altogether. So anything grouped by `person_id` loses ~85% of the activity, and
the views that start from `people` return nothing at all.

```sql
SELECT count() AS git_authors,
       countIf(entity_id IN (SELECT account_id FROM identity.account_assignment)) AS assigned
FROM (SELECT DISTINCT entity_id FROM insight.git_metric_observations)
-- → 179, 27
```

**There is no HR source.** `exec_summary` and `ic_kpis` group by `org_unit_id`,
which comes from BambooHR / Workday / Active Directory — all present as empty
`bronze_*` databases.

The practical rule: **repository- and component-level analytics need no identity
and work today; person- and org-level analytics wait on identity resolution and
an HR feed.** Everything this gear exposes deliberately sits on the first side
of that line.

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
| `POST /cf/studio-insight/v1/components/pull-requests` | Pull requests by state, sliced by component. |
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

### How a request is served

```text
portal
  │  POST /cf/studio-insight/v1/query
  │  POST /cf/studio-insight/v1/components/metrics
  ▼
api-gateway              strips /cf, authenticates the caller
  ▼
rest.rs                  DTO in, arguments validated, error mapped on the way out
  │
  ├─ components.rs       builds ONE read-only statement: validate → escape → render
  ▼
client.rs                InsightClient::query(sql)
  │  POST {base}{api_path}/{sql_resource}
  │  Authorization: Bearer <instance token>    ← attached here, never sent to the browser
  ▼
Insight                  {columns, rows, row_count, truncated}
  │
  └─ InsightError        400 the caller's · 503 the upstream's · 500 ours
```

Three things about that path are deliberate:

**The token never reaches the browser.** The portal calls our gateway with its
own session token; the Insight credential is attached server-side, in
`client.rs`. Nothing in the response carries it — `health` reports `configured`
and `base_url`, never the key.

**A trend costs a second query, and only when asked.** `components/metrics`
runs the totals first, takes the component keys the ranking kept, and only then
runs the bucketed statement restricted to those keys. Asking for a chart over a
large repository therefore cannot quietly become a query over all of it, and a
caller that wants numbers without a chart pays for one round trip.

**The failure is attributed before it is reported.** `InsightError` has three
shapes — `NotConfigured`, `Transport`, `Upstream { status, body }` — and only
the third can be the caller's fault. `to_canonical` maps an upstream 400/422 to
our 400 with Insight's own `detail` in a field violation, and everything else to
503 or 500. Without that, a typo in a statement and a dead upstream look
identical to whoever is reading the portal.

### Reaching it from another gear

The client is published to the ClientHub at `init`, before any REST phase, so a
consumer resolving it in its own REST phase cannot lose a race:

```rust
use crate::insight::{InsightClient, INSIGHT_INSTANCE_ID};
use toolkit::client_hub::ClientScope;

let insight = ctx
    .client_hub()
    .get_scoped::<dyn InsightClient>(&ClientScope::gts_id(INSIGHT_INSTANCE_ID))?;

let page = insight
    .query("SELECT count() AS n FROM insight.git_metric_observations")
    .await?;
let n = page.rows.first().and_then(|r| r.get("n")).and_then(|v| v.as_u64());
```

`SqlPage` is `{columns, rows, row_count, truncated}` with `rows` as JSON objects
keyed by column name — a warehouse row has no shape this gear could usefully
impose on it, so it is passed through and the caller names its own columns.

### Writing a statement that Insight will accept

* **One `SELECT` or `WITH`.** No second statement, no `SHOW`, no DDL. Schema
  discovery is `system.tables` / `system.columns`.
* **Aggregate in SQL, not in the caller.** `truncated: true` means the rows are
  a prefix; an average computed over a truncated page is not the average.
* **Name the dimension you slice by.** `ARRAY JOIN dimensions AS d` without a
  `WHERE d.key = …` multiplies every observation by its dimension count, and the
  result looks plausible.
* **Guard the divisions.** `nullIf(x, 0)` rather than a rate that becomes `inf`
  the first week a repository is quiet.
* **Say `today() - N`, not a literal date**, unless the window is the point —
  the warehouse's idea of today is the one the data is keyed by.

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

* **This operation returns no PR or CI metrics.** Neither exists as a
  dimension below the repository, because that is the entity a PR and a
  pipeline run belong to. A PR can still be *attributed* to the gears it
  touched — see [Pull requests, by state and by gear](#pull-requests-by-state-and-by-gear)
  for the join and its coverage — but that is a statement through `/query`,
  not this endpoint. CI has no equivalent: a pipeline run names a commit, not a
  file, so there is nothing to attribute it with.
* **Churn is not delivery.** `lines_added` counts generated files, vendored
  code and lockfiles exactly like hand-written logic. Declare components with
  prefixes that exclude what you do not mean, rather than reading the raw
  ranking as productivity.

Everything interpolated into the generated statement is validated (repository
charset, `YYYY-MM-DD` dates, depth 1–6, limit ≤ 500) *and* escaped. A malformed
`repository` is a 400 with a field violation, not an upstream error.

## Pull requests per component (the typed operation)

The cookbook above shows the join by hand. `POST
/cf/studio-insight/v1/components/pull-requests` is the same thing as an
operation, so a caller does not have to get the three traps right:

```json
{
  "repository": "constructorfabric/gears-rust",
  "from": "2026-05-01",
  "components": [{"key": "api-gateway"}, {"key": "credstore"}, {"key": "mini-chat"}],
  "include_other": false
}
```

```json
{
  "repository": "constructorfabric/gears-rust",
  "from": "2026-05-01", "to": "2026-09-11",
  "components": [
    {"component": "api-gateway", "open": 1, "merged": 36, "closed": 15,
     "total": 52, "merged_cycle_hours": 149.8, "authors": 14},
    {"component": "mini-chat",   "open": 1, "merged": 37, "closed": 13,
     "total": 51, "merged_cycle_hours": 140.1, "authors": 16}
  ],
  "truncated": false
}
```

It takes the same arguments as `components/metrics` — `repository`, the window,
`components` (path prefix or directory name, the key by default), `depth`,
`include_other`, `limit` — and applies the same validation, escaping and
longest-matcher-wins rule, because it renders from the same validated query.

Three differences worth knowing:

* **The window is on when a pull request was *opened*.** An open PR older than
  the window is out of scope. The alternative — current state, no window — makes
  a date filter mean nothing for two of the three states.
* **`merged_cycle_hours` is absent, not zero, when nothing merged.** It is also
  computed in minutes and divided, because `dateDiff('hour', …)` truncates:
  23 of `gears-rust`'s 590 pull requests merge inside an hour, so hour
  granularity records them as zero and drags the mean down — and excluding them
  to avoid that drags it up. Minutes avoid both.
* **The rows do not partition the repository's pull requests.** One touching
  three components is counted in all three. The question is how much pull
  request traffic passes through a component, not how the PRs were divided up.

And the coverage from the cookbook applies unchanged: ~97% of merged pull
requests reach their files, ~29% of closed and ~46% of open ones. A PR that
reaches no file is absent rather than counted against some fallback component,
which is why these totals sit below the repository's.

### In the portal

The prototype's **Components** page is the first consumer
(`studio-frontend-prototype/src/gear-activity.tsx`). It groups the catalogue by
the `repository` each crate publishes from and sends the gear names as
components — **two** requests per repository, `components/metrics` with
`bucket: "week"` and `components/pull-requests`, both with
`include_other: false`. Nobody maintains a crate → directory map: 47 of the
gears in `gears-rust` resolve on name alone.

Pull requests are a separate call on purpose, and their failure is swallowed: a
warehouse without them is not a reason to lose the commit activity too.

Each list card then carries a 12-week churn sparkline and the headline numbers,
and a gear's page gets a **Delivery activity** panel: five stat tiles, a weekly
bipolar column chart (lines added above the zero rule, removed below, one scale
for both arms), a table view of the same numbers, and a 30 / 90 / 365-day window
switch. The two data colours are the validated diverging pair (blue ↔ red) —
ΔE 21.6 light / 19.2 dark under simulated protanopia, ≥3:1 on both surfaces.

Under it, a **Pull requests** block: open, merged, closed and the mean merge
time, as four tiles rather than a chart. Three counts and a mean is what a stat
tile is for; a stacked bar would spend the categorical palette restating four
labelled numbers, and its hues would collide with the blue/red the churn chart
above already uses for a different meaning.

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

Four checks on the upstream contract — `SELECT 1` succeeds, a missing token is
a 401, a non-`SELECT` is a 400, the catalog is readable — and, with a portal
token, eight on the gear: the health probe, a statement passed through, a
rejected statement mapped to 400, components derived by depth, components
resolved by name with a weekly series, pull requests per named gear in every
state, and two malformed requests refused.

It then **re-runs every ```sql block on this page** through the gear. Not to
check the figures — the warehouse moves, and they are a snapshot of
2026-09-11 — but to catch a documented statement that stopped being valid: a
renamed table, a dropped measure, a tightened upstream. A doc that prints
answers has to be executable, or it rots without saying so.

```text
19 passed, 0 failed
```
