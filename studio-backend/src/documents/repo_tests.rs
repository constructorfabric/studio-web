//! Postgres-backed tests for the catalogue and document tables.
//!
//! These reach what the pure decision functions deliberately cannot: the real
//! migration set, the `(tenant_id, key)` row identity that lets an organization
//! and a workspace define the same key without colliding, the multi-tenant `IN`
//! scope the three-level catalogue reads through, and the cascade that takes a
//! document's verdicts with it.
//!
//! They run against a **real PostgreSQL**, because the assembly ships one for
//! every gear database and a test that proved the SQL on a different engine
//! would be proving it about an engine we do not ship. The database comes from
//! Testcontainers: one per test process, started on first use and thrown away
//! with it. That buys two things a shared server does not.
//!
//! * `cargo test` needs no setup beyond a Docker daemon -- no compose stack to
//!   remember, no environment to export.
//! * An EDITED migration always re-applies. Against a long-lived database the
//!   migration ledger says it already ran, so the change silently does not take
//!   and the test either fails against the old schema or, worse, passes against
//!   it. A fresh database cannot have that problem.
//!
//! `STUDIO_TEST_PG_DSN` still overrides it, for pointing at a database you
//! already have. Nothing here assumes an empty one: every test uses a fresh
//! tenant id, and every query is tenant-scoped.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use testcontainers::ContainerAsync;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;
use time::OffsetDateTime;
use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use crate::documents::entity::{analysis, capability, doc_type, document, stage};
use crate::documents::migrations::Migrator;
use crate::documents::repo::{
    DocumentsRepo, analysis_row_id, capability_row_id, stage_row_id, type_row_id,
};

/// The database every test in this process shares.
///
/// A `OnceCell` because the container has to outlive the tests that use it:
/// dropping the `ContainerAsync` stops Postgres, so the guard is held here for
/// the life of the process rather than by whichever test happened to start it.
/// Migrations run once, inside the same initialisation, so no two test threads
/// race to create the same tables.
static DB: OnceCell<TestDb> = OnceCell::const_new();

struct TestDb {
    dsn: String,
    /// Held, never read: this is what keeps the container alive. `None` when
    /// `STUDIO_TEST_PG_DSN` pointed us at a database somebody else owns.
    _container: Option<ContainerAsync<Postgres>>,
}

async fn db() -> &'static TestDb {
    DB.get_or_init(|| async {
        let (dsn, container) = match std::env::var("STUDIO_TEST_PG_DSN") {
            Ok(dsn) => (dsn, None),
            Err(_) => {
                let container = Postgres::default().start().await.expect(
                    "start a PostgreSQL container -- these tests need a Docker daemon, \
                         or set STUDIO_TEST_PG_DSN to a database you already have",
                );
                // Ask the container where it is rather than assuming
                // localhost: when the tests themselves run inside a container,
                // the published port is on the host, not on this loopback.
                let host = container.get_host().await.expect("container host");
                let port = container
                    .get_host_port_ipv4(5432)
                    .await
                    .expect("published port");
                (
                    format!("postgres://postgres:postgres@{host}:{port}/postgres"),
                    Some(container),
                )
            }
        };

        let conn = connect_db(&dsn, ConnectOpts::default())
            .await
            .unwrap_or_else(|e| panic!("connect to {dsn} failed: {e}"));
        run_migrations_for_testing(&conn, Migrator::migrations())
            .await
            .expect("run migrations");

        TestDb {
            dsn,
            _container: container,
        }
    })
    .await
}

async fn repo() -> DocumentsRepo {
    let db = db().await;
    let conn = connect_db(
        &db.dsn,
        ConnectOpts {
            max_conns: Some(4),
            min_conns: Some(1),
            ..Default::default()
        },
    )
    .await
    .expect("connect");
    DocumentsRepo::new(Arc::new(DBProvider::<anyhow::Error>::new(conn)))
}

