# Observability — metrics for the studio cluster

Metrics collection for the `webstudio` cluster, provisioned as code: three Helm
releases in the `studio-monitoring` namespace, each with a pinned chart version
and a values file in this directory. `make all` is idempotent.

The shape follows the stack Insight runs, minus the parts we have no source for
(no ClickHouse, no Airbyte/dbt). There is **no Prometheus server and no
Alertmanager**: VictoriaMetrics is the Prometheus-compatible store, and Alloy is
both the scraper and the OTLP receiver.

```
studio-backend ──OTLP :4317──┐
                             │
kubelet / cAdvisor ──────────┤
kube-state-metrics ──────────┼──► Alloy ──remote_write──► VictoriaMetrics ──PromQL──► (Grafana)
Traefik :9100 ───────────────┤     1 replica              30 d, 20 Gi
CloudNativePG :9187 ─────────┘
```

## Components

| Release | Chart | Role |
|---|---|---|
| `vm` | `vm/victoria-metrics-single` 0.45.0 | Metrics store. PromQL in, `remote_write` in, 30-day retention on a 20 Gi `cinder-default` PVC. |
| `kube-state-metrics` | `prometheus-community/kube-state-metrics` 8.4.1 | Kubernetes object state: readiness, restarts, OOMKills, replicas, pod phase. |
| `alloy-metrics` | `grafana/alloy` 1.12.1 | Deployment (not the chart's default DaemonSet). Scrapes every target, receives OTLP, remote-writes to `vm`. |
| `grafana` | `grafana/grafana` 10.5.15 | The UI. No persistence: datasource and dashboards are provisioned, so a deleted pod comes back identical. |

Plus one NetworkPolicy per application namespace (`scrape-netpol.yaml`) — see
**Reaching the application namespaces**.

## What is scraped

Everything below already exported metrics before this stack existed — nothing in
the cluster had to be modified to be observed.

| Job | Target | Gives |
|---|---|---|
| `kubelet-cadvisor` | kubelet `:10250/metrics/cadvisor` | Per-container CPU, memory, network |
| `kubelet-resource` | kubelet `:10250/metrics/resource` | Kubelet's own resource accounting |
| `kube-state-metrics` | in-namespace Service `:8080` | Restarts, OOMKills, ready-vs-desired, pod phase |
| `traefik` | Traefik pods `:9100` | Edge RED: request rate, status classes, TLS and connection failures |
| `cnpg` | CloudNativePG instance pods `:9187` | Postgres: connections, transactions, replication, WAL, database size |
| (OTLP) | pushed by `studio-backend` | `http_server_request_duration_seconds_*` — RED per `http.route` |

The OTLP receiver listened from day one. The backend pushes from the first
deploy that carries `backend.telemetry.metrics: true`, which the dev and test
environment values now set (see **Turning on application metrics**).

## Dashboards

Three, provisioned into the **Studio** folder from `grafana/dashboards/*.json`:

| UID | Covers |
|---|---|
| `studio-resources` | Per-pod CPU, memory vs limit, throttling, network I/O, restarts, OOMKills, ready-vs-desired, live Theia sessions. |
| `studio-edge` | Traefik: request rate, status classes, per-service rate and errors, latency percentiles, exporter health. |
| `studio-postgres` | CNPG: instances up, backends, cache hit ratio, longest transaction, commits/rollbacks, database sizes, replication lag, lock waits. |

All three carry the same **Namespace** dropdown, so one choice of environment
follows you between them — Grafana keeps a variable's value across dashboards
when the name matches. On Resources and Postgres it reads the `namespace` label
directly; on Edge it cannot, because Traefik's metrics come from Traefik's own
namespace, so the list is lifted out of the service id
(`studio-dev-studio-studio-web-backend-http@kubernetes`) by a capture group.
Three panels there stay cluster-wide and say so in their titles: the entrypoint
connection count and the exporter's own `up` carry no service label to filter
on.

`make dashboards` rebuilds the `studio-dashboards` ConfigMap from those files;
the file provider re-reads the directory every 30 s, so no restart is needed.

**Nothing is lost when Grafana dies.** `persistence` is off, the dashboards are
files in this repository mounted as a ConfigMap, and the datasource is
provisioned from `values.yaml` — a deleted pod comes back identical. The
corollary is the part that surprises people: editing a dashboard in the browser
is a scratchpad. The provider runs with `allowUiUpdates: false`, so the UI's
save button changes nothing that survives a restart. To change a board, edit
the JSON here and run `make dashboards`; to keep an experiment made in the
browser, export its JSON from the share menu and commit it.

Two things this arrangement buys, both learned the hard way elsewhere:

- **No dashboard sidecar.** The chart's sidecar discovers labelled ConfigMaps
  through the Kubernetes API, and on this cluster it cannot: the API server's CA
  carries no Authority Key Identifier, which current OpenSSL rejects outright
  (`CERTIFICATE_VERIFY_FAILED ... Missing Authority Key Identifier`). Mounting
  the ConfigMap needs no API call, so the failure mode does not exist.
- **No Helm templating over dashboard JSON.** The JSON files become a ConfigMap
  via `kubectl`, never through `tpl`, so a legend format stays written the way
  Grafana wants it instead of being helm-escaped. (Insight, which embeds
  dashboards inline in a values file, has to escape every one of them.)

## Alerts

Five rules, provisioned from `grafana/alerting/rules.yaml` into the same
**Studio** folder. Grafana's own unified alerting evaluates them against
VictoriaMetrics — there is still no Alertmanager and no second component to
operate.

| Rule | Fires when | Severity |
|---|---|---|
| `studio-edge-5xx` | A Traefik service answers 5xx for >5% of requests for 10 min, while serving at least 3 req/min | page |
| `studio-backend-latency` | Backend p95 (streams excluded) above 2 s for 10 min | ticket |
| `studio-restart-loop` | A container restarts more than 3 times in an hour | page |
| `studio-oomkilled` | A container was OOMKilled and restarted in the last 15 min | page |
| `studio-pg-connections` | Postgres holds more than 80 backends for 10 min | page |

Every query but one is lifted from a dashboard panel in `grafana/dashboards`,
so it runs against a metric this cluster is known to produce. The exception is
`studio-backend-latency`, which reads the backend's own OTLP histogram — see
**Verifying the latency rule** below.

### Installing them

```bash
make alerts ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/...  # rules + delivery
make alerts                                                        # rules only
```

`make grafana` (and therefore `make all`) depends on `alerts`, so the ConfigMap
the pod mounts always exists. Alerting provisioning runs **once at startup**,
unlike the dashboard file provider, so changing a rule needs a restart:

```bash
make alerts && kubectl -n studio-monitoring rollout restart deploy/grafana
```

### Where a firing alert goes

A **Discord channel**, through an incoming webhook — the contact point is
`type: discord`, provisioned from `grafana/alerting/contactpoints.yaml.template`.

Nowhere, though, until somebody supplies `ALERT_WEBHOOK_URL`, which is the one
input this repository cannot hold: a Discord webhook URL is not a name, it is a
bearer capability to post into that channel. Get it from Discord → the channel
→ Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL.

Without it, `make alerts` installs `rules.yaml` alone, prints that delivery is
unconfigured, and the alerts are visible in Grafana's Alerting UI. With it, it
also renders `contactpoints.yaml` and installs `policies.yaml`: everything goes
to one receiver, `severity: page` repeating every 4 h and `severity: ticket`
daily. The two files travel together because a notification policy naming a
receiver that was never provisioned makes Grafana fail provisioning at startup.

Confirm the channel end before wiring Grafana to it:

```bash
grafana/alerting/test-delivery.sh https://discord.com/api/webhooks/...
```

It posts one notification in the shape Grafana really sends and reports what
Discord answered. Worth doing first, because the two halves fail into the same
silence: Grafana logs a delivery failure and tells nobody, so "the webhook is
wrong" and "the rules never fired" look identical from the channel.

**Two things about Discord specifically**, both measured against
`grafana/grafana:12.3.1` rather than read off a doc page:

- **`url` goes in `settings`, not `secureSettings`.** Grafana's own
  `/api/alert-notifiers` reports it as `secure: true`, which reads like an
  invitation to do the opposite — but file provisioning validates against
  `settings` and refuses the file, and a refused alerting file does not degrade
  provisioning, it aborts Grafana startup. Once ingested it *is* encrypted and
  redacted from the provisioning API; it is only the ConfigMap that holds it in
  clear. So the caveat stands: anyone who can read ConfigMaps in
  `studio-monitoring` can post into that channel.
- **The body is a custom template, not `default.message`.** Grafana puts the
  whole body into Discord's `content`, which Discord caps at 2000 characters
  and Grafana truncates to exactly that. `default.message` prints labels and
  annotations first and the Source and Silence links LAST, and with the runbook
  paragraphs these rules carry, two alerts already render 1838 of those 2000 —
  so a group of three loses the link you were about to click. The template here
  prints the rule, the summary and the link, at roughly 146 characters per
  alert, which keeps a group of ten intact.

### Verifying the latency rule

`studio-backend-latency` is the only rule whose metric did not exist when it was
written — it arrives with the first backend deploy carrying
`backend.telemetry.metrics: true`. Two things to confirm on the stand once that
lands, both one query:

```bash
kubectl -n studio-monitoring port-forward svc/vm-victoria-metrics-single-server 8428:8428

# 1. The series exists under the expected name.
curl -s 'localhost:8428/api/v1/query?query=count(http_server_request_duration_seconds_bucket)' | jq .

# 2. It carries `env`, so dev and test are separable. Both namespaces push to
#    one collector, and an OTLP series has no `namespace` label to derive it
#    from — `env` is copied from the `deployment.environment` resource
#    attribute by a relabel rule in alloy-metrics/values.yaml.
curl -s 'localhost:8428/api/v1/query?query=count%20by%20(env)%20(http_server_request_duration_seconds_bucket)' | jq .
```

If the first returns nothing, the rule is evaluating against an empty result.
That is why its `noDataState` is `NoData` rather than `OK`: a rule that
silently measures nothing is the exact failure this stack exists to remove, so
it is made visible instead of being made quiet. The other rules use `OK`,
because for them an empty result genuinely means "no traffic, no restarts,
nothing wrong".

### Thresholds

Structural, not tuned — a container in a restart loop, a connection pool eating
the server's ceiling, an error ratio an order of magnitude above healthy. None
of them needs a baseline to be obviously wrong, which is what keeps the channel
worth reading long enough to earn tuned numbers later. Insight's lesson (a
threshold picked before the baseline exists is the fastest route to a muted
channel) is the reason these are deliberately far from the edge rather than the
reason to have none.

