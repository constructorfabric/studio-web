# ADR-0014: A document type is a component, not a GTS type

Status: **proposed** · Date: 2026-09-08 · Builds on ADR-0013 · Amends ADR-0010 (frontend)

## Context

Studio is a constructor: an organization defines the document types its projects
fill in, the stages a project passes through, and the capability vocabulary
those documents seed. Today the first is half true and the other two are not
true at all.

### What already works, and is not rebuilt here

`studio-documents` already implements a two-level ownership model:

- `Owner` is `Builtin | Workspace { tenant_id }` (`src/documents/model.rs:18`).
- `list_types(workspace_id)` returns the platform catalogue **overlaid by
  workspace-defined types of the same key** (`src/documents/service.rs:53`).
- `POST /studio-documents/v1/workspaces/{id}/types` accepts `body`, `sections`,
  `rules` **and `questionnaire`** (`UpsertTypeDto`, `src/documents/rest.rs:140`).
- Documents inherit: `list_project_documents` returns own + inherited.

Templates, section checklists, conformance rules and intake questionnaires are
therefore already data an organization controls. This ADR is about the four
places where the constructor stops.

### Defect 1 — a GTS type is minted per catalogue key

```rust
// src/documents/model.rs:219
pub fn type_gts_id(key: &str) -> String {
    format!("gts.cf.studio.doc.{key}.v1~")
}
```

`upsert_type` stamps that id onto workspace-defined types
(`src/documents/service.rs:88`) and never registers them, so a workspace type
carries an identifier pointing at nothing. The id is also deployment-global: two
workspaces defining `vision` produce one id for two different schemas.

ADR-0013 §4 already forbids this shape — a tenant-authored type must carry a
tenant vendor segment, never `cf.studio.*`, because the types-registry is not
tenant-scoped. Registering them properly would be worse: a registered schema is
immutable (ADR-0013 §5), so every template edit becomes a schema migration, and
a malformed key surfaces as `post-init failed for gear …` on a pod rather than
as a validation error on the request that caused it.

### Defect 2 — the stage catalogue is a frontend constant

`JOURNEY_STAGES` lives in two client codebases
(`studio-frontend/src-app/mfe_packages/projects-mfe/src/model/project.ts:104`
and `studio-frontend-prototype/src/api.ts:96`), with `intent` hardcoded as the
only required stage and `DEFAULT_STAGES = ['intent']` hardcoded in the create
wizard. There is no backend representation and no API: `GET
/studio-project/v1/stages` disappeared with the `studio-project` gear, and
ADR-0010 recorded the move to client constants as a consequence.

The stage list is the path a product takes through the studio. It is the one
thing a constructor must let an organization change, and it is the one thing
unreachable from any API.

### Defect 3 — the capability vocabulary is prose

`Question.capability` is `Option<String>` (`src/documents/model.rs:120`) — free
text, no catalogue, no validation. Its only consumer is `composePlan`
(`studio-frontend-prototype/src/documents.tsx:705`), which resolves a capability
to candidate components through `CAP_KEYWORDS`, a hardcoded keyword table,
scoring by matched words. A workspace that invents a capability gets zero
candidates and no explanation — while the component catalogue already computes
embeddings for exactly this kind of lookup (`src/components_catalog/gts.rs:143`).

### Defect 4 — editing a type rewrites the past

`upsert_type` overwrites the row (`src/documents/service.rs:75`). Documents
created from the previous definition are then validated against rules that did
not exist when they were written. An organization that tunes its PRD template
silently invalidates every PRD already approved, so in practice nobody touches a
type and the constructor freezes.

## Decision

### 1. Four layers, four rates of change

| Layer | Holds | Changed by | Mechanism |
| --- | --- | --- | --- |
| **GTS contract** | the *shape* of a catalogue entry | the platform | a new `vN`, registered in code, immutable |
| **Component** | the entry itself, as publishable bytes | its publisher | a kit in Git, versioned, with a manifest |
| **Installation + override** | what this tenant actually uses, and its local edits | organization / workspace | installation record + override row |
| **Project** | which entries apply and what was produced | the project | inheritance + documents |

The load-bearing sentence: **a catalogue key is not a type — it is a component,
and its use by a tenant is an installation.** `prd` is not
`gts.cf.studio.doc.prd.v1~`; it is a kit named `prd`, installed in a workspace,
whose content is an instance of `gts.cf.studio.doc.document_type.v1~`.

### 2. Retire `type_gts_id(key)`