/// A tenant id no other test uses.
fn tenant() -> Uuid {
    Uuid::new_v4()
}

fn row(tenant: Uuid, key: &str, name: &str, hidden: bool) -> doc_type::Model {
    let now = OffsetDateTime::now_utc();
    doc_type::Model {
        id: type_row_id(tenant, key),
        tenant_id: tenant,
        key: key.to_string(),
        name: name.to_string(),
        description: String::new(),
        gts_type_id: "gts.cf.studio.doc.document_type.v1~".to_string(),
        template: "{\"body\":\"\",\"sections\":[]}".to_string(),
        hidden,
        created_at: now,
        updated_at: now,
    }
}

#[tokio::test]
async fn the_migrations_create_a_table_with_the_tombstone_column() {
    // `m0002` adds `hidden`; if its SQL were wrong the insert below would fail,
    // so assert the column by writing through it rather than by reading DDL.
    let repo = repo().await;
    let ws = tenant();
    repo.upsert_type(row(ws, "prd", "PRD", true))
        .await
        .expect("insert a tombstone");
    let rows = repo.list_types(&[ws]).await.expect("list");
    assert_eq!(rows.len(), 1);
    assert!(rows[0].hidden, "the column round-trips");
}

#[tokio::test]
async fn one_query_reads_the_organization_and_the_workspace_together() {
    let repo = repo().await;
    let (org, ws) = (tenant(), tenant());
    repo.upsert_type(row(org, "prd", "House PRD", false))
        .await
        .expect("org row");
    repo.upsert_type(row(ws, "prd", "Team PRD", false))
        .await
        .expect("workspace row");

    let both = repo.list_types(&[org, ws]).await.expect("list both");
    assert_eq!(both.len(), 2, "the same key at two levels is two rows");

    let only_ws = repo.list_types(&[ws]).await.expect("list one");
    assert_eq!(only_ws.len(), 1);
    assert_eq!(only_ws[0].tenant_id, ws);
}

#[tokio::test]
async fn a_tenant_outside_the_scope_is_not_read() {
    let repo = repo().await;
    let (org, ws, other) = (tenant(), tenant(), tenant());
    repo.upsert_type(row(other, "prd", "Someone else's PRD", false))
        .await
        .expect("other workspace row");
    let rows = repo.list_types(&[org, ws]).await.expect("list");
    assert!(
        rows.is_empty(),
        "the scope is an IN filter, not an unconstrained read"
    );
}

#[tokio::test]
async fn an_empty_chain_reads_nothing() {
    let repo = repo().await;
    let ws = tenant();
    repo.upsert_type(row(ws, "prd", "Team PRD", false))
        .await
        .expect("row");
    let rows = repo.list_types(&[]).await.expect("list");
    assert!(
        rows.is_empty(),
        "an empty scope must not widen to everything"
    );
}

#[tokio::test]
async fn rewriting_a_type_updates_the_tombstone_flag_in_place() {
    // `hidden` has to be in the ON CONFLICT update list, or hiding an entry
    // that already exists would silently keep showing it.
    let repo = repo().await;
    let ws = tenant();
    repo.upsert_type(row(ws, "adr", "ADR", false))
        .await
        .expect("insert");
    repo.upsert_type(row(ws, "adr", "ADR", true))
        .await
        .expect("hide");

    let rows = repo.list_types(&[ws]).await.expect("list");
    assert_eq!(rows.len(), 1, "the key is upserted, not duplicated");
    assert!(rows[0].hidden);
}

fn stage_row(tenant: Uuid, key: &str, label: &str, hidden: bool) -> stage::Model {
    let now = OffsetDateTime::now_utc();
    stage::Model {
        id: stage_row_id(tenant, key),
        tenant_id: tenant,
        key: key.to_string(),
        label: label.to_string(),
        required: false,
        ordinal: 15,
        requires: "[]".to_string(),
        gates: "[]".to_string(),
        hidden,
        created_at: now,
        updated_at: now,
    }
}

