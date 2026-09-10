# studio-kits

The catalogue of kits, and which kits a project wants installed.

## Why it exists

A kit is a bundle of working material — templates, prompts, checklists — that a
project pulls into its checkout. The first vertical slice deliberately keeps the
kit **bytes** in their canonical Git repositories rather than copying them into
a store of our own: a kit is already versioned where it lives, and a second
copy would be a second thing to keep current.

So this gear owns only what Git cannot answer: the catalogue metadata, and the
per-project record of which kits are *desired*. `cfs` remains the only component
that materializes kit files into a checkout — this gear says what should be
there, not how it gets there.

## What it owns

Catalogue entries and project-scoped desired installations. Access to a project
is authorized through account-management, the same way
[`../documents`](../documents) authorizes its project routes.

## REST

| Method + path | Does |
|---|---|
| `GET /catalog` | every kit this deployment knows about |
| `GET`/`POST /projects/{id}/installations` | what the project wants installed |
| `DELETE /projects/{id}/installations/{kit_slug}` | stop wanting one |
| `GET /projects/{id}/repositories` | the repositories a kit would be materialized into |

## In the assembly

- Gear `studio-kits`, capabilities `[rest]`, deps `account_management`.
- Config section `gears.studio-kits` — the catalogue's Git sources.
- See the repository-root `docs/kit-registry-prototype.md`.