`studio-pg-connections` is an absolute count rather than a fraction of
`max_connections` on purpose: the exporter family carrying that setting
(`cnpg_pg_settings_setting`) is dropped at the collector as static dead weight,
so there is nothing to divide by. Raise the threshold the day `max_connections`
is raised, and not before.

## Access: SSO over a port-forward

Grafana is `ClusterIP` only. The way in is

```bash
kubectl -n studio-monitoring port-forward svc/grafana 3000:80
# admin; password:
kubectl -n studio-monitoring get secret grafana -o jsonpath='{.data.admin-password}' | base64 -d
```

**SSO is live.** That login page offers a Keycloak button next to the local
admin form: the `grafana` client exists in the studio realm, and the redirect
URIs cover the port-forward, so the whole flow works today without any public
hostname. The client is **public, with PKCE** — the same shape `studio-portal`
uses — so there is no client secret anywhere to seal, rotate, or leak.

### The hostname: `studio.monitoring.cfabric.org`

Everything on this side is prepared and committed — `ingress.enabled: true`,
`ingress.hosts`, `grafana.ini.server.domain`, `root_url`, and the redirect URI
and web origin on the `grafana` client in `keycloak/realm-studio.json`.

**Two things outside this repository have to land before it answers**, and
they were requested together because either alone is worse than neither:

