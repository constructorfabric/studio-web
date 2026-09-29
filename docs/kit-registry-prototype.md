# Kit Registry — prototype vertical slice

## Scope

This implementation intentionally exposes Kit Registry only in
`studio-frontend-prototype`. The production `studio-frontend` is unchanged.

A kit is a versioned bundle of Constructor Studio conventions and workflows
whose canonical content remains in Git. The initial official entry is:

- slug: `sdlc`
- repository: `https://github.com/constructorfabric/studio-kit-sdlc`
- manifest: `.cf-studio-kit.toml`
- default Git ref: `5c5b85c870cb4b62ed0506ae1a8ca196156d1c74`

## User flow

1. Open an organization, workspace and project in the prototype.
2. Select **Kits** in the project sidebar.
3. Start the project's IDE session.
4. Choose a Git ref and select **Install in IDE**.

The request is first stored as project-scoped desired state and then sent over
the authenticated backend-to-Theia bridge. Status advances through `pending`,
`installing`, and `installed` or `failed`. Removing it deletes the desired-state
entry. The browser never receives the bridge token and never executes kit code.

## Backend API

All endpoints require the normal authenticated Studio security context.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/studio-kits/v1/catalog` | List registry entries |
| `GET` | `/studio-kits/v1/projects/{project_id}/installations` | Read project desired state |
| `POST` | `/studio-kits/v1/projects/{project_id}/installations` | Create or replace one request |
| `POST` | `/studio-kits/v1/projects/{project_id}/installations/{kit_slug}/materialize` | Run the request in the live IDE |
| `DELETE` | `/studio-kits/v1/projects/{project_id}/installations/{kit_slug}` | Remove one request |

Installations are persisted through Account Management tenant metadata using:

`gts.cf.core.am.tenant_metadata.v1~cf.studio.project.kit_installations.v1~`

The metadata uses `override_only`, so a project never inherits another
tenant's kit installation list.

Example request:

```json
{
  "kit_slug": "sdlc",
  "version": "v1.2.3",
  "install_mode": "copy"
}
```

## Installation boundary

The trusted runner inside the project IDE session:

1. accepts only the S2S-token-gated internal control request;
2. independently resolves `sdlc` to `constructorfabric/studio-kit-sdlc`;
3. validates the Git ref and selects the sole repository (or an explicit id);
4. invokes `cfs kit install ... --version ...` without a shell;
5. invokes `cfs generate-agents` after a successful install;
6. reports `installed` or a bounded failure reason to project metadata.

The Theia image contains the official `cfs` CLI in an isolated Python virtual
environment, pinned to a reviewed tag or commit in `theia/cfs.json` (a build
can still override it with `STUDIO_CFS_REF`). The runner does not accept arbitrary repository URLs or shell
fragments. Private registries should later use Studio Connections/Secrets and
short-lived credentials, never return credentials to the UI.

## Verification

- Prototype: `npm run build`
- Prototype tests: `npm test`
- Backend release image (the bridge is required):

```text
docker build -f studio-backend/Dockerfile.src \
  -t studio-backend-kits-check \
  --build-arg "CARGO_FEATURES=--no-default-features --features graph,theia-bridge" .
```
