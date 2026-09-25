---
type: decomposition
status: accepted
owner: studio-team
---

# Decomposition: Constructor Studio

**Overall implementation status:**
- [ ] `p1` - **ID**: `cpt-studio-status-overall`

## Table of Contents

<!-- toc -->

- [1. Overview](#1-overview)
- [2. Entries](#2-entries)
  - [2.1 Identity and sign-in](#21-identity-and-sign-in)
  - [2.2 Organizations and access](#22-organizations-and-access)
  - [2.3 Workspaces and projects as tenants](#23-workspaces-and-projects-as-tenants)
  - [2.4 Levels in the shell](#24-levels-in-the-shell)
  - [2.5 Workspaces in scope](#25-workspaces-in-scope)
  - [2.6 The organization's workspaces](#26-the-organizations-workspaces)
  - [2.7 The organization overview](#27-the-organization-overview)
  - [2.8 Create a project](#28-create-a-project)
  - [2.9 Connect a source](#29-connect-a-source)
  - [2.10 Project artifacts](#210-project-artifacts)
  - [2.11 Reserved portal areas](#211-reserved-portal-areas)
  - [2.12 Prototype portal](#212-prototype-portal)
  - [2.13 Connections and credentials](#213-connections-and-credentials)
  - [2.14 IDE sessions](#214-ide-sessions)
  - [2.15 Theia bridge](#215-theia-bridge)
  - [2.16 AI in the session](#216-ai-in-the-session)
  - [2.17 Documents and specifications](#217-documents-and-specifications)
  - [2.18 Knowledge graph](#218-knowledge-graph)
  - [2.19 Gears, products and delivery metrics](#219-gears-products-and-delivery-metrics)
  - [2.20 Kits](#220-kits)
  - [2.21 Background work, notifications and presence](#221-background-work-notifications-and-presence)
  - [2.22 Files](#222-files)
  - [2.23 Contract, registries and bootstrap](#223-contract-registries-and-bootstrap)
  - [2.24 Deployment and delivery](#224-deployment-and-delivery)
- [3. Feature Dependencies](#3-feature-dependencies)

<!-- /toc -->

## 1. Overview

The [design](../design/constructor-studio.md) is decomposed along the gear
boundary of the backend assembly and the package boundary of the portal and the
IDE: each entry below groups the gears, microfrontends and Theia packages that
together deliver one area of the [PRD](../prd/constructor-studio.md), and names
the requirement ids it covers. Seven entries are user-facing portal slices that
already have a feature spec under [`docs/feature/`](../feature/); their titles
link to it. The other entries are implemented without a feature spec, and say
so.

Every design component appears in at least one entry, and every PRD functional
requirement is covered by at least one entry. The repository ranks no
priorities, so every entry carries `p1`; an entry is checked when everything it
covers is implemented, and unchecked when it contains a planned requirement or
open Definitions of Done. The overall status is unchecked because two PRD
requirements are planned (`cpt-studio-fr-authz-row-roles`,
`cpt-studio-fr-notification-delivery-choice`).

## 2. Entries

### 2.1 Identity and sign-in

- [x] `p1` - **ID**: `cpt-studio-feature-identity`

- **Purpose**: A person signs in once through Keycloak and is one canonical user however they signed in, with memberships, invitations and a platform view of unassigned identities. No feature spec is written for it.

- **Depends On**: None

- **Scope**:
  - OIDC sign-in in both portals, static tokens for scripts
  - the canonical user, logins, aliases, merge and UI preferences
  - invitations, memberships, the no-access state and the identity directory

- **Out of scope**:
  - who may administer an organization (`cpt-studio-feature-organizations-access`)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-sign-in`
  - [x] `p1` - `cpt-studio-fr-canonical-user`
  - [x] `p1` - `cpt-studio-fr-invitations-membership`
  - [x] `p1` - `cpt-studio-fr-identity-directory`
  - [x] `p1` - `cpt-studio-fr-user-settings`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-prove-before-show`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - User, Login, Membership, Alias, Invitation

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-user`
  - [x] `p1` - `cpt-studio-component-identity-directory`
  - [x] `p1` - `cpt-studio-component-platform-auth-plugins`
  - [x] `p1` - `cpt-studio-component-keycloak`
  - [x] `p1` - `cpt-studio-component-platform-feature-gears`

- **API**:
  - `/studio-user/v1`
  - `/studio-identity/v1`

- **Sequences**:

  - None

- **Data**:

  - [x] `p1` - `cpt-studio-db-users`
  - [x] `p1` - `cpt-studio-dbtable-identity-user`

### 2.2 Organizations and access

- [ ] `p1` - **ID**: `cpt-studio-feature-organizations-access`

- **Purpose**: A member creates an organization and owns it; the owner administers it; every request is clamped to the caller's tenant. Row-level role mapping is planned. No feature spec is written for it.

- **Depends On**: `cpt-studio-feature-identity`

- **Scope**:
  - organization creation with owner membership and access grant
  - the access catalogue, capabilities and rollups
  - the Studio PDP and the shared access-config module

- **Out of scope**:
  - role-mapped Studio resource types (planned, ADR-0019 Follow-ups)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-org-create`
  - [x] `p1` - `cpt-studio-fr-org-administration`
  - [x] `p1` - `cpt-studio-fr-authz-tenant-clamp`
  - [ ] `p1` - `cpt-studio-fr-authz-row-roles`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-tenant-clamp-first`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Tenant, Access config, Membership

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-organizations`
  - [x] `p1` - `cpt-studio-component-authz-plugin`
  - [x] `p1` - `cpt-studio-component-access-config`

- **API**:
  - `/studio-organizations/v1`

- **Sequences**:

  - None

- **Data**:

  - [x] `p1` - `cpt-studio-db-users`

### 2.3 Workspaces and projects as tenants

- [x] `p1` - **ID**: `cpt-studio-feature-tenancy`

- **Purpose**: Workspaces and projects are account-management tenants, so tenant isolation and membership come from the platform. No feature spec is written for the tenancy itself; the portal slices below build on it.

- **Depends On**: `cpt-studio-feature-organizations-access`

- **Scope**:
  - workspace and project tenants and their metadata
  - the platform gears the tenant tree rests on

- **Out of scope**:
  - a third level of nesting (undecided in `PRODUCT.md`)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-workspace-project-tenants`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-project-is-unit`
  - [x] `p1` - `cpt-studio-principle-visible-seams`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Tenant

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-account-management`
  - [x] `p1` - `cpt-studio-component-platform-system`

- **API**:
  - `/cf/account-management/v1`

- **Sequences**:

  - None

- **Data**:

  - None of Studio's own

### 2.4 [Levels in the shell](../feature/shell-levels.md)

- [x] `p1` - **ID**: `cpt-studio-feature-shell-levels`

- **Purpose**: The FrontX shell navigates organization, workspace and project levels, draws each level's menu and path, and mounts microfrontend entries, including frame entries.

- **Depends On**: `cpt-studio-feature-tenancy`

- **Scope**:
  - the level ladder, the rail and the breadcrumb of three slots
  - Module Federation and iframe entries

- **Out of scope**:
  - a router that owns the address (the feature's "Nothing owns the address yet")

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-portal-levels`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-project-is-unit`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Tenant

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-portal-shell`

- **API**:
  - `/cf/account-management/v1`

- **Sequences**:

  - None

- **Data**:

  - None

### 2.5 [Workspaces in scope](../feature/workspace-scope.md)

- [x] `p1` - **ID**: `cpt-studio-feature-workspace-scope`

- **Purpose**: The shell owns the organization's workspace list, creates a workspace and makes it current, and roots the projects list at it.

- **Depends On**: `cpt-studio-feature-shell-levels`

- **Scope**:
  - the workspace slot next to the organization
  - the New workspace overlay

- **Out of scope**:
  - the organization-level list of workspaces (`cpt-studio-feature-workspaces-screen`)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-workspace-project-tenants`
  - [x] `p1` - `cpt-studio-fr-portal-levels`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-project-is-unit`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Tenant

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-portal-shell`
  - [x] `p1` - `cpt-studio-component-projects-mfe`

- **API**:
  - `/cf/account-management/v1`

- **Sequences**:

  - None

- **Data**:

  - None

### 2.6 [The organization's workspaces](../feature/workspaces-screen.md)

- [x] `p1` - **ID**: `cpt-studio-feature-workspaces-screen`

- **Purpose**: The organization level lists its workspaces, leads into each, and creates one from the list.

- **Depends On**: `cpt-studio-feature-workspace-scope`

- **Scope**:
  - the Workspaces screen of `organization-mfe`

- **Out of scope**:
  - workspace settings

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-workspace-project-tenants`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-prove-before-show`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Tenant

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-organization-mfe`

- **API**:
  - `/cf/account-management/v1`

- **Sequences**:

  - None

- **Data**:

  - None

### 2.7 [The organization overview](../feature/organization-overview.md)

- [ ] `p1` - **ID**: `cpt-studio-feature-organization-overview`

- **Purpose**: The organization level's first screen: tiles that either carry a number from a read the screen already makes or say which answer does not exist yet. Three of its Definitions of Done are open.

- **Depends On**: `cpt-studio-feature-workspaces-screen`

- **Scope**:
  - the Overview screen of `organization-mfe`

- **Out of scope**:
  - an aggregate endpoint for gear health, invitations and connection health

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-portal-levels`
  - [x] `p1` - `cpt-studio-fr-portal-reserved-areas`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-reserved-not-empty`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Tenant

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-organization-mfe`

- **API**:
  - `/cf/account-management/v1`

- **Sequences**:

  - None

- **Data**:

  - None

### 2.8 [Create a project](../feature/project-create.md)

- [x] `p1` - **ID**: `cpt-studio-feature-project-create`

- **Purpose**: The New project wizard creates a project in the current workspace, empty or from repositories picked through connections.

- **Depends On**: `cpt-studio-feature-workspace-scope`, `cpt-studio-feature-connection-create`

- **Scope**:
  - the wizard overlay, its steps and its two writes

- **Out of scope**:
  - importing the repositories' content (`cpt-studio-feature-project-artifacts`)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-workspace-project-tenants`
  - [x] `p1` - `cpt-studio-fr-connections`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-project-is-unit`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Tenant, Connection

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-projects-mfe`
  - [x] `p1` - `cpt-studio-component-connector`

- **API**:
  - `/cf/account-management/v1`
  - `/studio-connector/v1`

- **Sequences**:

  - [x] `p1` - `cpt-studio-seq-create-project`

- **Data**:

  - None

### 2.9 [Connect a source](../feature/connection-create.md)

- [x] `p1` - **ID**: `cpt-studio-feature-connection-create`

- **Purpose**: The Connections screen lists the organization's connections with their health and adds one at organization scope through a single-step overlay.

- **Depends On**: `cpt-studio-feature-shell-levels`, `cpt-studio-feature-connections`

- **Scope**:
  - the Connections screen and the Connect source overlay of `connections-mfe`

- **Out of scope**:
  - workspace-scoped and personal connections

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-connections`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-credentials-by-reference`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Connection

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-connections-mfe`

- **API**:
  - `/studio-connector/v1`

- **Sequences**:

  - [x] `p1` - `cpt-studio-seq-connect-source`

- **Data**:

  - None

### 2.10 [Project artifacts](../feature/project-artifacts.md)

- [ ] `p1` - **ID**: `cpt-studio-feature-project-artifacts`

- **Purpose**: A project's rail and its artifacts table, synced per repository into the knowledge graph. Two of its Definitions of Done are open.

- **Depends On**: `cpt-studio-feature-project-create`, `cpt-studio-feature-knowledge-graph`

- **Scope**:
  - the project screen of `projects-mfe` with its artifacts table and sync

- **Out of scope**:
  - classifying documents (`cpt-studio-feature-documents`)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-artifact-ingest`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-prove-before-show`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Artifact node

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-projects-mfe`
  - [x] `p1` - `cpt-studio-component-artifact-ingest`

- **API**:
  - `/studio-artifact-ingest/v1`

- **Sequences**:

  - [x] `p1` - `cpt-studio-seq-create-project`

- **Data**:

  - None

### 2.11 Reserved portal areas

- [x] `p1` - **ID**: `cpt-studio-feature-reserved-areas`

- **Purpose**: People, Kits, Search, Organization settings and six project sections are present in the FrontX navigation and say they have no source yet. No feature spec is written for them.

- **Depends On**: `cpt-studio-feature-shell-levels`

- **Scope**:
  - `people-mfe`, `kits-mfe`, `search-mfe`, the Organization settings screen
  - the project sections of `projects-mfe` that render `PlaceholderSection`: Overview, Findings, Activity, Timeline, Team, Project settings

- **Out of scope**:
  - the content of those areas

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-portal-reserved-areas`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-reserved-not-empty`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - None

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-reserved-mfes`
  - [x] `p1` - `cpt-studio-component-organization-mfe`
  - [x] `p1` - `cpt-studio-component-projects-mfe`

- **API**:
  - None

- **Sequences**:

  - None

- **Data**:

  - None

### 2.12 Prototype portal

- [x] `p1` - **ID**: `cpt-studio-feature-prototype-portal`

- **Purpose**: The pre-FrontX portal on port 8081 carries every screen the FrontX portal does not have yet, listed by key in the design's prototype portal component. No feature spec is written for it.

- **Depends On**: `cpt-studio-feature-identity`, `cpt-studio-feature-tenancy`

- **Scope**:
  - the prototype's top-level, admin, platform-admin, workspace and project screens
  - the "Open Studio" launcher

- **Out of scope**:
  - porting screens into FrontX (see `docs/frontend-handover-hardcode.md`)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-workspace-project-tenants`
  - [x] `p1` - `cpt-studio-fr-portal-reserved-areas`
  - [x] `p1` - `cpt-studio-fr-presence`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-prove-before-show`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - All core entities

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-prototype-portal`

- **API**:
  - every prefix in the design's API Contracts

- **Sequences**:

  - [x] `p1` - `cpt-studio-seq-open-ide-session`

- **Data**:

  - None

### 2.13 Connections and credentials

- [x] `p1` - **ID**: `cpt-studio-feature-connections`

- **Purpose**: Connections to source hosts, model providers and chat platforms, with credential values that survive a restart. The portal slice is `cpt-studio-feature-connection-create`; the backend has no separate feature spec.

- **Depends On**: `cpt-studio-feature-tenancy`

- **Scope**:
  - `studio-connector` and its eleven plugin gears
  - the Postgres value store and the secrets bootstrap

- **Out of scope**:
  - OAuth-app or installation tokens (open question in the PRD)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-connections`
  - [x] `p1` - `cpt-studio-fr-credentials-durable`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-credentials-by-reference`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Connection

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-connector`
  - [x] `p1` - `cpt-studio-component-credstore-pg`
  - [x] `p1` - `cpt-studio-component-secrets-bootstrap`
  - [x] `p1` - `cpt-studio-component-platform-feature-gears`

- **API**:
  - `/studio-connector/v1`

- **Sequences**:

  - [x] `p1` - `cpt-studio-seq-connect-source`

- **Data**:

  - [x] `p1` - `cpt-studio-db-credstore-values`
  - [x] `p1` - `cpt-studio-dbtable-credstore-values`

### 2.14 IDE sessions

- [x] `p1` - **ID**: `cpt-studio-feature-ide-sessions`

- **Purpose**: One Theia IDE session per workspace, with Studio's product surfaces inside it. No feature spec is written for it.

- **Depends On**: `cpt-studio-feature-connections`

- **Scope**:
  - `studio-session` with its Docker and Kubernetes drivers
  - the session image and the `theia/studio`, `theia/product-ext` and `theia/drawio-editor` extensions

- **Out of scope**:
  - `theia/electron-app` (not built into the image)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-ide-session`
  - [x] `p1` - `cpt-studio-fr-ide-product-surface`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-credentials-by-reference`

- **Design Constraints Covered**:

  - [x] `p1` - `cpt-studio-constraint-https-only-cloning`
  - [x] `p1` - `cpt-studio-constraint-single-replica-sessions`
  - [x] `p1` - `cpt-studio-constraint-extension-not-patch`

- **Domain Model Entities**:
  - Session

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-session`
  - [x] `p1` - `cpt-studio-component-session-image`
  - [x] `p1` - `cpt-studio-component-theia-studio`
  - [x] `p1` - `cpt-studio-component-theia-product-ext`
  - [x] `p1` - `cpt-studio-component-theia-drawio-editor`

- **API**:
  - `/studio-session/v1`

- **Sequences**:

  - [x] `p1` - `cpt-studio-seq-open-ide-session`

- **Data**:

  - None

### 2.15 Theia bridge

- [x] `p1` - **ID**: `cpt-studio-feature-theia-bridge`

- **Purpose**: Backend gears reach a running session's node backend for control calls, and receive its events. No feature spec is written for it.

- **Depends On**: `cpt-studio-feature-ide-sessions`

- **Scope**:
  - `studio-theia`, the control API and event forwarder in `theia/studio`

- **Out of scope**:
  - the broker-backed sink beyond the `theia-event-broker` feature

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-theia-bridge`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-one-push-channel`

- **Design Constraints Covered**:

  - [x] `p1` - `cpt-studio-constraint-extension-not-patch`

- **Domain Model Entities**:
  - Session

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-theia-bridge`
  - [x] `p1` - `cpt-studio-component-theia-studio`

- **API**:
  - `/studio-theia/v1`

- **Sequences**:

  - None

- **Data**:

  - None

### 2.16 AI in the session

- [x] `p1` - **ID**: `cpt-studio-feature-ide-ai`

- **Purpose**: Agents in a session reach a model through the LLM proxy with the member's token; workspace AI chat runs on mini-chat when `llm` is built. No feature spec is written for it.

- **Depends On**: `cpt-studio-feature-ide-sessions`

- **Scope**:
  - `studio-llm-proxy`, `mini_chat`, `api_egress`

- **Out of scope**:
  - the LLM chain in the Kubernetes release

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-ide-llm-proxy`
  - [x] `p1` - `cpt-studio-fr-workspace-ai-chat`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-credentials-by-reference`

- **Design Constraints Covered**:

  - [x] `p1` - `cpt-studio-constraint-llm-off-in-release`

- **Domain Model Entities**:
  - None

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-llm-proxy`
  - [x] `p1` - `cpt-studio-component-llm-chain`

- **API**:
  - `/studio-llm/v1`

- **Sequences**:

  - [x] `p1` - `cpt-studio-seq-open-ide-session`

- **Data**:

  - None

### 2.17 Documents and specifications

- [x] `p1` - **ID**: `cpt-studio-feature-documents`

- **Purpose**: The document catalogue, authored documents, the documents already in a repository, and their quality. No feature spec is written for it; `docs/documents-from-a-repository.md` explains the repository path.

- **Depends On**: `cpt-studio-feature-knowledge-graph`

- **Scope**:
  - `studio-documents` and `studio-spec-quality`
  - editing documents in the IDE's markdown editor

- **Out of scope**:
  - document types distributed as kits (ADR-0014 Follow-ups)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-document-catalogue`
  - [x] `p1` - `cpt-studio-fr-documents`
  - [x] `p1` - `cpt-studio-fr-repository-documents`
  - [x] `p1` - `cpt-studio-fr-spec-quality`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-prove-before-show`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Document type, Stage, Capability, Document, Analysis, Binding

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-documents`
  - [x] `p1` - `cpt-studio-component-spec-quality`
  - [x] `p1` - `cpt-studio-component-theia-product-ext`

- **API**:
  - `/studio-documents/v1`
  - `/spec-quality/v1`
  - `/studio-spec-quality/v1`

- **Sequences**:

  - [x] `p1` - `cpt-studio-seq-classify-documents`

- **Data**:

  - [x] `p1` - `cpt-studio-db-documents`
  - [x] `p1` - `cpt-studio-dbtable-document-bindings`
  - [x] `p1` - `cpt-studio-dbtable-document-types`

### 2.18 Knowledge graph

- [x] `p1` - **ID**: `cpt-studio-feature-knowledge-graph`

- **Purpose**: Repository artifacts and the Studio domain model in graph storage. The portal slice is `cpt-studio-feature-project-artifacts`; the backend has no separate feature spec.

- **Depends On**: `cpt-studio-feature-connections`

- **Scope**:
  - `studio-artifact-ingest`, `studio-domain-model`, `graph_storage`, PostgreSQL

- **Out of scope**:
  - switching embedding providers over a populated graph

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-artifact-ingest`
  - [x] `p1` - `cpt-studio-fr-domain-model`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-link-time-assembly`

- **Design Constraints Covered**:

  - [x] `p1` - `cpt-studio-constraint-graph-postgres`

- **Domain Model Entities**:
  - Artifact node, Model, Object type

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-artifact-ingest`
  - [x] `p1` - `cpt-studio-component-domain-model`
  - [x] `p1` - `cpt-studio-component-graph-storage`
  - [x] `p1` - `cpt-studio-component-postgres`

- **API**:
  - `/studio-artifact-ingest/v1`
  - `/studio-domain-model/v1`

- **Sequences**:

  - [x] `p1` - `cpt-studio-seq-create-project`

- **Data**:

  - [x] `p1` - `cpt-studio-db-artifact-index`
  - [x] `p1` - `cpt-studio-dbtable-artifact-index`

### 2.19 Gears, products and delivery metrics

- [x] `p1` - **ID**: `cpt-studio-feature-gears-products`

- **Purpose**: The gear catalogue from crates.io, gear scaffolding, Gearbox products in the portal and the IDE, and Constructor Insight metrics on a component's page. No feature spec is written for it; `theia/gearbox-studio/README.md` records its phases.

- **Depends On**: `cpt-studio-feature-knowledge-graph`, `cpt-studio-feature-ide-sessions`

- **Scope**:
  - `studio-components-catalog`, `studio-insight`, `theia/gearbox-studio`, `theia/gdl-language`

- **Out of scope**:
  - Gearbox phases P4 and P6b

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-gear-catalogue`
  - [x] `p1` - `cpt-studio-fr-gear-scaffold`
  - [x] `p1` - `cpt-studio-fr-gearbox-product`
  - [x] `p1` - `cpt-studio-fr-delivery-insight`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-prove-before-show`

- **Design Constraints Covered**:

  - [x] `p1` - `cpt-studio-constraint-gearbox-licence`

- **Domain Model Entities**:
  - Gear, Crate version

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-components-catalog`
  - [x] `p1` - `cpt-studio-component-insight`
  - [x] `p1` - `cpt-studio-component-theia-gearbox-studio`
  - [x] `p1` - `cpt-studio-component-theia-gdl-language`

- **API**:
  - `/studio-components-catalog/v1`
  - `/studio-insight/v1`

- **Sequences**:

  - [x] `p1` - `cpt-studio-seq-compose-product`

- **Data**:

  - None of Studio's own relational tables

### 2.20 Kits

- [x] `p1` - **ID**: `cpt-studio-feature-kits`

- **Purpose**: A kit catalogue and each project's desired kits, installed into a session's checkout by `cfs`. No feature spec is written for it; `docs/kit-registry-prototype.md` describes the prototype slice.

- **Depends On**: `cpt-studio-feature-theia-bridge`

- **Scope**:
  - `studio-kits` and the kit installer in `theia/studio`

- **Out of scope**:
  - the FrontX Kits area, which is reserved (`cpt-studio-feature-reserved-areas`)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-kits`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-prove-before-show`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Kit installation

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-kits`

- **API**:
  - `/studio-kits/v1`

- **Sequences**:

  - None

- **Data**:

  - None

### 2.21 Background work, notifications and presence

- [ ] `p1` - **ID**: `cpt-studio-feature-background-work`

- **Purpose**: Durable runs, schedules, queued chat notifications, presence and the push channel. How a notification leaves Studio is planned. No feature spec is written for it.

- **Depends On**: `cpt-studio-feature-tenancy`

- **Scope**:
  - `studio-tasks`, `studio-scheduler`, `studio-notify`, `studio-presence`, `studio-events`

- **Out of scope**:
  - personal e-mail or a stored inbox (undecided, `TASKS.md`)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-background-runs`
  - [x] `p1` - `cpt-studio-fr-schedules`
  - [x] `p1` - `cpt-studio-fr-push-channel`
  - [x] `p1` - `cpt-studio-fr-presence`
  - [x] `p1` - `cpt-studio-fr-chat-notifications`
  - [ ] `p1` - `cpt-studio-fr-notification-delivery-choice`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-one-push-channel`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - Run, Schedule, Event

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-tasks`
  - [x] `p1` - `cpt-studio-component-scheduler`
  - [x] `p1` - `cpt-studio-component-notify`
  - [x] `p1` - `cpt-studio-component-presence`
  - [x] `p1` - `cpt-studio-component-events`

- **API**:
  - `/studio-tasks/v1`
  - `/studio-scheduler/v1`
  - `/studio-notify/v1`
  - `/studio-presence/v1`
  - `/studio-events/v1`

- **Sequences**:

  - [x] `p1` - `cpt-studio-seq-create-project`

- **Data**:

  - [x] `p1` - `cpt-studio-db-tasks`
  - [x] `p1` - `cpt-studio-db-scheduler`
  - [x] `p1` - `cpt-studio-db-events`
  - [x] `p1` - `cpt-studio-dbtable-tasks-runs`
  - [x] `p1` - `cpt-studio-dbtable-events-log`

### 2.22 Files

- [x] `p1` - **ID**: `cpt-studio-feature-files`

- **Purpose**: File storage through the platform gear, with the S3 data plane on Kubernetes. No feature spec is written for it.

- **Depends On**: `cpt-studio-feature-tenancy`

- **Scope**:
  - `file_storage` and its S3 sidecar

- **Out of scope**:
  - S3 in Docker Compose (`README.md`)

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-file-storage`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-link-time-assembly`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - None of Studio's own

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-platform-feature-gears`

- **API**:
  - `/cf/file-storage/v1`

- **Sequences**:

  - None

- **Data**:

  - None

### 2.23 Contract, registries and bootstrap

- [x] `p1` - **ID**: `cpt-studio-feature-contract-registries`

- **Purpose**: The REST contract ratchet, one pagination contract, the GTS inventory and live audit, and database bootstrap. No feature spec is written for it.

- **Depends On**: None

- **Scope**:
  - `api_contract.rs`, `pagination.rs`, `gts_inventory.rs`, `gts_audit.rs`, `database_bootstrap.rs`, the platform system gears

- **Out of scope**:
  - the OpenAPI document, which a booted assembly serves at `/cf/docs`

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-api-contract`
  - [x] `p1` - `cpt-studio-fr-gts-consistency`
  - [x] `p1` - `cpt-studio-fr-database-bootstrap`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-link-time-assembly`

- **Design Constraints Covered**:

  - None

- **Domain Model Entities**:
  - None

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-api-contract`
  - [x] `p1` - `cpt-studio-component-gts-inventory`
  - [x] `p1` - `cpt-studio-component-database-bootstrap`
  - [x] `p1` - `cpt-studio-component-platform-system`

- **API**:
  - `studio-backend api-contract`, `gts-types`, `gts-audit`, `bootstrap`, `migrate`

- **Sequences**:

  - None

- **Data**:

  - None

### 2.24 Deployment and delivery

- [x] `p1` - **ID**: `cpt-studio-feature-deployment`

- **Purpose**: The Docker Compose stack, the Kubernetes deployment, the observability stack and the Studio Delivery pipeline. No feature spec is written for it; `deploy/README.md` and `deploy/PIPELINES.md` are the runbooks.

- **Depends On**: None

- **Scope**:
  - `docker-compose.yml`, `docker-compose.published.yml`, `deploy/helm/studio-web`, `deploy/k8s/cloudnative-pg`, `keycloak/`, `deploy/observability`, `.github/workflows/studio-delivery.yml`

- **Out of scope**:
  - the kustomize files directly under `deploy/k8s/`

- **Requirements Covered**:

  - [x] `p1` - `cpt-studio-fr-deploy-compose`
  - [x] `p1` - `cpt-studio-fr-deploy-kubernetes`
  - [x] `p1` - `cpt-studio-fr-observability`
  - [x] `p1` - `cpt-studio-fr-delivery-pipeline`

- **Design Principles Covered**:

  - [x] `p1` - `cpt-studio-principle-link-time-assembly`

- **Design Constraints Covered**:

  - [x] `p1` - `cpt-studio-constraint-llm-off-in-release`
  - [x] `p1` - `cpt-studio-constraint-single-replica-sessions`
  - [x] `p1` - `cpt-studio-constraint-graph-postgres`

- **Domain Model Entities**:
  - None

- **Design Components**:

  - [x] `p1` - `cpt-studio-component-deployment`
  - [x] `p1` - `cpt-studio-component-keycloak`
  - [x] `p1` - `cpt-studio-component-postgres`
  - [x] `p1` - `cpt-studio-component-session-image`

- **API**:
  - None

- **Sequences**:

  - None

- **Data**:

  - [x] `p1` - `cpt-studio-topology-compose`
  - [x] `p1` - `cpt-studio-topology-kubernetes`

---

## 3. Feature Dependencies

```text
cpt-studio-feature-contract-registries      cpt-studio-feature-deployment
cpt-studio-feature-identity
    ↓
cpt-studio-feature-organizations-access
    ↓
cpt-studio-feature-tenancy
    ├─→ cpt-studio-feature-shell-levels
    │       ├─→ cpt-studio-feature-workspace-scope
    │       │       ├─→ cpt-studio-feature-workspaces-screen
    │       │       │       └─→ cpt-studio-feature-organization-overview
    │       │       └─→ cpt-studio-feature-project-create
    │       │               └─→ cpt-studio-feature-project-artifacts
    │       ├─→ cpt-studio-feature-connection-create
    │       └─→ cpt-studio-feature-reserved-areas
    ├─→ cpt-studio-feature-prototype-portal
    ├─→ cpt-studio-feature-connections
    │       ├─→ cpt-studio-feature-connection-create
    │       ├─→ cpt-studio-feature-knowledge-graph
    │       │       ├─→ cpt-studio-feature-documents
    │       │       ├─→ cpt-studio-feature-project-artifacts
    │       │       └─→ cpt-studio-feature-gears-products
    │       └─→ cpt-studio-feature-ide-sessions
    │               ├─→ cpt-studio-feature-theia-bridge
    │               │       └─→ cpt-studio-feature-kits
    │               ├─→ cpt-studio-feature-ide-ai
    │               └─→ cpt-studio-feature-gears-products
    ├─→ cpt-studio-feature-background-work
    └─→ cpt-studio-feature-files
```

**Dependency Rationale**:

- `cpt-studio-feature-organizations-access` requires `cpt-studio-feature-identity`: an organization's owner is a canonical user with a membership.
- `cpt-studio-feature-tenancy` requires `cpt-studio-feature-organizations-access`: workspaces are created under an organization.
- `cpt-studio-feature-project-create` requires `cpt-studio-feature-workspace-scope` and `cpt-studio-feature-connection-create`: a project is created in the current workspace, and its repositories step reads connections.
- `cpt-studio-feature-project-artifacts` requires `cpt-studio-feature-project-create` and `cpt-studio-feature-knowledge-graph`: it syncs the sources the wizard wrote into the graph.
- `cpt-studio-feature-ide-sessions` requires `cpt-studio-feature-connections`: sessions clone sources with connection credentials.
- `cpt-studio-feature-kits` requires `cpt-studio-feature-theia-bridge`: materializing a kit is a control call into the session.
- `cpt-studio-feature-documents` requires `cpt-studio-feature-knowledge-graph`: a binding names a graph file node.
- `cpt-studio-feature-contract-registries` and `cpt-studio-feature-deployment` depend on no entry; every other entry rests on them.
- `cpt-studio-feature-background-work`, `cpt-studio-feature-files` and `cpt-studio-feature-prototype-portal` are independent of each other and of the portal slices.