1. **A DNS record for `studio.monitoring.cfabric.org`.** Nothing under
   `monitoring.cfabric.org` resolves today — not the zone apex and not this
   name — so it has to be created rather than inherited from a wildcard. The
   origin is the Traefik LoadBalancer, `188.42.240.112`,
   the same entry the product's hostnames use, with Cloudflare in front
   terminating TLS. The cluster has no cert-manager `Issuer`, which is why the
   ingress values here carry no `tls` block and no annotations — the
   certificate was never ours to request.

2. **`studio-monitoring` added to the cluster Traefik's
   `--providers.kubernetesingress.namespaces`**, which reads
   `studio-dev,studio-test` today. Until it does, the Ingress object exists and
   Traefik cannot see it. That is a one-line change to a cluster-wide Traefik
   release this repository does not own.

The name is environment-neutral on purpose, and product-scoped on purpose. One
Grafana serves studio-dev and studio-test, so `grafana.studio-dev…` would
misdescribe what it shows; `monitoring` outlives the tool, since the
`grafana/grafana` chart is flagged deprecated upstream and the name should
survive replacing it; and the `studio.` prefix leaves `monitoring.cfabric.org`
a shared zone where other products get siblings rather than argue over an
apex.

A path on the existing host was considered and does not work: an Ingress cannot
point at a Service in another namespace and `allowExternalNameServices` is off.
The symptom is worth remembering either way — the frontend SPA answers `200` on
every path, so `/grafana/api/health` returned HTML and looked like a working
route.

