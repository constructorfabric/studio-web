---
type: design
status: accepted
owner: studio-team
---

# Technical Design — studio-credstore-pg

- [x] `p3` - **ID**: `cpt-studio-design-credstore-pg`

The gear-level design of `cpt-studio-component-credstore-pg`. The
product-level view, and how this gear sits among the others, is in
[Constructor Studio's design](constructor-studio.md). The code is
[`studio-backend/src/credstore_pg/`](../../studio-backend/src/credstore_pg/).

## Table of Contents

- [1. Architecture Overview](#1-architecture-overview)
- [2. Principles & Constraints](#2-principles--constraints)
- [3. Technical Architecture](#3-technical-architecture)
- [4. Additional context](#4-additional-context)
- [5. Traceability](#5-traceability)

## 1. Architecture Overview

### 1.1 Architectural Vision

A credstore value store that survives a restart. credstore splits a secret in
two: the metadata row lives in its own PostgreSQL database, and the value lives
in whatever backend plugin is selected. The only plugin CF/Gears ships is
`static-credstore-plugin`, whose backend is a `HashMap` seeded from YAML.

So every `docker compose restart backend` left the metadata intact and the
values gone (issue #66). `get` then failed closed on the value fingerprint
fence and answered `Ok(None)`, and any token a person had typed into the
portal — source PATs (`studio-repo-*`, `studio-root-*`), connector tokens
(`studio-connection-*`) — was unrecoverable. Unlike `openai-key` or
`anthropic-key`, there is no environment variable to re-seed those from. This
gear makes the value store a table, with every value encrypted.

### 1.2 Architecture Drivers

#### Functional Drivers

| Requirement | Design Response |
|-------------|------------------|
| `cpt-studio-fr-credentials-durable` | Values are rows in `studio_credstore_values`, sealed with AES-256-GCM under a key from the environment. Healing config-seeded secrets is `cpt-studio-component-secrets-bootstrap`, not this gear. |

#### NFR Allocation

| NFR ID | NFR Summary | Allocated To | Design Response | Verification Approach |
|--------|-------------|--------------|-----------------|----------------------|
| `cpt-studio-nfr-durable-work` | Credential values survive a restart | `cpt-studio-component-credstore-pg` | The value store is a table in its own database | `credstore_pg/store_tests.rs`, each test on a fresh database (`test_pg::fresh_database`) |
| `cpt-studio-nfr-credential-isolation` | No secret where it does not belong | `cpt-studio-component-credstore-pg-cipher` | Values are ciphertext at rest; the key is in neither database; each ciphertext is bound to its key class | `crypto.rs` unit tests |

### 1.3 Architecture Layers

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| Plugin seam | Be credstore's selected value backend | `CredStorePluginClientV1`, a `PluginV1` instance in the types-registry |
| Store | `get`, `put`, `delete` by key class | `store.rs` |
| Crypto | Seal and open a value | `crypto.rs`, AES-256-GCM over `aws-lc-rs` |
| Storage | `studio_credstore_values` | PostgreSQL database `studio_credstore_values` |

## 2. Principles & Constraints

### 2.1 Design Principles

Keys and tokens travel by reference (`cpt-studio-principle-credentials-by-reference`);
this gear is where the referenced values rest.

#### Replace the static plugin, do not sit beside it

- [x] `p2` - **ID**: `cpt-studio-principle-credstore-pg-replaces-static`

credstore resolves its backend through `choose_plugin_instance`, which filters
by `vendor` and returns the single instance with the lowest `priority`. There
is no chain and no fallback. At priority 50 this gear displaces
`static-credstore-plugin` (100) outright, and that plugin's config-seeded
values stop being reachable. In the profiles that enable this gear that costs
nothing: those entries are empty, and the values arrive from the environment
through `cpt-studio-component-secrets-bootstrap` on every boot. A config test
checks, across every shipped profile, that wherever this gear is enabled it
outranks the static plugin and names the key variable the code reads.

#### No key, no plugin; a bad key, no boot

- [x] `p2` - **ID**: `cpt-studio-principle-credstore-pg-key-gate`

With no `STUDIO_CREDSTORE_KEY` the gear logs a warning and does not register,
so the static plugin wins and the deployment behaves as it did before #66. A
key that is present but malformed fails the boot, because a silent downgrade
would only be discovered as lost secrets after the next restart. Once the key
is accepted, a missing database and a failed instance registration fail the
boot too: a value store that is configured but unreachable would present as
"all secrets silently missing".

#### As dumb as the store it replaces

- [x] `p2` - **ID**: `cpt-studio-principle-credstore-pg-dumb-store`

Sharing, hierarchy, authorization, lifecycle and the value fence all live in
credstore, which has resolved tenant and owner before a call arrives here. The
only things this layer adds over the in-memory `HashMap` are that the map is a
table and the values are ciphertext. A `put` is a last-writer-wins upsert;
credstore's write saga owns generations and preconditions. A `delete` of a
missing row is success, since credstore treats a missing value as already
deleted.

### 2.2 Constraints

#### It has to be a system gear

- [x] `p2` - **ID**: `cpt-studio-constraint-credstore-pg-system-gear`

`GtsPluginSelector` memoises the successful resolution for the life of the
process. If a feature gear touched a secret before this plugin had published
its instance (`mini-chat` provisioning its OAGW upstream at init, for one),
credstore would latch onto the static plugin for ever and this gear would do
nothing. System gears initialize before every non-system gear, which closes
that window by construction rather than by luck of ordering.

#### Changing the key makes the stored values unreadable

- [x] `p2` - **ID**: `cpt-studio-constraint-credstore-pg-key-rotation`

There is no re-encryption. A value that does not open under the current key
(almost always a rotated or replaced `STUDIO_CREDSTORE_KEY`) is logged and
treated as absent, failing closed like the value fence does, and the next
write re-seals it: secrets-bootstrap at boot for the environment-seeded keys,
a person re-entering a token for everything else. Returning an error instead
would leave consumers retrying something no retry can fix. A storage fault,
by contrast, is `ServiceUnavailable`, which credstore surfaces as a retryable
503 rather than a missing secret.

PostgreSQL only: the migration refuses any other backend.

## 3. Technical Architecture

### 3.1 Domain Model

- [x] `p2` - **ID**: `cpt-studio-entity-credstore-key-class`

A **key class** is `(tenant_id, reference, owner_id)`. `owner_id` is the
subject for a private secret and the nil UUID for the tenant class, so the key
never has to reason about `NULL`. The row id is a deterministic v5 UUID of the
class, so `put` is an idempotent upsert on the primary key and `get` and
`delete` need no secondary index. credstore keeps its own fence key in the
value store too (`cfs-internal-fence-key`, nil tenant); once the store is
durable, the fence key stops being regenerated every boot, which is what made
surviving metadata rows read as poisoned in the first place.

### 3.2 Component Model

#### Value cipher

- [x] `p2` - **ID**: `cpt-studio-component-credstore-pg-cipher`

##### Why this component exists

Values and metadata deliberately do not share a database, and the key is in
neither: the same split-knowledge stance credstore takes with its
fingerprints.

##### Responsibility scope

`crypto.rs`: AES-256-GCM with a random 96-bit nonce per write, through
AWS-LC (`aws-lc-rs`), the library the platform already uses for TLS and for
credstore's value fence, so a `--features fips` build runs this through the
validated module too. The associated data is the canonical class string
`tenant|reference|owner`, so a row copied to another tenant, renamed, or moved
between the tenant and private classes fails to open rather than decrypting
into the wrong caller's hands. The key is base64 (standard or URL-safe, padded
or not) decoding to exactly 32 bytes.

##### Responsibility boundaries

Knows nothing about tenants or credstore; seals and opens bytes.

##### Related components (by ID)

- `cpt-studio-component-credstore-pg` — used by

### 3.3 API Contracts

- [x] `p2` - **ID**: `cpt-studio-interface-credstore-pg-plugin`

- **Contracts**: none external
- **Technology**: `CredStorePluginClientV1` (`get`, `put`, `delete`), published as a ClientHub client scoped to the plugin's GTS instance id; the instance (segment `cf.studio._.pg_credstore.v1`, vendor and priority from config) is registered in the types-registry
- **Location**: [`credstore_pg/store.rs`](../../studio-backend/src/credstore_pg/store.rs)

No REST surface: the gear is reached only through credstore.

### 3.4 Internal Dependencies

| Dependency Gear | Interface Used | Purpose |
|-------------------|----------------|----------|
| `types_registry` | `TypesRegistryClient` | Publish the plugin instance so credstore can select it |
| `credstore` (`cpt-studio-component-platform-feature-gears`) | the plugin contract, inbound | The only caller |

### 3.5 External Dependencies

#### PostgreSQL

| Dependency Gear | Interface Used | Purpose |
|-------------------|---------------|---------|
| `cpt-studio-component-credstore-pg` | `toolkit-db` (SeaORM, secure ORM scoped per tenant) | The value table, in a database of its own |

### 3.6 Interactions & Sequences

#### Read a secret value

**ID**: `cpt-studio-seq-credstore-pg-read`

**Actors**: `cpt-studio-actor-member`

```mermaid
sequenceDiagram
    participant G as Studio gear
    participant C as credstore
    participant P as studio-credstore-pg
    participant DB as studio_credstore_values
    G->>C: get(reference)
    C->>C: resolve tenant, owner, sharing; metadata row
    C->>P: get(tenant, reference, owner)
    P->>DB: row by v5(tenant|reference|owner)
    P->>P: open(aad = tenant|reference|owner)
    P-->>C: value, or None if absent or not openable
    C->>C: check the value fence
    C-->>G: value
```

**Description**: A write is the same path with `seal` and an upsert. The
product-level path that stores a connection's token is
`cpt-studio-seq-connect-source`.

### 3.7 Database schemas & tables

- [x] `p3` - **ID**: `cpt-studio-db-credstore-values`

Database `studio_credstore_values`. It must exist before the first boot:
`auto_provision` does not create PostgreSQL databases, so a fresh volume gets
it from `studio-backend/docker/initdb/01-create-databases.sql`.

#### Table: studio_credstore_values

**ID**: `cpt-studio-dbtable-credstore-values`

**Schema**:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | deterministic v5 UUID of `(tenant_id, reference, owner_id)` |
| `tenant_id`, `owner_id` | UUID | `owner_id` is the nil UUID for the tenant key class |
| `reference` | TEXT | the credstore reference |
| `nonce`, `ciphertext` | BYTEA | the encrypted value |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**PK**: `id`

**Constraints**: `CHECK (length(reference) BETWEEN 1 AND 255)`; every column
`NOT NULL`.

**Additional info**: Encrypted with `STUDIO_CREDSTORE_KEY`; changing the key
makes stored values unreadable (`README.md`). No secondary index: every access
is by the derived primary key. An upsert replaces `nonce`, `ciphertext` and
`updated_at` and keeps `created_at`, which records when the class first got a
value.

**Example**:

| reference |
|--------|
| `studio-connection-…` |

### 3.8 Deployment Topology

In-process in the one `studio-backend` binary: gear `studio-credstore-pg`,
capabilities `[system, db]`, deps `types_registry`, config section
`gears.studio-credstore-pg` (`vendor` `constructorfabric`, which must equal
`credstore.vendor`; `priority` 50; `key_env` `STUDIO_CREDSTORE_KEY`). The key
is read from the environment so it never lands in a profile, an image layer or
`--print-config`. The docker, oidc and k8s profiles enable the gear; dev and
postgres do not, because their static plugin entries carry real values and
there is no secrets-bootstrap to re-supply them.

## 4. Additional context

`static-credstore-plugin` stays configured at priority 100 in every profile,
as the fallback for a deployment with no key.

## 5. Traceability

- **PRD**: [Constructor Studio](../prd/constructor-studio.md)
- **Design**: [Constructor Studio](constructor-studio.md)
- **ADRs**: [ADR index](../adr/README.md)
- **Code**: [`studio-backend/src/credstore_pg/`](../../studio-backend/src/credstore_pg/)
