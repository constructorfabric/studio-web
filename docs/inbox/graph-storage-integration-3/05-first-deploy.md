# First deploy of the weftgraph build onto an existing environment

What #512 needs on an environment that ran an earlier build (studio-dev), and
what the follow-up does about each point. Findings are numbered as in
`04-consumers-and-fixes.md`.

## Automatic now

| Finding | What happens | Where |
|---|---|---|
| **S-14** outbox without `trace` | `bootstrap --apply` repairs every pre-0.16 outbox before the migrations run: adds `trace` to `<prefix>_outbox_body` and `<prefix>_outbox_dead_letters` and, when `<prefix>_outbox_trace` is missing, forgets `m001_create_toolkit_outbox_schema*` so the (idempotent) migration runs again. Finds outboxes by table name, so mini-chat's is covered. The Helm `database-bootstrap` job runs this before the new pods start. | `src/outbox_repair.rs`, `src/database_bootstrap.rs` |
| **S-13** partition stuck behind a given-up run | A redelivered message whose run already failed is acknowledged instead of re-entering the give-up path at the head of its partition. | `src/tasks/dispatch.rs` (`settled`) |
| **S-15** refusal reason lost | Type registration and ingest errors now carry the gear's field violations. | `src/graph_error.rs` |
| **S-12** edge traits | A test refuses any edge type that declares `x-gts-traits`. | `gts_inventory::no_edge_type_declares_traits` |

The bootstrap job connects with the bootstrap credentials: they must be able to
`ALTER` the gear tables (the owner or a superuser), which the Helm default is.

## By hand, once

1. **Right after the deploy, before the first repository sync (G-17).** The
   connector's edge types are stored on studio-dev with `full_text_search`; the
   in-process client cannot update them, so syncs answer 409 until they are
   updated over REST:

   ```bash
   STUDIO_TOKEN=<platform admin token> scripts/graph-storage-update-edge-types.sh https://<studio>/cf          # verdicts only
   STUDIO_TOKEN=<platform admin token> scripts/graph-storage-update-edge-types.sh https://<studio>/cf --apply  # update the stale ones
   ```

   It asks `POST /graph-storage/v1/types/compatibility` for every edge type in
   `docs/gts-types.json` and updates only those neither `new` nor `unchanged`,
   with `on_existing: update`; it stops if any change is not admissible. Safe to
   re-run. The gear's G-17 fix (a byte-identical stored type converges before
   it is analysed) shipped in weftgraph 0.1.1, which this build runs, and does
   not make this step unnecessary: S-12 changed these schemas, so what studio
   offers is no longer byte-identical to what studio-dev stored. It stays
   needed until the in-process client can pass `on_existing: update`.

2. **Custom configs.** A profile supplied outside the image (DMZ
   `existingConfigMap`, a hand-kept compose file) must make the same two
   changes #512 made to the shipped profiles, or the backend does not boot:
   drop the `gts.cf.core.am.tenant_type.v1~cf.core.am.platform.v1~` entity from
   `types-registry.entities`, and define the `rl_mini_chat_chat` /
   `ifl_mini_chat_chat` api-gateway zones. It should also copy
   `hnsw.iterative_scan` / `hnsw.ef_search` into
   `graph-storage.database.params` (every shipped profile has them): not
   needed to boot, but without them filtered vector search can answer an
   empty page for a small tenant.

3. **Compose only.** Rebuild `backend-bootstrap` (`docker compose build
   backend-bootstrap`) so it creates the databases of gears added since the
   volume was made. The Helm chart runs bootstrap from the backend image, so
   Kubernetes needs nothing extra.

## Watch after the deploy

- `studio_tasks` and `studio_mini_chat` enqueue (a catalogue or repository
  sync, a chat). A `column "trace" … does not exist` means the bootstrap job
  did not run or could not `ALTER`.
- api-gateway throttles chat creation per client IP at 10/s. Behind one
  ingress every user may share an IP, i.e. one bucket.
