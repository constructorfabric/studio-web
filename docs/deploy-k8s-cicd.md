# Deploy to Kubernetes + CI/CD

Status: proposal for the infra team. Manifests live in `deploy/k8s/` (kustomize),
CI already exists in `.github/workflows/` (ci.yml builds & tests on push,
release.yml builds images on tag — its deploy job is the TODO this document closes).

---

## Reply to infra (copy-paste)

> **1) What we build/test/deploy.**
> One repo: `github.com/constructorfabric/studio-web` (public, Apache-2.0). It's a
> monorepo with two services:
> - `studio-backend` — Rust HTTP API (port 8090). Built with a sibling checkout of
>   `github.com/constructorfabric/gears-rust` (public). Needs Postgres 16 (8 databases,
>   init SQL included); runs its own migrations on start. Docker image ~90 MB.
> - `studio-frontend` — static React build served by nginx (port 80). nginx proxies
>   `/cf/` to the backend, everything else is static files.
>
> Tests: `cargo test` + `vitest`, already running in GitHub Actions on every push.
>
> **2) Where we build/test.**
> Outside the perimeter: GitHub-hosted runners, images pushed to ghcr.io. Both repos
> and both images are public; no corporate secrets are used at build time. If policy
> forbids even that, fallback: mirror to corporate GitLab and run the same two Docker
> builds on an internal runner (Option B below) — the Dockerfiles don't change.
>
> **3) Where we deploy.**
> The frontend must be reachable from the internet over HTTPS (one DNS name, one
> Ingress). The backend and Postgres stay cluster-internal — nothing else is exposed.
> If the cluster itself sits behind the VPN with no inbound access from GitHub, we
> prefer pull-based CD (Argo CD/Flux inside the cluster watches the repo and ghcr.io)
> so no cluster credentials ever leave the perimeter and no hole is opened.
>
> Everything is manifest-ready: `deploy/k8s/` in the repo, `kubectl apply -k` away.
> What we need from you: (a) a DNS name, (b) which ingress class / cert-manager
> issuer the cluster runs, (c) the verdict on GitHub vs GitLab mirror.

---

## What ships

| Artifact | Source | Image | Port | Exposed |
|---|---|---|---|---|
| studio-backend | `studio-backend/` + gears-rust sibling, `Dockerfile.src` | `ghcr.io/constructorfabric/studio-web/studio-backend` | 8090 | cluster-only |
| studio-frontend | `studio-frontend/`, `Dockerfile.src` | `ghcr.io/constructorfabric/studio-web/studio-frontend` | 80 | Ingress, HTTPS |
| postgres | `postgres:16-alpine` + initdb ConfigMap | upstream | 5432 | cluster-only |

Naming is deliberate and load-bearing:

- Service **`postgres`** — `config/docker.yaml` (baked into the backend image) points
  at host `postgres`. Same config works in compose and k8s, no third profile.
- Service **`studio-backend`** — the frontend's `nginx.conf` proxies `/cf/` to
  `http://studio-backend:8090`. Same nginx config works in compose and k8s.

So the Ingress routes the single host to `studio-frontend` only; nginx inside the
frontend pod does the `/cf/` fan-out (with `proxy_buffering off` — required for the
SSE chat stream). The Ingress mirrors that: `proxy-buffering: off`,
`proxy-read-timeout: 3600`.

## Cluster layout (`deploy/k8s/`)

```
namespace.yaml      namespace: studio
postgres.yaml       StatefulSet + PVC 5Gi + initdb ConfigMap + Service "postgres"
backend.yaml        Deployment (1 replica, /healthz probes) + Service "studio-backend"
frontend.yaml       Deployment (2 replicas) + Service "studio-frontend"
ingress.yaml        HTTPS via cert-manager, host studio.example.com → frontend
kustomization.yaml  namespace + image-tag pinning
```

First-time setup:

```bash
kubectl create namespace studio
kubectl -n studio create secret generic studio-secrets \
  --from-literal=pg-password='<strong password>'
kubectl apply -k deploy/k8s
```

Notes:

- **Backend replicas = 1** until multi-replica behaviour (per-gear locking, SSE
  affinity) is verified. Frontend scales freely.
- **initdb runs only on an empty PVC** — same rule as the compose volume. Adding a
  gear with a new database later means creating it manually (README, Postgres
  section) or wiping the PVC.
- **Postgres in production**: swap the StatefulSet for managed Postgres or
  CloudNativePG; only the DSN in the backend config changes.
- **Secrets inventory**: `pg-password` (required); the mini-chat OpenAI key currently
  lives in the backend config as a `static-credstore-plugin` value — for k8s it must
  be moved to an env-substituted secret before the AI chat works publicly.

## CI/CD

After some deploys a platform administrator runs a one-off data step; the list
is in [`deploy/PIPELINES.md`](../deploy/PIPELINES.md#one-off-data-steps-after-a-deploy).

Already in the repo:

- `ci.yml` — push/PR: backend `cargo build+test` (checks out gears-rust as sibling),
  frontend `npm ci + vitest + build`.
- `release.yml` — tag `v*`: builds both artifacts, publishes GitHub Release, builds
  and pushes both images to ghcr.io. The `deploy` job is a placeholder — the options
  below are the ways to fill it.

### Option A — GitHub end-to-end (preferred if the cluster is reachable)

Fill the `deploy` job in `release.yml`:

```yaml
- uses: azure/k8s-set-context@v4
  with: { kubeconfig: "${{ secrets.KUBECONFIG }}" }   # scoped ServiceAccount, not admin
- run: |
    kubectl -n studio set image deploy/studio-backend  studio-backend=$IMAGE_PREFIX/studio-backend:${{ github.ref_name }}
    kubectl -n studio set image deploy/studio-frontend studio-frontend=$IMAGE_PREFIX/studio-frontend:${{ github.ref_name }}
    kubectl -n studio rollout status deploy/studio-backend --timeout=300s
```

Requires the k8s API to be reachable from GitHub runners (public endpoint or
allowlisted egress). The `production` environment gate (manual approval) is already
configured in the workflow.

### Option A′ — GitHub builds, cluster pulls (VPN-friendly, recommended)

If the cluster has no inbound access: install Argo CD (or Flux) inside the cluster,
point it at `deploy/k8s/` in this repo. CI's only deploy step becomes bumping the
image tags in `kustomization.yaml` (commit by the release workflow). Nothing outside
the perimeter holds cluster credentials; the cluster pulls public images from ghcr.io
over plain egress.

### Option B — corporate GitLab mirror

If building on GitHub violates policy: set up a pull mirror of the repo in GitLab,
add a `.gitlab-ci.yml` with the same three stages (test → build images → deploy) on
an internal runner, push images to the corporate registry, and change the two image
names in `kustomization.yaml`. Dockerfiles and manifests are registry-agnostic;
nothing else changes. Cost: mirror lag and a second CI config to keep in sync — we'd
avoid it unless policy insists.

## Open questions for infra

1. DNS name for the frontend (we assumed `studio.example.com` in `ingress.yaml`).
2. Ingress class and cert-manager issuer name in the target cluster.
3. Is the k8s API reachable from GitHub-hosted runners (A) or do we go pull-based (A′)?
4. GitHub CI acceptable for public repos, or GitLab mirror (B)?
5. Storage class for the Postgres PVC, or a managed Postgres endpoint instead.
