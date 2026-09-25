# Graph PostgreSQL for dev and test

This is an experimental PostgreSQL 19 beta deployment. PostgreSQL 19 is not in
CloudNativePG's supported PostgreSQL range yet; do not use this profile for
production data.

## Connections

`max_connections` is declared in both templates at PostgreSQL's own default of
100. It is written down rather than inherited because it is a budget several
other files spend against, and an implicit ceiling is one nobody can check:

| Consumer | Ceiling | Where it is set |
|---|---|---|
| studio-backend, 13 gear pools | 52 | `pool.max_conns: 4` on `pg_main`, `studio-backend/config/k8s.yaml` |
| studio-backend, graph-storage | 8 | that gear's own `pool` override |
| studio-backend, studio-events | 2 | that gear's own `pool` override |
| Keycloak | 10 | `keycloak.dbPoolMaxSize`, `deploy/helm/studio-web/values.yaml` |
| backend-bootstrap Job | ~2 | transient, one pass per upgrade |
| CloudNativePG + exporter | ~5 | the operator |
| `superuser_reserved_connections` | 3 | PostgreSQL default |
| **Total** | **~82** | |

The thing to know before changing any of it: toolkit-db caches one pool **per
gear**, not per server, so the `max_conns` on `pg_main` is multiplied by the
number of gear databases — fourteen. Raising it by one raises the ceiling by
fourteen. Give a single gear its own `pool` block instead, the way
`graph-storage` has one.

A second backend replica doubles the backend's share — 128 on its own — which
does not fit, and this is now the **main** thing in the way of running one.
The other blocker, a push channel whose sequence lived in process memory, is
gone: `studio-events` keeps its sequence and its replay window in the database
listed above, so two replicas agree on what a cursor means.

So `max_connections` is **150**, not PostgreSQL's default of 100. The
arithmetic, which is the whole reason for the number:

| shared `max_conns` | per replica | two replicas | with everyone else | under 100? |
|---|---|---|---|---|
| 4 (today) | 64 | 128 | 148 | no |
| 3 | 51 | 102 | 122 | no |
| 2 | 38 | 76 | 96 | yes |

(Per replica: thirteen gears on the shared pool, plus graph-storage's own 8,
studio-events' 2 and studio-artifact-ingest's 2.)

Lowering the per-gear pool is therefore not the way to make room: three
connections per gear still does not fit, and two — the only value that does —
is a queue rather than a budget for any gear serving a burst.

Raising the ceiling is not free either. A PostgreSQL backend is a process, so
150 of them is roughly another 400 MB of resident memory at saturation, and
`resources.limits.memory` moves from 2 Gi to 3 Gi with it. That is the trade
being made: memory on one server against a second replica of the backend.

The pooler below is the third way and is not available yet.

> **This takes effect on the next Deploy Infra**, and changing
> `max_connections` restarts PostgreSQL — it is not a reloadable parameter.
> Plan it like any other database restart.

### PgBouncer

`pooler.template.yaml` is a CloudNativePG `Pooler` and is **deliberately not
applied**. Session pooling would multiplex nothing here (the backend's pools
are long-lived, so each would simply hold a server connection), and transaction
pooling is blocked by two things in the backend: sqlx's per-connection prepared
statement cache, which toolkit-db exposes no way to disable, and
studio-scheduler's session-level advisory lock, which transaction pooling would
quietly stop enforcing. The file states both in full, along with what to change
and how to verify it afterwards.

## Ordering

1. Create an `infra-v*` tag on a tested commit from `main` and wait for the
   **Build Images** workflow to publish the infrastructure release.
2. Confirm that the graph PostgreSQL and Keycloak release images are readable
   from GHCR.
   Public image visibility does not grant Kubernetes deploy access; deployments
   remain controlled by cluster RBAC.
3. Install the pinned CloudNativePG operator version documented in the cluster
   runbook and wait for its controller deployment.
4. Run **Deploy Infra** with the published `infra-v*` tag. It renders the
   matching template with the versioned image reference and applies it to the
   selected namespace.
5. Wait for `cluster/studio-postgres` to report `Cluster in healthy state`.
6. Verify that Secret `studio-postgres-app` exists. CloudNativePG creates it;
   both Helm environment values map the username key to `username`.

The dev template creates one 10 GiB Cinder-backed instance. The test template
creates two 20 GiB Cinder-backed instances on separate nodes. Neither exposes a
public Service. Each template also reconciles a separate logical `keycloak`
database and login role inside the same PostgreSQL cluster. Create the
namespace-local `keycloak-postgres-app` Secret before applying the template; it
must use type `kubernetes.io/basic-auth`, contain `username: keycloak` and a
strong `password`, and also provide `host`, `port`, and `dbname` keys for the
Keycloak workload. Keycloak 26.7 does not officially support PostgreSQL 19, so
this shared-cluster layout is for dev/test only. Backup configuration is
intentionally a separate gate and must be completed before storing important
data.
