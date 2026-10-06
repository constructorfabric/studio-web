# Feedback & proposals for the Gears team

From: Studio backend integration (studio-web/studio-backend) · Date: 2026-07-29
Context: we assembled a 13-gear server (account-management as the domain gear), ran the
full multi-tenancy scenario end-to-end (SQLite and Postgres profiles) and built a portal
frontend against it. Everything below comes from that real integration, with repro
steps. Bug/docs reports are in `gears-rust-issues.md` (4 items, ready to file);
this document adds the improvement/extension proposals.

## Cover message (paste to Slack/Teams)

> Привет! Мы собрали первый бэкенд Constructor Studio на gears (13 гиров, AM как
> доменный) и прогнали мультитенантный сценарий целиком: bootstrap → org/workspace
> tenant-типы из GTS → type-барьеры → пользователи через IdP-контракт → RG-группы →
> dual-consent конверсии → tenant metadata. Впечатления очень положительные — AM
> закрыл весь слой «пользователи+тенантность» без строчки нашего Rust-кода.
>
> По дороге собрали 4 issue (готовы к заведению: скрытые причины ошибок регистрации в
> types-registry; расхождение путей в OpenAPI-артефакте AM; member-handle в PRD §5.6;
> и главное — typed derived tenant-metadata схемы сейчас нерегистрируемы в принципе)
> и 6 предложений по расширению — от приоритизации simple-resource-registry (у него
> появился первый живой заказчик) до OIDC-плагина. Детали: docs/upstream/gears-rust-issues.md
> и docs/gears-feedback.md в studio-web. Готовы созвониться и показать живое демо.

## Proposals

### P1. Prioritize `simple-resource-registry` — it has its first real consumer

Studio Projects (Organization → Workspace → **Project**) are today implemented as RG
groups with a `workspace_id` metadata field (our ADR-0002) — a stopgap. The spec-stage
`gears/simple-resource-registry` (PRD/DESIGN, no code) is a near-exact fit: typed CRUD,
GTS-validated payloads, tenant/owner authz, lifecycle events. **Ask:** implementation
priority + we can contribute the Project resource type as the pilot consumer.

### P2. OIDC plugin for authn-resolver + a real IdP plugin (Keycloak) for AM

Static-authn/static-idp are dev-only. Studio's production login is OIDC (portal
redirect flow → JWT → gateway validation via JWKS), and AM's IdP contract needs a real
provider (Keycloak admin API) so Invite provisions actual accounts. One Keycloak covers
both roles. **Ask:** are these planned? If not, we're candidates to contribute both
plugins — the plugin seams (authn plugin GTS instances, `IdpPluginClient`) look ready.

### P3. Context-tenant (delegated scope) for Resource Group writes

RG scopes a new group to the **caller's** tenant. An org admin acting on a child
workspace cannot create workspace-scoped groups — hence our metadata workaround. The
platform already has the Context Tenant concept (authorization TENANT_MODEL); RG's
write path doesn't accept one. **Ask:** support an explicit context-tenant (validated
against the caller's subtree + policy) on RG create/update.

### P4. EVT (events/audit bus) — the biggest missing platform piece for Studio

AM's lifecycle events are deferred "until EVT is introduced" (PRD §4.2); RG has none;
simple-resource-registry's PRD already promises lifecycle notifications. Studio's
activity feed, watch flows and worker triggers all need events; today the only option
is polling. **Ask:** EVT roadmap slot; even a minimal transactional-outbox→SSE bridge
gear would unblock activity UX.

### P5. AM tr_plugin read-only role provisioning

Enabling the AM-co-located tenant-resolver plugin warns:
`registering against shared writer pool (DESIGN section 3.5 read-only role not yet
provisioned)`. Fine for dev, but the DESIGN's read-only-role isolation is the actual
security story. **Ask:** ship the role provisioning (or a migration + config knob).

### P6. Adopter DX: assembly template + GTS authoring guide + deploy assets

Things we had to reverse-engineer that a first-party doc would make trivial:

- an "assembly quickstart" for building your own server from `cf-gears-example-server`
  (path deps from an external repo work fine — worth documenting; our `studio-backend`
  can serve as the reference);
- GTS authoring rules in one place: 5-part segment grammar
  (`vendor.package.namespace.type.version`), schema-vs-instance (`~`), chained ids,
  trailing-`~` matching semantics, `x-gts-traits` vs payload — each of these cost us a
  debugging cycle;
- deploy assets beyond mini-chat: a generic helm chart / compose example (we wrote our
  own initdb-based compose for per-gear Postgres databases — happy to upstream it).

## What worked well (worth keeping as-is)

Deterministic per-gear migrations at startup; loud `deny_unknown_fields` config
failures; the topo-ordered lifecycle with per-phase logs (debugging was mostly
log-reading); structured canonical errors on the wire (the type-barrier violation
`TYPE_NOT_ALLOWED` with machine-readable context is exemplary — the portal renders it
directly); idempotent bootstrap; `types-registry.config.entities` declarative seeding.