#[tokio::test]
async fn the_stage_table_exists_and_round_trips_a_row() {
    // `m0003` creates it. `ordinal` is the column that would break first if the
    // rename away from `position` had been half-applied.
    let repo = repo().await;
    let ws = tenant();
    repo.upsert_stage(stage_row(ws, "discovery", "Discovery", false))
        .await
        .expect("insert");
    let rows = repo.list_stages(&[ws]).await.expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].label, "Discovery");
    assert_eq!(rows[0].ordinal, 15);
}

#[tokio::test]
async fn a_stage_and_a_document_type_may_share_a_key_under_one_tenant() {
    // `prd` is both a stage and a document type. Two row-id namespaces, two
    // tables, so neither write can land on the other.
    let repo = repo().await;
    let ws = tenant();
    repo.upsert_type(row(ws, "prd", "PRD document", false))
        .await
        .expect("type");
    repo.upsert_stage(stage_row(ws, "prd", "PRD stage", false))
        .await
        .expect("stage");

    let types = repo.list_types(&[ws]).await.expect("list types");
    let stages = repo.list_stages(&[ws]).await.expect("list stages");
    assert_eq!(types.len(), 1);
    assert_eq!(stages.len(), 1);
    assert_ne!(
        types[0].id, stages[0].id,
        "the two ids are not the same uuid"
    );
}

#[tokio::test]
async fn rewriting_a_stage_updates_its_order_in_place() {
    let repo = repo().await;
    let ws = tenant();
    repo.upsert_stage(stage_row(ws, "discovery", "Discovery", false))
        .await
        .expect("insert");
    let mut moved = stage_row(ws, "discovery", "Discovery", false);
    moved.ordinal = 95;
    repo.upsert_stage(moved).await.expect("move");

    let rows = repo.list_stages(&[ws]).await.expect("list");
    assert_eq!(rows.len(), 1, "the key is upserted, not duplicated");
    assert_eq!(rows[0].ordinal, 95);
}

#[tokio::test]
async fn deleting_a_workspace_override_leaves_the_organization_row_alone() {
    // The safety property of `delete_type`: a workspace reverting `prd` must
    // not take the organization's `prd` away from every sibling workspace.
    let repo = repo().await;
    let (org, ws) = (tenant(), tenant());
    repo.upsert_type(row(org, "prd", "House PRD", false))
        .await
        .expect("org row");
    repo.upsert_type(row(ws, "prd", "Team PRD", false))
        .await
        .expect("workspace row");

    let removed = repo.delete_type(ws, "prd").await.expect("delete");
    assert!(removed);

    let rows = repo.list_types(&[org, ws]).await.expect("list");
    assert_eq!(rows.len(), 1, "only the workspace row is gone");
    assert_eq!(rows[0].tenant_id, org);
    assert_eq!(rows[0].name, "House PRD");
}

#[tokio::test]
async fn deleting_a_key_this_level_never_overrode_is_not_an_error() {
    // The route is idempotent, so the repo has to answer rather than fail.
    let repo = repo().await;
    let ws = tenant();
    assert!(!repo.delete_type(ws, "prd").await.expect("delete type"));
    assert!(!repo.delete_stage(ws, "intent").await.expect("delete stage"));
}

#[tokio::test]
async fn deleting_a_tombstone_brings_the_hidden_entry_back() {
    // Hiding adds a row; reverting removes it. Together they are the two
    // directions of one setting rather than a one-way door.
    let repo = repo().await;
    let ws = tenant();
    repo.upsert_stage(stage_row(ws, "testing", "unused", true))
        .await
        .expect("hide");
    assert_eq!(repo.list_stages(&[ws]).await.expect("list").len(), 1);

    assert!(repo.delete_stage(ws, "testing").await.expect("revert"));
    assert!(
        repo.list_stages(&[ws]).await.expect("list").is_empty(),
        "nothing of this workspace's own is left, so the built-in shows through"
    );
}

