# Studio Backend — knowledge handover

How the backend works: what CF/Gears is, what our assembly consists of, how
we develop it day to day, and the traps we already paid for. Written from
the experience of building `studio-backend` from scratch.

Repo layout this document assumes (sibling checkouts):

```
C:\Repos\CFS\
├── gears-rust\        # CF/Gears framework + platform gears (our fork)
├── studio-web\        # THIS product: studio-backend + studio-frontend
│                      #   + theia\ — the IDE image the sessions run
└── gts-spec\          # GTS type-system specification
```

(The Theia image used to be a fourth sibling, `fabric-poc\poc\theia`. It moved
into `studio-web\theia` in `b51b18d` — see ADR-0003's amendment.)

---

## 1. The big picture

**CF/Gears is a modular-monolith framework for Rust.** A deployment is ONE
binary ("assembly") composed of **gears** — self-contained modules that own
their domain, database migrations, REST surface and background workers. The
framework (`gears-rust/libs/toolkit`) provides the runtime: lifecycle,
config, DB, HTTP hosting, service discovery, security. Platform gears
(`gears-rust/gears/…`) provide accounts, groups, secrets, LLM egress, etc.

`studio-backend` (in `studio-web/studio-backend`) is our assembly: platform
gears consumed as **path dependencies** on the sibling `gears-rust`
checkout, plus gears we wrote in-crate (`src/studio_session`,
`src/keycloak_idp_plugin`).

**The number one thing to internalize:** gears activate at **link time**,
not from config. `src/registered_gears.rs` is a list of `use some_gear as _;`
imports — importing the crate registers the gear via the `inventory` crate,
and `Registry::discover_and_build()` runs EVERYTHING that is linked.
Config sections parameterize gears; they do not enable or disable them.
If you link a plugin, it participates in selection everywhere (see §5 for
how to keep one inert).

## 2. Anatomy of a gear

```rust
#[toolkit::gear(
    name = "studio-session",          // config section + log name
    deps = [credstore],               // init/start ordering (topo-sorted)
    capabilities = [rest, stateful]   // what phases it participates in
)]
pub struct StudioSessionGear { /* OnceLock-held service state */ }

#[async_trait]
impl Gear for StudioSessionGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: MyConfig = ctx.config_expanded_or_default()?; // ${VAR} expanded
        let client = ctx.client_hub().get::<dyn CredStoreClientV1>()?;
        // build service, stash in OnceLock, register own clients…
        Ok(())
    }
}
```

Key toolkit facilities available through `GearCtx`:

- **Config**: `ctx.config_expanded_or_default()` deserializes the gear's
  YAML section (`gears.<name>.config`); `#[derive(ExpandVars)]` +
  `#[expand_vars]` fields get `${ENV_VAR}` substitution. That's how
  `STUDIO_PG_PASSWORD` / `STUDIO_LLM_API_KEY` stay out of the repo.
- **Database**: the `gears.<name>.database` section maps to a server from
  the top-level `database.servers`; the gear provides migrations, the
  runtime runs them in the `db` phase (`auto_provision: true` creates
  missing databases in dev).
- **ClientHub**: in-process service discovery. Gears register trait objects
  (`register_scoped::<dyn Trait>(scope, arc)`) and consumers `get` them —
  that is how AM finds its IdP plugin and studio-session finds credstore.
- **inventory / lifecycle phases**: `pre_init → db → init → post_init →
  rest (router registration) → grpc → start → … → stop`. Order between
  gears follows `deps` topologically.

**Lifecycle trap №1:** `RunnableCapability::start` runs SEQUENTIALLY per
gear. If your `start` loops forever, every gear after you never starts and
the HTTP port never binds (we lost an evening to this). Spawn your loop
with `tokio::spawn` and RETURN.

## 3. REST: OperationBuilder, DTOs, errors

The api-gateway gear hosts one axum router for the whole assembly under a
prefix (`/cf`), builds the OpenAPI (`/cf/docs` — live Swagger) and derives
the **auth route policy** from operation declarations (auth required by
default; operations opt out explicitly).

Routes are declared with a **typestate builder** — the compiler enforces
declaration order:

```rust
OperationBuilder::post("/studio-session/v1/sessions")
    .operation_id("studio_session.create_session")
    .summary("…").tag("StudioSessions")
    .authenticated()
    .require_license_features::<License>([])
    .json_request::<CreateSessionRequest>(openapi, "…")
    .handler(create_session)
    .json_response_with_schema::<SessionDto>(openapi, StatusCode::CREATED, "…")
    .error_400(openapi).error_401(openapi).error_500(openapi)
    .register(router, openapi);
```

Traps: the **response must be registered before `error_*` calls** (typestate
won't compile otherwise), and DELETE endpoints use
`.no_content_response(StatusCode::NO_CONTENT, "…")`.

DTOs are annotated with `#[toolkit_macros::api_dto(request)]` /
`(response)` — that derives serde + utoipa + the Request/ResponseApiDto
marker traits the builder demands.

Errors use the **canonical error taxonomy**: `CanonicalError::internal(msg)
.create()` for generic failures; for resource-attributable errors declare
`#[resource_error(gts_id!("cf.studio.session.session.v1~"))] struct XErr;`
and use `XErr::not_found("…").with_resource(id).create()` — the envelope,
HTTP status and GTS resource type come out consistent across the platform.

## 4. GTS and the types-registry

GTS is the platform's type system (see `gts-spec`). The types-registry gear
stores **schemas** (e.g. tenant types, tenant-metadata shapes, secret
types) and **instances** (permissions, plugin registrations). Our config
seeds Studio's types at boot (`types-registry.config.entities` in the yaml):
organization/workspace tenant types with `x-gts-traits.allowed_parent_types`,
and the workspace-settings metadata schema.

Schema derivation is validated (OP#12): a derived schema must narrow its
base. Known friction: the base `tenant_metadata` envelope is closed, so
derived metadata schemas stay free-form for now (gears issue #4); we also
contributed `x-gts-closed-derivations` upstream (gts-spec#91, gts-rust#111).

## 5. Plugins: vendor + priority selection

Cross-cutting contracts (authn, authz, tenant-resolver, IdP provisioning,
credstore value-store, model policy) are **plugin interfaces**. A plugin is
itself a gear that, at init, publishes a `PluginV1<SpecV1>` instance to the
types-registry with a `vendor` and a `priority`, and registers its trait
object in ClientHub scoped by that instance id. The consuming gear
enumerates instances for its configured vendor and picks one.

**Trap №2 (the big one): LOWER priority number WINS** (nice-style). We
burnt hours on "invalid client credentials" because the static authn plugin
at 100 was beating the oidc plugin at 1000. Convention in our configs:
winner = 50–100, loser = 1000.

**Trap №3:** because activation is link-time, every profile must configure
every linked plugin *validly* — you deactivate one by out-prioritizing it,
not by omitting it. Our `keycloak-idp-plugin` shows the polite pattern: with
no `client_secret` it self-registers at priority 10000 so the static echo
plugin keeps winning in non-OIDC profiles.

Plugins in our assembly and who wins where:

| Contract | dev/postgres profile | oidc profile |
|---|---|---|
| authn | static-authn (tokens) | oidc-authn (Keycloak JWT) |
| authz | static allow-all | static allow-all (PDP parked, ADR-0004) |
| IdP provisioning | static echo | **keycloak-idp-plugin** (real users) |
| credstore value-store | static (in-memory!) | static (in-memory!) |
| model policy / audit | static | static |

## 6. Security model

- api-gateway extracts the bearer, the selected **authn plugin** validates
  it and produces a `SecurityContext { subject_id, subject_tenant_id,
  token_scopes }`. For OIDC: Keycloak JWT, `sub` → subject, `tenant_id`
  claim (a user attribute in the realm) → home tenant. **The home tenant IS
  the access scope**: callers see their home subtree.
- **Barriers**: a `self_managed` tenant cuts its subtree off from ancestor
  admins ("barrier as data"). Mode changes go through **dual-consent
  conversions** (one side requests, the other approves; self-managed→managed
  can only be REQUESTED from inside). Symptom of hitting a barrier: honest
  404 "not found or not accessible".
- Fine-grained permissions exist as a GTS vocabulary (~40 instances) but
  enforcement is allow-all until the Studio PDP (ADR-0004 phase 3).

## 7. Map of our assembly

System: `api-gateway` (HTTP host, OpenAPI, auth policy), `grpc-hub` (UDS
inter-gear gRPC), `gear-orchestrator` (registry/lifecycle — the портал's
System view reads it), `types-registry`, `nodes-registry`, the three
resolvers + their plugins.

Platform: `account-management` (tenants/users/conversions + pluggable IdP —
see ADR-0001/0004), `resource-group` (groups/memberships; backs Projects,
ADR-0002), `credstore` (secrets; metadata in PG + value-store plugin),
`oagw` (egress gateway with SSRF guard) → `mini-chat` (chats + SSE
streaming; any OpenAI-compatible provider via `openai_chat_completions` —
host from `STUDIO_LLM_HOST`, key from `STUDIO_LLM_API_KEY`),
`file-storage`, `simple-user-settings`.

Ours (in-crate): **`studio_session`** — per-workspace Theia IDE containers
via bollard: mints a session gate token, injects env (repos, PATs resolved
from credstore, gateway URL), binds ports 41000-41099 on loopback, reaps
expired sessions (ADR-0003); **`keycloak_idp_plugin`** — real user
provisioning over the Keycloak Admin API.

## 8. Day-to-day development

Run (WSL):

```bash
cd studio-web && docker compose up -d postgres keycloak
cd studio-backend
export STUDIO_PG_PASSWORD=… STUDIO_LLM_API_KEY=…   # LLM key optional
cargo run -- --config config/oidc.yaml run          # or dev.yaml / postgres.yaml
# frontend: cd ../studio-frontend && npm run dev    # http://localhost:5173
# Theia image — only to hack on it; CI publishes the one the gear pulls:
#   cd .. && docker build -f theia/Dockerfile -t cf-studio-theia:latest theia
```

Profiles: `dev.yaml` (static tokens), `postgres.yaml` (same + PG), 
`oidc.yaml` (Keycloak login, real IdP provisioning — the daily driver),
`docker.yaml` (all-in-compose). `demo/*.sh` scripts exercise AM/RG flows.

**Adding a new gear to the assembly**, in order:
1. module in `src/<name>/` (gear.rs + service.rs + rest.rs is our layout —
   `simple-user-settings` in gears-rust is the canonical small example);
2. `mod <name>;` in `main.rs` (in-crate) or a path dep in `Cargo.toml` +
   `use <crate> as _;` in `registered_gears.rs` (external);
3. `gears.<name>` section in EVERY config profile (a linked gear with a
   broken/missing required config fails the whole boot);
4. if it's a plugin — vendor/priority story of §5.

CI/CD: GitHub Actions — `ci.yml` (build+test on PR), `release.yml` (tag
`v*` → ghcr images). K8s: `deploy/helm/studio-web` per the Helm policy
(Postgres/IdP via existing Secrets only); the Constructor pipeline is
GitHub → GitLab mirror → Harbor → Argo CD (INFRA-3721).

## 9. The traps we already paid for (read this twice)

1. **`start` must not block** — spawn and return, or nothing after you
   starts (§2).
2. **Plugin priority is inverted** — lower number wins (§5).
3. **Link-time activation** — configure every linked plugin in every
   profile; deactivate by priority, not by omission (§5).
4. **Static credstore value-store is IN-MEMORY.** Secret metadata lives in
   PG, values don't: after every backend restart secrets still *exist*
   (create → 409) but reads fail closed. Heal: rewrite via
   `PUT /credstore/v1/secrets/{ref}` with `If-Match: *` (the portal's
   putSecret does this automatically). There is also NO list endpoint —
   surfaces must track references themselves.
5. **Keycloak 26 drops unmanaged user attributes** written via the Admin
   API unless `unmanagedAttributePolicy: ENABLED` (our realm import sets
   it). Symptom: invited users get 401 (no `tenant_id` claim) and vanish
   from attribute queries.
6. **Barrier 404s are by design** — "not found or not accessible" on a
   tenant you could see yesterday usually means someone flipped it to
   self-managed (§6), not data loss.
7. **secret types have trait-guarded sharing** — `personal_token` is
   private-only; repo PATs are stored as `api_key` with `sharing: tenant`.
8. **OperationBuilder order** — response before errors; `no_content_response`
   for 204 (§3).
9. **api-gateway binds loopback by default** — session containers reach it
   via `host.docker.internal`, which needs `bind_addr: 0.0.0.0` (auth still
   applies per request).
10. **Windows/WSL friction** — CRLF sneaks into commits (`sed -i 's/\r$//'`
    before committing to gears-rust), and 9P filesystem makes big git
    operations slow.

## 10. Where to read further

- `docs/adr/0001…0004` — identity mapping, RG-backed projects, Theia
  sessions, onboarding/roles.
- `docs/domain-alignment.md` — portal ↔ Studio Product Domain Model.
- `gears-rust/gears/<gear>/docs/DESIGN.md` — per-gear design docs (credstore
  and account-management are the deepest ones).
- `gts-spec/README.md` — the type system, incl. our §9.11.4.
- Live OpenAPI of the running assembly: `http://localhost:8090/cf/docs`.
