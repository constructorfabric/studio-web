# Constructor Studio Frontend

Walking-skeleton SPA for the Studio backend: Vite + React 19 + TypeScript, vitest for tests. A small tenant workbench over the live API: sign-in with a bearer token (validated via `/me`; dev tokens `studio-admin-token` / `studio-user-token`), list child tenants of your home tenant, create organizations/workspaces (the backend's type barrier surfaces as a form error if you try a workspace under root), open a tenant's users and invite new ones through the IdP contract.

```bash
npm install
npm run dev      # http://localhost:5173, /cf proxied to http://127.0.0.1:8090
npm test         # vitest
npm run build    # type-check + production bundle in dist/
```

Start the backend first (`../studio-backend`, `cargo run -- --config config/dev.yaml run`), open http://localhost:5173, press **Connect** (dev token is pre-filled).

## Gear coverage

| Gear | Portal surface |
|---|---|
| account-management | login `/me` · org/workspace CRUD + type barrier · users invite/list · workspace settings (tenant metadata) · **dual-consent mode conversions** (request per org + pending-approvals inbox) |
| resource-group | Projects (RG groups + metadata binding) · project members (memberships) |
| mini-chat (+ oagw, credstore, model-policy) | Ask AI on the dashboard · **Chats view**: thread list, history, streamed replies, delete, model catalog |
| simple-user-settings | Profile → Preferences (server-side theme/language; dark theme) |
| file-storage | **Project artifacts**: signed S3 upload for manual/generated files; Files view for observability |
| gear-orchestrator, oagw, types-registry | **System view**: live gears list, OAGW upstreams (the LLM egress), GTS entities |
| api-gateway, authn/authz, tenant-resolver, grpc-hub, nodes-registry, credstore | infrastructure — exercised by every call rather than shown as screens |

The API client (`src/api.ts`) is hand-written for now; the plan is to generate it from the backend's live OpenAPI (`/cf/docs`) once the surface stabilizes.

## The two pages beside the portal

The product menu on the wordmark opens two pages of their own, each a separate
Vite entry served by the same image:

- **Docs & API** — `/api-docs/` (`api-docs/index.html`, `src/api-docs.ts`): the
  backend's live `/cf/openapi.json`, grouped by the gear that serves each path.
  `?component=<gear>` narrows it to one gear.
- **Architecture** — `/architecture/` (`architecture/index.html`,
  `src/architecture.ts`): how Studio is built, for people who did not build it.
  The gears come from the running backend (`GET /cf/studio-assembly/v1/manifest`,
  [docs/design/studio-assembly.md](../docs/design/studio-assembly.md)), their
  REST paths from `/cf/openapi.json`, and which screen calls which gear from
  `architecture/prototype-map.json`, which the build extracts from `src/`
  (`../scripts/prototype-api-map.mjs`, the same reader as the CI API-usage
  check). Nothing on it is written by hand, so it cannot drift; the header shows
  the backend's and the prototype's commits and warns when they differ. It
  renews the portal's session in this browser for the one authenticated read.

**Product shape.** This app is the **portal** (control plane UI): sign in → pick an organization/workspace → manage members. Selecting a workspace hands off to the **Studio workbench** — a Theia-based per-user session bound to that workspace tenant (the "Open Studio" button stakes out the `/studio/{workspace_id}` contract; the session manager — docker-compose MVP, then theia-cloud on k8s — and the Studio Theia extension are future work). Longer term the portal views converge with the gears-frontx / fabric-poc UI (see `../../fabric-poc`).