Per-key generation goes, and with it the loop in
`src/documents/gts.rs:type_schemas()` that registers one entry per built-in
catalogue type. Two base types remain and become the whole document surface:

```
gts.cf.studio.doc.document_type.v1~   the shape of a catalogue entry
gts.cf.studio.doc.document.v1~        the shape of a document
```

`DocumentType.gts_type_id` stops being a per-key identifier and becomes the base
type every entry is an instance of. No tenant registers a type in order to
define a document type, so ADR-0013 §4's vendor-segment escape hatch is never
spent on catalogue data and stays available for genuinely new kinds of thing.

### 3. A document type is distributed as a kit

`studio-kits` already owns exactly this shape (`src/kit_registry/service.rs:16`):

```rust
pub struct KitDescriptor {
    slug, name, description, publisher,
    visibility,                              // private types for one organization
    source, repository_url, manifest_path,   // bytes in Git, reviewed by PR
    default_version,
}
```

and `KitInstallation` carries `version`, `install_mode`, `status`, `scope` and
`materializations` — one entry per repository the kit was written into.

Every mechanism a document type needs is therefore already built:

| Need | Kit machinery |
| --- | --- |
| revision of a catalogue entry | `default_version` + per-installation `version` |
| a type private to one organization | `visibility` + `publisher` |
| an organization-wide default | an installation at organization `scope` |
| removing an inherited entry | no installation |
| writing generated documents into a repository | `materializations` |
| reviewing a change to a type | a pull request in its Git repository |

Crates are the wrong vehicle: `studio-components-catalog` synchronizes public
crates.io entries under the `constructorfabric` keyword (`mod.rs:32`), and a
document type private to one customer cannot be published there. Kits keep their
bytes in Git behind a connection, which is what `visibility` is for.

### 4. A local override sits on top of the installed component

An installed type may be adjusted in place — a section added, a rule relaxed, a
question reworded — without forking its repository. The precedent is
`gear_profile`, *"editable Studio metadata for one gear, kept separately from
crates.io sync data"* (`src/components_catalog/gts.rs:21`): synchronized content
and local edits are separate rows, and the effective value is their overlay.

- An override records the component **version it was written against**, so a
  version bump surfaces as a reviewable conflict rather than a silent
  reinterpretation.
- Overrides resolve in the tenant hierarchy: **organization, then workspace**.
- An override is **reversible in both directions**, and the two directions are
  different operations. *Hiding* adds an entry that suppresses what it
  overrides; *reverting* removes this level's entry so the level below shows
  through again (`DELETE .../types/{key}`, `DELETE .../stages/{key}`). Without
  the second, an override would be a one-way door -- a workspace that once
  replaced `prd` could never go back to the organization's -- and the overlay
  would be a trap rather than a setting. The delete is scoped to the tenant in
  the path, so a workspace reverting its own entry cannot take the
  organization's away from its siblings, and it is idempotent: the request names
  a desired state, not an event.
- The effective type for a project is
  `installed component version → organization override → workspace override`.

This is what `Owner` becomes. It no longer describes distribution — the kit
registry does that — only the local layer, and it gains the organization level:

```rust
enum Owner { Builtin, Organization { tenant_id }, Workspace { tenant_id } }
```

### 5. Two node types and four edges

Stages and capabilities become catalogue entries under the same model —
published as kits, installed per tenant, overridable locally. They are process
vocabulary rather than documents, so they take a `process` namespace:

```
gts.cf.studio.process.stage.v1~
gts.cf.studio.process.capability.v1~
```

Edges, namespace `rel`, family `static_edge` per ADR-0013:

| edge | from → to | meaning |
| --- | --- | --- |
| `rel.requires.v1~` | stage → document_type | this stage is incomplete without a document of this type |
| `rel.produces.v1~` | document → stage | this document is evidence for this stage |
| `rel.seeds.v1~` | question → capability | answering this seeds this capability |
| `rel.realizes.v1~` | capability → component | this component provides this capability |

All six are registered in both registries with a human title and description, so
ADR-0013 §2's completeness invariant holds for this set from the start rather
than being retrofitted.

`rel.realizes` is why the vocabulary must be catalogue data: once a capability is
an entry and a component declares which capabilities it realizes, "assemble from
Gears" is one resolution strategy over that data, and a second target stack is a
second set of edges rather than a second `composePlan`.

### 6. Storage

- **Git** is the system of record for a component's content.
- **The gear's PostgreSQL** holds installations and overrides — the tenant-local
  state, the thing a request must read to answer "what is the effective type".