fn cap_row(tenant: Uuid, key: &str, label: &str, terms: &str) -> capability::Model {
    let now = OffsetDateTime::now_utc();
    capability::Model {
        id: capability_row_id(tenant, key),
        tenant_id: tenant,
        key: key.to_string(),
        label: label.to_string(),
        terms: terms.to_string(),
        hidden: false,
        created_at: now,
        updated_at: now,
    }
}

#[tokio::test]
async fn the_capability_table_round_trips_its_terms() {
    // `m0004` creates it; `terms` is a JSON array in a text column, so the
    // round trip is the only thing that proves the two agree.
    let repo = repo().await;
    let ws = tenant();
    repo.upsert_capability(cap_row(ws, "auth", "Sign-in", "[\"keycloak\",\"oidc\"]"))
        .await
        .expect("insert");
    let rows = repo.list_capabilities(&[ws]).await.expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].terms, "[\"keycloak\",\"oidc\"]");
}

#[tokio::test]
async fn a_capability_and_a_stage_may_share_a_key_under_one_tenant() {
    let repo = repo().await;
    let ws = tenant();
    repo.upsert_stage(stage_row(ws, "deploy", "Deploy", false))
        .await
        .expect("stage");
    repo.upsert_capability(cap_row(ws, "deploy", "Deployment", "[]"))
        .await
        .expect("capability");
    let stages = repo.list_stages(&[ws]).await.expect("stages");
    let caps = repo.list_capabilities(&[ws]).await.expect("caps");
    assert_eq!(stages.len(), 1);
    assert_eq!(caps.len(), 1);
    assert_ne!(stages[0].id, caps[0].id);
}

#[tokio::test]
async fn reverting_a_capability_leaves_the_level_below_alone() {
    let repo = repo().await;
    let (org, ws) = (tenant(), tenant());
    repo.upsert_capability(cap_row(org, "auth", "House sign-in", "[]"))
        .await
        .expect("org");
    repo.upsert_capability(cap_row(ws, "auth", "Team sign-in", "[]"))
        .await
        .expect("ws");
    assert!(repo.delete_capability(ws, "auth").await.expect("revert"));
    let rows = repo.list_capabilities(&[org, ws]).await.expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].tenant_id, org);
}

#[tokio::test]
async fn deleting_a_document_takes_its_verdicts_with_it() {
    // The rule lives in the schema (ON DELETE CASCADE), not in the delete path,
    // so it holds for every writer rather than for the one that remembered. A
    // verdict about a document that no longer exists is litter, not data.
    let repo = repo().await;
    let ws = tenant();
    let doc_id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();

    repo.upsert_doc(document::Model {
        id: doc_id,
        tenant_id: ws,
        project_id: None,
        type_key: "prd".to_string(),
        title: "A PRD".to_string(),
        content: String::new(),
        status: 0,
        conforms: false,
        validation: "{}".to_string(),
        capabilities: "[]".to_string(),
        created_by: "someone".to_string(),
        created_at: now,
        updated_at: now,
    })
    .await
    .expect("document");

    repo.upsert_analysis(analysis::Model {
        id: analysis_row_id(doc_id, "bloat"),
        tenant_id: ws,
        document_id: doc_id,
        detector: "bloat".to_string(),
        state: "passed".to_string(),
        task_id: Some("task-1".to_string()),
        summary: String::new(),
        created_at: now,
        updated_at: now,
    })
    .await
    .expect("verdict");

    assert_eq!(
        repo.list_analyses(ws, &[doc_id]).await.expect("list").len(),
        1
    );
    assert!(repo.delete_doc(ws, doc_id).await.expect("delete"));
    assert!(
        repo.list_analyses(ws, &[doc_id])
            .await
            .expect("list")
            .is_empty(),
        "the verdict went with the document"
    );
}
