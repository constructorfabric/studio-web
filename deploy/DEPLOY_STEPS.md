# File-storage S3 rollout checklist

Use this checklist after the code changes have passed CI. Complete dev first;
promote the same release to test only after the dev upload/download smoke test.

## 1. Prepare Virtuozzo S3

- [ ] `dev-webstudio` exists in region `eu3`.
- [ ] `test-webstudio` exists in region `eu3`.
- [ ] Dev credentials can access only `dev-webstudio`.
- [ ] Test credentials can access only `test-webstudio`.
- [ ] Any credential previously shared in chat or a ticket is revoked.

## 2. Configure GitHub Environment `dev`

- [ ] Generate a dev keypair with
  `py deploy/scripts/generate-file-storage-keypair.py`.
- [ ] Set `FILE_STORAGE_S3_ACCESS_KEY_ID`.
- [ ] Set `FILE_STORAGE_S3_SECRET_ACCESS_KEY`.
- [ ] Set `FILE_STORAGE_SIGNING_SEED`.
- [ ] Set `FILE_STORAGE_SIDECAR_PUBLIC_KEY`.

## 3. Configure GitHub Environment `test`

- [ ] Generate a different test keypair.
- [ ] Set the same four secret names with test-only values.

## 4. Build

- [ ] Merge the implementation after CI succeeds.
- [ ] Create the next `v*` service tag, or publish an immutable `sha-*` build.
- [ ] Confirm GHCR contains both `studio-backend:<tag>` and
  `file-storage-sidecar:<tag>`.

## 5. Deploy and verify dev

- [ ] Run `Deploy Services`: environment `dev`, component `backend` (or `all`),
  image tag from step 4.
- [ ] Confirm the backend Pod is `2/2` ready.
- [ ] Confirm both containers have clean startup logs.
- [ ] Upload and download a small text file through the UI.
- [ ] Confirm the object exists only in `dev-webstudio`.

## 6. Deploy and verify test

- [ ] Run `Deploy Services` with the same release tag: environment `test`,
  component `backend` (or `all`).
- [ ] Repeat the Pod, log, upload, download, and bucket checks.
- [ ] Confirm no dev object or credential is visible from test.

Operational details and commands are in [FILE_STORAGE_S3.md](FILE_STORAGE_S3.md).
