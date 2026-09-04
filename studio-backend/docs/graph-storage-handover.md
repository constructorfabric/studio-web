# Graph Storage as a dependency — handover to the studio-web maintainers

Branch `feature/graph-storage-gear-dependency` (11 commits over `main` at
`ab0faac`). Companion documents: [quickstart](./graph-storage-quickstart.md),
[API reference](./graph-storage-api.md), and the
[stand report](./graph-storage-stand-report-2026-09-03.md) with every problem
found and its status.

## 1. What this branch does, in one paragraph

The knowledge-graph gear is no longer copied into `src/graph_storage`. It is a
crate, `cf-gears-graph-storage` (+ `-sdk`), linked in `registered_gears.rs` like
credstore or file-storage, and the three consumers (artifact-ingest, the gears
catalogue, the repository importer in studio-connector) talk to it through
`graph_storage_sdk::GraphStorageClientV1` from the ClientHub. The gear computes
every vector itself with one configurable provider — in-process ONNX (default),
an OpenAI-compatible remote endpoint, or a deterministic fake — so the
producer-side embedder in artifact-ingest is gone. The repository import runs as
a background task with a poll endpoint. Verified end to end on the compose
stand: 824 nodes / 823 edges from a real GitHub repository, SQL/PGQ traversal
without fallback, semantic search, convergent re-sync in 4 s, provider-switch
guard, three consumers.

## 2. Where the gear comes from, and why that is temporary

| | now | when gears-rust PR #4639 merges and the gear is published |
| --- | --- | --- |
| gear source | `git = vasylcf/gears-rust`, `tag = cf-gears-graph-storage-v0.1.1` | `constructorfabric/gears-rust`, `branch = "main"` (release-plz tags it and publishes to crates.io) |
| every other `cf-gears-*` crate | redirected to the same tag by the `[patch]` block at the end of `Cargo.toml` (61 entries) | patch block deleted, `cargo update`, commit the lockfile |
| why | the gear needs `toolkit-db`'s `pgq` feature and `toolkit-sea-orm-pgq`, which exist only on PR #4639; a binary cannot link two gears-rust sources | — |

Nothing in `src/` changes when the source moves. The fork tag is a snapshot of
gears-rust `main` (2026-09-03) + #4639 + the gear, so moving to it **is** a
gears-rust upgrade for studio-web — see § 4.

## 3. How to integrate it into the project

