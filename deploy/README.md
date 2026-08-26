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

- **IDE sessions are disabled** (`studio-session.enabled=false` in
  `k8s.yaml`): the Docker session driver needs `/var/run/docker.sock`;
  the per-session Pod driver is a future step (ADR-0003). Session APIs
  answer 503 with a clear message; the rest of the portal is unaffected.
- **User invites are optional**: set `backend.idpAdmin.baseUrl` +
  `idp_admin_secret` to enable the Keycloak Admin provisioning plugin;
  without them the plugin self-deprioritizes.

## Install

```bash
helm upgrade --install studio-web deploy/helm/studio-web \
  -n studio --create-namespace \
  -f values-dmz.yaml
```

Prerequisites: the three Secrets from `values-dmz.example.yaml`, an OIDC
realm (issuer must serve real TLS), and a Postgres with a CREATEDB-capable
app user. Per-gear databases are NOT auto-provisioned: `auto_provision` only creates SQLite directories, so the databases come from the initdb list in k8s/postgres.yaml, which runs once on an empty volume — add one by hand if you introduce a gear later.

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
