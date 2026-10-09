# Deploying studio-web to Kubernetes

The chart and environment values live in this repository so application and
deployment changes can be reviewed together. `.github/workflows/deploy.yml`
deploys backend and frontend services, while
`.github/workflows/deploy-infra.yml` deploys graph PostgreSQL and Keycloak.
Both are manually initiated and gated by GitHub Environments; no separate
infrastructure repository or Argo CD installation is used. The complete tag
and promotion contract is documented in [`PIPELINES.md`](PIPELINES.md).

## Images

Service images are published by the **Build Images** workflow on a `v*` tag:

- `ghcr.io/constructorfabric/studio-web/studio-backend:<tag>`
- `ghcr.io/constructorfabric/studio-web/studio-frontend:<tag>`

Infrastructure images are published only on an `infra-v*` tag:

- `ghcr.io/constructorfabric/studio-web/graph-postgres:<tag>`
- `ghcr.io/constructorfabric/studio-web/cf-studio-keycloak:<tag>`

Both run non-root (backend: `studio` system user; frontend:
nginx-unprivileged, uid 101, port 8080). Chart requires explicit immutable
tags — no `latest`.

## Configuration model

One image, any environment:

- **Backend** starts with `--config config/k8s.yaml`, which resolves every
  environment-specific value from env vars; the chart wires those from
  pre-created Secrets (see `values-dmz.example.yaml` header for the exact
  Secret names/keys).
- **Frontend** serves a static bundle; per-environment values (OIDC issuer,
  client id, links) are injected at container start into `env.js`
  (`window.__STUDIO_ENV__`) — no rebuild per environment.

## Feature flags in cluster v1

- **An installation names its own administrators** (`backend.platformAdmins`).
  A platform administrator is a membership of the platform root and nothing
  else (ADR-0018 §3): the token's tenant stopped granting it, so an
  installation that names nobody has no administrator at all, and the identity
  directory's routes answer `403 PLATFORM_ADMIN_REQUIRED` to everyone. The gear
  writes the membership from this list at every start, which is what makes it
  survive a database recreated from scratch.

  The value is Keycloak **subject ids**, comma-separated, and it is
  per-environment because a subject id is — the same person is a different
  subject on each Keycloak. Find one with

  ```bash
  curl -H "Authorization: Bearer $TOKEN"     "https://<host>/auth/admin/realms/studio/users?username=<name>&exact=true"
  ```

  Empty is a legitimate setting and the gear says so at boot rather than
  failing; it is only wrong if somebody expected to administer the place.
- **The Gearbox engine is environment-controlled** (`backend.gearbox.enabled`,
  off by default). On, the backend keeps a checkout of the gear corpus in an
  `emptyDir` (`sizeLimit: 2Gi`) and serves the gear catalogue an IDE lists when
  its workspace has no gears, product previews, and the corpus clone relay
  (`/studio-product/v1/gearbox/*`, run by the `studio-product` gear; three
  deprecated aliases stay under `/studio-components-catalog/v1/gearbox/`);
  off, those routes answer 503
  (`STUDIO_GEARBOX_WORKDIR is not set`) and Building's catalogue is empty in such a workspace. `corpusUrl`, `corpusRef`
  and `refreshSecs` override the code's defaults. The dev example turns it on
  with `MikeFalcon77/gears-rust` at `feature/gearbox`, the branch that carries
  `gear.gdl` until constructorfabric/gears-rust#4793 merges. The published
  backend image carries the `gearbox` binary at the pin the session image
  uses; it does nothing until this is on.
- **IDE sessions are environment-controlled** (`backend.sessions.enabled`).
  Dev enables the Kubernetes Pod driver and launches the immutable
  `cf-studio-theia` image matching the backend SHA. The backend needs a
  namespace-only Role for session Pods/Services. A cluster-admin chart install
  can create it with `backend.sessions.rbac.create=true`; restricted GitHub
  deployers must set that value to `false` and have an administrator bootstrap
  the Role and RoleBinding once (example below). Keep backend autoscaling
  disabled until the in-memory session registry is replaced by shared storage.
  Dev leaves session egress unrestricted so arbitrary Git sources can clone;
  controlled environments should enable the policy and list approved CIDRs.

  ```bash
  helm template studio deploy/helm/studio-web \
    --namespace studio-dev \
    --show-only templates/backend/sessions-rbac.yaml \
    --set backend.sessions.enabled=true \
    --set backend.sessions.rbac.create=true \
    --set backend.autoscaling.enabled=false \
  | kubectl --kubeconfig /path/to/admin.kubeconfig apply -f -
  ```

  Repeat with the target namespace for test/prod. Do not grant the application
  deployer general access to Roles or RoleBindings.
- **Namespace capacity is off until an administrator opens it**
  (`capacity.enabled`). The chart renders the namespace's `ResourceQuota` and
  `LimitRange` so the ceiling is reviewed like any other number, but the
  `studio-deployer` ServiceAccount the workflows run as cannot write either, and
  must not be able to grant itself the right. With it on, every deploy to that
  namespace stops at the server-side dry-run:

  ```text
  Error from server (Forbidden): resourcequotas "studio-dev" is forbidden:
  User "system:serviceaccount:studio-dev:studio-deployer" cannot patch
  resource "resourcequotas" in API group "" in the namespace "studio-dev"
  ```

  It stops safely — the dry-run precedes `helm upgrade`, so nothing is
  half-applied — but nothing deploys either. Same shape as the session Role
  above: an administrator grants it once, then the flag goes on.

  ```bash
  kubectl --kubeconfig /path/to/admin.kubeconfig apply -f - <<'YAML'
  apiVersion: rbac.authorization.k8s.io/v1
  kind: Role
  metadata:
    name: studio-deployer-capacity
    namespace: studio-dev
  rules:
    - apiGroups: [""]
      resources: ["resourcequotas", "limitranges"]
      # No `delete`: the chart only ever creates or updates these, and a
      # deployer that can delete a quota can lift its own ceiling.
      verbs: ["get", "list", "create", "patch", "update"]
  ---
  apiVersion: rbac.authorization.k8s.io/v1
  kind: RoleBinding
  metadata:
    name: studio-deployer-capacity
    namespace: studio-dev
  roleRef:
    apiGroup: rbac.authorization.k8s.io
    kind: Role
    name: studio-deployer-capacity
  subjects:
    - kind: ServiceAccount
      name: studio-deployer
      namespace: studio-dev
  YAML
  ```

  Then set `capacity.enabled: true` for that environment in the same change, so
  the flag and the permission it needs are reviewed together. Until then the
  hand-applied quota stays in force — the ceiling exists, git just does not
  describe it yet.
