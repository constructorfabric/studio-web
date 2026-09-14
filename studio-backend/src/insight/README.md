# studio-insight

The integration seam to **Constructor Insight**
(`github.com/constructorfabric/insight`), a decision-intelligence platform whose
REST API is rooted at `/api`.

## Why it exists

Insight is a separate product with its own deployment, its own credential and
its own evolving contract. Rather than let each gear that wants it grow its own
HTTP client and its own copy of the base URL, this gear is the assembly's one
place of contact — so when the contract moves, one module changes.

It moved once already. This gear was written against an assumed `/api/v1` and a
generic `pull`/`push` pair; checked against the live deployment, `/api/v1` and
every path under it answer 404, and the surface Insight actually exposes is a
single **read-only SQL endpoint** over its ClickHouse warehouse.

## The upstream contract

```http
POST {base_url}/api/sql/query
Authorization: Bearer <instance token>

{"sql": "SELECT 1"}
→ {"columns":[{"name":"1","type":"UInt8"}],"row_count":1,"rows":[{"1":1}],"truncated":false}
```

One statement, `SELECT` or `WITH` only — a second statement, a `SHOW`, or any
write is refused with a 400 naming the violation. The token goes in as a bearer;
anywhere else is a 401 `INVALID_INSTANCE_TOKEN`. There is no schema endpoint and
no OpenAPI document, so discovery goes through ClickHouse's own catalog
(`system.tables`, `system.columns`).

`docs/insight-quickstart.md` records the whole contract, the shape of the
warehouse, worked queries with their real answers, and how to check the wiring.

## What is actually in there

Three shapes per domain, and the grain matters: `*_metric_observations` is one
**person**, one day, one measure, one set of dimensions — the repository is a
*dimension*, not the entity, and there is no dimension below it.
`*_metric_evidence` says which records made a number. The raw tables
(`git_commit_file_changes`, `git_authored_commits`, `git_review_events`,
`task_status_spans`) carry the detail, and are the only place a **file path**
exists — which is why `components/metrics` reads them rather than the
observations.

Populated today: git (37 measures — commits, lines, PR cycle/first-review/
review-to-merge hours, reviewer counts), CI (10 — gate runs, pass and first-try
rates, durations, deployments), task (8 — closed, reopened, pickup and
resolution days). The `ai_*`, `collab_*` and `wiki_*` families exist with the
same shape and zero rows: those connectors are not ingested for this tenant.

The person-level gold views (`exec_summary`, `people`, `ic_kpis`) read empty,
and that is a data-coverage fact rather than a bug: only 27 of the 179 git
author handles are assigned to a person, and no HR source feeds `org_unit_id`.
Repository- and component-level questions need neither, which is why everything
this gear exposes sits on that side of the line.

## Two ways in

- **REST** (`/studio-insight/v1/{query,components/metrics,components/pull-requests,
  pull,push,health}`)
  for the portal and out-of-process callers.
- **An in-process `InsightClient`** published to the ClientHub, so another gear
  reaches Insight without a network hop back through our own gateway.

`pull`/`push` stay as the generic `resource + JSON` escape hatch for whatever
Insight publishes next — the point of having the seam is that adding a typed
operation is a change here and nowhere else.

## REST

| Method + path | Does |
|---|---|
| `POST /query` | run one read-only statement; returns columns, rows, `truncated` |
| `POST /components/metrics` | delivery metrics for one repository, sliced by component |
| `POST /components/pull-requests` | pull requests for one repository, by state, sliced by component |
| `POST /pull` | read a resource from Insight |
| `POST /push` | send one to it |
| `GET /health` | is the upstream configured, and does it answer a `SELECT 1` |

Errors are mapped by fault: a statement Insight rejects is the caller's **400**
with the upstream's own message; an unconfigured or unreachable upstream is
**503**; anything else is **500**. Otherwise every SQL typo reads as "the
platform is broken".

## Components, not repositories

Insight keys its git metrics by `repository` and nothing finer, but a repository
is not a component — `gears-rust` alone holds ~90 gear crates under
`gears/<area>/<name>/`. `components/metrics` groups the per-file commit records
underneath it, either by path depth or by a declared component map. A component
is named by a path prefix or, more usefully for a caller that knows names and
not paths, by a **directory name** matched as a whole path segment: send
`api-gateway` and the seam finds `gears/system/api-gateway/…` without anybody
maintaining a crate → directory map. `components.rs` carries the detail.

## In the assembly

- Gear `studio-insight`, capabilities `[rest]`, no gear deps.
- Config section `gears.studio-insight`; the host is in `config/*.yaml` and the
  key comes from the environment (`api_key_env`), so the credential is never in
  the repository.
- Not configured in every profile — a deployment without an Insight to talk to
  simply omits the section, and every call then answers 503 with the variables
  to set.
