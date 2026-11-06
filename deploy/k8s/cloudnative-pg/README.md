# Graph PostgreSQL for dev and test

This is an experimental PostgreSQL 19 beta deployment. PostgreSQL 19 is not in
CloudNativePG's supported PostgreSQL range yet; do not use this profile for
production data.

## Connections

`max_connections` is **160** in both templates. It is written down rather than
inherited because it is a budget several other files spend against, and an
implicit ceiling is one nobody can check. Per backend replica:

| Consumer | Ceiling | Where it is set |
|---|---|---|
| studio-backend, 14 gear pools | 42 | `pool.max_conns: 3` on `pg_main`, `studio-backend/config/k8s.yaml` |
| studio-backend, graph-storage | 8 | that gear's own `pool` override |
| studio-backend, studio-events | 2 | that gear's own `pool` override |
| studio-backend, studio-product | 2 | that gear's own `pool` override (ADR-0053) |
| studio-backend, studio-artifact-ingest | 2 | that gear's own `pool` override |
| studio-backend, studio-domain-model | 2 | that gear's own `pool` override (ADR-0066) |
| studio-backend, studio-environments | 1 | that gear's own `pool` override (ADR-0062) |
| studio-backend, postgres-usage-collector-plugin | 3 | 1 on its toolkit `pool`, 2 on its own sqlx pool (`pool_size_max`) |
| **One replica** | **62** | |

And once, whatever the number of replicas:

| Consumer | Ceiling | Where it is set |
|---|---|---|
| Keycloak | 10 | `keycloak.dbPoolMaxSize`, `deploy/helm/studio-web/values.yaml` |
| backend-bootstrap Job | ~2 | transient, one pass per upgrade |
| CloudNativePG + exporter | ~5 | the operator |
| `superuser_reserved_connections` | 3 | PostgreSQL default |
| **Everyone else** | **~20** | |

The thing to know before changing any of it: toolkit-db caches one pool **per
gear**, not per server, so the `max_conns` on `pg_main` is multiplied by the
number of gear databases that inherit it -- fourteen (the gears in `k8s.yaml`
with a `database:` on `pg_main` and no `pool` of their own). Raising it by one
raises the ceiling by fourteen per replica. Give a single gear its own `pool`
block instead, the way `graph-storage` has one.

The arithmetic for two replicas, which is the whole reason for the numbers:

| shared `max_conns` | per replica | two replicas | with everyone else | fits 160? |
|---|---|---|---|---|
| 4 (until 2026-11) | 76 | 152 | 172 | no |
| **3 (today)** | **62** | **124** | **144** | **yes, 16 spare** |
| 2 | 48 | 96 | 116 | yes, but a queue |

The shared pool was 4 until the domain read model (ADR-0066), the product
descriptions (ADR-0053) and the environments gear (ADR-0062) each took their
own pool: two replicas then needed more than 160, and a second replica could
not start without raising `max_connections` again. It is 3 now, not the
server limit higher:

- **Lowering one knob** that every small gear inherits frees fourteen
  connections per replica; lowering any single gear's own pool frees one or
  two, and the gears with their own pools have them because they need them
  (graph-storage's 8 is the busiest pool there is).
- **Two replicas at 3 give each gear 6** connections in all, more than one
  replica at 4 gave it. A gear that queues behind 3 on one replica is one that
  wants its own `pool` block anyway.
- **Raising the ceiling is not free.** A PostgreSQL backend is a process, so
  every ten more is roughly another 30 MB of resident memory at saturation,
  and `max_connections` is not reloadable.

Two is the floor not to go to: it would be a queue rather than a budget for
any gear serving a burst. The pooler below is the other way to make room and
is not available yet.

> **Changing `max_connections` takes effect on the next Deploy Infra**, and it
> restarts PostgreSQL -- it is not a reloadable parameter. Plan it like any
> other database restart. Changing a `max_conns` takes effect on the next
> backend deploy.

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
