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
realm (issuer must serve real TLS), and PostgreSQL credentials with `CREATEDB`
for the bootstrap Job. The Job runs before every install and upgrade: it
discovers PostgreSQL databases from the effective `gears.*.database` config,
creates only missing databases, then runs forward migrations. It never drops
or alters existing databases or data. For least privilege, set
`backend.bootstrap.existingSecret` to a dedicated provisioner secret; leaving
it empty reuses `backend.database.existingSecret`.

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
