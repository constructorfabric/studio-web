# studio-documents

Document management: the types a document can be, the templates and checklists
that shape it, and the documents themselves.

## Why it exists

A specification is not free text — an organization has opinions about what a
PRD contains, what stage it is at, and whether it is finished. This gear makes
those opinions data: a document **type** carries a markdown template, a section
checklist and structural conformance rules, so "is this document complete" has
an answer that is not a person reading it.

## Workspaces own documents; projects inherit them

Storage scope is always the **workspace** tenant. A document's `project_id`
column distinguishes project-owned from inherited — `NULL` means
workspace-level, visible to every project in it. Inheritance is therefore a
cheap column filter rather than a cross-tenant read, which is what keeps a
project's document list one query.

Types, stages and capabilities can be defined at the **organization** level and
overridden at the **workspace** level, with a tombstone to hide an inherited
entry rather than delete something that is not yours.

## What it owns

Its own relational database (`toolkit_db` / SeaORM plus migrations), the same
shape as [`../credstore_pg`](../credstore_pg). Access to a workspace or project
tenant is authorized through account-management, as [`../kit_registry`](../kit_registry)
does for its project routes.

Document types are also registered in the platform types-registry, which is why
a profile that gives this gear no database also has no `doc.*` types — the
`gts-audit` command names them rather than leaving you to notice an empty
screen.

## REST

| Method + path | Does |
|---|---|
| `GET`/`POST`/`DELETE /{organizations\|workspaces}/{id}/types[/{key}]` | the document types, defined at either level |
| `GET`/`POST`/`DELETE /{organizations\|workspaces}/{id}/stages[/{key}]` | the lifecycle stages |
| `GET`/`POST`/`DELETE /{organizations\|workspaces}/{id}/capabilities[/{key}]` | what a document at a stage may claim |
| `GET`/`POST /workspaces/{id}/documents` | list and create |
| `GET`/`PUT`/`DELETE /workspaces/{id}/documents/{doc}` | one document |
| `POST /workspaces/{id}/documents/{doc}/validate` | check it against its type's checklist and rules |
| `GET /workspaces/{id}/projects/{project}/documents` | the effective set for a project: its own plus inherited |
| `GET /workspaces/{id}/projects/{project}/analyses` | quality verdicts recorded against them |

## In the assembly

- Gear `studio-documents`, capabilities `[db, rest]`, deps `account_management`,
  `types_registry`.
- Config section `gears.studio-documents`; no `database:` block means the gear
  stands down.
- Deeper analysis of a document's text is [`../spec_quality`](../spec_quality).