**The port-forward keeps working** after the hostname lands. Its redirect URIs
stay on the `grafana` client alongside the new one, so the Keycloak button
works both ways.

### Keeping the realm and this repository in step

The deployed realm comes from the `studio-web-keycloak-realm` Secret, not from
the image and not from this file — `studio-delivery.yml` only checks that the
Secret exists. The client was therefore created twice: through the Admin API, so
the running Keycloak has it now, and in the Secret, so a Keycloak that starts
against an empty database imports it too. `keycloak/realm-studio.json` is the
source both were built from.

One constraint the file cannot show: Keycloak stores `client.description` in a
`varchar(255)`. A longer one fails with a Postgres error rather than a
validation message, and it fails the realm import the same way.

Everyone who authenticates gets **Viewer**. Dashboards are provisioned with
`allowUiUpdates: false`, so Editor would grant the right to change nothing that
survives a restart; Admin stays the local account, which also keeps a way in for
the case where the IdP is the thing that broke.

> The `grafana/grafana` chart is flagged `deprecated: true` upstream, yet 10.5.15
> is its newest release and carries the current Grafana (12.3.1). The successor
> is `grafana-operator`, a CRD-based rewrite — not worth it for one instance.
> Noted here so the flag is a known fact rather than a surprise at upgrade time.

## Reaching the application namespaces

`studio-dev` and `studio-test` carry a hand-applied `default-deny-ingress`.
Nothing in the repo created it, and it silently broke the first CNPG scrape:
discovery found all three Postgres instances, the targets showed `up == 0`, and
no component reported an error — a dropped packet reads exactly like a broken
exporter.

`scrape-netpol.yaml` opens one hole per namespace: from pods in
`studio-monitoring`, to the container port **named** `metrics`. The named port is
the same handle Alloy's discovery keeps on, so a workload becomes scrapable
exactly when it declares that it exports metrics. Nothing else crosses the
namespace boundary, and egress is untouched — the backend's OTLP push out to the
collector is an outbound connection, and only ingress is denied by default.

## Labels

