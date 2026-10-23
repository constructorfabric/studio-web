---
type: adr
status: proposed
date: 2026-10-23
---

# ADR-0049: Constructor Research builds and runs a product as one of its applications, reached through a connection and an integration service

**ID**: `cpt-studio-adr-research-environments`

Status: **proposed** · Date: 2026-10-23 · Issue #868 · Extends `cpt-studio-adr-deployment-environments` (ADR-0043) and ADR-0048 (a product ships as images and a chart in the organization's registry) · Uses `cpt-studio-adr-self-service-identity-resolution` (ADR-0012) and `cpt-studio-adr-the-person-is-the-key-not-the-login` (ADR-0025)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. Research is a connection, and it signs in with OAuth](#1-research-is-a-connection-and-it-signs-in-with-oauth)
  - [2. A Research environment is a Research project](#2-a-research-environment-is-a-research-project)
  - [3. Studio prepares, Research compiles](#3-studio-prepares-research-compiles)
  - [4. A deploy is an application of services](#4-a-deploy-is-an-application-of-services)
  - [5. Who owns what runs](#5-who-owns-what-runs)
  - [6. What the integration service provides](#6-what-the-integration-service-provides)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

Constructor Research is another Constructor product. It gives its users
compute it allocates and accounts for: projects, desks, hardware
configurations (CPU, memory, GPU), and a trial mode. Studio, by ADR-0043 and
ADR-0048, builds a product's images and deploys its chart into an
organization's environments, and an environment today is a Kubernetes
cluster the organization connects with a service-account token.

Many of Studio's users have no cluster, but they have, or can be given,
Research. Building the generated Dockerfiles and running the result on the
hardware Research allocates would take them from a specification to a
running product without operating Kubernetes.

The Research team will write an integration service for what Studio needs.
This record says what that is, and how Studio reaches it.

What Research has today shapes the answer:

- **Applications.** A Research project can hold applications, each made of
  services. A service runs an image as a Deployment, with ports, environment
  variables, volumes, a replica count and a hardware configuration. A port
  may be exposed to the internet at an address of its own. Every application
  gets a namespace of its own.
- **Image builds.** A member builds an image from a Dockerfile in the
  project's files (buildah, in a Job), and the image is pushed to the
  platform's registry. A service may run only an image built this way.
- **No namespace per member or project**, and no resource quota: desks and
  environments of all members share one namespace, and the cluster's
  internal APIs rely on staying inside it. Research does not hand out
  Kubernetes access, and should not.
- **No teams and no service accounts.** Above a person there is only the
  tenant of the shared identity provider. A project has one owner and
  collaborators without roles. Machine access exists only for Research's own
  services, and it lets the caller act as any user it names.
- **The shared Constructor identity provider** (IdentityServer) signs people
  in with authorization code and PKCE, `offline_access`, and Google, Apple,
  Microsoft or Facebook as well as a password. Its clients are configuration,
  kept in its database; it supports `private_key_jwt` client authentication.
  Tokens carry the tenant (`tid`). Many people have no password at all.

## Considered Options

1. **Research hands out namespaces.** The integration service gives Studio a
   namespace and short-lived Kubernetes credentials, and Studio builds and
   deploys exactly as ADR-0048 does.
2. **Research runs Studio's products as its own applications.** The
   integration service accepts a build context and a list of services, and
   uses Research's image build and applications to run them. Studio
   translates its chart into that list.
3. **A connection with the person's Research login and password.** Studio
   stores the password and signs in as the person.

## Decision Outcome

Chosen option: **2**.

Option 1 would have Research give a tenant's tool write access to a cluster
whose namespaces are shared and whose internal APIs are unauthenticated
inside it; making that safe is a rebuild of Research's isolation, not an
integration. Option 3 fails everyone who signs in through Google or
Microsoft, breaks under multi-factor sign-in, and stores a secret that cannot
be narrowed or revoked on its own. Option 2 uses what Research already
builds, runs, meters and exposes, and asks the integration service only to
make it callable by Studio.

The cost is a second deploy path beside ADR-0048's Helm install. It is kept
narrow: Studio renders the same chart and hands over what it contains (§4),
so the product, its configuration and its build stay one.

### 1. Research is a connection, and it signs in with OAuth

A new connection kind, `research`, a plugin gear like every provider
(`cpt-studio-principle-connector-provider-is-plugin`). It is not created by
pasting a credential. **Connect Constructor Research** sends the person to the
identity provider with authorization code and PKCE, as a confidential client
`constructor-studio` registered there (authenticated with `private_key_jwt`),
asking for `offline_access` and the integration service's scope. The
callback stores the refresh token in credstore; the connection keeps only its
reference (`cpt-studio-principle-credentials-by-reference`).

Its test calls the integration service's `/me`. The connection's `account` is
the Research user's id and its tenant. A `personal` connection that passed the
test proves its creator controls that Research account (ADR-0012), so the link
between a Studio person and a Research user needs no mechanism of its own.

The connector gains a second way to create a connection, `oauth_start` and
`oauth_callback`, beside the pasted credential. Research is the first provider
to use it; a GitHub App or a GitLab OAuth application could use it later.

The integration service validates the audience and the scope of every token.
Research's own services do not check either today; the integration service
is the place a token issued to Studio is told apart from one issued to
Research's web client.

### 2. A Research environment is a Research project

An environment (ADR-0043 §1) gets a `kind`: `kubernetes`, as today, or
`research`. A Research environment names its connection and a **Research
project** that the connection's user owns or collaborates on. One Studio
project deploys into that Research project as one application per
environment (`{project}-{environment}`), created on the first deploy.

The hardware a service may use is one of the Research project's hardware
configurations, chosen per application in the environment's binding, and
offered as the integration service lists them for that user. The trial mode
is Research's: a trial user gets trial configurations and Research's trial
limits, and their applications end when Research ends them. Studio shows what
the integration service says about it.

The registry, the namespace and the public address are Research's, not the
environment's: a Research environment has no registry or namespace pattern to
fill in.

### 3. Studio prepares, Research compiles

**Build in Studio** to a Research environment runs ADR-0048 §9's `prepare`
step on the Studio server as a background run: clone the product's
repository and its gears, `gearbox generate`, make the tree buildable. That
generates; it does not compile (ADR-0043). The prepared tree is packed as an
archive and sent to the integration service with the paths of the generated
Dockerfiles. Research builds each image with its own builder, on its own
nodes, and pushes it to its own registry. The build's record (ADR-0045) is
`where: research`, with the images by Research's reference, the step and the
last lines of a failure, as for any build.

Images built by CI or the desktop into the organization's registry
(ADR-0048 §4, §5) may run in Research once the integration service accepts an
image by reference with a pull credential. Until then, a Research environment
deploys only builds made in Research.

### 4. A deploy is an application of services

**Deploy** to a Research environment takes a build, renders the product's
chart (`helm template`, the same chart and the same values ADR-0048 would
install) and gives the integration service what Research can run:

- each Deployment as a **service**: its image, ports and which of them are
  public (from the chart's ingress), environment variables, volumes, replicas,
  and the hardware configuration of the binding;
- configuration secrets (ADR-0048 §7) as secret variables, which the
  integration service keeps in Research's secret store and never echoes back;
- a `namespace`-mode database (ADR-0048 §7) as one more service, a Postgres
  with a volume and no public port, with the databases created by the
  integration service's start hook or by the product's own migration.

A deploy replaces the application's services with the new set, as `helm
upgrade` would. Status reads the services' state and their public addresses
back. Rollback deploys an earlier record again; uninstall removes the
application. A chart object with no service equivalent (a CronJob, a
StatefulSet other than the database, a custom resource) refuses the deploy
and names the object, rather than dropping it silently.

Public addresses are Research's, and Research does not authenticate requests
to an application's public port: a product is reachable by anyone with its
address, and protects itself as it would on the internet.

### 5. Who owns what runs

Research has no team or service account, so every application has a person as
its owner. Studio says so instead of hiding it:

- **Phase one: a member's own Research.** A Research environment is held by a
  member through their personal connection, as ADR-0043 §5 allows a member's
  own cluster. The deploy runs with the member's token, refreshed from the
  stored refresh token. Its record says "in X's Research". When the member
  revokes the connection or leaves, the application stops being Studio's to
  change; Research keeps or ends it by its own rules.
- **Phase two: an organization's Research.** An environment held by the
  organization, as ADR-0043 requires of shared environments. It needs Research
  to own an application by its tenant, not a person, and a credential the
  integration service issues to an organization (a client of the identity
  provider bound to one tenant, revocable from Research). Studio does not
  accept the act-as-any-user path Research's own services use.

### 6. What the integration service provides

This is the contract the Research team is asked to build. Every call is
authorized with a bearer token from the identity provider whose audience is
the integration service; answers are JSON; errors carry a stable code and a
message. Long operations answer at once with an id and are read back.

| Call | Purpose |
|---|---|
| `GET /me` | the caller: Research user id, tenant, trial or not |
| `GET /projects` | the Research projects the caller owns or collaborates on |
| `GET /projects/{p}/hardware` | the hardware configurations the caller may use there |
| `POST /projects/{p}/builds` | a build: the context archive (or an upload URL), Dockerfile paths and image names; answers a build id |
| `GET /builds/{b}` | state, per-image reference and digest, the failing step and its last lines |
| `PUT /projects/{p}/applications/{name}` | create or replace an application: its services, ports, variables, secret variables, volumes, replicas, hardware; idempotent; answers a revision |
| `GET /projects/{p}/applications/{name}` | state per service, public addresses, the revision running |
| `GET …/applications/{name}/services/{s}/logs` | recent log lines of a service |
| `DELETE /projects/{p}/applications/{name}` | remove it, volumes kept unless asked |
| a webhook or an event stream | a build or an application changed state; a trial or a limit is about to end |

Later, for phase two and for images from elsewhere:

- a service may name an image by reference outside Research's registry, with
  a pull credential the integration service keeps;
- an application may be owned by a tenant, and a tenant may hold a credential
  of its own for the integration service.

From the identity provider: a client `constructor-studio` with Studio's
redirect URIs, `offline_access`, and a scope whose audience is the
integration service.

## Consequences

- Good: a member with Research and no cluster can build and run a product from
  Studio, on hardware Research already accounts for, with an address on the
  internet.
- Good: no password is stored; the person signs in where they always do, and
  the link between the two accounts is a proof (ADR-0012).
- Good: Research keeps its isolation. Nothing outside Research reaches its
  cluster.
- Bad: a second deploy path. A chart feature with no Research equivalent
  refuses the deploy until the integration service grows it.
- Bad: phase one's environments belong to a person, against ADR-0043's rule
  for shared environments; it is labelled, and lifted by phase two.
- Bad: the connector gets an OAuth flow, with a callback, state and PKCE kept
  between two requests, and refresh-token renewal.
- Bad: a build to Research generates on the Studio server and uploads the
  tree; a large product's context is a large upload.

## More Information

**Phases:**

1. **The connection.** The identity provider's client; the connector's OAuth
   flow; the `research` plugin; a personal connection that lists the
   member's Research projects and hardware. *Needs: the client, `/me`,
   `/projects`, `/hardware`.*
2. **Deploy to a member's Research.** `kind: research` on an environment, a
   personal one; build through the integration service; deploy as an
   application; status, logs, rollback, uninstall. *Needs: builds,
   applications, logs, events.*
3. **An organization's Research.** Tenant-owned applications and a tenant
   credential; images from the organization's registry. *Needs: Research to
   model both.*

**Open questions for the Research team:**

- Where does a build's context go: an upload the service unpacks into a build
  volume, or a branch in the project's repository?
- Can a service take a secret variable kept outside the project's files?
- What owns an application when its owner leaves or their trial ends, and
  what happens to it?
- Can an application belong to a tenant (phase two), and what would identify
  the tenant's credential?
- Which hardware does a trial user get, and how long does an application of
  theirs live?

## Traceability

- **PRD**: [PRD](../prd/constructor-studio.md)
- **DESIGN**: [DESIGN](../design/studio-connector.md)

This decision directly addresses the following requirements or design elements:

* `cpt-studio-fr-connections`
* `cpt-studio-component-connector`
* `cpt-studio-adr-deployment-environments`
* `cpt-studio-adr-self-service-identity-resolution`
* `cpt-studio-nfr-credential-isolation`