- **User invites are optional**: set `backend.idpAdmin.baseUrl` +
  `idp_admin_secret` to enable the Keycloak Admin provisioning plugin;
  without them the plugin self-deprioritizes.

## Rollout, restart, and the outage window

**A backend deploy is an outage.** Every environment runs one backend replica
with `maxUnavailable: 1, maxSurge: 0`, so the old pod stops before the new one
starts and the API is unavailable for as long as a boot takes. This is written
down rather than fixed because both ways out are closed today:

- a second replica is refused by the chart while `backend.sessions.enabled` is
  true, and
- `studio-events` fans out in-process, so two replicas would each serve half
  the subscribers their own half of the events.

Surge is not the missing piece either: `maxSurge: 1` needs a second backend's
worth of CPU and memory free on a stand that already runs at quota with IDE
sessions active, and it would still be refused by the replica guard.

What the chart does instead is make the window short and side-effect free:

| Setting | Default | What it prevents |
|---|---|---|
| `backend.startupBudgetSeconds` | 300 | A liveness probe killing the pod during boot. It migrates fourteen gear databases and may load an embedding model; the startup probe gives that its own budget, and liveness only begins after it passes. Before this, a slow boot looked like a crash loop. |
| `backend.preStopDrainSeconds` | 10 | 502s during the rollout. Endpoint removal and container shutdown are concurrent in Kubernetes, so without a pause the process starts stopping while kube-proxy still routes to it. |
| `backend.terminationGracePeriodSeconds` | 60 | In-flight requests being SIGKILLed. It deliberately does **not** cover the long-lived streams (SSE, the IDE WebSocket) — those run for minutes to an hour and waiting for them would mean never rolling. They are cut, and the portal reconnects with `?after_seq=`. |

The chart refuses to render if the drain does not fit inside the grace period,
and `studio-delivery.yml` asserts that refusal.

**The portal is not an outage.** `frontend.replicas: 2` in the environment
values, with the same `maxUnavailable: 1, maxSurge: 0`, rolls one pod at a time
with the other serving — zero downtime, no surge capacity, 50m/64Mi for the
second pod.

**PodDisruptionBudgets render only above one replica**, for backend, frontend,
prototype and Keycloak alike. At one replica the choice is between a budget
that permits the eviction, which protects nothing, and one that forbids it,
which blocks node drains and cluster upgrades on an operator. Neither is
availability, and an object in the cluster that looks like a guarantee while
being neither is worse than the gap being legible in `values.yaml`. So today
only the frontend budget exists in a deployed environment — which is also an
accurate statement of where redundancy exists.

## Install

```bash
helm upgrade --install studio-web deploy/helm/studio-web \
  -n studio --create-namespace \
  -f values-dmz.yaml
```

Prerequisites: the Secrets from `values-dmz.example.yaml`, an OIDC realm
(issuer must serve real TLS), and a `studio-postgres-bootstrap` Secret. CNPG
uses that Secret for its `studio_bootstrap` managed role; the role has only
`LOGIN`, `CREATEDB`, and membership in `studio`, so it can create a missing
database owned by the application role without giving `CREATEDB` to the
runtime backend. The Secret must contain `host`, `port`, `username`,
`password`, and `dbname` (normally `postgres`). The Job runs before every
install and upgrade: it discovers PostgreSQL databases from the effective
`gears.*.database` config, creates only missing databases, then runs forward
migrations. It never drops or alters existing databases or data.

## GitHub deployment

All routine dev and test deployments are performed only by the GitHub Actions
**Deploy Services** and **Deploy Infra** workflows. Direct local `helm` or
`kubectl` mutations are reserved for documented break-glass recovery; after
recovery, reconcile the same state through GitHub so the deployment history
remains authoritative.

Create GitHub Environments named `dev` and `test`. In each Environment add a
secret named `KUBE_CONFIG_B64` containing the base64-encoded kubeconfig for
that namespace's `studio-deployer` ServiceAccount. Never use the administrator
kubeconfig. Add required reviewers when repository access is hardened.

Run **Deploy Services** from `main` and select `backend`, `frontend`, or `all`.
A full `sha-<commit>` snapshot built from any internal branch may be deployed
only to `dev`. A versioned `v*` release tag pointing to a commit on `main` may
be deployed to `dev` or `test`. Run **Deploy Infra** only with a published
`infra-v*` release. Production will be added only after its namespace and
values exist. The workflows:

1. enforce the snapshot-to-dev and release-to-environment promotion policy and reject cluster-admin credentials;
2. verify the selected images and required namespace Secrets;
3. lint and server-side dry-run the rendered changes;
4. perform a Helm upgrade with automatic rollback and wait for readiness;
5. verify deployed image tags, PostgreSQL health where applicable, HTTPS health
   and the environment OIDC issuer.