Every series carries `cluster="webstudio"` (Alloy's `external_labels`). Series
that come from an application namespace also carry `env="dev"` or `env="test"`,
derived from `namespace` by a relabel rule — one store holds both environments
and a query separates them by label, not by reading pod names.

## Cardinality

The one workload here with unbounded pod churn is the session gear: it starts a
Theia pod per workspace, named `cf-studio-session-<workspace-uuid>`, and every
one of them becomes a fresh set of cAdvisor series that never repeats. The
`drop_noise` pass in `alloy-metrics/values.yaml` therefore drops the families
that multiply per device and per interface (`container_fs_*` rates,
`container_blkio_device_usage_total`, `container_network_{tcp,udp}_usage_total`,
`container_spec_*`, …), the pod-level roll-ups cAdvisor duplicates as an empty
`container` label, and the systemd slice tree.

What it deliberately keeps is per-pod CPU, memory and restarts for session pods:
that is the signal we want, and it is one series per pod per family. If session
volume grows enough to matter, the next cut is aggregating session pods into one
series at scrape time, not dropping them.

`kube_pod_labels` carries `cf.studio.session` and `cf.studio.workspace_id`
(the KSM allowlist), which is the only way to tell a session pod from a platform
pod in a query — cAdvisor series carry pod names, never pod labels.

## Turning on application metrics

The backend needs no code change. The `api-gateway` gear already installs the
`HttpMetrics` layer unconditionally — `http.server.request.duration` (histogram,
seconds, OTel semconv attributes `http.request.method`, `http.route`,
`http.response.status_code`) and `http.server.active_requests`. Without a meter
provider those instruments are no-ops, which is exactly the state today: there
is no `opentelemetry` block in `studio-backend/config/*.yaml`, so the toolkit
never initializes one.

Adding the block turns them on:

```yaml
opentelemetry:
  resource:
    service_name: "studio-backend"
  exporter:
    kind: "otlp_grpc"
    endpoint: "${STUDIO_OTLP_ENDPOINT:-http://alloy-metrics.studio-monitoring.svc.cluster.local:4317}"
  tracing:
    enabled: ${STUDIO_OTEL_TRACING:-false}
  metrics:
    enabled: ${STUDIO_OTEL_METRICS:-false}
```

That block is already in `studio-backend/config/k8s.yaml`, and the Helm chart
wires the switches (`backend.telemetry.metrics` / `.tracing` / `.endpoint` →
`STUDIO_OTEL_*`). The chart still defaults both to **off**, so an environment
without a collector is unaffected; `deploy/helm/values-dev.example.yaml` and
`values-test.example.yaml` turn `metrics` on, because those two clusters have
one. Tracing stays off everywhere — there is no Tempo, and spans with nowhere
to go are a batch processor filling up and dropping them.

Because the config file is baked into the image, the flags only take effect from
the next image build onward — flipping the value on a pod running an older image
changes nothing, since that image's config never mentions the variable.

Two things make that work, and both are easy to get wrong:

- `OpenTelemetryConfig` is `#[serde(deny_unknown_fields)]`. A stray key does not
  degrade to a default — it fails the boot.
- The toolkit expands `${VAR}` and `${VAR:-default}` textually, over the raw
  YAML, *before* parsing it. That is why `enabled: ${STUDIO_OTEL_METRICS:-false}`
  yields a real boolean and why the rubber duck is an env var, settable per
  environment from the Helm chart without rebuilding the image.

## Operating it

```bash
make all                  # namespace + all three releases (idempotent)
make status               # releases, pods, PVCs

# Query the store directly, before there is a Grafana to blame:
kubectl -n studio-monitoring port-forward svc/vm-victoria-metrics-single-server 8428:8428
curl -s 'localhost:8428/api/v1/query?query=up' | jq '.data.result[].metric.job'

# The collector's own view of its targets — read this before rewriting a query
# when a panel is empty:
kubectl -n studio-monitoring port-forward svc/alloy-metrics 12345:12345
open http://localhost:12345/
```

## Not here yet

- **Logs and traces.** Loki + an Alloy DaemonSet, Tempo for the OTLP spans the
  toolkit already knows how to emit.
- **A webhook URL for the alerts channel.** The destination is chosen and the
  contact point is written (Discord — see **Where a firing alert goes**); the
  URL is not in the repository and cannot be. Until it is supplied,
  `make alerts` installs the rules alone and says so out loud.
- **Domain metrics for `studio-session`.** Session start latency, failures to
  create, live sessions per tenant, idle reaping. These do not exist in any gear
  yet and need code (the pattern is a meter in the gear, as in
  `gears/bss/ledger/src/infra/metrics.rs`).
- **Multi-replica identity.** The backend runs one replica and the chart refuses
  to autoscale while the session registry is process-local. When that changes,
  OTLP series from two replicas collapse into one unless the pod identity is
  stamped on them (Insight uses a `k8sattributes` processor for exactly this).
