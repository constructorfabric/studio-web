---
type: adr
status: proposed
date: 2026-11-04
---

# ADR-0062: A project's build, its images and its namespaces are its own, not the platform's

**ID**: `cpt-studio-adr-build-deploy-boundaries`

Status: **proposed** · Date: 2026-11-04 · Amends `cpt-studio-adr-deployment-environments` (ADR-0043: namespaces and the bootstrap) · Amends `cpt-studio-adr-product-images` (ADR-0048: the builder image, registry paths and credentials) · Amends `cpt-studio-adr-project-environments` (ADR-0054: where a project's own environment's namespace comes from) · Amends `cpt-studio-adr-previews` (ADR-0055: a preview's namespace is named from the recorded one) · Uses `cpt-studio-adr-build-deploy-readiness` (ADR-0059)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. A build runs in the builder image, by digest](#1-a-build-runs-in-the-builder-image-by-digest)
  - [2. Push and pull are two identities, and a project has one path](#2-push-and-pull-are-two-identities-and-a-project-has-one-path)
  - [3. A project's namespace is recorded, named from its slug](#3-a-projects-namespace-is-recorded-named-from-its-slug)
  - [4. Images are records, in a project's context](#4-images-are-records-in-a-projects-context)
  - [5. The organization's registries, as they are](#5-the-organizations-registries-as-they-are)
  - [6. A cluster says how far it is bootstrapped](#6-a-cluster-says-how-far-it-is-bootstrapped)
  - [7. Builds run in a namespace of their own](#7-builds-run-in-a-namespace-of-their-own)
  - [8. A build says what it will do before it starts](#8-a-build-says-what-it-will-do-before-it-starts)
  - [9. A product signs in with an IdP of its own](#9-a-product-signs-in-with-an-idp-of-its-own)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

On 2026-11-04 the project Studioweb (Studio rebuilt on gears, inside Studio) was built and deployed from the local stand. A project inside Studio must not lean on the Studio platform's own resources, and another project must be able to deploy the same way. The run found these places where the two were mixed:

- **The builder was the server.** `prepare` and `publish` ran in `STUDIO_BUILDER_IMAGE`, else the server's own `studio-backend:sha-<commit>`. A project's build changed with the version of Studio that ran it, and the image used belonged to another Studio's version. To work around it the platform's image was pushed into the project's registry.
- **One credential did everything.** The registry connection was a person's GitHub token with `admin:org` and `admin:enterprise`. Studio wrote it into the project's namespace as the pull secret, and the build pushed with it too. The cluster held a credential that could administer the organization.
- **Paths were shared.** Every project of an organization pushed to `{prefix}/{app}` and `oci://{prefix}/charts/{product}`. Two projects with an application of the same name overwrote each other, and a push token for one could reach the other's.
- **Namespaces were guessed.** The namespace was `{project}-{environment}`, computed from the project's display name on every call. A rename moved it. A cluster that gives Studio pre-made namespaces (`studio-web-dev`) instead of letting it create them could not be described, and a namespace that happened to exist was used whoever it belonged to.
- **A half-bootstrapped cluster failed late.** The bootstrap manifest was never applied to the dev cluster. Nothing told a full bootstrap from a partial one, and a build failed with a 403.
- **The build lived with the release.** The build Job, the repository token and the registry login sat in the runtime namespace.
- **The product used the platform's IdP.** The product's first configuration pointed `oidc-authn-plugin` at Studio's own realm and its `studio-portal` client.
- **Images were invisible.** Nothing said which images a project's builds had published, where each ran, or what in the organization's registry nobody accounted for.

## Considered Options

1. **Keep the server image as the builder, and pin the server.** This was rejected: the build would still change whenever Studio is upgraded.
2. **A builder image of its own, published by CI and pinned by digest, which an environment may replace with a mirror.** This was chosen.
3. **A push token scoped by wildcard (`{path}/{slug}/*`).** This was rejected: the token-service specification has no wildcard, and a registry that took it literally would refuse every push. The token is minted for the exact names instead (§2).
4. **Namespaces from the pattern, with a label check only.** This was rejected: a rename still moves them, and a cluster that gives namespaces has nothing to compute from.
5. **Image records in the graph, beside builds.** This was rejected: records are read by digest and joined with deployments, and they need their state changed by sweeps. The environments gear gets tables of its own.

## Decision Outcome

### 1. A build runs in the builder image, by digest

CI publishes the Dockerfile's `builder` target as `studio-builder` beside the backend, prints its digest, and the deploy sets `backend.builds.builderImage` to `…/studio-builder@sha256:…`. The backend passes it as `STUDIO_BUILDER_IMAGE`. `builder_for(env)` takes an environment's `builder_image` (an organization's mirror) first, then the platform's. It never takes the server's own image.

A builder that names no digest is refused before the build is queued, with `BUILDER_NOT_PINNED`. A local stand may set `STUDIO_BUILDER_ALLOW_TAG=1` (docker-compose does) to take a tag, and the server logs a warning. A builder on another registry is pulled with its own connection (`builder_registry_connection_id`), through a pull secret in the Job, never with the project's push login. The build record keeps the builder image and, when it is known before the run, the Gearbox version (`STUDIO_BUILDER_GEARBOX`). `publish` reports the version the image actually carries.

### 2. Push and pull are two identities, and a project has one path

- **Paths.** A project's images go to `{prefix}/{project-slug}/{app}` and its charts to `oci://{prefix}/{project-slug}/charts/{product}`. A deploy takes only images and charts under that path (`IMAGE_NOT_IN_PROJECT_PATH`). A member's push token (`POST /environments/{id}/push-tokens`) is issued only for names under it.
- **Push.** The build Job pushes with a token in Secret `<job>-push`. `prepare` names the images it built in its termination message, and the watch then mints a token from the registry's token service for exactly those repositories and the chart. It writes the token and a `ready` mark, and the `build` step waits for the mark. The watch renews a token that is about to lapse. A registry without a token service gets the push connection's login instead, and the log says so. The secret is deleted with `-git` when the build is recorded.
- **Pull.** An environment may name `registry_pull_connection_id`, a read-only identity. The runtime namespace's `studio-registry` secret holds only that. Without one, the push connection is used, and the environment carries the warning "the cluster gets a credential that can write".
- **Scopes.** A registry connection's test reports its token's scopes (GHCR: GitHub's `X-OAuth-Scopes`). A server build refuses a token that administers or deletes (`admin:*`, `delete:*`, `repo`, `workflow`, `write:org`…) with `REGISTRY_TOKEN_TOO_BROAD`, unless the environment sets `allow_broad_registry_token`. It refuses a personal registry connection with `REGISTRY_CONNECTION_PERSONAL`.
- **Labels.** Every image carries `org.opencontainers.image.source` (the repository's address without credentials), `.revision`, `.created`, `studio.constructor.tech/project`, `/build` and `/description-revision`, as labels and as manifest annotations.

### 3. A project's namespace is recorded, named from its slug

A project's slug is made from its name the first time it is needed, then kept: renaming the project changes neither its namespaces nor its registry path. Slugs are unique across organizations (`-2`, `-3`, … and then a piece of the id). The namespace a project gets in an environment, and its build namespace, are recorded at the first build or deploy that made or found them. Every later build, deploy, build log and preview reads the record.

A namespace found in the cluster whose `studio.constructor.tech/project` label names another project is refused with `NAMESPACE_OF_ANOTHER_PROJECT`. A found namespace without the label is used only when an administrator assigned it. An environment on a cluster that gives namespaces instead of letting Studio make them lists them (`namespaces`). An organization administrator assigns each project one with `PUT /namespace-assignments`. Until then a build or a deploy is refused with `NAMESPACE_NOT_ASSIGNED`, and the refusal lists them. Studio does not guess.

### 4. Images are records, in a project's context

The environments gear keeps a table of images and charts: `{registry, repository, tags, digest, media type, size, platforms, build, app, commit, description revision, lock hash, pushed_by, pushed_at, kind, state, pinned, promoted_from, source_ref}`. A record is written for each image and chart at publish, from the build's manifest (the chart's digest from `helm push`), and from a pipeline's `studio-build.json`. A project sees only its own records:

- `GET /images` lists them, with where each runs: the live releases whose images name its digest, or whose chart is it at one of its versions.
- Pin and unpin. A pinned image is never swept or deleted.
- `DELETE` answers 409 `IMAGE_RUNNING` or `IMAGE_PINNED`, else 202 with a run that deletes the digest through the registry's own API.
- `POST /images/{id}/promotions` copies the digest into another environment's registry, under the project's path there. The copy is server-side through the OCI API, without Docker.
- `PUT /image-retention` sets a project's policy, or the organization's default: `keep_last` per repository and `keep_days`. The daily `environments.image_sweep` deletes what is past both and runs nowhere, and marks what it must keep `retained`.
- **Imports.** A project may import an external image (Docker Hub, quay, ghcr), or a chart published as OCI, into its own path `{prefix}/{project-slug}/mirror/<name>`. `POST /images/imports` copies it by digest and records its provenance: the source reference, the digest, who imported it and when. A deploy takes only images in the organization's registry, so an external image comes in this way.

### 5. The organization's registries, as they are

`RegistryCatalog` (`connectors/registry.rs`) reads a registry the way that registry lets itself be read:

- **GHCR:** the GitHub Packages API. GHCR has no `_catalog`. It lists an organization's or a person's container packages, and the versions with their tags and digests; nested names are URL-encoded. A version is deleted by its id.
- **Harbor:** `/api/v2.0`.
- **Any other registry:** `_catalog`, `tags/list` and HEAD manifest.

The organization's routes need `environment.manage`. `GET /registries` lists the registry connections the environments use for push or pull. `…/repositories` lists each repository with the project whose path holds it, and `…/tags` lists the digests with their records and where they run. `DELETE …/versions/{digest}` is refused while the digest runs. `…/orphans` lists four kinds:

- `unowned`: under no project's path;
- `unrecorded`: under a project's path, with no record;
- `undeployed`: recorded, unpinned, and running nowhere;
- `missing`: recorded as present, but gone from the registry.

### 6. A cluster says how far it is bootstrapped

`cluster_readiness` asks the cluster three things as the connection:

- whether it holds the bootstrap manifest's rights, one SelfSubjectAccessReview each;
- whether the admission policy refuses a namespace without Studio's label, asked as a server-side dry run;
- which version the `studio.constructor.tech/bootstrap-version` label on the manifest's ClusterRole carries.

The manifest is version 2. It adds the label and the right to read that one ClusterRole. The answer is one of three:

- `bootstrapped`;
- `namespace_limited`, with the given namespaces the connection may work in;
- `partial`, with what is missing.

A build or a deploy on a partial cluster is refused before it is queued, with `CLUSTER_NOT_BOOTSTRAPPED` and everything it lacks. `GET /environments/{id}/readiness` answers the same, and the place cards show it.

### 7. Builds run in a namespace of their own

An environment's `build_namespace` (default `{project}-build`, named from the slug) holds the build Job, the repository token, the push token and the builder's pull secret. The runtime namespace holds only the pull secret. Both are made, checked and recorded by the rules of §3.

### 8. A build says what it will do before it starts

`POST /builds/plan` takes the body of `POST /builds` and answers without starting anything:

- the sources, each with its ref (or pinned commit) and the connection it is read through: label, scope and holder;
- the description revision, the strictness, the namespace and build namespace;
- the registry path and the repositories;
- the builder image, whether it is pinned, and the Gearbox version;
- warnings;
- `refusal`, the code and the reason a build would be refused with now.

The prototype shows the plan above the Build button and disables the button on a refusal.

### 9. A product signs in with an IdP of its own

A build is refused with `PRODUCT_USES_PLATFORM_IDP` when the description's OIDC issuer is Studio's own (`STUDIO_OIDC_ISSUER`), or when its client is one of Studio's own (`studio-portal`, `studio-desktop`, `studio-cli`). A deploy refuses the same in the rendered chart. When the issuer's `/.well-known/openid-configuration` does not answer, the build plan carries a warning rather than a refusal: the IdP may be deployed with the product.

## Consequences

- **Builder.** A Studio deployed without `backend.builds.builderImage` refuses every build with `BUILDER_NOT_PINNED`, until CI has published `studio-builder` and the deploy has pinned it.
- **Clusters.**
  - A cluster without the version-2 manifest is `partial`. Applying the current `bootstrap.yaml` again fixes that.
  - A cluster that only gives namespaces (such as the dev cluster's `studio-web-dev`) needs `namespaces` on the environment and an administrator's assignment.
- **Existing images and namespaces.**
  - Images published before this change sit at `{prefix}/{app}`. They are not under any project's path, so the registry browser lists them as `unowned`, and a deploy of an old build by id is refused until it is built again.
  - Namespaces named by the old pattern are recorded the first time they are used, as long as their label names the project.
- **Push token.** The token is minted only after `prepare` ends, so a build waits up to a watch round, about 20 seconds plus the kubelet's sync of the mounted Secret, before `build` starts.
- **Records and running images.** Image records need the environments gear's database (`studio_environments`, one connection per replica). Without one, the gear behaves as before, and the image routes answer 503. Where an image runs is read from the deployment history, so a release installed outside Studio does not count.

## More Information

- ADR-0043: environments and the bootstrap. Namespaces are now recorded, and the manifest is versioned.
- ADR-0048: images and a chart in the organization's registry. The paths are per project, the builder is its own image, and push and pull are separate.
- ADR-0054: a project's own environments, named by the same rules.
- ADR-0055: previews, under the recorded namespace.
- ADR-0059: causes named before a run is queued. This ADR adds `BUILDER_NOT_PINNED`, `REGISTRY_TOKEN_TOO_BROAD`, `REGISTRY_CONNECTION_PERSONAL`, `CLUSTER_NOT_BOOTSTRAPPED`, `NAMESPACE_NOT_ASSIGNED`, `NAMESPACE_OF_ANOTHER_PROJECT`, `IMAGE_NOT_IN_PROJECT_PATH` and `PRODUCT_USES_PLATFORM_IDP`.

## Traceability

- `studio-backend/src/environments/build.rs`:
  - `BuilderSpec`, `builder_for`, `builder_from`, `is_pinned`;
  - `push_secret_name`, `builder_secret_name`, `Named`, `push_names`, `give_push_token`;
  - `image_labels`, `source_url`, `pushed_digest`, and `BUILD_SCRIPT`'s wait and labels.
- `studio-backend/src/environments/placement.rs`: `Place`, `place_of`, `owner_refusal`, `record`.
- `studio-backend/src/environments/records.rs` and `migrations.rs`: slugs, namespace assignments, image records, retention.
- `studio-backend/src/environments/images.rs`: `Reference`, `project_prefix`, `from_manifest`, `sweep`, `orphans`, `live_deployments`, `runs`.
- `studio-backend/src/environments/image_tasks.rs`: `environments.images` (delete, copy) and `environments.image_sweep`.
- `studio-backend/src/environments/service_images.rs`, `rest_images.rs`: the routes of §4, §5 and §8, and the namespace assignments.
- `studio-backend/src/environments/readiness.rs`: `bootstrap_refusal`, `token_refusal`. `service.rs`: `check_cluster_ready`, `place`, `slug`, `request_build` (with `dry_run`).
- `studio-backend/src/environments/preflight.rs`: `oidc_settings`, `platform_idp_refusal`, `unreachable_issuers`.
- `studio-backend/src/environments/model.rs`: `Boundaries`, `project_image`, `check_chart_in_project`, `Environment::pull_connection`, `warnings`, `build_namespace_for`.
- `studio-backend/src/connectors/registry.rs`, `registry_oci.rs`: `RegistryCatalog`, `Oci`, `token_scopes`, `too_broad`, `docker_config_with_token`.
- `studio-backend/src/connectors/kubernetes.rs`: `cluster_readiness`, `readiness_of`, `BOOTSTRAP_VERSION`.
- `deploy/k8s/studio-environments/bootstrap.yaml` (version 2); `.github/workflows/studio-delivery.yml` (`studio-builder`); `deploy/helm/studio-web` (`backend.builds.builderImage`).
- `studio-frontend-prototype/src/images.ts`, `project-images.tsx`, `registry-browser.ts`, `registry-browser-view.tsx`, `build-plan.ts`, and the readiness badge in `environments-screen.tsx`.
- `studio-frontend-prototype/src/namespace-assignments.ts`, `namespace-assignments-view.tsx`: Infrastructure's Namespaces tab, which lists and assigns the namespaces of §3 (`GET`/`PUT /namespace-assignments`), and its Image retention tab, the organization's default of §4 (`/image-retention?organization_id=`), which shares `RetentionForm` with the project's Images.

> Amended by ADR-0064 ([a product's infra services are catalogue components, deployed with it](0064-a-products-infra-services-are-catalogue-components-deployed-with-it.md)): an infra service's image and ready chart are imported into the project's path like any external image (section 4); a deploy refuses one not imported (`INFRA_IMAGE_NOT_IMPORTED`). With Keycloak placed with the product, the issuer the product reads is its own, so `PRODUCT_USES_PLATFORM_IDP` (section 9) passes.
