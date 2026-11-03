---
type: adr
status: proposed
date: 2026-10-23
---

# ADR-0049: Constructor Research builds and runs a product as one of its applications, reached through a connection and Research's public API

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
  - [6. What Studio calls in Research](#6-what-studio-calls-in-research)
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

This record first asked the Research team for an integration service of
Studio's own. There will be none: Research opens its public API instead --
the routes its web client calls, which an `rk-` access key may call too.
This record says how Studio builds and runs a product through it.

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
  kept in its database. Tokens last an hour.
  Tokens carry the tenant (`tid`). Many people have no password at all.

## Considered Options

1. **Research hands out namespaces.** Research gives Studio a
   namespace and short-lived Kubernetes credentials, and Studio builds and
   deploys exactly as ADR-0048 does.
2. **Research runs Studio's products as its own applications.** Studio
   puts the build context in the project's files, has Research build the
   images there, and creates the application's services through Research's
   public API. Studio translates its chart into those services.
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
builds, runs, meters and exposes, through the API Research already has.

The cost is a second deploy path beside ADR-0048's Helm install. It is kept
narrow: Studio renders the same chart and hands over what it contains (§4),
so the product, its configuration and its build stay one.

### 1. Research is a connection, and it signs in with OAuth

A new connection kind, `research`, a plugin gear like every provider
(`cpt-studio-principle-connector-provider-is-plugin`). It is not created by
pasting a credential. **Connect Constructor Research** sends the person to the
identity provider with authorization code and PKCE, as a confidential client
`constructor-studio` registered there (authenticated with a client secret;
the identity provider's client configuration has no `private_key_jwt`),
asking for `openid profile user platform`. The sign-in is used once: with
the identity provider's token, the callback makes the member an `rk-` access
key (`POST /access-keys`, named `studio`, with an `expires_at` 90 days out)
and stores the key and its id in credstore; the connection keeps only its
reference (`cpt-studio-principle-credentials-by-reference`). Every call sends
the key as `X-Research-AccessKey: Bearer rk-…`, and Research limits a key to
the routes §6 lists. When the key runs out, Research answers 401 and the
member is asked to sign in again. A connection made before the keys stored a
refresh token and still trades it for an access token on each use.

Its test calls Research's `GET /auth/session`. The connection's `account` is
the Research user's id and its tenant. A `personal` connection that passed the
test proves its creator controls that Research account (ADR-0012), so the link
between a Studio person and a Research user needs no mechanism of its own.

The connector gains a second way to create a connection, `oauth_start` and
`oauth_callback`, beside the pasted credential. Research is the first provider
to use it; a GitHub App or a GitLab OAuth application could use it later.

Research does not check an identity provider token's audience or scope, so
such a token issued to Studio could call any route the member can; a key
cannot. That, and Research's own guidance for the connector (2026-10-29), is
why the key is kept, not a refresh token.

Disconnecting does not delete the key: `DELETE /access-keys/{id}` takes an
identity provider token, not a key, and Research has no screen for keys yet.
The key stays usable until its `expires_at`.

*Considered, first chosen, then replaced:* keep the refresh token
(`offline_access`) and trade it for an access token on every call. Research
does not need refresh tokens from this client, and a token from it is not
limited to the allowed routes.

### 2. A Research environment is a Research project

An environment (ADR-0043 §1) gets a `kind`: `kubernetes`, as today, or
`research`. A Research environment names its connection and a **Research
project** that the connection's user owns or collaborates on. One Studio
project deploys into that Research project as one application per
environment (`{project}-{environment}`), created on the first deploy.

The hardware a service may use is one of the Research project's hardware
configurations, chosen per application in the environment's binding, and
offered as Research lists them for that user. The trial mode
is Research's: a trial user gets trial configurations and Research's trial
limits, and their applications end when Research ends them. Studio shows what
Research says about it. With no hardware chosen, a service runs on the
smallest configuration without a GPU.

The registry, the namespace and the public address are Research's, not the
environment's: a Research environment has no registry or namespace pattern to
fill in.

### 3. Studio prepares, Research compiles

**Build in Studio** to a Research environment runs ADR-0048 §9's `prepare`
step on the Studio server as a background run: clone the product's
repository and its gears, `gearbox generate`, make the tree buildable. That
generates; it does not compile (ADR-0043). Research has no upload: Studio
starts a desk of the Research project (its own `studio` desk, or the
project's one desk), writes the prepared tree into its files over WebDAV
(`studio-build/<build>/`, kept out of the project's git and removed after),
and asks Research for one image per generated Dockerfile. Research builds
each with its own builder, on its own nodes, into its own registry; Studio
polls, then stops the desk if it started it. The build's record (ADR-0045)
is `where: research`, with each image by Research's id, the step and the
last lines of a failure (from Research's build log, while it has it), as for
any build.

A Research service takes no files and no command (§4), so the build renders
the chart as the deploy will and bakes into each image what the chart would
mount from a ConfigMap, its command and arguments and its scratch folders
(each generated Dockerfile gains `COPY`, `ENTRYPOINT` and `CMD` lines). The
image's reference carries a digest of that; a deploy whose chart asks for
something else refuses and asks for a new build. A database server's
Postgres is built the same way, `FROM` the environment's database image with
the script that creates its databases.

Images built by CI or the desktop into the organization's registry
(ADR-0048 §4, §5) may run in Research once Research accepts an image by
reference with a pull credential. Until then, a Research environment deploys
only builds made in Research.

### 4. A deploy is an application of services

**Deploy** to a Research environment takes a build, renders the product's
chart (`helm template`, the same chart and the same values ADR-0048 would
install) and creates in Research what it can run:

- each Deployment as a **service**: its image, ports and which of them are
  public (from the chart's ingress), environment variables, volumes, replicas,
  and the hardware configuration of the binding;
- configuration secrets (ADR-0048 §7) as **plain** environment variables:
  Research's public API has no secret variables and returns a service's
  variables as they are. The deploy says so in its progress and its outcome;
- a `namespace`-mode database (ADR-0048 §7) as one more service, a Postgres
  with a volume and no public port, its databases created by the script
  baked into its image (§3);
- another service's address as Research's: Research reaches a service at
  `svc-<name>`, and an address in a variable or a YAML file is rewritten.

A deploy makes the application's services exactly the new set, as `helm
upgrade` would: it creates the application if need be, creates or changes
each service (a volume of the same name keeps its data) and restarts it,
removes the services the product no longer has, and waits for all to run.
Research runs one replica of a service and has no health check of Studio's. Status reads the services' state and their public addresses
back. Rollback deploys an earlier record again; uninstall removes the
application. A chart object with no service equivalent (a CronJob, a
StatefulSet other than the database, a Secret mounted as files, a sidecar,
a custom resource) refuses the deploy and names the object, rather than
dropping it silently.

Public addresses are Research's, and Research does not authenticate requests
to an application's public port: a product is reachable by anyone with its
address, and protects itself as it would on the internet.

### 5. Who owns what runs

Research has no team or service account, so every application has a person as
its owner. Studio says so instead of hiding it:

- **Every member runs with their own sign-in.** A Research environment names
  a Research project. Each build, deploy, status or test runs with the
  connection of the member who asks: their personal sign-in, whose access key
  is theirs alone. Nobody's run reads another member's sign-in. The connection
  the environment was created with only lists the projects to pick from. A
  member without a sign-in is told to sign in. One who is not in the project
  is told its owner adds them in Research.
- **The project is what is shared.** Research shares a project by adding its
  members, and checks an application against the project, not against its
  owner. So members of one Studio organization deploy to the same project,
  each as themselves. An application still records the member who created it
  as its owner. When that member leaves, Research keeps or ends it by its own
  rules.
- **No organization credential.** Studio does not ask Research for a
  credential bound to a tenant, and it does not accept the act-as-any-user
  path Research's own services use. A shared project and personal sign-ins
  cover what an organization needs. (Decided 2026-11-03. This replaces the
  "phase two: an organization's Research" this section used to plan.)

### 6. What Studio calls in Research

Research's own public API, with the member's access key. The connection's
address is the account API, `https://<stand>/api/platform-account/v1`; the
desk's files (`/api/platform-storage`) and the logs (`/api/platform-keeper`)
are on the same origin and take the same key. Answers are JSON; a refusal
is `{"detail": {"msg", "error_code"}}`, and its `msg` is what the person
sees. Nothing answers with an event: Studio polls.

| Call | Purpose |
|---|---|
| `GET /auth/session` | the connection's test: the member's id, name and email |
| `GET /projects` | the projects the member owns or collaborates on |
| `GET`, `PATCH /projects/{p}` | `deployment_enabled`, turned on before a deploy |
| `GET /projects/{p}/hardware-configurations` | the hardware a project's services may use, trial or not |
| `GET`, `POST /projects/{p}/desks` | the desk a build uses |
| `GET /desks/{d}`, `POST`/`DELETE /desks/{d}/filesystem` | start the desk, wait for `running`, stop it |
| `MKCOL`, `PUT`, `GET`, `DELETE /api/platform-storage/desks/{d}/dav/project/…` | the prepared tree in the desk's files |
| `POST /desks/{d}/images`, `GET /images/{i}` | an image per Dockerfile, and its `build_status` |
| `GET /api/platform-keeper/image-builds/{i}/logs` | the last lines of a failed build |
| `GET`, `POST /projects/{p}/applications`, `GET`, `DELETE /applications/{a}` | the environment's application: found by name, created, read, removed |
| `POST /applications/{a}/services`, `PATCH /applications/{a}/services/{s}`, `DELETE /services/{s}` | its services, one call each |
| `POST /services/{s}/start`, `/stop`, `GET /services/{s}` | run them; `status` and the public `link` |

What Research's API cannot do today, and what Studio does instead:

- **secret variables**: none; a secret is a plain variable, and the deploy
  says so;
- **files and a command for a service**: none; baked into the image at build
  (§3);
- **an upload**: none; the desk's files;
- **events**: none; polling;
- **service logs**: a live stream only (`/api/platform-keeper/services/{s}/
  logs`), of the current container, with no history: Studio reads its last
  lines when a deploy finds a service failed or not answering.

How Research builds, as Research's own deployment MCP
(`constructor-research-mcp`) found on live runs, and Studio does the same:

- a Dockerfile is named `Dockerfile` or `<name>.dockerfile`; Studio writes
  `studio-<app>.dockerfile`;
- a build started right after its files were uploaded does not see them:
  Studio waits 30 s after the upload;
- `build_status` reads `error` for a moment while Research retries a build
  itself: an error counts once seen twice for the same image, and a confirmed
  one is built once more, as `<name>-r2`, before the build fails;
- a project's deployments are off until `deployment_enabled` is turned on,
  and Research's UI shows its applications only then: Studio turns it on;
- Research starts only a stopped or failed service, and its restart of a
  running one stops it and starts it at once, before it has stopped. Studio
  changes a running service stopped: stop, wait, `PATCH`, start;
- `running` is not ready: after a deploy Studio asks each public link for a
  minute (any answer below 500 counts), and follows every service's log for
  that minute. Research keeps no log of a replaced container, and each
  connection replays the current one: a connection that begins with another
  first line, or "Container is waiting to start" after the container's own
  lines, is a restart. The deploy still succeeds; its result names each
  service that restarted, with what the container before printed, and each
  that did not answer, with its last lines or, when it printed nothing, the
  usual reasons a container exits at once.

Later, for images from elsewhere and for what a chart may hold: a service
that names an image outside Research's registry with a pull credential;
secret variables; a command, init containers and scheduled jobs.

From the identity provider: a client `constructor-studio` with Studio's
redirect URIs, a client secret and the scopes `openid profile user platform`.
From Research: `POST /access-keys` on the account API's root
(`/api/platform-account/access-keys`), which takes the identity provider's
token.

## Consequences

- Good: a member with Research and no cluster can build and run a product from
  Studio, on hardware Research already accounts for, with an address on the
  internet.
- Good: no password is stored; the person signs in where they always do, and
  the link between the two accounts is a proof (ADR-0012).
- Good: Research keeps its isolation. Nothing outside Research reaches its
  cluster.
- Bad: a second deploy path. A chart feature with no Research equivalent
  refuses the deploy until Research's API grows it.
- Bad: configuration secrets are plain variables in Research, visible to
  whoever can open the service, until Research has secret variables.
- Bad: what a chart mounts is baked into the image, so a change to it needs a
  new build, not only a new deploy.
- Bad: what an organization deploys to Research runs on its members' personal
  sign-ins. A member who leaves keeps owning the applications they created,
  and Research, not Studio, decides what happens to them.
- Bad: the connector gets an OAuth flow, with a callback, state and PKCE kept
  between two requests.
- Bad: a key outlives a disconnect until its `expires_at`, and a member signs
  in again every 90 days.
- Bad: a build to Research generates on the Studio server and writes the
  tree into a desk file by file; a large product's context is a large upload,
  and the build starts (and stops) a desk.

## More Information

**Phases:**

1. **The connection.** The identity provider's client; the connector's OAuth
   flow; the `research` plugin; a personal connection that lists the
   member's Research projects and hardware. *Needs: the client,
   `/auth/session`, `/projects`, `/hardware-configurations`.*
2. **Deploy to a Research project.** `kind: research` on an environment; build
   in a desk; deploy as an application; status, rollback and uninstall, each
   with the requesting member's own sign-in (§5). *Needs: desks and their
   files, images, applications and services.*

**Open questions for the Research team:**

- Can a service take a secret variable kept outside the project's files,
  and files or a command of its own?
- What owns an application when its owner leaves or their trial ends, and
  what happens to it?
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