1. **Review and merge the PR into `main`.** That is the whole code path; there
   is no second repository to merge for studio-web. The gears-rust side lives on
   the fork until the upstream PR (blocked by #4639) lands.
2. **Compose.** `docker compose up --build -d` is enough. New: service
   `embedding-model` (one-shot, fetches the MiniLM model into volume
   `studio_models`, pinned by SHA-256) and the ONNX runtime inside the backend
   image. No new `.env` keys are required; `STUDIO_EMBEDDING_PROVIDER`
   (`onnx` | `remote` | `fake`) and `STUDIO_EMBED_*` are optional.
3. **Kubernetes.** Helm values gained `backend.embedding` (provider, remote
   endpoint/model, model pins). With `provider: onnx` an init container fetches
   the model into an emptyDir; with `provider: remote` the `embed_api_key` key
   in the app secret is required. The release image already links the gear
   (`--features graph`) and Deploy Infra already provisions the graph PostgreSQL.
   Watch the backend pod's memory: ONNX adds roughly 300 MiB RSS to a 1 GiB limit.
4. **Data.** The graph schema is v2 and is not migrated from v1: the
   `graph_storage` database must be empty (fresh volume, or
   `DROP/CREATE DATABASE graph_storage`). Graph content is a derived index and
   re-imports converge, so nothing durable is lost.
5. **Contract changes visible to the portal.**
   - `POST /studio-connector/v1/connections/{id}/graph-sync` answers
     `{task_id, status: "queued"}`; poll `GET /studio-connector/v1/graph-sync/tasks/{task_id}`.
     `"wait": true` keeps the old inline answer for small repositories.
   - graph-storage REST is v2 (`/types` batch, `/ingest`, `/nodes`,
     `/nodes/{key}`, `/search` with `mode`, `/graph/traverse`,
     `/graph/neighborhood`, `/revision`). `/stats`, `/neighbours`, `/subgraph`,
     `/hybrid` are gone. The portal does not call these directly today.
   - Catalogue edge type renamed to `cf.studio.catalog.has_version.v1~`.

## 4. The gts 0.12 compatibility problem, and the options

**What happened.** gears-rust `main` moved to gts 0.12 on 2026-08-28 and
account-management's `tenant_type` / `tenant_metadata` envelopes became closed
roots with an open `payload`. Under gts 0.12's directional check a derived Type
Schema must be *included in* its base, so every free-form `type: object` type
studio-web declares (four tenant types, five tenant-metadata types, the
connector plugin type) was refused by types-registry at boot — *"Ready commit
failed with 10 errors"* — and the process exited. This is independent of
graph-storage: any move of studio-web past gears-rust `f8f446e` hits it.

**What we did, and what it proved.** Each derived type now composes its base,
`allOf: [{ "$ref": "gts://<base>" }]`, in all five config profiles (the shape
gears-rust's own `config/e2e-local.yaml` uses). With that, **all 42 gears of the
assembly booted on gears-rust main + gts 0.12** — the in-crate studio gears
(connectors, artifact-ingest, catalogue, documents, kits, identity directory,
sessions, spec-quality, authz plugin) compiled and initialised, and the compose
stack ran the full test. We did not run the portal's own smoke tests, so if a
studio gear failed for you on 0.12 in another way than these ten schemas, that
is the thing to name: it did not show up here.

**Why "two gts versions side by side" is not the flexible option.** The rule
that bit is a rule of the GTS specification (derivation = inclusion), not of a
crate version; types-registry validates with the one `gts` the assembly links.
Two validators would mean two truths about the same schema, and the rows AM
stores would still be checked by one of them. What *is* flexible is authoring:

1. **Author every derived schema to the spec's strictest rule** — compose the
   base with `allOf`/`$ref`, never a free-form object. That form validated under
   gts 0.10 (gears-rust's e2e config), 0.11 and 0.12, so schemas written this way
   survive the next bump too. Done for the ten types on this branch; the YAML
   comments citing "gears issue #4" (closed base envelope) describe a problem
   that is now fixed upstream and can go.
2. **One `gts` in the binary, chosen by gears-rust.** studio-web pinned
   `gts = "0.11"` directly while the toolkit brought 0.12, which produced
   trait-bound errors in the toolkit before any schema was read. Prefer the
   re-exports (`toolkit_gts::{GtsId, GtsSchema, …}`, `toolkit::gts::PluginV1`);
   where a type is not re-exported (`gts::GtsTypeId` in four files), keep the
   direct pin equal to gears-rust's and let CI fail on a split
   (`cargo tree -d -i gts` must list one version).
3. **Catch a schema refusal in CI, not at boot.** A test that registers every
   schema studio-web ships (config YAML + in-code) into a types-registry over
   SQLite and asserts the ready commit succeeds turns "the pod exits" into a
   red check on the PR that bumps gears-rust. gears-rust's own `gts-validation`
   workflow is the pattern.
4. **Upgrade gears-rust as one unit, at tags.** release-plz tags every published
   crate (`cf-gears-toolkit-vX.Y.Z`, …); pin the lockfile to one tag, run the
   check from (3) and the compose smoke boot, then move. Two revisions of the
   toolkit never link, so there is no partial move anyway.

If some gear genuinely cannot follow gts 0.12 yet, the honest interim is to
stay on `f8f446e` **and** not take this branch: the graph gear cannot be
back-ported below PR #4639's base. In that case the branch waits on that gear,
not on graph-storage.

## 5. Limitations found on the stand, and how to live with them

| # | Limitation | Workaround now | Real fix (where) |
| --- | --- | --- | --- |
| 1 | Import is a background task because embedding 800 nodes takes 12–30 s | poll the task; `wait: true` for small repos | done on this branch |
| 2 | Remote provider without ADR-0004's per-tenant egress policy: node and query text leave the deployment | use `onnx`; `remote` only where that is acceptable | gears-rust D-025 (policy via OAGW) |
| 3 | Switching provider over a populated graph blocks vector search until re-embedded | `DROP/CREATE DATABASE graph_storage`, re-import | model-change lifecycle (gear, D-103) |
| 4 | Lexical search misses identifiers inside file names (`README`, `rust`) | search by whole tokens (`Dockerfile`) or use `hybrid` | gear D-028 |
| 5 | artifact-ingest writes relations only after every source succeeded; a transient GitHub 502 leaves nodes without edges | re-run the sync | flush edges per phase (artifact-ingest) |
| 6 | The gear's PostgreSQL conformance lane cannot use the CNPG-based `studio-graph-postgres` image | `gears/graph-storage/dev/pg19-pgvector-test.Dockerfile` (official base) | fold into gears-rust `test-containers` (D-003) |
| 7 | `docs/gear-intelligence-sync.md` still says the k8s release runs without graph-storage | — | update the doc |
| 8 | A stale local `studio-graph-postgres` image runs `bash` and exits 0 silently | `docker compose build graph-postgres` | none needed; noted in the quickstart |

## 6. What is still open

- Live run of the `remote` provider (the key we had was rejected by OpenAI).
- Upstream: gears-rust PR for the gear after #4639; then § 2's second column.
- The four consumer-side items above (5, 7) and the gear-side gaps (2, 3, 4, 6)
  are tracked in the gear's `dev/DEVIATIONS.md` and in the stand report.