- **Graph-storage** holds a per-tenant projection for reads that traverse the
  edges of §5 ("which types does this project still owe for stage X", "which
  capabilities have no realizing component"). It is derived state; no write
  decision reads it.

ADR-0013 §2 lists `gts.cf.studio.doc.*` as the catalog-only exception. That
exception narrows rather than disappears: the base and process types now reach
the graph, and per-key document types no longer exist to be excepted.

### 7. Stages move to the backend; the frontend constants are deleted

`JOURNEY_STAGES` and `DEFAULT_STAGES` are removed from both clients and served
as an effective, inheritance-resolved list. `intent` stops being required by
construction — it is a built-in stage flagged `required`, which an organization
may override or replace like any other entry.

This closes the client-side-invariant hole ADR-0010 opened for stages. The other
three invariants that ADR records — the status ladder, the shape invariant and
name uniqueness — are out of scope here.

## What was rejected

**Registering each catalogue key as a GTS type properly.** The shape the code
implies today. It fails three ways: the types-registry is not tenant-scoped
(ADR-0013 §1), so two organizations collide; a registered schema is immutable
(§5), so every template edit is a migration; and registration failures surface
at boot, so a bad key from a UI form takes down a pod.

**Letting organizations register types under a tenant vendor segment.** ADR-0013
§4 permits it, and it is the right tool for a genuinely new *kind* of thing. A
document type is not a new kind — it is another instance of a kind the platform
already ships. Spending the escape hatch here hands every organization a
registry namespace to maintain, for no gain.

**Inventing a revision counter for catalogue entries.** The first draft of this
ADR did exactly that, before noticing that kits already version, publish, scope
and materialize. A second versioning mechanism beside an existing one is a cost
with no return.

**Distributing document types as crates.** No private publication, and a
document type is a template plus a manifest, not a compiled crate.

**Component only, no local override.** Cleaner — one source per effective type —
but every organization ends up maintaining a fork repository to move one section,
and the existing `POST /types` form flow would have to be deleted rather than
re-pointed.

**Making the graph the system of record.** Its per-tenant scoping fits, but a
node's concrete type is immutable under upsert (ADR-0013 §5) and overrides need
rows that supersede cheaply.

## Consequences

- **`docs/gts-types.json` changes shape**: seven per-key document types leave the
  snapshot, two node types and four edges enter it. The diff is the review, per
  ADR-0013 §3.
- **A migration for existing installations.** Documents keep their `type_key` and
  keep working; each workspace-defined type becomes an override row, and each
  document gains the component version it was created against — backfilled to
  the current one, which is correct because nothing has been edited since.
- **`studio-documents` gains a dependency on `studio-kits`** for resolution, and
  runtime writes to the graph projection. Its current best-effort registration
  policy — warn and continue, where every other gear aborts — is already a
  follow-up in ADR-0013 §6.2 and should be settled before this lands, since a
  failure now affects a per-tenant projection rather than a fixed boot-time set.
- **Editing a type is publication, not a form** — for the component. The local
  override keeps the fast path for small adjustments, at the cost of two places
  to look when explaining why a type renders as it does.
- **One resolver serves three catalogues.** Types, stages and capabilities share
  distribution, installation, override and projection. That is the argument for
  doing them together rather than one at a time.
- **Generated documents reach a repository through machinery that exists.**
  `KitInstallation.materializations` already records what was written where, so
  "generate the docs and put them in the repo" stops being a separate subsystem.

## What this change implements, and what it does not

Sections 2, 4, 5 and 7 are implemented; sections 3 and 6 are not, and the gap is
deliberate. Distribution and the graph projection are each larger than the whole
of what is here, and neither is needed to make the catalogues editable — which
was the point. The layering is built so they slot in rather than replace:

| Section | State |
| --- | --- |
| §2 retire `type_gts_id` | done — two base types plus two process types, seven per-key types gone from the snapshot |
| §4 three levels, tombstones, revert | done for all three catalogues |
| §5 stages and capabilities as entries | done — `rel.requires` and the capability terms are carried as data; the edges themselves wait on §6 |
| §7 stages served, client constants deleted | done in both clients |
| §3 a document type distributed as a kit | **not started** |
| §6 per-tenant graph projection | **not started** |

Two consequences of stopping here, recorded so they are not rediscovered:

- **An override has no version to be written against.** §4 says an override
  records the component version it was based on, so a version bump surfaces as a
  conflict. Without §3 there is no component and no version, so an override is
  simply the newest write. Nothing breaks; the conflict detection §4 promises is
  not there yet, and the column arrives with distribution.
- **`rel.requires` and `rel.realizes` are fields, not edges.** A stage carries
  `requires: string[]` and a capability carries `terms: string[]`. Queries that
  want to traverse them ("which types does this project still owe for stage X")
  have to read the catalogue and join in the caller until §6 lands.

## Follow-ups

1. ~~The wizard's `stages: ['intent']` write becomes "the effective required
   stages for this workspace".~~ Done: `requiredStages` in `wizardEffects`,
   traced as `cpt-studiofrontend-algo-project-create-write` inst-4a. Reading the
   catalogue is best-effort — a project is created with no stages rather than not
   created, because an empty stage list is recoverable and a missing project is
   not.
2. ~~Composing questionnaire answers into a document happens in the client, and
   capabilities round-trip through a front-matter string parsed by regex.~~
   Done: `POST .../documents` accepts `answers` and composes the body from the
   type's questionnaire (`documents/intake.rs`), and a document carries its
   declared capabilities as a field.

   The capability column is an **index over the document's own front matter**,
   re-derived on every write, not a second store. A generated document declares
   its capabilities in text because the markdown ends up in a repository where a
   person reads it; the column exists so the composer need not parse every body.
   Re-indexing on write is what keeps them from drifting when a document is
   edited by hand, which no answer store would survive.

   Two things surfaced while doing it, both fixed here:

   - `validate` counted a **present but empty optional section** against
     conformance, contradicting its own module doc ("required sections present…
     a genuinely filled document never trips a false positive") and the
     `Section::required` doc comment ("an optional one only warns"). Since the
     generator emits every declared section so the checklist has somewhere to
     point, every questionnaire-generated document was born non-conforming. An
     empty optional section is now reported through `SectionStatus.ok` and does
     not fail the document; present, non-empty and too short still does.
   - Sending both `answers` and `content` is refused rather than silently
     dropping one, as is an answer to a question the type does not declare.
3. ~~Spec-quality verdicts have nowhere to live, so "the documentation passed
   validation" cannot be expressed in data.~~ Done. A verdict is recorded per
   `(document, detector)` with the upstream task id that produced it
   (`PUT .../documents/{id}/analyses/{detector}`), and a stage may name the
   detectors its required documents must pass (`Stage::gates`).
   `GET .../projects/{id}/stage-status` answers, per stage, which required types
   are present, which conform, and which gating detectors have not passed. That
   is the gate between "we wrote the documents" and "the documents are good
   enough to build from".

   The gear still does not run the analysis: `studio-spec-quality` is a
   passthrough whose task lifecycle the caller drives, and this only remembers
   what the analysis said. Two judgements are worth the ink:

   - **Status is computed, never stored.** A stored completion flag goes stale
     the moment a document is edited, and nothing would notice.
   - **Only `passed` opens a gate.** Missing, pending, failed and any state this
     build does not recognise all keep it shut. A gate that opens on a value we
     cannot interpret is the one failure mode a gate must not have.

   The verdict table cascades from the document (`ON DELETE CASCADE`), in the
   schema rather than in the delete path, so the rule holds for every writer.
4. Who in an organization may edit a catalogue every workspace under it inherits.
   The rule in code today is "whoever may read the organization tenant", set by
   the route rather than by a payload field (`upsert_type_at`). That is a
   placeholder for a real role, not a decision.
5. Namespace choice in §5 (`process` vs reusing `catalog`) should be settled with
   the vocabulary decision ADR-0013 defers in its follow-up 3 — the namespace is
   part of the id, so changing it later changes the type.
6. **Semantic component matching.** `terms` is lexical. The component catalogue
   already computes embeddings (`src/components_catalog/gts.rs:143`), and
   `rel.realizes` is what would carry the result. Lexical terms should stay
   alongside it: a term match is explainable ("matched because the component
   mentions `keycloak`"), a vector score is not.
7. **The platform catalogues are code, not data.** `builtin_types`,
   `builtin_stages` and `builtin_capabilities` are Rust. That is right while they
   are the platform's own, and it is exactly what §3 replaces — the built-ins
   become kits the platform publishes like anyone else.
8. Tests for the catalogue routes go through the repo and the pure decision
   functions (`overlay`, `evaluate_stage`, `intake`); the REST layer itself has
   no test, so a wrong path or a missing `authorize` would surface at runtime.
   A handler-level suite needs a stub `AccountManagementClient` -- the whole
   trait, for the one method `authorize` calls -- which is why it has not been
   written. Worth it when a second gear starts depending on these endpoints, or
   the first time a route bug reaches a deployment.
