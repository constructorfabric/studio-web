---
type: adr
status: proposed
date: 2026-11-04
---

# ADR-0064: A product's infra services are catalogue components, deployed with it

**ID**: `cpt-studio-adr-infra-services`

Status: **proposed** · Date: 2026-11-04 · Amends `cpt-studio-adr-component-passports` (ADR-0061 §2: `service.gdl` gains `kind = "infra"`) · Amends `cpt-studio-adr-product-images` (ADR-0048 §7: the product's database server runs its infra service's imported image) · Uses `cpt-studio-adr-build-deploy-boundaries` (ADR-0062 §2, §4, §9)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. An infra service is a `service.gdl` with `kind = "infra"`](#1-an-infra-service-is-a-servicegdl-with-kind--infra)
  - [2. What it provides binds to what the gears read](#2-what-it-provides-binds-to-what-the-gears-read)
  - [3. Placement: with the product, or the organization's shared place](#3-placement-with-the-product-or-the-organizations-shared-place)
  - [4. Images and charts come from the project's own path](#4-images-and-charts-come-from-the-projects-own-path)
  - [5. Install: a ready chart, or one generated from the passport](#5-install-a-ready-chart-or-one-generated-from-the-passport)
  - [6. The plan says it before the deploy](#6-the-plan-says-it-before-the-deploy)
  - [Amendment 2026-11-05 — files, and an address that answers](#amendment-2026-11-05--files-and-an-address-that-answers)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

The product map has an Infrastructure lane: what the gears need running beside
them, derived by the engine from the gears (`product::gearbox::infrastructure`:
PostgreSQL for every gear that keeps data, an OIDC issuer for
`oidc-authn-plugin`, Keycloak, ClickHouse, TimescaleDB for their plugins). The
lane said what was needed and nothing could deploy it. Only the database had a
path: a deploy made a Postgres in the product's namespace from a fixed image
(ADR-0048 §7).

The 2026-11-04 deploy of Studioweb showed the cost. The product had no
identity provider of its own, so its first configuration pointed at Studio's
own realm, which mixes the platform and a project inside it (ADR-0062 §9). A
realm in the shared Keycloak could not be made either. The product needs its
own Keycloak, deployed with it.

The user's decisions of 2026-11-04:

1. An infra service is a catalogue component, described by `service.gdl` with
   `kind = "infra"`: a third-party image, ports and health, what it provides
   (`oidc.issuer`, `database.url`), config and secrets.
2. What it provides binds to the gears' requirements; at deploy Studio fills
   the gears' configuration and writes the secrets.
3. In dev the product's Keycloak and database run with the product, one
   instance per environment. In prod the environment chooses: with the
   product, or a shared place of the organization.
4. A project imports an external image into its own path in the
   organization's registry, by digest, with provenance. Deploys use only
   images in the organization's registry.
5. A ready chart (Bitnami, itself imported) installs it when one exists;
   otherwise Studio generates a minimal chart from `service.gdl`.

## Considered Options

1. **Infra services as passports, bound by capability, installed beside the
   product as releases of their own** (this ADR).
2. **Infra services as subcharts of the product's generated chart.** Gearbox
   would have to learn every service, and a product's release would own the
   database's volume: an uninstall or a failed upgrade would touch the data.
3. **Infra services managed outside Studio** (operators, the organization's
   platform team). This is what a shared place is; making it the only way
   leaves a dev environment without a product IdP of its own, which is the
   problem.

## Decision Outcome

Chosen option: **1**.

### 1. An infra service is a `service.gdl` with `kind = "infra"`

```text
gdl_version = "1.6"

service(
    name = "keycloak",
    kind = "infra",
    version = "26.0.7",
    image = "quay.io/keycloak/keycloak:26.0.7",   # its publisher's, with a tag or digest
    args = ["start-dev"],
    ports = {"http": 8080, "management": 9000},
    health = "/health/ready",
    config = {"KC_HEALTH_ENABLED": "true", "KC_BOOTSTRAP_ADMIN_USERNAME": "admin"},
    secrets = ["KC_BOOTSTRAP_ADMIN_PASSWORD"],     # Studio makes and keeps them
    provides = {
        "oidc.issuer": "{public_url}/realms/product",
        "keycloak.admin_url": "http://{host}:{port.http}",
    },
    stateful = False,                              # True: a volume, storage, data_path
    chart = "oci://registry-1.docker.io/bitnamicharts/keycloak",
    chart_version = "24.4.0",
)
```

- `kind` is `own` (the default: ADR-0061's own service) or `infra`. An infra
  service is pulled, never built: `dockerfile` and `context` are refused. It
  names an `image`, a `chart`, or both.
- `config` holds literal variables. `secrets` lists variables whose values
  Studio makes once per project and environment and keeps in credstore
  (`INFRA_<SERVICE>_<KEY>` under the release's configuration-secret
  reference). A variable is in one or the other.
- `provides` is a dict of capability to template. A template knows `{host}`
  (the Service's name, the passport's `name`), `{namespace}`, `{public_url}`
  (the project's address for it, else `http://{host}:<http port>`),
  `{port.<name>}`, `{config.<KEY>}` and `{secret.<KEY>}`, and every name it
  uses must be declared by the passport. A list of keys is read too: their
  values come from a shared place or the project.
- `stateful = True` needs `data_path`; `storage` defaults to `10Gi`.
- The catalogue keeps these on the service node under `infra`, with
  `service_kind`. This repository carries two: `infra/postgresql/service.gdl`
  and `infra/keycloak/service.gdl`.

### 2. What it provides binds to what the gears read

A capability reaches the product as an environment variable named after it:
`oidc.issuer` is `OIDC_ISSUER`, `database.url` is `DATABASE_URL`. A gear's
configuration reads it the way it already reads secrets, `${OIDC_ISSUER}`.
At deploy the run resolves each template and keeps the value in credstore as
one of the release's configuration secrets. The chart then gives it to every
application (`existingSecret`/`secretKeys`, ADR-0048 §7), so no new channel
into a generated chart is needed.

A project's infra services are a list on the project
(`GET`/`PUT /infra-services?project_id=`). No two of them may provide the
same capability.

> Amended by ADR-0065 ([a product's infra services are said by its description and placed by the environment](0065-a-products-infra-services-are-said-by-its-description-and-placed-by-the-environment.md)): which services the product runs, their image and their configuration are `product(infra = [use_service(...)])` in `product.gdl`, and a deploy runs the services its build's lock resolved. The list keeps the environment's side: the copy of the image, a ready chart and its values, the public address. The engine's needs bind to capabilities: `postgres` to
`postgres`, `oidc` to `oidc.issuer`, `keycloak` to `keycloak.admin_url`,
`clickhouse` to `clickhouse.url`, `timescaledb` to `timescaledb.url`. The
product map shows each need with the service that meets it, or the catalogue
service that would.

**The product's own IdP.** With Keycloak placed with the product, the issuer
the product reads is its own Keycloak's. `PRODUCT_USES_PLATFORM_IDP`
(ADR-0062 §9) compares the rendered issuer with Studio's, so it passes. Its
build-plan warning about an issuer that does not answer yet is expected: the
IdP comes with the deploy.

### 3. Placement: with the product, or the organization's shared place

An environment says where infra services run (`infra` on the environment):

- `with_product` (the default): in the product's namespace, one of each per
  environment, installed with every deploy.
- `shared`: the organization runs them, and Studio installs nothing. The
  environment names each shared service and what it provides
  (`{service, namespace, provides}`). Those values are not secret; a password
  a shared place needs is set as a configuration secret of the project.

An environment checked as a development one (ADR-0060 §5, strictness `dev`)
may not choose `shared`: in dev, the product's Keycloak and database run with
it. A deploy to a `shared` environment whose place names no entry for one of
the project's services is refused with `INFRA_NOT_IN_SHARED_PLACE`.

### 4. Images and charts come from the project's own path

The passport's image is its publisher's. Before a deploy runs it, the project
imports it (`POST /images/imports`, ADR-0062 §4, `kind: image` or `chart`)
into `{prefix}/{project-slug}/mirror/<name>`, copied by digest, with the
source, digest, who and when recorded. The project's service then names the
copy (`image`, and for a ready chart `chart_ref` and `chart_version`).

A deploy refuses a service that names no copy (`INFRA_IMAGE_NOT_IMPORTED`)
or one outside the project's path (`IMAGE_NOT_IN_PROJECT_PATH`). An
environment without a registry takes images as named.

### 5. Install: a ready chart, or one generated from the passport

Before the product's release, the run brings each service:

- **database**: a service that provides `postgres` is the product's database
  server. The existing database step (ADR-0048 §7) makes it, now with the
  service's imported image instead of the environment's fixed one. It wires
  the gears to the server itself, so its other capabilities are not written
  as variables.
- **chart**: `helm upgrade --install <service> <chart_ref> --version …`, with
  the project's `chart_values` (strings filled as templates, `{secret.KEY}`
  among them) and `fullnameOverride: <service>`, so `{host}` holds.
- **generated**: Studio writes a chart from the passport and installs it as
  the release `<service>`. It holds a Deployment, or a StatefulSet with a
  volume claim when the service keeps data, a Service for its ports, and a
  Secret with what Studio made for it. The probes use `health` on the
  `management` port, else `http`; without a route, a TCP probe on the first
  port. The files are rendered manifests, not templates, so a `config` value
  or an argument may not contain `{{`.
- **shared**: nothing is installed; the place's values are written.

Each service is its own Helm release in the product's namespace. Uninstalling
the product leaves them, and a StatefulSet's volume claim outlives an
uninstall of the service too.

### 6. The plan says it before the deploy

`GET /environments/{id}/infra-plan?project_id=` answers, for each service:
how it comes, from which image or chart, the variables it gives, and the code
a deploy would be refused with now. The deploy screen shows it beside each
environment. The environment form has the placement.

### Amendment 2026-11-05 — files, and an address that answers

A product's own Keycloak came up with no realm, and its issuer named
`http://keycloak:8080` -- an address only the cluster reaches -- so sign-in
broke after a deploy that succeeded. Two changes, both passport-agnostic.

- **Files.** A service's record (the environment side, ADR-0065 §3) may carry
  `files`: absolute path in the container → text, at most 20 files and
  256 KiB together, no `.`/`..` names. The text may say the `provides`
  template names (`{secret.KEY}`, `{host}`, `{public_url}`, `{namespace}`,
  `{port.x}`, `{config.K}`), each checked against the passport; any other
  brace is the file's own, so a JSON document needs no escaping. `args` are
  appended to the passport's. The generated chart keeps the files in a
  ConfigMap -- a Secret when one says `{secret.*}` -- mounts each read-only
  by `subPath` at its path, and puts their sha-256 on the pod
  (`studio.constructor.tech/files-sha256`) so a change restarts it. A ready
  chart, the database step and a shared place do not apply them: the plan
  says so in its `notes`. For Keycloak: a realm JSON at
  `/opt/keycloak/data/import/<realm>.json` and `--import-realm`; the
  prototype writes one from the passport's issuer path, with a public client
  for the portal and a confidential one whose secret is
  `{secret.OIDC_CLIENT_SECRET}`, which the passport now declares and
  provides as `oidc.client_secret`.
- **`{public_url}` is never the cluster's address.** When a capability or a
  file of a service Studio installs (`generated` or `chart`) says
  `{public_url}` and the project gives none, the plan and the deploy refuse
  with `INFRA_PUBLIC_URL_MISSING`, naming what to set. With a `public_url`,
  a generated chart carries an Ingress for the service's http port at that
  host and path: TLS for `https://` with the placement's `ingress.tls_secret`
  (else the controller's default certificate), its `ingress.annotations`,
  and its `ingress.class`, else the environment's preview class. The plan's
  `route` says the address. A ready chart routes itself through its values.

This supersedes the Consequences' "a realm is not made" and "no Ingress for
an infra service is made yet". Traceability: `infra.rs` `InfraIngress`,
`check_ingress`, `files`, `PUBLIC_URL_MISSING`, `infra_ingress`,
`FILES_HASH_ANNOTATION`; `rest_infra.rs` `InfraIngressDto`; the prototype's
`keycloakRealm`, `withKeycloakRealm`, `FilesEditor`.

## Consequences

- Good: Studioweb in dev gets its own Keycloak, so its deploy no longer leans
  on Studio's IdP.
- Good: the database follows the same rule as any other service: an imported
  image, recorded, in the project's path.
- Good: the generated chart needs no Gearbox change.
- Bad: a product's gears must read capabilities as `${VARIABLE}` in their
  configuration. Platform gears whose configuration cannot be written that way
  (an issuer inside a list) need the value in the product's description.
- Bad: a realm is not made. The Keycloak passport provides the issuer of realm
  `product`, and the product creates or imports it.
- Bad: a ready chart's own images are whatever its values say. Pointing them at
  the project's path is the project's `chart_values`; Studio does not rewrite
  them.
- Neutral: an issuer's public address is the project's `public_url`. No
  Ingress for an infra service is made yet.

## More Information

- ADR-0061: component passports; `service.gdl` vocabulary.
- ADR-0062: imports (§4), the project's path (§2), the platform-IdP refusal
  (§9).
- ADR-0048 §7: the product's database in its namespace.

## Traceability

- `studio-backend/src/components_catalog/service_gdl.rs`: `Infra`,
  `TemplateRef`, `template_refs`, `variable`, `read_infra`.
- `studio-backend/src/components_catalog/repo_enrich.rs`: `infra` and
  `service_kind` on the service node.
- `studio-backend/src/environments/infra.rs`: `InfraPlacement`,
  `check_placement`, `InfraService`, `checked_services`, `plan`, `installs`,
  `produced_variables`, `database_image`, `resolve`, `provided_values`,
  `chart_values`, `generated_chart`.
- `studio-backend/src/environments/infra_install.rs`: `bring` (secrets,
  values, helm installs).
- `studio-backend/src/environments/service_infra.rs`, `rest_infra.rs`: the
  routes; `service.rs` `project_config`, `request_deploy` (`check_infra`).
- `studio-backend/src/api_contract/schema_names.rs`: a test that no two
  schema types share a name across the crate and the locked `cf-*` crates.
- `infra/postgresql/service.gdl`, `infra/keycloak/service.gdl`.
- `studio-frontend-prototype/src/infra-services.ts`,
  `infra-services-view.tsx` (`InfraLane`, `InfraPlacementField`,
  `InfraPlanView`).
