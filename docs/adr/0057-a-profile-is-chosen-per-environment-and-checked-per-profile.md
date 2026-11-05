---
type: adr
status: proposed
date: 2026-11-03
---

# ADR-0057: A profile is chosen per environment and checked per profile

**ID**: `cpt-studio-adr-profile-per-environment`

Status: **proposed** · Date: 2026-11-03 · Amends `cpt-studio-adr-deployment-environments` (ADR-0043) §2 · Changes the bindings' rule and the product record

## Table of Contents

<!-- toc -->

- [Context and Problem Statement](#context-and-problem-statement)
- [Considered Options](#considered-options)
- [Decision Outcome](#decision-outcome)
  - [1. An environment is bound to the profile it runs](#1-an-environment-is-bound-to-the-profile-it-runs)
  - [2. The engine's verdict is kept per profile](#2-the-engines-verdict-is-kept-per-profile)
  - [3. The description's default profile is pinned](#3-the-descriptions-default-profile-is-pinned)
  - [4. The screens read verdicts per profile and environment](#4-the-screens-read-verdicts-per-profile-and-environment)
- [Consequences](#consequences)
- [More Information](#more-information)
- [Traceability](#traceability)

<!-- /toc -->

## Context and Problem Statement

A product's `product.gdl` declares three profiles, which are deployment shapes:
- `embedded(id = "dev")`: one process;
- `self_hosted(id = "local")`: processes on one host;
- `kubernetes(id = "prod")`: a cluster.

The organization has environments: `dev`, `stage` and `prod`, on clusters or in Constructor Research. ADR-0043 §2 lets a project bind a profile to an environment. Four things in how Studio did that were wrong:

- **The Backend section had one profile select for the whole product.** It decided which single profile the engine checked. Each switch overwrote the previous verdict and rewrote `default_profile` in the generated `product.gdl`, so a new revision appeared with no real change.
- **The select decided nothing about what is built or deployed.** The bindings decide that.
- **Bindings were keyed by profile.** A profile could be bound to one environment only, so stage and prod could not both run `prod`.
- **Infrastructure compared each binding with the last checked profile.** An environment showed as "unchecked" whenever someone had looked at another profile.

## Considered Options

1. **Keep the select, and only let a profile be bound to many environments.** The verdict would still be one profile's at a time, and the description would still change with the select.
2. **Bind environments to profiles, and keep one verdict per profile.** The select goes. The engine checks the profiles that environments run, and the others on demand.
3. **Check every profile on every change.** This costs three engine runs for each edit, when one profile is usually enough. The engine takes one product at a time (some 1.5 GB each).

## Decision Outcome

Chosen option: **2.**

### 1. An environment is bound to the profile it runs

- A binding is environment → profile. Each environment is bound at most once, and one profile may be bound to any number of environments.
- For now, only `kubernetes` profiles bind, as ADR-0043 §2 says.
- The stored shape stays `{profile, environment_id, values?}`. Only the rule changes: the list may repeat a profile, not an environment.
  - Lists saved under the old rule repeat no profile. They load as they are.
  - A list that bound two profiles to one environment also loads. The editor keeps the first, and the next save drops the others.
- A build for an environment takes the profile bound to it.

### 2. The engine's verdict is kept per profile

- A preview of profile X records its result on the product under `checks.X`: `ok`, `errors`, `warnings`, `applications`, `gears`, `infrastructure`, `corpus_commit`, and `gdl_sha256`.
- The new check is merged into `checks`. The other profiles' checks stay.
- `gdl_sha256` is the hash of the rendered `product.gdl`. A check is current only while the description has that hash. A check made before the last change is stale.
- `last_preview` is still written for older readers. It is the latest check, with its profile.
- A record from before `checks` existed has only `last_preview`. That preview answers for the profile it names.

### 3. The description's default profile is pinned

`product.gdl` always says `default_profile = "dev"`. The profile being checked no longer changes the description, and checking another profile makes no revision.

### 4. The screens read verdicts per profile and environment

- **Product › Backend:** a row of chips replaces the select, one chip per profile.
  - Each chip is labelled shape first: *Kubernetes · prod*, *One host · local*, *One process · dev*.
  - It shows the environments that run the profile, the profile's verdict (✓, ✗ N errors, not checked, or stale), and a Check button.
  - The chip picked is the profile whose diagnostics, fixes and map the card shows.
- **When the engine checks:**
  - The profiles that environments run are checked whenever the product changes, and `prod` is checked when no environment is bound.
  - Other profiles are checked only when someone presses Check.
- **Product › Infrastructure:** each environment shows its profile, that profile's verdict, and what that profile needs. The database check uses those needs.
- **The strip's Backend part** is done only when every bound profile's check is current and resolves. When one fails, it names the profile and the environments that run it.

## Consequences

- Stage and prod can run the same profile, and each has its own release, chart values and secrets.
- Looking at another profile no longer changes the product, and no revision is made for it.
- A product with bindings to two profiles costs two engine runs per change, one after the other. Unbound profiles cost nothing until someone checks them.
- The product's `profile` field is no longer written or read. Old records still carry it.

## More Information

- ADR-0043: an organization's products run in its environments. This ADR amends its §2.
- ADR-0053: Studio keeps a product's description and builds it with the code of a chosen branch. A pinned `default_profile` keeps its revisions meaningful.
- ADR-0056: places, environments and releases are laid out the way an organization runs them. Its Infrastructure section and Releases tab show the bindings.

## Traceability

- `studio-backend/src/environments/model.rs`: `checked_bindings` refuses an environment bound twice, not a profile. Its tests load a list saved under the old rule.
- `studio-backend/src/product/rest.rs`: `preview_product` records `checks.<profile>` and `last_preview`, and returns `gdl_sha256`. `studio-backend/src/product/service.rs`: `merge_product_patch` merges `checks` by profile.
- `studio-backend/src/product/gearbox.rs`: `render_product_gdl_from` writes `DEFAULT_PROFILE`.
- `studio-frontend-prototype/src/product.ts`: `PRODUCT_PROFILES` with `kind`, `KUBERNETES_PROFILES`, `profilesToCheck`, `checkOf`, `verdictOf`.
- `studio-frontend-prototype/src/kits.tsx`: `ProfileVerdicts`, the chips (§4).
- `studio-frontend-prototype/src/product-sections.ts`: `infrastructureOf`, per environment. `product-flow.ts`: the Backend and Infrastructure parts.
- `studio-frontend-prototype/src/environments-screen.tsx`: `ProjectEnvironments` gives each environment a profile select. `deploy-actions.tsx`: `profileFor`, a build's profile from its environment's binding.
