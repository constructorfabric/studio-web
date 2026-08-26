//! studio-graph-storage — a typed, multi-tenant knowledge graph.
//!
//! ## Why this gear is vendored here rather than depended on
//!
//! The upstream gear lives in `gears-rust` under `gears/graph-storage` and is
//! not published: it takes a documented raw-SQL exception to reach SQL/PGQ
//! (`GRAPH_TABLE`), and where that emitting code is allowed to live is still
//! open on the platform side — see the gear's ADR-0006 and the secure-orm
//! ADR-0002 discussion. Until that settles, the source is carried here.
//!
//! The module layout is a deliberate copy of the upstream crate's — `api` ->
//! `domain` -> `infra`, plus `sdk` where the standalone `graph-storage-sdk`
//! crate's contents go — so that replacing this directory with a dependency on
//! the official gear is a mechanical change and not a rewrite. Nothing is
//! omitted and nothing is rewritten: the only edits to the copied sources are
//! module paths, re-anchored from the crate root to `crate::graph_storage`.
//!
//! ## Database
//!
//! This gear does NOT run on the assembly's main server. Its migrations need
//! `CREATE EXTENSION vector`, `CREATE PROPERTY GRAPH` (SQL/PGQ, PostgreSQL
//! 19+) and an HNSW index. `config/*.yaml` routes it to `pg_graph`, backed by
//! the `graph-postgres` service in docker-compose.yml.

// Upstream, this is a LIBRARY crate: its public surface — the SDK trait, the
// GTS type constants, the hybrid-retrieval queries, the pattern builder — is
// "used" by definition, because consumers live across a crate boundary.
// Vendored into a binary, the compiler sees only this assembly's own calls, and
// everything reached solely through `ClientHub` or not yet routed to REST reads
// as dead. Silencing that here, module-wide, is what lets the copied sources
// stay byte-identical to upstream; the alternative is deleting surface we would
// have to restore when the official gear replaces this directory.
#![allow(unused_imports, dead_code)]

// === PUBLIC CONTRACT (the upstream `graph-storage-sdk` crate) ===
pub mod sdk;

pub use sdk::{GraphStats, GraphStorageClientV1, GraphStorageError};

// === GEAR ENTRY POINT ===
pub mod gear;

pub use gear::GraphStorage;

// === INTERNAL MODULES ===
pub mod api;
pub mod config;
pub mod domain;
pub mod infra;
