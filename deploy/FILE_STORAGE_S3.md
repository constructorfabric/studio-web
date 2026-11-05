# File storage on Virtuozzo S3

This document describes the supported `studio-web` deployment of the
`cf-gears-file-storage` control plane and its S3 data-plane sidecar.

Dev and test are isolated:

| Environment | Namespace | Bucket | Public origin |
| --- | --- | --- | --- |
| Dev | `studio-dev` | `dev-webstudio` | `https://studio-dev.cfabric.org` |
| Test | `studio-test` | `test-webstudio` | `https://studio-test.cfabric.org` |

Each environment has its own S3 credentials and Ed25519 signing pair. No secret
value, rendered Kubernetes Secret, or kubeconfig belongs in Git.

## Architecture

```text
browser
  | authenticated metadata request
  v
https://<studio-host>/cf/api/file-storage/v1
  | signed upload/download URL
  v
https://<studio-host>/api/file-storage-data/v1/...
  | same Pod, separate container, S3 credentials
  v
Virtuozzo S3
```

The Helm chart runs two containers in the backend Pod:

- `backend`: the file-storage control plane; metadata lives in PostgreSQL;
- `file-storage-sidecar`: validates signed URLs and streams bytes to S3.
- The sidecar's compatibility `local-fs` backend uses container-local `/tmp`;
  application uploads are routed to the configured S3 backend. This keeps the
  pinned sidecar's aggregate `/readyz` check healthy without persisting data in
  the pod filesystem.

The sidecar is exposed through the existing Studio hostname. No additional DNS
record and no cross-origin browser configuration are required. Only signed data
paths are public; `/healthz` and `/readyz` remain cluster-internal probes.

The graph stores an object reference, not file bytes. Studio currently uses S3
for user-uploaded and Studio-generated project artifacts only. Repository
issues, pull requests, commits and files stay in Git plus Artifact Graph and are
not copied to S3.

Each project artifact is tagged with the logical ownership hierarchy:

```text
organization_id -> workspace_id -> project_id -> file_id -> version_id
```

These values are file-storage custom metadata and are repeated on the standard
Artifact Graph file node. Physical S3 keys remain owned by the platform
file-storage gear (`file_id/version_id`). Changing that platform layout to an
`organizations/.../workspaces/.../projects/...` prefix requires a separately
reviewed file-storage change; Studio must not bypass the gear or modify Graph
Storage for this purpose.

## Image ownership and versioning

The sidecar source belongs to `constructorfabric/gears-rust`. `release.yml`
reads the exact gears revision from `studio-backend/Cargo.lock`, checks out that
commit, builds `cf-gears-file-storage --bin sidecar`, and publishes:

```text
ghcr.io/constructorfabric/studio-web/file-storage-sidecar:<studio-image-tag>
```

The backend and sidecar therefore share one Studio release tag while the source
revision remains defined in one place. Updating the `gears-rust` dependency and
`Cargo.lock` automatically updates the sidecar source used by the next build.

## GitHub Environment secrets

Create these four secrets independently in both GitHub Environments (`dev` and
`test`):

| Secret | Meaning |
| --- | --- |
| `FILE_STORAGE_S3_ACCESS_KEY_ID` | Access key restricted to this environment's bucket |
| `FILE_STORAGE_S3_SECRET_ACCESS_KEY` | Matching S3 secret key |
| `FILE_STORAGE_SIGNING_SEED` | 32-byte Ed25519 seed, base64url without padding |
| `FILE_STORAGE_SIDECAR_PUBLIC_KEY` | Matching raw Ed25519 public key, base64url without padding |

Generate a new signing pair for each environment:

```powershell
py -m pip install cryptography
py deploy/scripts/generate-file-storage-keypair.py
```

Copy the two printed values directly into the selected GitHub Environment. Do
not paste them into issues, pull requests, chat, workflow inputs, or repository
variables. Run the script again for the other environment.

Revoke any S3 access key that has previously appeared in chat or a ticket.

## Deployment behavior

`Deploy Services` performs the secret synchronization before Helm:

- creates or updates `studio-web-file-storage-s3` in the target namespace;
- creates or updates `studio-web-file-storage-signing`;
- validates the signing values as 32-byte unpadded base64url;
- injects a non-secret digest into the Pod template so secret rotation causes a
  rollout;
- checks that the matching sidecar image exists before changing the release.

Bucket names and the non-secret S3 endpoint live in the environment values:

- `deploy/helm/values-dev.example.yaml` -> `dev-webstudio`;
- `deploy/helm/values-test.example.yaml` -> `test-webstudio`.

Do not apply the legacy files in `deploy/k8s` for this feature. GitHub Actions
and the Helm chart are the deployment source of truth.

## Verification

After deploying the backend or all services:

```powershell
# Select the intended kubeconfig/context first; never run these against an
# unverified current context.
kubectl config current-context
kubectl -n studio-dev rollout status deployment/studio-studio-web-backend
kubectl -n studio-dev get pods -l app.kubernetes.io/component=backend
kubectl -n studio-dev logs deployment/studio-studio-web-backend -c backend --tail=200
kubectl -n studio-dev logs deployment/studio-studio-web-backend -c file-storage-sidecar --tail=200
kubectl -n studio-dev exec deployment/studio-studio-web-backend -c file-storage-sidecar -- curl -fsS http://127.0.0.1:8087/readyz
```

The backend Pod must report `2/2` ready containers. Repeat with `studio-test`
after dev smoke tests pass.

The end-to-end smoke test is an authenticated upload through the Studio UI:

1. create a file and receive a URL under `/api/file-storage-data/v1/upload/...`;
2. upload completes without CORS or loopback-address errors;
3. the sidecar finalize callback succeeds;
4. the object appears in the environment's S3 bucket;
5. a download returns identical bytes.

## Project artifact integration

The authenticated browser drives the existing file-storage contract:

1. create a file (or presign a new immutable version of an existing file);
2. PUT arbitrary bytes to the returned signed data-plane URL;
3. wait until file-storage reports the version as `available`;
4. bind that version as current;
5. register a standard file node through `studio-artifact-ingest`, containing
   only hierarchy metadata and the `file_id`/`version_id`/checksum reference.

`origin` is restricted to `manual` or `generated`. Repository sync follows its
existing connector/checkout path and never invokes project artifact upload.
Graph Storage remains an external platform component and is used exclusively
through its existing adapter; this feature adds no Graph Storage schema or API
changes.
