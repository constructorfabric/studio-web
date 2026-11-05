---
type: adr
status: proposed
date: 2026-11-05
---

# ADR-0065: A product's infra services are said by its description and placed by the environment

**ID**: `cpt-studio-adr-infra-in-description`

Status: **proposed** · Date: 2026-11-05 · Amends `cpt-studio-adr-infra-services` (ADR-0064 §2: the services come from `product.gdl`, not a list on the project; §4: the import is checked against the image the description chose) · Uses `cpt-studio-adr-build-deploy-boundaries` (ADR-0062 §4)

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. What the product runs is in `product.gdl`](#1-what-the-product-runs-is-in-productgdl)
  - [2. Where and how it runs is the environment's](#2-where-and-how-it-runs-is-the-environments)
  - [3. A deploy takes the services its build was resolved with](#3-a-deploy-takes-the-services-its-build-was-resolved-with)
  - [4. A gear reads a capability, and the process renders it at start](#4-a-gear-reads-a-capability-and-the-process-renders-it-at-start)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

ADR-0064 kept a product's infra services in a list on the project
(`GET`/`PUT /infra-services`). Gears and frontends are in the product's
description, so a revision says which gears a build takes and the lock pins
them. Infra services were outside it. The list held three different things:

1. **What the product runs.** The service, its publisher's image (a version
   choice), and the configuration the product sets on it.
2. **What one environment does with it.** Where it runs, its public address,
   a ready chart's values and the copy of its image the environment's
   registry holds.
3. **The passport.** This is a copy of the catalogue's `service.gdl` taken
   when the service was added. It went stale when the passport changed.

Because of this, one description revision could deploy differently on two
days. Nothing in a build said which Keycloak the product was built to run
beside. A gear read `${OIDC_ISSUER}`, but no check knew the variable came from
anywhere.

Gearbox GDL 1.6 has the vocabulary for this:

- `product(infra = [use_service(...)], secrets = [...])`;
- passports are `service.gdl` files with `kind = "infra"`, found in a source
  of the product;
- capabilities are bound to variables;
- GBX0127–GBX0130 report a wrong choice or an unbound variable;
- the lock carries an `infra` section;
- a generated process substitutes `${NAME}` in its gears' configuration when
  it starts.

The user's decisions of 2026-11-05:

- keep infra in `product.gdl`;
- split it between the product and the environment;
- render the gears' configuration at start.

## Considered Options

1. **The description says what, the environment says where** (this ADR).
2. **Keep the project's list, and let the description name only service
   names.** This is half a split: the image and the configuration still live
   outside a revision, and a build still cannot say what it was made for.
3. **Everything in the description, the public address and chart values
   too.** Then one revision cannot go to dev and prod, which ADR-0060 §5
   requires. A mirror's address names an environment's registry, which a
   product does not know.

## Decision Outcome

Chosen option: **1**.

### 1. What the product runs is in `product.gdl`

```text
infra = [
    use_service("keycloak", source = "studio-web",
        image = "quay.io/keycloak/keycloak:26.0.7",
        config = {"KC_PROXY_HEADERS": "xforwarded"}),
    use_service("postgresql", source = "studio-web"),
],
secrets = ["SMTP_PASSWORD"],
```

- The service is the passport `name` in the named `source`. The publisher's
  `image`, a ready `chart`/`chart_version`, `config` and `profile_config` are
  the product's choice. When one is left out, the passport's is used.
- The engine checks the choice:
  - GBX0127: there is no such infra passport;
  - GBX0128: two services provide one capability;
  - GBX0129: a config key is not the passport's, or is one of its secrets or
    a `${...}`;
  - GBX0130: a `${NAME}` the configuration reads is not declared.

  Studio shows these on the description like any other diagnostic.
- The Infrastructure tab edits these calls. Each save is a new description
  revision (ADR-0053), so infra has history and is reviewed like gears.

### 2. Where and how it runs is the environment's

These stay on Studio's side, keyed by the service's name:

- the placement (`with_product` or `shared`, ADR-0064 §3);
- the copy of the image in the project's path (`image`, ADR-0064 §4) and of a
  ready chart (`chart_ref`, `chart_version`);
- the ready chart's `chart_values` and the `public_url`.

`GET`/`PUT /infra-services` remains as this side. A record's passport is read
only for a build without `infra` (§3). A record for a service the description
does not choose does nothing.

The import is checked against the description. The copy must be of the image
the build's lock names: the same digest, or, when the lock has no digest, the
same tag, which an import keeps. Otherwise the deploy is refused with `INFRA_IMAGE_NOT_IMPORTED`,
which names the reference to import.

### 3. A deploy takes the services its build was resolved with

The build's `product.lock` carries `infra.services`: each service resolved for
the build's profile, with its passport, its passport hash, the chosen image
(with its digest when the reference has one), the chart and the merged
configuration.

- `build-prepare` reads that section, and `build-publish` puts it in the
  manifest it leaves for Studio (`Manifest.infra`).
- Studio keeps it on the project for every passed build, an empty list for a
  build that chose none, before the build is recorded as passed. When it
  cannot be kept, the build fails at `publish`. The project keeps the newest
  50 builds' services.
- A deploy of the build installs those services. It uses the lock's passport
  and configuration, joined by name with the environment's side (§2).
- A service the lock names without an environment record is refused, as
  ADR-0064 §4 says.
- A build from a description without `infra` deploys the project's records
  as ADR-0064 did. So does any build of a project that has no kept services
  yet, so the switch breaks nothing already deployed.
- A deploy of a build whose services are not kept, on a project that keeps
  some, is refused with `BUILD_INFRA_NOT_KEPT`. It is not run with today's
  services.

The manifest reaches Studio as the publish container's termination message,
which the kubelet caps at 4 KiB. The infra section is written without fields
a deploy does not read (`description`, `docs`, `requires`). A manifest that
would not fit fails the publish step with its size, instead of being cut.
When a product outgrows that, the section moves to a record the job writes.

### 4. A gear reads a capability, and the process renders it at start

A gear's configuration reads `${OIDC_ISSUER}` (ADR-0064 §2). The runtime
expands variables only in its `database` section. A process generated by the
engine from GDL 1.6 substitutes every `${NAME}` in its gears' configuration
when it starts, and stops, naming the variable, when one is not set. The
deploy writes each capability's value and each of `secrets` into the
release's configuration Secret, which every application already reads
(`existingSecret`/`secretKeys`). So the issuer inside a list
(`jwt.trusted_issuers[0].issuer`), which an environment override cannot
reach, now comes from the product's own Keycloak.

Studio runs a Gearbox that knows GDL 1.6: `STUDIO_GEARBOX_REF` is raised to
the release that carries it.

## Consequences

- Good: a description revision says the whole product, gears and the services
  beside them. A build records exactly what it was made for, and the lock diff
  names a moved image (`infra.keycloak.image`).
- Good: one revision deploys to dev and prod. Only the environment's side
  differs.
- Good: the passport is read from its source at build time, never copied, so
  it does not go stale.
- Bad: changing a service's configuration is a description revision and a
  build, not an edit on the project. This is intended: it changes what the
  product runs.
- Bad: the 4 KiB termination message bounds how much infra a build can
  report.
- Neutral: a project that never adopts `infra` in its description keeps
  ADR-0064's list.

## More Information

- ADR-0064: infra services, placement, imports, install.
- ADR-0053: the description's revisions.
- ADR-0060 §5: one revision, many environments.
- Gearbox `docs/gdl.md`, "Infra services and variables (GDL 1.6)".

## Traceability

- `studio-backend/src/product/gearbox.rs`: `Resolution.infra`, read from the
  engine's resolve.
- `studio-backend/src/environments/build.rs`: `Prepared.infra`,
  `Manifest.infra`, the size check in `publish`.
- `studio-backend/src/environments/infra.rs`: `LockedInfra`, `from_lock`.
- `studio-backend/src/environments/service.rs`: `project_config` takes the
  build's services.
- `studio-frontend-prototype/src/infra-store.ts`: the description-backed
  store.
