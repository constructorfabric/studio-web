---
type: adr
status: proposed
date: 2026-10-08
---

# ADR-0039: One way out to the model providers

**ID**: `cpt-studio-adr-one-way-out-to-llm-providers`

Status: **proposed** · Date: 2026-10-08 · Builds on ADR-0030 (each agent call on its own person's key) and ADR-0027 §3 (the desktop session keeps the secrets on the server)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

An architecture review counted three paths from the backend to a model
provider. Read closely, they are these:

1. **`mini_chat` and `api_egress` (OAGW)**, the platform's workspace chat and
   its outbound gateway, linked with the `llm` Cargo feature. The portals'
   Ask AI view and Theia's Ask AI widget call `/mini-chat/v1/chats…` from the
   browser; mini-chat reaches OpenAI through an OAGW upstream whose key is the
   credstore reference `openai-key`. No Studio code calls either gear.
2. **`studio-llm-proxy`**, two passthroughs. `/studio-llm/v1/chat/completions`
   and `/models` serve Theia AI's `ai-openai` provider from one upstream with
   one key in the backend's environment (`STUDIO_LLM_*`).
   `/studio-llm/v1/providers/{anthropic,openai}/…` serves Claude Code and Codex
   with the key credstore holds for the calling member (ADR-0030). It was
   behind the `llm` feature too, so the Kubernetes release did not have it —
   while `studio-session` points every session's agents at it.
3. **The connector gear's model-provider drivers** (`connectors/ai_providers.rs`,
   linked as `anthropic-connector-plugin` and `openai-connector-plugin`). They
   do one thing with a provider: "test connection" lists models with the key
   being stored, through an HTTP client and URL conventions of their own. The
   key is then kept in credstore under the connection's reference, where
   nothing reads it to call a provider.

The provider calls the review also named in `notify/rest.rs`,
`presence/rest.rs` and `connectors/zulip.rs` are not provider calls: they are
Studio's own `…/messages` routes and Zulip's messages API. `studio-spec-quality`
calls an external detector service, not a model provider.

So Studio code reaches a model provider from two places (2 and 3), each with
its own client, its own idea of where the provider is and how it wants its
key; and the platform reaches one from a third (1). A change to how Studio
talks to a provider — a header, a proxy, a timeout, an audit line — has to be
made twice and is easy to make once.

## Considered Options

1. **Route Studio's calls through OAGW.** OAGW is the platform's outbound
   gateway: upstreams and routes, credential injection from credstore, rate
   limits, SSE passthrough, a `ServiceGatewayClientV1` on the ClientHub. It is
   the right long-term transport. It cannot be Studio's today: linking it makes
   a fresh database deadlock on the root tenant, so the release builds without
   it (`cpt-studio-constraint-llm-off-in-release`); every provider would need
   an upstream and routes provisioned per tenant before the first call; and
   whether its credential injection resolves a key *as the calling member*,
   which ADR-0030 needs, is not established.
2. **Keep three paths, document them.** Cheapest, and the duplication stays.
3. **`studio-llm-proxy` is Studio's only way out; a connector stores and
   tests, through it.** The proxy owns the provider table and the one HTTP
   client; other gears reach a provider through its port.

## Decision Outcome

Chosen option: **3**, with option 1 as the transport to move to behind the
same port once the platform resolves the deadlock.

### 1. One gear calls providers

`studio-llm-proxy` is the only Studio code that sends a request to a model
provider. Its provider table (`gears.studio-llm-proxy.config.providers`) says,
once, which providers exist, where they live, how each wants its key, where its
model list is and which headers Studio's own calls carry.

### 2. Other gears use the port

The gear publishes `llm_proxy::port::ModelProviders` on the ClientHub. A gear
that needs a provider takes that client; it carries no HTTP client or provider
URL of its own. The port has one method today, `list_models(provider,
base_url, key)`, because one thing is needed in-process: proving a key. A gear
that needs a completion adds a method there.

### 3. A connector stores, selects and tests a key — nothing more

The Anthropic and OpenAI drivers keep what a connection knows: the provider's
name, the hosts a key may be sent to (`url_guard`), and how a stored address
maps onto the proxy's form. "Test connection" calls the port with the key
being tested. The key stays where it is stored, in credstore under the
connection's reference.

### 4. The proxy is linked into every build

`studio-llm-proxy` needs nothing the `llm` feature brings, and the connector
gear now depends on it, so it leaves the feature. The release image gains it:
the agents' provider routes `studio-session` already points sessions at
answer there, and Theia AI's upstream follows the `STUDIO_LLM_*` values the
Helm chart already sets. `llm` keeps gating only `mini_chat` and `api_egress`.

### 5. mini-chat and OAGW stay the platform's

The workspace chat is a platform product that the portals call directly, and
its egress is the platform's gateway. Studio does not call it, wrap it, or
route through it, and this decision does not change it.

### Consequences

- One place to change how Studio reaches a provider; a connector's key test and
  an agent's call go out through the same client, table and headers.
- The release deploys the proxy. (At the time, without `STUDIO_LLM_BASE_URL`/
  `_MODEL`/`_API_KEY` the OpenAI-compatible half answered with an error naming
  them. Since 2026-10-09 that half has no server upstream at all: see the
  follow-up below.)
- A key test in a deployment without the proxy fails with a message naming it,
  instead of reaching the provider on its own.
- Two key stores still exist for the agents: the member's profile keys and the
  workspace's shared ones under `anthropic-key` / `openai-key`, which the
  provider half reads, and the AI connections, which it does not. Having the
  provider half select a member's AI connection is the follow-up that makes
  the connection the one place a key is kept.
  **Done (2026-10-09).** A call — an agent's or the IDE chat's — goes out on a
  person's key only: their profile key (private only; a shared value under the
  same reference is ignored), else their personal AI connection, else the
  workspace's (on `/studio-llm/v1/workspaces/{workspace_id}/…`, which sessions
  now point their agents and chat at), else the organization's
  (`ConnectorService::model_key_for`). The env-seeded shared `openai-key` /
  `anthropic-key` and the chat half's server upstream (`STUDIO_LLM_BASE_URL`,
  `_MODEL`, `_API_KEY`) are gone; the chat picks the first provider with a chat
  model the caller has a key for.

## More Information

### What this does not decide

- Moving the proxy's transport onto OAGW. When the root-tenant deadlock is
  fixed and per-member credential resolution is confirmed, the provider layer
  can send through `ServiceGatewayClientV1` behind the same port, with no
  change to its callers.
- The `openai-key` reference that mini-chat's OAGW upstream and the proxy's
  `openai` provider both read. They are one secret by configuration, not by
  design. (Resolved with the follow-up above: mini-chat's upstream reads its own
  `studio-assistant-llm-key`, and `openai-key` is only a member's profile key.)

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/constructor-studio.md), [studio-llm-proxy](../design/studio-llm-proxy.md), [studio-connector](../design/studio-connector.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-fr-ide-llm-proxy`
* `cpt-studio-component-llm-proxy`
* `cpt-studio-component-connector`
* `cpt-studio-nfr-credential-isolation`
