---
type: prd
status: accepted
owner: studio-team
capabilities: domain, tenancy, auth, authz, storage, connectors, facade, deploy
---

# PRD — Constructor Studio

## Table of Contents

<!-- toc -->

- [1. Overview](#1-overview)
  - [1.1 Purpose](#11-purpose)
  - [1.2 Background / Problem Statement](#12-background--problem-statement)
  - [1.3 Goals (Business Outcomes)](#13-goals-business-outcomes)
  - [1.4 Glossary](#14-glossary)
- [2. Actors](#2-actors)
  - [2.1 Human Actors](#21-human-actors)
  - [2.2 System Actors](#22-system-actors)
- [3. Operational Concept & Environment](#3-operational-concept--environment)
  - [3.1 Gear-Specific Environment Constraints](#31-gear-specific-environment-constraints)
- [4. Scope](#4-scope)
  - [4.1 In Scope](#41-in-scope)
  - [4.2 Out of Scope](#42-out-of-scope)
- [5. Functional Requirements](#5-functional-requirements)
  - [5.1 Organizations, workspaces and navigation](#51-organizations-workspaces-and-navigation)
  - [5.2 Identity and access](#52-identity-and-access)
  - [5.3 Connections and credentials](#53-connections-and-credentials)
  - [5.4 IDE sessions](#54-ide-sessions)
  - [5.5 Documents](#55-documents)
  - [5.6 Knowledge graph](#56-knowledge-graph)
  - [5.7 Gears, products and kits](#57-gears-products-and-kits)
  - [5.8 Background work and push](#58-background-work-and-push)
  - [5.9 Files and settings](#59-files-and-settings)
  - [5.10 Contract, registries and operation](#510-contract-registries-and-operation)
- [6. Non-Functional Requirements](#6-non-functional-requirements)
  - [6.1 Gear-Specific NFRs](#61-gear-specific-nfrs)
  - [6.2 NFR Exclusions](#62-nfr-exclusions)
- [7. Public Library Interfaces](#7-public-library-interfaces)
  - [7.1 Public API Surface](#71-public-api-surface)
  - [7.2 External Integration Contracts](#72-external-integration-contracts)
- [8. Use Cases](#8-use-cases)
- [9. Acceptance Criteria](#9-acceptance-criteria)
- [10. Dependencies](#10-dependencies)
- [11. Assumptions](#11-assumptions)
- [12. Risks](#12-risks)
- [13. Open Questions](#13-open-questions)
- [14. Traceability](#14-traceability)
  - [14.1 Functional requirements to implementation](#141-functional-requirements-to-implementation)
  - [14.2 Acceptance criteria to implementation](#142-acceptance-criteria-to-implementation)

<!-- /toc -->

## 1. Overview

### 1.1 Purpose

Constructor Studio, from Constructor Fabric, gives an engineering team a
governed place to do project work. A project holds its people, sources, secrets
and connections, and launches a Theia IDE session against those sources with AI
agents already configured. This repository is the web runtime of the product:
the Rust backend assembled from CF/Gears (`studio-backend/`), the FrontX portal
(`studio-frontend/`), the prototype portal (`studio-frontend-prototype/`), the
Keycloak image (`keycloak/`), the IDE session image (`theia/`) and the
deployment definitions (`docker-compose.yml`, `deploy/`).

The product brief is [`PRODUCT.md`](../../PRODUCT.md); it stays the authority on
positioning, principles and brand. How the system is built is in
[the design](../design/constructor-studio.md), and how it splits into
implementable entries is in [the decomposition](../decomposition/constructor-studio.md).

### 1.2 Background / Problem Statement

An engineer who works on a codebase with AI agents alongside assembles that
environment locally: clones every repository, holds a personal access token for
each source host, puts an LLM provider key where the agent can read it, and
configures quality and search tooling by hand. That is repeated per person and
per machine, and each step leaves a credential somewhere the organization does
not govern.

A local IDE with an agent plugin cannot keep provider keys and Git credentials
out of the place where the work happens, and a hosted IDE without a tenant model
cannot say which organization, project and people a session belongs to. Nobody
can answer "which repositories do we have" or "which specifications does this
project have, and are they complete" from one place (`PRODUCT.md`,
Positioning).

### 1.3 Goals (Business Outcomes)

- A member opens a project and reaches a working IDE session with its
  repositories cloned and its agents authenticated, without a local checkout.
  A member who works on a desktop instead gets the same session on their own
  machine, and no credential reaches it (ADR-0027).
- No provider key or Git token is readable in a session container or in a
  browser.
- Every surface the portal shows is backed by a backend read, or is labelled as
  derived, local or reserved (`PRODUCT.md`, Product Principles 2 and 5).

`PRODUCT.md` records that no usage numbers exist in this repository, so the
goals are stated as observable outcomes rather than numeric targets.

### 1.4 Glossary

These terms are used with exactly this meaning in every document under `docs/`.

| Term | Definition |
|------|------------|
| Organization | An account-management tenant that owns members, the shared connection catalogue and the access config. Hidden from navigation in concept v2, not removed. |
| Workspace | An account-management tenant of type `workspace` under an organization. Concept v2 calls it a root project; the wire keeps `workspace` and `workspace_id` (ADR-0010). |
| Project | A tenant nested under a workspace; its attributes are tenant metadata (ADR-0010). |
| Member | A person with a membership in an organization, recorded by `studio-user` (ADR-0016). |
| Gear | A CF/Gears module linked into the backend binary and registered at link time through `inventory`. A Studio gear lives in `studio-backend/src/`; a platform gear comes from gears-rust. |
| Plugin | A gear that implements another gear's plugin contract, for example a connector plugin for `studio-connector` or an AuthZ resolver plugin. |
| Connection | A configured credential for one provider (source host, model provider or chat platform), owned by a tenant; its secret is a credstore reference. |
| Session | A running Theia IDE container or Pod for one workspace, managed by `studio-session`. |
| Document type | A template, section checklist and rules a document is validated against (`studio-documents`). |
| Binding | The record that ties a repository file's knowledge-graph node to a document type, with its detection state and validation report (`studio_document_bindings`). |
| Capability | A key of the capability vocabulary a PRD declares (`domain`, `tenancy`, `auth`, `authz`, `storage`, `connectors`, `facade`, `billing`, `compliance`, `deploy`), from which gears are suggested. The vocabulary translates each key into the contracts that satisfy it. |
| Contract | What the Gearbox engine reports a gear doing for others, so it is checked rather than read from prose: a contract the gear provides (`<gear>/<Trait>@v<N>`, projected from `#[toolkit::provides]`), the GTS spec of an extension point it hosts, or the spec of the point it implements as a plugin. |
| Mapping | A capability of a specification paired with the gear that covers it, or with nothing (a gap); proposed by the system, decided by a member. |
| Kit | A bundle of templates, prompts and checklists kept in its own Git repository and installed into a project's checkout by `cfs`. |
| Product | A `product.gdl` composed from picked gears and resolved by the Gearbox engine. |
| Run | One unit of durable background work in `studio-tasks`. |

## 2. Actors

> **Note**: Stakeholder needs are managed outside this repository. The actors below are the users and systems that interact with Constructor Studio.

### 2.1 Human Actors

#### Member

**ID**: `cpt-studio-actor-member`

- **Role**: A signed-in person with a membership in the organization in scope. The primary member is a software engineer working on a codebase: opens projects, launches the IDE session, connects sources, reads documents and artifacts.
- **Needs**: A project that is ready to work in — sources cloned, agents authenticated, quality and search surfaces present — without holding credentials locally.

#### Organization owner

**ID**: `cpt-studio-actor-org-owner`

- **Role**: A member who owns an organization. Administers its people, invitations and roles; the owner gate is answered in the gear from the access config (ADR-0019).
- **Needs**: To place people into the organization and decide their roles without granting any other member that authority.

#### Platform administrator

**ID**: `cpt-studio-actor-platform-admin`

- **Role**: Operates the installation. Sees identities that belong to no organization and assigns them, and sees the hidden organization level, which the portal shows behind `localStorage.setItem("studio.platformAdmin", "on")`.
- **Needs**: A view of every identity Keycloak holds, including the ones no tenant-scoped list can show (ADR-0011).

### 2.2 System Actors

#### Portal shell

**ID**: `cpt-studio-actor-shell`

- **Role**: The FrontX host application in `studio-frontend/src-app/app/`. Owns the levels, the path, the rail, the overlay frame and which microfrontend is mounted, and publishes the organization and workspace in scope.

#### Microfrontend

**ID**: `cpt-studio-actor-mfe`

- **Role**: A FrontX microfrontend package under `studio-frontend/src-app/mfe_packages/`. Declares the level of each screen it contributes, reads its data from the backend and announces what it wrote.

#### Provider

**ID**: `cpt-studio-actor-provider`

- **Role**: An external service a connection talks to: a source host (GitHub, GitLab, Bitbucket), a model provider (Anthropic, OpenAI) or a chat platform (Slack, Zulip, Discord). Answers credential probes and serves repositories, models or message delivery.

#### Identity provider

**ID**: `cpt-studio-actor-keycloak`

- **Role**: Keycloak. Authenticates people with OIDC, brokers GitHub identities, and is provisioned through account-management's Keycloak IdP plugin.

#### IDE session

**ID**: `cpt-studio-actor-session`

- **Role**: The Theia node backend inside a session container. Serves the IDE to the browser, exposes an internal control API to the backend, and posts its events to the backend's ingress (ADR-0022).

#### AI agent

**ID**: `cpt-studio-actor-agent`

- **Role**: An agent running inside a session — Theia AI with @Universal/@Coder, Codex, Claude Code, the Orca panel and the `@Gearbox` chat agent. Calls the model through `studio-llm-proxy` with the member's Studio token.

## 3. Operational Concept & Environment

> **Note**: The foundational documents that exist in this repository are [`README.md`](../../README.md) (supported deployment modes), [`PRODUCT.md`](../../PRODUCT.md) (product brief), [`docs/api-conventions.md`](../api-conventions.md) (REST and event contract) and [`deploy/README.md`](../../deploy/README.md) (Kubernetes operation). There is no parent PRD. Only the constraints specific to Constructor Studio are listed here.

### 3.1 Gear-Specific Environment Constraints

- The graph-storage gear runs only on PostgreSQL 19 with pgvector, and its migrations run at boot (`studio-backend/Cargo.toml`, feature `graph`).
- The `llm` feature (mini-chat, `api_egress`) is left out of the Kubernetes release image because of a fresh-boot root-tenant deadlock (`studio-backend/Cargo.toml`, feature `llm`).
- Cloning into a session is HTTPS-only; the session container has no SSH key or agent (`PRODUCT.md`, Capabilities and Constraints).
- Docker Compose launches sessions through the host Docker daemon and requires the same host path `/srv/cf-studio-workspaces` on both sides of the mount (`README.md`).
- While IDE sessions are enabled on Kubernetes, the Helm chart refuses more than one backend replica (`deploy/helm/studio-web/values.yaml`).

## 4. Scope

### 4.1 In Scope

- Organizations, workspaces and projects as account-management tenants, and the portal's navigation over them.
- Sign-in through Keycloak, the canonical user, memberships, invitations and the platform identity directory.
- Tenant-scoped authorization through the Studio PDP, with administrative authority answered from the access config.
- Connections to source hosts, model providers and chat platforms, with credentials kept in credstore.
- Per-workspace IDE sessions, the backend-to-backend bridge into them, and the LLM proxy their agents use.
- The desktop session: `theia/electron-app` on the member's machine, with Git and the LLM proxied through the backend (ADR-0027).
- Document types, documents, repository document bindings and specification quality.
- Ingest of repository artifacts and of the Studio domain model into the knowledge graph.
- The gear catalogue, gear scaffolding, Gearbox products, kits and Constructor Insight delivery metrics.
- Durable background runs, schedules, queued notifications, presence and the push channel to the portal.
- The REST contract ratchet, the GTS registry consistency checks and database bootstrap.
- Deployment with Docker Compose and on Kubernetes, the observability stack and the delivery pipeline.

### 4.2 Out of Scope

- Billing, metering and compliance certification: no gear in the assembly provides them.
- Customers, pricing, licensing terms and public marketing copy: `PRODUCT.md` records that none exist.
- SSH cloning into a session.
- A committed Studio brand identity: the FrontX marks in the tree are template scaffolding (`PRODUCT.md`, Brand Commitments).
- The kustomize manifests in `deploy/k8s/*.yaml`: they belong to the earlier proposal in `docs/deploy-k8s-cicd.md`; the supported Kubernetes path is the Helm chart.

## 5. Functional Requirements

> **Testing strategy**: Verification is by the automated suites the Studio Delivery workflow runs (`.github/workflows/studio-delivery.yml`: backend, frontend, prototype, Theia session gate, API usage, infrastructure and deployment-config jobs). Where a requirement is checked another way, the method is named.

Functional requirements define what the system does. Each is traced to the module, route or screen that implements it in [§14 Traceability](#14-traceability). A requirement marked `[ ]` is planned, with its source; every other requirement is implemented in this repository.

### 5.1 Organizations, workspaces and navigation

#### Create an organization with an owner

- [x] `p1` - **ID**: `cpt-studio-fr-org-create`

The system **MUST** create an organization as one resumable operation that writes the account-management tenant, the creator's owner membership and the access-config grant.

- **Rationale**: A client that writes only the tenant produces an organization nobody owns and nobody sees (ADR-0018).
- **Actors**: `cpt-studio-actor-member`

#### Administer an organization

- [x] `p1` - **ID**: `cpt-studio-fr-org-administration`

The system **MUST** let an organization owner manage the organization's invitations, memberships and non-owner roles, and **MUST** serve the organization's access catalogue, capabilities and rollups; only an owner may change who owns the organization.

- **Rationale**: Administrative authority is one answer per organization, answered in the gear from the access config rather than by the PDP (ADR-0019 §3, §9).
- **Actors**: `cpt-studio-actor-org-owner`

#### Workspaces and projects are tenants

- [x] `p1` - **ID**: `cpt-studio-fr-workspace-project-tenants`

The system **MUST** create and list workspaces as account-management tenants of type `workspace` under an organization, and projects as tenants nested under a workspace, with project attributes stored as tenant metadata.

- **Rationale**: The retired `studio-project` gear is replaced by tenancy the platform already enforces (ADR-0010).
- **Actors**: `cpt-studio-actor-member`, `cpt-studio-actor-shell`

#### Navigate by level

- [x] `p1` - **ID**: `cpt-studio-fr-portal-levels`

The portal **MUST** navigate three levels — organization, workspace, project — with a top bar, an overlay drawer and one context slot, draw the menu of the level it is on, and mount a microfrontend entry that is a Module Federation remote or an iframe whose address arrives at runtime.

- **Rationale**: ADR-0008 fixes the shell's structure; ADR-0021 adds frame entries.
- **Actors**: `cpt-studio-actor-member`, `cpt-studio-actor-shell`, `cpt-studio-actor-mfe`

#### Reserved areas say so

- [x] `p2` - **ID**: `cpt-studio-fr-portal-reserved-areas`

The portal **MUST** show an area whose backing does not exist yet as reserved, with no fabricated data.

- **Rationale**: `PRODUCT.md`, Product Principle 5 ("Reserved is not empty").
- **Actors**: `cpt-studio-actor-member`

### 5.2 Identity and access

#### Sign in with Keycloak

- [x] `p1` - **ID**: `cpt-studio-fr-sign-in`

The system **MUST** authenticate people with OIDC Authorization Code + PKCE against Keycloak, renew the session silently from a refresh token, accept GitHub identities through Keycloak brokering, and keep static bearer tokens for scripts.

- **Rationale**: Real sign-in replaces dev tokens for people; scripts keep working (`PRODUCT.md`, Operating Context).
- **Actors**: `cpt-studio-actor-member`, `cpt-studio-actor-keycloak`

#### One canonical user per person

- [x] `p1` - **ID**: `cpt-studio-fr-canonical-user`

The system **MUST** keep one canonical user per person, separate from the logins that resolve to it, with aliases a person attributes to themselves that bind only on a proof of control, and **MUST** support merging two users.

- **Rationale**: Without it the same human becomes several users and their work is split (ADR-0023, ADR-0012, ADR-0015, ADR-0025).
- **Actors**: `cpt-studio-actor-member`, `cpt-studio-actor-keycloak`

#### Invitations and memberships

- [x] `p1` - **ID**: `cpt-studio-fr-invitations-membership`

The system **MUST** record a membership where assignment happens, invite people by e-mail with a token stored only as a digest, and give a person with no membership a valid no-access state instead of an error.

- **Rationale**: Authentication does not grant organization membership (ADR-0011, ADR-0016, ADR-0018).
- **Actors**: `cpt-studio-actor-member`, `cpt-studio-actor-org-owner`

#### Identity directory

- [x] `p2` - **ID**: `cpt-studio-fr-identity-directory`

The system **MUST** give a platform administrator a read-only, root-scoped list of the identities Keycloak holds, including those in no organization, and let the administrator assign one.

- **Rationale**: No tenant-scoped list can show a person who is in no tenant (ADR-0011).
- **Actors**: `cpt-studio-actor-platform-admin`

#### Tenant-clamped authorization

- [x] `p1` - **ID**: `cpt-studio-fr-authz-tenant-clamp`

The system **MUST** answer every authorization request through the Studio PDP, which keeps the request inside the caller's tenant subtree, and **MUST** only narrow that bound with role grants.

- **Rationale**: Roles are layered over the tenant model and can never widen it (ADR-0009, ADR-0019).
- **Actors**: `cpt-studio-actor-member`

#### Row-level role mapping

- [ ] `p2` - **ID**: `cpt-studio-fr-authz-row-roles`

Planned. The Studio PDP **MUST** map a Studio resource type and action to a privilege when that resource's gear starts asking for row-level access; `privilege_for` in `studio_authz_plugin.rs` returns nothing today (ADR-0019, Follow-ups).

- **Rationale**: Row access is the PDP's question; administration is not (ADR-0019 §3).
- **Actors**: `cpt-studio-actor-member`

#### Presence and direct messages

- [x] `p2` - **ID**: `cpt-studio-fr-presence`

The system **MUST** report who is in Studio from portal heartbeats and deliver a direct message to an online person on their next heartbeat without storing it.

- **Rationale**: An administrator asked who is working now and how to reach them (`studio_presence` module documentation).
- **Actors**: `cpt-studio-actor-member`

### 5.3 Connections and credentials

#### Connections

- [x] `p1` - **ID**: `cpt-studio-fr-connections`

The system **MUST** let a tenant configure one connection per provider — source hosts GitHub, GitLab and Bitbucket; model providers Anthropic and OpenAI; chat platforms Slack, Zulip and Discord, each with a bot-token and an incoming-webhook variant — verify the credential when it is created, and list repositories, targets and files through it, returning the credstore reference and never the token.

- **Rationale**: One connection replaces a clone URL and a token per repository per workspace ([studio-connector](../design/studio-connector.md)).
- **Actors**: `cpt-studio-actor-member`, `cpt-studio-actor-provider`

#### Durable credentials

- [x] `p1` - **ID**: `cpt-studio-fr-credentials-durable`

The system **MUST** keep credential values across a backend restart, encrypted in a Postgres table, and **MUST** heal config-seeded secrets once at start.

- **Rationale**: With the in-memory value store every restart lost the tokens people had entered (issue #66, `studio-backend/src/credstore_pg/README.md`).
- **Actors**: `cpt-studio-actor-member`

#### Queued chat notifications

- [x] `p2` - **ID**: `cpt-studio-fr-chat-notifications`

The system **MUST** validate a notification to a chat connection, queue it, deliver it with retries, and keep what cannot be delivered as a dead-letter record.

- **Rationale**: A message dropped inside a request handler is dropped for good ([studio-notify](../design/studio-notify.md)).
- **Actors**: `cpt-studio-actor-provider`

#### Notifications that leave Studio

- [ ] `p2` - **ID**: `cpt-studio-fr-notification-delivery-choice`

Planned. The system **MUST** tell a person about comment threads waiting on them without the person opening the product, once the delivery channel is decided between a project channel, personal e-mail and a stored inbox (`TASKS.md`, 2026-09-17).

- **Rationale**: Requirement §10 of the collaboration requirements cited in `TASKS.md`.
- **Actors**: `cpt-studio-actor-member`

### 5.4 IDE sessions

#### Per-workspace IDE session

- [x] `p1` - **ID**: `cpt-studio-fr-ide-session`

The system **MUST** launch, list, reach and stop one Theia IDE session per workspace, clone the workspace's sources into it on first launch, reap it four hours after launch, and adopt running sessions after a backend restart; it **MUST** run sessions through a Docker driver and a Kubernetes driver behind the same REST contract.

- **Rationale**: The IDE is a running container with a checkout, credentials and an agent runtime, and somebody has to own its lifecycle (ADR-0003).
- **Actors**: `cpt-studio-actor-member`, `cpt-studio-actor-session`

#### Backend-to-backend bridge

- [x] `p2` - **ID**: `cpt-studio-fr-theia-bridge`

The system **MUST** let backend gears open a workspace, run and retry operations and read repositories and status in a running session over an authenticated internal control API, and **MUST** accept the session's events at an authenticated ingress; the bridge is built with the `theia-bridge` Cargo feature.

- **Rationale**: The portal needs the session's state from outside the IDE without a browser in the loop (ADR-0022).
- **Actors**: `cpt-studio-actor-session`

#### IDE product surface

- [x] `p1` - **ID**: `cpt-studio-fr-ide-product-surface`

The session IDE **MUST** provide the Studio surfaces as Theia extensions: the portal bridge, repositories, Git operations, Analyze and Audit panels, workspace and artifact graphs and the Orca agents panel (`theia/studio`); the markdown editor, quality and flow rails, figure and table editors, search, comments, tracked changes and co-presence (`theia/product-ext`); and draw.io diagram editing (`theia/drawio-editor`).

- **Rationale**: Every capability is hung on a published contribution point so Theia can be upgraded (`theia/studio/README.md`).
- **Actors**: `cpt-studio-actor-member`, `cpt-studio-actor-session`

#### LLM proxy for the IDE

- [x] `p1` - **ID**: `cpt-studio-fr-ide-llm-proxy`

The system **MUST** expose an OpenAI-compatible chat-completions, models and client-config endpoint that authenticates the caller with the member's Studio token and attaches the server-held provider key on the way upstream, streaming responses through.

- **Rationale**: A provider key in the container is readable by anything in it ([studio-llm-proxy](../design/studio-llm-proxy.md)).
- **Actors**: `cpt-studio-actor-agent`

#### Workspace AI chat

- [x] `p3` - **ID**: `cpt-studio-fr-workspace-ai-chat`

The system **MUST** offer workspace AI chat through the mini-chat gear and its LLM egress when the `llm` feature is built; the prototype's Chats view is kept but hidden from navigation.

- **Rationale**: `registered_gears.rs` links `mini_chat` and `api_egress` behind `llm`; `App.tsx` keeps the `chats` view reachable but unlisted.
- **Actors**: `cpt-studio-actor-member`

### 5.5 Documents

#### Document catalogue

- [x] `p1` - **ID**: `cpt-studio-fr-document-catalogue`

The system **MUST** hold document types (template, section checklist, rules, questionnaire), lifecycle stages and the capability vocabulary at organization level, overridable per workspace with a tombstone that hides an inherited entry.

- **Rationale**: An organization's opinion of what a document contains becomes data ([studio-documents](../design/studio-documents.md), ADR-0014).
- **Actors**: `cpt-studio-actor-org-owner`

#### Documents and validation

- [x] `p1` - **ID**: `cpt-studio-fr-documents`

The system **MUST** create, read, update and delete documents owned by a workspace and inherited by its projects, compose a PRD from a questionnaire, validate a document against its type's checklist and rules, and report each stage's status for a project.

- **Rationale**: "Is this document complete" gets an answer that is not a person reading it ([studio-documents](../design/studio-documents.md)).
- **Actors**: `cpt-studio-actor-member`

#### Documents already in a repository

- [x] `p1` - **ID**: `cpt-studio-fr-repository-documents`

The system **MUST** classify each prose file of a project's repository — declared front matter first, then inference from sections, path, title and front-matter keys, then the external `purpose` detector — record the result as a binding to the file's graph node, validate it against the chosen type, and let a member confirm, change or mark it as not a document.

- **Rationale**: Documents written before Studio saw them name no type (`docs/documents-from-a-repository.md`).
- **Actors**: `cpt-studio-actor-member`

#### Specification quality

- [x] `p2` - **ID**: `cpt-studio-fr-spec-quality`

The system **MUST** submit documents to the external spec-quality service's `bloat`, `purpose`, `leak` and `traceability` detectors through an authenticated passthrough, wait for the result as a background run, and record and interpret each verdict.

- **Rationale**: The service's shared secret must not reach the browser ([studio-spec-quality](../design/studio-spec-quality.md)).
- **Actors**: `cpt-studio-actor-member`

### 5.6 Knowledge graph

#### Repository artifacts in the graph

- [x] `p1` - **ID**: `cpt-studio-fr-artifact-ingest`

The system **MUST** pull issues, pull requests and files from a connection's repository into the knowledge graph as typed GTS nodes with deterministic ids, so a re-sync upserts, and **MUST** serve nodes, edges, files, activity, quality and search over them.

- **Rationale**: A consumer traverses one graph instead of three provider APIs ([studio-artifact-ingest](../design/studio-artifact-ingest.md)).
- **Actors**: `cpt-studio-actor-member`, `cpt-studio-actor-provider`

#### Domain model in the graph

- [x] `p2` - **ID**: `cpt-studio-fr-domain-model`

The system **MUST** store the Studio domain model as GTS types in graph storage, seeded from `ontology.core.json`, and let a member create objects and relations, extend a type with fields, and import, sync and revert the model.

- **Rationale**: Graph storage is the model's system of record (ADR-0024).
- **Actors**: `cpt-studio-actor-member`

### 5.7 Gears, products and kits

#### Gear catalogue

- [x] `p1` - **ID**: `cpt-studio-fr-gear-catalogue`

The system **MUST** sync every crate published under the `constructorfabric` keyword on crates.io into the graph as `gear` and `crate_version` nodes, and serve the components, versions, field schemas, profiles and activity of that catalogue.

- **Rationale**: "What gears are there, at what versions" had no answer inside Studio ([studio-components-catalog](../design/studio-components-catalog.md)).
- **Actors**: `cpt-studio-actor-member`

#### Gear scaffolding

- [x] `p2` - **ID**: `cpt-studio-fr-gear-scaffold`

The system **MUST** record which repository a project's gears live in, create that repository through a connection, and write a gear skeleton into it on a branch, optionally opening a pull request.

- **Rationale**: Once Studio knows what a gear looks like it can create one ([studio-product](../design/studio-product.md)).
- **Actors**: `cpt-studio-actor-member`

#### Gearbox products

- [x] `p2` - **ID**: `cpt-studio-fr-gearbox-product`

The system **MUST** compose a `product.gdl` from picked gears, resolve it with the Gearbox engine against a pinned gear corpus, store and optionally commit it for a project, and open it in the IDE's Gearbox perspective with the native `.gdl` language.

- **Rationale**: The portal and the IDE run the same engine at the same commit so they agree (`theia/gearbox-studio/README.md`).
- **Actors**: `cpt-studio-actor-member`, `cpt-studio-actor-agent`

#### A specification maps to gears

- [ ] `p1` - **ID**: `cpt-studio-fr-spec-gear-mapping`

The system **MUST** map every capability a product's specification requires to gears in this order, and **MUST** say for each proposal which step produced it:
1. **Contract.** A gear the Gearbox engine reports as providing one of the capability's contracts is matched: a provided contract, a hosted extension point or an implemented one. The organization's capability vocabulary translates a capability key into the contracts that satisfy it.
2. **Evidence.** A capability no declared contract satisfies is searched for in the gears' documentation. A proposal from search cites the passage that supports it, and ranks below every contract match.
3. **Gap.** A capability neither step covers is a gap, offered as the starting point of a new gear.

The same rules **MUST** apply to every project; nothing in them may name a particular product, repository or corpus.

The system **MUST** read the capabilities a specification requires from the specification as it is written, and **MUST NOT** require it to be changed for the mapping: a `capabilities:` line in its front matter is used when present, and otherwise the capabilities are inferred from its functional requirements, each citing the requirements behind it. A repository document the classifier proposed and nobody has confirmed counts too, marked as unconfirmed.

- **Rationale**: Keyword matching over gear prose alone cannot tell a gear that provides a capability from one that mentions it. Different products bring different specifications, so the mapping must be data-driven (#205, #199).
- **Actors**: `cpt-studio-actor-member`, `cpt-studio-actor-agent`

#### A mapping is a decision on record

- [ ] `p1` - **ID**: `cpt-studio-fr-mapping-decisions`

The system **MUST** let a member confirm or reject each proposed mapping. It **MUST** record each decision in the knowledge graph as a link from the specification section through the capability to the gear, with:
- who decided;
- which step proposed it;
- the gear version and the document revision decided against.

A decision **MUST** be shown as needing review again once the section or the gear changes. Past decisions **MUST** rank later proposals of the same capability in the same organization.

- **Rationale**: A product's composition has to be explainable section by section, and a confirmation made once should not be asked for again on the next product (#205, #206).
- **Actors**: `cpt-studio-actor-member`

#### Non-functional requirements shape the profile, not the gear list

- [ ] `p2` - **ID**: `cpt-studio-fr-nfr-to-profile`

The system **MUST** map a specification's non-functional requirements (where the product runs, tenancy, data residency, scale) to the product's deployment profile and gear configuration in `product.gdl`, and **MUST NOT** turn them into extra gears.

- **Rationale**: "On premises" is the `self_hosted` profile, not a component. Mapping it to a gear would add a component the product does not need.
- **Actors**: `cpt-studio-actor-member`

#### Delivery metrics from Constructor Insight

- [x] `p3` - **ID**: `cpt-studio-fr-delivery-insight`

The system **MUST** read delivery metrics and pull requests per component from Constructor Insight's read-only SQL endpoint through one integration gear.

- **Rationale**: One place of contact when Insight's contract moves ([studio-insight](../design/studio-insight.md)).
- **Actors**: `cpt-studio-actor-member`

#### Kits

- [x] `p2` - **ID**: `cpt-studio-fr-kits`

The system **MUST** serve a kit catalogue and record, per project, which kits are desired, and ask the session to materialize or reconcile an installation; the kit bytes stay in their Git repositories.

- **Rationale**: A kit is versioned where it lives ([studio-kits](../design/studio-kits.md)).
- **Actors**: `cpt-studio-actor-member`

### 5.8 Background work and push

#### Durable background runs

- [x] `p1` - **ID**: `cpt-studio-fr-background-runs`

The system **MUST** record every background job as a run whose state moves `queued → running → succeeded | failed | cancelled`, written with its queue entry in one transaction, and let a caller list, cancel and retry runs.

- **Rationale**: Three gears had each kept an in-memory task map that lost everything on restart ([studio-tasks](../design/studio-tasks.md)).
- **Actors**: `cpt-studio-actor-member`

#### Schedules

- [x] `p2` - **ID**: `cpt-studio-fr-schedules`

The system **MUST** keep cron and interval schedules evaluated in UTC (other time zones are refused until a time-zone database is in), a concurrency policy (`allow | forbid | replace`) and a missed-schedule policy (`skip | catch_up | backfill`), enqueue a run when one is due, and run one on demand.

- **Rationale**: Nothing in gears-rust schedules anything ([studio-scheduler](../design/studio-scheduler.md)).
- **Actors**: `cpt-studio-actor-member`

#### Push channel to the portal

- [x] `p1` - **ID**: `cpt-studio-fr-push-channel`

The system **MUST** publish every producer's events on one tenant-scoped SSE stream with at-least-once delivery and replay after a cursor.

- **Rationale**: Consumers polled for state changes; one domain-neutral channel replaces the polling (ADR-0026).
- **Actors**: `cpt-studio-actor-shell`, `cpt-studio-actor-mfe`

### 5.9 Files and settings

#### File storage

- [x] `p3` - **ID**: `cpt-studio-fr-file-storage`

The system **MUST** store files through the `file_storage` gear, with the S3 data-plane sidecar on Kubernetes; the prototype's Files view is kept but hidden from navigation.

- **Rationale**: `registered_gears.rs` links `file_storage`; `deploy/FILE_STORAGE_S3.md` describes the Kubernetes data plane.
- **Actors**: `cpt-studio-actor-member`

#### User settings

- [x] `p3` - **ID**: `cpt-studio-fr-user-settings`

The system **MUST** keep a person's profile and UI preferences.

- **Rationale**: `simple_user_settings` is linked and `studio-user` serves `/me/ui-preferences`.
- **Actors**: `cpt-studio-actor-member`

### 5.10 Contract, registries and operation

#### One REST contract

- [x] `p1` - **ID**: `cpt-studio-fr-api-contract`

The backend **MUST** declare every REST operation under `/<gear>/v1`, page every list with `?offset=&limit=` and a total, and fail the build when a declaration breaks `docs/api-conventions.md` beyond the committed baseline.

- **Rationale**: The contract is enforced by a ratchet rather than agreed in review (ADR-0020).
- **Actors**: `cpt-studio-actor-mfe`
- **Verification Method**: the `api_contract` drift test in `cargo test` and the `studio-backend api-contract` command.

#### GTS registry consistency

- [x] `p2` - **ID**: `cpt-studio-fr-gts-consistency`

The backend **MUST** build the inventory of every GTS document it registers offline, drift-check it in `cargo test`, and audit a live deployment's types-registry and graph-storage ontology against it.

- **Rationale**: A malformed type surfaced only as a crash at boot (ADR-0013 §6).
- **Actors**: `cpt-studio-actor-platform-admin`
- **Verification Method**: `studio-backend gts-types` and `studio-backend gts-audit`.

#### Database bootstrap

- [x] `p1` - **ID**: `cpt-studio-fr-database-bootstrap`

The backend **MUST** discover the PostgreSQL databases its configured gears declare, create only the missing ones, and run migrations, from the same configuration the server uses.

- **Rationale**: Database names are not copied into Helm or initdb scripts (`studio-backend/src/database_bootstrap.rs`).
- **Actors**: `cpt-studio-actor-platform-admin`

#### Local stack with Docker Compose

- [x] `p1` - **ID**: `cpt-studio-fr-deploy-compose`

The system **MUST** run as one local stack with Docker Compose, from source or from the published images, with sessions launched through the host Docker daemon.

- **Rationale**: Local development and functional checks on one machine (`README.md`).
- **Actors**: `cpt-studio-actor-platform-admin`

#### Kubernetes deployment

- [x] `p1` - **ID**: `cpt-studio-fr-deploy-kubernetes`

The system **MUST** deploy to the `studio-dev` and `studio-test` namespaces from the Helm chart `deploy/helm/studio-web`, with graph PostgreSQL on CloudNativePG and the Keycloak image deployed as infrastructure, using immutable image tags.

- **Rationale**: The shared environments (`README.md`, `deploy/README.md`).
- **Actors**: `cpt-studio-actor-platform-admin`

#### Observability

- [x] `p2` - **ID**: `cpt-studio-fr-observability`

The system **MUST** provision metrics collection for the cluster as code: VictoriaMetrics, Alloy, kube-state-metrics and Grafana dashboards and alert rules.

- **Rationale**: `deploy/observability/README.md`.
- **Actors**: `cpt-studio-actor-platform-admin`

#### Delivery pipeline

- [x] `p1` - **ID**: `cpt-studio-fr-delivery-pipeline`

The system **MUST** test changed components on every pull request and push, publish a complete `sha-<commit>` image set after the tests pass on a push, and deploy only when an operator runs a deploy operation.

- **Rationale**: `README.md`, CI/CD; `deploy/PIPELINES.md`.
- **Actors**: `cpt-studio-actor-platform-admin`

## 6. Non-Functional Requirements

> **Global baselines**: No project-wide NFR baseline document exists in this repository, and there is no parent PRD. The NFRs below are specific to Constructor Studio.

### 6.1 Gear-Specific NFRs

#### Credentials never reach the session or the browser

- [x] `p1` - **ID**: `cpt-studio-nfr-credential-isolation`

The system **MUST NOT** place a provider key or Git token in a session container, a browser or an API response.

- **Threshold**: zero secret values returned by any Studio REST operation; Git tokens reach a session only as credstore references through an inline credential helper and are never written into `.git/config`.
- **Rationale**: `PRODUCT.md`, Product Principle 3.
- **Architecture Allocation**: See DESIGN.md § NFR Allocation for how this is realized

#### Tenant isolation holds under every access model

- [x] `p1` - **ID**: `cpt-studio-nfr-tenant-isolation`

The system **MUST** keep every allowed request inside the caller's tenant subtree, under both the `tenant` and the `roles` access model.

- **Threshold**: no allow outside the tenant clamp; a mis-entered grant can only deny (ADR-0009, Consequences).
- **Rationale**: Tenancy is the platform invariant roles sit on.
- **Architecture Allocation**: See DESIGN.md § NFR Allocation for how this is realized

#### Background work survives a restart

- [x] `p1` - **ID**: `cpt-studio-nfr-durable-work`

The system **MUST** keep runs, schedules, the event sequence and credential values across a backend restart.

- **Threshold**: a run, schedule, event cursor or credential written before a restart is readable after it.
- **Rationale**: In-memory registries lost work on every redeploy ([studio-tasks](../design/studio-tasks.md), `studio-backend/src/studio_events/mod.rs`).
- **Architecture Allocation**: See DESIGN.md § NFR Allocation for how this is realized

#### Sessions are bounded

- [x] `p2` - **ID**: `cpt-studio-nfr-session-bounds`

The system **MUST** bound each IDE session in time and in port range.

- **Threshold**: a session lives four hours before the reaper collects it; Docker sessions bind loopback ports 41000–41099 (`PRODUCT.md`, Operating Context).
- **Rationale**: A running session costs a container.
- **Architecture Allocation**: See DESIGN.md § NFR Allocation for how this is realized

#### Lists are paged the same way

- [x] `p2` - **ID**: `cpt-studio-nfr-list-pagination`

Every collection endpoint **MUST** take `offset` and `limit` and report `total`.

- **Threshold**: `limit` between 1 and 200, default 50 (`studio-backend/src/pagination.rs`).
- **Rationale**: A caller that can page one list can page all of them.
- **Architecture Allocation**: See DESIGN.md § NFR Allocation for how this is realized

### 6.2 NFR Exclusions

- No project-default NFR set exists to exclude from; availability, latency and throughput targets are not stated anywhere in this repository and are not set here.

## 7. Public Library Interfaces

Constructor Studio is a product, not a library. Its public surfaces are the REST API, the push channel, the portal-to-IDE message bridge and the session control API, defined in the design as `cpt-studio-interface-rest-api`, `cpt-studio-interface-push-channel`, `cpt-studio-interface-portal-ide-bridge` and `cpt-studio-interface-session-control`.

### 7.1 Public API Surface

The REST API is served under `/cf/<gear>/v1`, documented at `/cf/docs` and committed as `studio-backend/docs/api-contract.json`; its rules are [`docs/api-conventions.md`](../api-conventions.md) and ADR-0020. Breaking changes land together with their consumers (ADR-0020 §8).

### 7.2 External Integration Contracts

The contracts with external systems are defined in the design's External Dependencies: `cpt-studio-contract-keycloak-oidc` (Keycloak), `cpt-studio-contract-provider-apis` (source hosts, model providers, chat platforms), `cpt-studio-contract-spec-quality-service`, `cpt-studio-contract-insight-sql` (Constructor Insight), `cpt-studio-contract-crates-io`, `cpt-studio-contract-gearbox-engine` and `cpt-studio-contract-s3`.

## 8. Use Cases

#### Open a project and work in its IDE session

- [x] `p1` - **ID**: `cpt-studio-usecase-open-ide-session`

**Actor**: `cpt-studio-actor-member`

**Preconditions**:
- The member belongs to the organization and the workspace has sources.
- IDE sessions are enabled in the deployment.

**Main Flow**:
1. The member opens the project in the portal and launches its session.
2. The backend starts a container or Pod for the workspace and clones its sources over HTTPS with credentials supplied by reference.
3. The portal embeds the IDE and hands it the theme; the agents in it call the model through the LLM proxy.

**Postconditions**:
- A session exists for the workspace and is listed by the backend until it is stopped or reaped.

**Alternative Flows**:
- **Sessions disabled**: the portal surface that assumes a session says that none is available.

#### Connect a source

- [x] `p1` - **ID**: `cpt-studio-usecase-connect-source`

**Actor**: `cpt-studio-actor-member`

**Preconditions**:
- An organization is in scope.

**Main Flow**:
1. The member chooses a provider, a label and a credential.
2. The backend probes the provider with the credential and stores the connection at organization scope.

**Postconditions**:
- The connection is listed and offered by the New project wizard.

**Alternative Flows**:
- **Credential refused**: the form stays open and shows the provider's refusal on the credential field.

#### Create a project from repositories

- [x] `p1` - **ID**: `cpt-studio-usecase-create-project`

**Actor**: `cpt-studio-actor-member`

**Preconditions**:
- A workspace is in scope.

**Main Flow**:
1. The member opens the New project wizard and picks repositories from a connection.
2. The portal writes the project tenant and its metadata.
3. The project's repositories are synced into the knowledge graph.

**Postconditions**:
- The project is listed under the workspace and its artifacts are readable.

**Alternative Flows**:
- **Empty project**: the member skips the repositories step.

#### Recognise the documents in a repository

- [x] `p2` - **ID**: `cpt-studio-usecase-classify-documents`

**Actor**: `cpt-studio-actor-member`

**Preconditions**:
- The project's repository files are in the knowledge graph.

**Main Flow**:
1. The member asks for the project's documents to be classified.
2. Each prose file gets a binding with a detected type, a confidence and a validation report.
3. The member confirms or corrects the bindings the classifier could not settle.

**Postconditions**:
- The project's specifications are listed with their type and conformance.

**Alternative Flows**:
- **Not a specification**: the member marks the file as not a document.

#### Compose a product from gears

- [x] `p2` - **ID**: `cpt-studio-usecase-compose-product`

**Actor**: `cpt-studio-actor-member`

**Preconditions**:
- The gear catalogue has been synced and product previews are enabled (`STUDIO_GEARBOX_WORKDIR`).

**Main Flow**:
1. The member picks gears for a project's product.
2. The backend composes a `product.gdl`, resolves it with the Gearbox engine and returns the result.
3. The member saves the product and opens it in the IDE's Gearbox perspective.

**Postconditions**:
- The project has a stored product, optionally committed to its repository.

**Alternative Flows**:
- **Resolution conflicts**: the engine's conflicts are shown in the product preview and in the IDE's Conflicts view.

## 9. Acceptance Criteria

Business-level acceptance criteria for the PRD as a whole. Each is observable on a running stack and traced to its implementation in [§14 Traceability](#14-traceability).

- [ ] **AC1** — A member signed in through Keycloak who launches a session for a workspace with sources gets a running IDE whose repositories are cloned, and `GET /cf/studio-session/v1/sessions` lists that session.
- [ ] **AC2** — Inside a running session, no environment variable, file or Git configuration holds a provider key or a source-host token.
- [ ] **AC3** — No response of `GET /cf/studio-connector/v1/connections` contains a token; each connection carries only its credstore reference.
- [ ] **AC4** — An organization created through `POST /cf/studio-organizations/v1/organizations` is listed for its creator with the creator as owner.
- [ ] **AC5** — A person who signs in without any membership sees a no-access state, and the platform administrator's identity directory lists that person as unassigned.
- [ ] **AC6** — A request on behalf of a member of one organization never returns rows owned by another organization's tenants.
- [ ] **AC7** — After `docker compose restart backend`, a previously stored connection credential still resolves, a queued or finished run is still listed, and a reconnecting event subscriber replays the events after its cursor.
- [ ] **AC8** — Classifying a project whose repository contains this `docs/` tree binds every file under `docs/prd`, `docs/design`, `docs/decomposition`, `docs/feature` and `docs/adr` to its declared type, and each binding conforms.
- [ ] **AC9** — A `studio-events` subscriber receives the transitions of a run it did not start, without polling `studio-tasks`.
- [ ] **AC10** — A change that adds a REST operation violating `docs/api-conventions.md` fails `cargo test` until the violation is fixed or baselined.
- [ ] **AC11** — For every product project already on the dev stand, mapping its specification lists each required capability with a contract match, a cited search match or a gap, and the same request run twice returns the same contract matches.

## 10. Dependencies

| Dependency | Description | Criticality |
|------------|-------------|-------------|
| gears-rust | Platform gears and SDKs, pinned in `studio-backend/Cargo.lock` | p1 |
| PostgreSQL 19 with pgvector | Application databases and `graph_storage` (`graph-postgres`) | p1 |
| Keycloak | Sign-in, GitHub brokering and user provisioning | p1 |
| Docker daemon or Kubernetes API | Where sessions run (`studio-session` drivers) | p1 |
| Source hosts, model providers, chat platforms | Repositories, models and message delivery through connections | p2 |
| Spec-quality service | The four detectors behind `studio-spec-quality` | p2 |
| Gearbox engine | Product resolution and the `.gdl` language, pinned by `STUDIO_GEARBOX_REF` | p2 |
| crates.io | The public API the gear catalogue sync reads | p2 |
| Constructor Insight | Read-only SQL endpoint behind `studio-insight` | p3 |
| GHCR | Published images and the session image | p1 |
| S3 (Virtuozzo) | File storage data plane on Kubernetes | p3 |

Criticality follows `README.md`: without PostgreSQL, gears-rust or an identity provider the backend does not serve; blank keys for the optional integrations leave them unavailable without preventing the stack from starting.

## 11. Assumptions

- Sources are reachable over HTTPS from where sessions run.
- The session image is built or pulled before the first session (`README.md`, the `session-image` service).
- A `GITHUB_TOKEN` is available when the session image is built, because the image resolves the skill engine through `api.github.com` (`README.md`).

## 12. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `PRODUCT.md` describes authorization as allow-all and Kubernetes v1 as running without sessions, while the code clamps every request to the tenant and the dev values enable the session driver | Readers of the brief misjudge what is enforced and where sessions run | This PRD follows the code; the brief is to be reconciled |
| Source-host tokens are stored in credstore, while the roadmap PRD decided Studio should not permanently hold host credentials (`docs/roadmap-alignment.md`) | The connection model may need to move to OAuth-app or installation tokens | Recorded as an open question |
| `theia/gearbox-studio` is ported from a repository with no licence yet | It cannot ship beyond evaluation until its owner grants permission | Stated in `theia/gearbox-studio/README.md` |
| Two backend replicas have never run with sessions against a real cluster | Scaling the backend with sessions on is unproven | The chart refuses more than one replica while sessions are on |

## 13. Open Questions

- Whether nested projects may nest further, whether root projects derive an owner, and what the shared connection catalogue is called while organizations stay hidden (`PRODUCT.md`).
- Whether source-host access moves from stored tokens to OAuth-app or installation tokens (`docs/roadmap-alignment.md`).
- Which channel a notification leaves Studio by (`TASKS.md`, 2026-09-17).
- Who owns the capability-to-contract vocabulary: the platform, the organization, or the platform with organization additions. Today the vocabulary is organization data overridable per workspace (`cpt-studio-fr-document-catalogue`).
- Whether Gearbox should resolve a product from required contracts instead of picked gears (`requires = [...]` in `product.gdl`), which would move the choice of gear and vendor into the engine.
- How a product's FrontX micro-frontends are composed with its gears: whether a gear's UI lives beside the gear, and whether the FrontX shell is itself a gear (constructorfabric/gearbox#3).

## 14. Traceability

- **Design**: [DESIGN](../design/constructor-studio.md)
- **ADRs**: [ADR index](../adr/README.md)
- **Features**: [DECOMPOSITION](../decomposition/constructor-studio.md) and [`docs/feature/`](../feature/)

### 14.1 Functional requirements to implementation

| Requirement | Implemented in |
|---|---|
| `cpt-studio-fr-org-create` | `studio-backend/src/organizations/`; `POST /studio-organizations/v1/organizations`; prototype admin `tenants` |
| `cpt-studio-fr-org-administration` | `studio-backend/src/organizations/`, `studio-backend/src/access_config.rs`, `studio-backend/src/user_profile/`; `/studio-organizations/v1/{access-catalogue,capabilities,rollups}`, `/studio-user/v1/organizations/{org_id}/invitations`; prototype admin `access` and `people`; official portal: `people-mfe`, specified in [feature/organization-people.md](../feature/organization-people.md) |
| `cpt-studio-fr-workspace-project-tenants` | platform `account_management`; `/cf/account-management/v1`; `projects-mfe` (Projects, New project, New workspace), `organization-mfe` (Workspaces); prototype `projects`, workspace tab `projects`, platform `workspaces`, project tab `automation` |
| `cpt-studio-fr-portal-levels` | `studio-frontend/src-app/app/`, `studio-frontend/src-app/mfe_packages/_iframe-fixture/`; `organization-mfe` (Overview) |
| `cpt-studio-fr-portal-reserved-areas` | `people-mfe`, `kits-mfe`, `search-mfe`, `organization-mfe` (Organization settings), `projects-mfe` placeholder sections (Overview, Findings, Activity, Timeline, Team, Project settings); prototype project tab `timeline` |
| `cpt-studio-fr-sign-in` | platform `oidc_authn_plugin`, `static_authn_plugin`, `static_authz_plugin`; `keycloak/`; `studio-frontend/src-app/app/`; `studio-frontend-prototype/src/oidc.ts` |
| `cpt-studio-fr-canonical-user` | `studio-backend/src/user_profile/`; `/studio-user/v1/{me,resolve,merge,users}`; prototype `profile` |
| `cpt-studio-fr-invitations-membership` | `studio-backend/src/user_profile/`, platform `keycloak_idp_plugin`, `static_idp_plugin`; `/studio-user/v1/me/{invitations,memberships}`; prototype `people`, project tab `people` |
| `cpt-studio-fr-identity-directory` | `studio-backend/src/identity_directory/`; `/studio-identity/v1`; prototype platform `identities` |
| `cpt-studio-fr-authz-tenant-clamp` | `studio-backend/src/studio_authz_plugin.rs`, `studio-backend/src/access_config.rs`; platform `authz_resolver`, `tenant_resolver`, `resource_group` |
| `cpt-studio-fr-authz-row-roles` | planned: `privilege_for` in `studio-backend/src/studio_authz_plugin.rs`; ADR-0019 Follow-ups |
| `cpt-studio-fr-presence` | `studio-backend/src/presence/`; `/studio-presence/v1`; `studio-frontend-prototype/src/presence.tsx` |
| `cpt-studio-fr-connections` | `studio-backend/src/connectors/` and its eleven plugin gears; `/studio-connector/v1`; `connections-mfe` (Connections, Connect source); prototype `connectors`, admin `connectors`, project tab `sources` |
| `cpt-studio-fr-credentials-durable` | `studio-backend/src/credstore_pg/`, `studio-backend/src/secrets_bootstrap/`; platform `credstore`, `static_credstore_plugin`; prototype admin `secrets` |
| `cpt-studio-fr-chat-notifications` | `studio-backend/src/notify/`; `/studio-notify/v1`; `studio-frontend-prototype/src/notifications.tsx` in prototype `system` |
| `cpt-studio-fr-notification-delivery-choice` | planned: `TASKS.md`, 2026-09-17 |
| `cpt-studio-fr-spec-gear-mapping` | `studio-backend/src/spec_mapping/` (`reading.rs`: a specification read as written; `plan.rs`: contract, then evidence with a cited passage, then gap); `/studio-spec-mapping/v1/{plan,capabilities}`; facts from `product/gearbox.rs` (`gdl_contracts`) and `repo_enrich.rs` (`doc_text`); vocabulary `documents/model.rs` (`Capability::contracts`); prototype project tab `components`; #205, #199 |
| `cpt-studio-fr-mapping-decisions` | `studio-backend/src/spec_mapping/` (`/studio-spec-mapping/v1/decisions`, ranking in `plan.rs`); stored as `mapping_decision` nodes with `decision_on` edges by `artifact_ingest` (`port::MappingDecisionStore`); prototype project tab `components` (✓/✗ on a candidate); planned: decisions shared across an organization; #205, #206 |
| `cpt-studio-fr-nfr-to-profile` | `studio-backend/src/spec_mapping/` (`reading::declared_requirements`, `plan::deployment_profile`, `nonfunctional` capabilities offer no gear); `/studio-spec-mapping/v1/requirements`; indexed by `documents` (`m0013`); prototype project tab `components` ("Use <profile>"); planned: `config` from requirements; #205 |
| `cpt-studio-fr-ide-session` | `studio-backend/src/studio_session/`; `/studio-session/v1`; `theia/Dockerfile`, `theia/browser-app/`; prototype "Open Studio" launcher and `home` (live sessions) |
| `cpt-studio-fr-theia-bridge` | `studio-backend/src/studio_theia/`; `/studio-theia/v1`; `theia/studio/src/node/studio-control-api.ts` |
| `cpt-studio-fr-ide-product-surface` | `theia/studio/`, `theia/product-ext/`, `theia/drawio-editor/` |
| `cpt-studio-fr-ide-llm-proxy` | `studio-backend/src/llm_proxy/`; `/studio-llm/v1` |
| `cpt-studio-fr-workspace-ai-chat` | platform `mini_chat`, `api_egress`; prototype `chats` (hidden) |
| `cpt-studio-fr-document-catalogue` | `studio-backend/src/documents/`; `/studio-documents/v1/{organizations,workspaces}/{id}/{types,stages,capabilities}`; prototype workspace tabs `types` and `process` |
| `cpt-studio-fr-documents` | `studio-backend/src/documents/`; `/studio-documents/v1/workspaces/{workspace_id}/documents`, `…/projects/{project_id}/stage-status`; prototype project tabs `overview` and `specs` |
| `cpt-studio-fr-repository-documents` | `studio-backend/src/documents/{classify,validate,intake}.rs`; `/studio-documents/v1/workspaces/{workspace_id}/document-bindings`, `/studio-documents/v1/{spec-rows,spec-pipeline,specs-per-source}`; prototype project tab `specs` |
| `cpt-studio-fr-spec-quality` | `studio-backend/src/spec_quality/`; `/studio-spec-quality/v1`; `studio-frontend-prototype/src/spec-quality.tsx` |
| `cpt-studio-fr-artifact-ingest` | `studio-backend/src/artifact_ingest/`, platform `graph_storage`; `/studio-artifact-ingest/v1`; `projects-mfe` project screen; prototype project tabs `artifacts` and `activity`, and the hidden `files` view's repository files |
| `cpt-studio-fr-domain-model` | `studio-backend/src/domain_model/`; `/studio-domain-model/v1`; prototype `objects` |
| `cpt-studio-fr-gear-catalogue` | `studio-backend/src/components_catalog/`; `/studio-components-catalog/v1/{components,versions,sync,reference,component-values,component-history,types,field-schemas,profiles,activity}`; prototype `gears` |
| `cpt-studio-fr-gear-scaffold` | `studio-backend/src/product/{scaffold,skeleton}.rs`; `/studio-product/v1/projects/{project_id}/{gear-repo,create-repo,scaffold}` |
| `cpt-studio-fr-gearbox-product` | `studio-backend/src/product/` (`gearbox.rs`, `service.rs`); `/studio-product/v1/gearbox`, `/studio-product/v1/projects/{project_id}/product`, `/studio-spec-mapping/v1/plan`; `theia/gearbox-studio/`, `theia/gdl-language/`; prototype project tab `components` |
| `cpt-studio-fr-delivery-insight` | `studio-backend/src/insight/`; `/studio-insight/v1`; prototype `gears` component page |
| `cpt-studio-fr-kits` | `studio-backend/src/kit_registry/`; `/studio-kits/v1`; `theia/studio/src/node/kit-installer.ts`; prototype project tab `components` |
| `cpt-studio-fr-background-runs` | `studio-backend/src/tasks/`; `/studio-tasks/v1`; prototype `tasks` |
| `cpt-studio-fr-schedules` | `studio-backend/src/scheduler/`; `/studio-scheduler/v1`; prototype `tasks` |
| `cpt-studio-fr-push-channel` | `studio-backend/src/studio_events/`; `/studio-events/v1`; `studio-frontend/docs/studio-events.md` |
| `cpt-studio-fr-file-storage` | platform `file_storage`; `deploy/FILE_STORAGE_S3.md`; prototype `files` (hidden) |
| `cpt-studio-fr-user-settings` | platform `simple_user_settings`; `/studio-user/v1/me/ui-preferences`; prototype `profile` |
| `cpt-studio-fr-api-contract` | `studio-backend/src/api_contract.rs`, `studio-backend/src/pagination.rs`; `studio-backend/docs/api-contract.json`; platform `api_gateway` |
| `cpt-studio-fr-gts-consistency` | `studio-backend/src/gts_inventory.rs`, `studio-backend/src/gts_audit.rs`; platform `types_registry`; prototype `system` |
| `cpt-studio-fr-database-bootstrap` | `studio-backend/src/database_bootstrap.rs`; `backend-bootstrap` service in `docker-compose.yml` |
| `cpt-studio-fr-deploy-compose` | `docker-compose.yml`, `docker-compose.published.yml`, `scripts/dev-up.sh` |
| `cpt-studio-fr-deploy-kubernetes` | `deploy/helm/studio-web/`, `deploy/k8s/cloudnative-pg/`, `keycloak/` |
| `cpt-studio-fr-observability` | `deploy/observability/` |
| `cpt-studio-fr-delivery-pipeline` | `.github/workflows/studio-delivery.yml`, `deploy/PIPELINES.md` |

Platform gears that serve every requirement rather than one — `gear_orchestrator`, `grpc_hub`, `nodes_registry`, `authn_resolver` — are traced through `cpt-studio-fr-api-contract` and `cpt-studio-fr-sign-in` in the design's component model.

### 14.2 Acceptance criteria to implementation

| Criterion | Implemented in |
|---|---|
| AC1 | `studio-backend/src/studio_session/`; `theia/Dockerfile`; `cpt-studio-fr-ide-session`, `cpt-studio-fr-sign-in` |
| AC2 | `studio-backend/src/llm_proxy/`, `studio-backend/src/studio_session/`; `cpt-studio-nfr-credential-isolation` |
| AC3 | `studio-backend/src/connectors/rest.rs`; `cpt-studio-fr-connections` |
| AC4 | `studio-backend/src/organizations/`; `cpt-studio-fr-org-create` |
| AC5 | `studio-backend/src/user_profile/`, `studio-backend/src/identity_directory/`; `cpt-studio-fr-invitations-membership`, `cpt-studio-fr-identity-directory` |
| AC6 | `studio-backend/src/studio_authz_plugin.rs`; `cpt-studio-nfr-tenant-isolation` |
| AC7 | `studio-backend/src/credstore_pg/`, `studio-backend/src/tasks/`, `studio-backend/src/studio_events/`; `cpt-studio-nfr-durable-work` |
| AC8 | `studio-backend/src/documents/classify.rs`, `studio-backend/src/documents/validate.rs`; `cpt-studio-fr-repository-documents` |
| AC9 | `studio-backend/src/studio_events/`, `studio-backend/src/tasks/`; `cpt-studio-fr-push-channel` |
| AC10 | `studio-backend/src/api_contract.rs`; `cpt-studio-fr-api-contract` |
| AC11 | `studio-backend/src/spec_mapping/` (`GET /studio-spec-mapping/v1/plan`); `cpt-studio-fr-spec-gear-mapping`, `cpt-studio-fr-mapping-decisions` |
