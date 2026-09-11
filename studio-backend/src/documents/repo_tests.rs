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
//! would be proving it about an engine we do not ship. Where that server comes
//! from is [`crate::test_pg`]'s business.
//!
//! Nothing here assumes an empty database: these tests share one with every
//! other suite, so each takes a fresh tenant id and every query is
//! tenant-scoped.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use time::OffsetDateTime;
use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use uuid::Uuid;

use crate::documents::entity::{analysis, capability, doc_type, document, document_binding, stage};
use crate::documents::migrations::Migrator;
use crate::documents::repo::{
    DocScope, DocumentsRepo, analysis_row_id, binding_row_id, capability_row_id, stage_row_id,
    type_row_id,
};

/// The migrations, run once against the shared database.
///
/// A `OnceCell` so no two test threads race to create the same tables. The
/// server itself, and the choice between a container and `STUDIO_TEST_PG_DSN`,
/// belong to [`crate::test_pg`].
static MIGRATED: OnceCell<&'static str> = OnceCell::const_new();

async fn db() -> &'static str {
    MIGRATED
        .get_or_init(|| async {
            let dsn = crate::test_pg::shared_dsn().await;
            let conn = connect_db(dsn, ConnectOpts::default())
                .await
                .unwrap_or_else(|e| panic!("connect to {dsn} failed: {e}"));
            run_migrations_for_testing(&conn, Migrator::migrations())
                .await
                .expect("run migrations");
            dsn
        })
        .await
}

async fn repo() -> DocumentsRepo {
    let dsn = db().await;
    let conn = connect_db(
        dsn,
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

/// Editing a stage's gates has to take. A column left out of the conflict
/// update makes the first write of a key permanent however many edits follow
/// it, and a gate nobody can remove is worse than one nobody set.
#[tokio::test]
async fn rewriting_a_stage_updates_its_gates_in_place() {
    let repo = repo().await;
    let ws = tenant();
    let mut gated = stage_row(ws, "discovery", "Discovery", false);
    gated.gates = "[\"bloat\"]".to_string();
    repo.upsert_stage(gated).await.expect("insert");

    let mut regated = stage_row(ws, "discovery", "Discovery", false);
    regated.gates = "[\"purpose\",\"leak\"]".to_string();
    repo.upsert_stage(regated).await.expect("re-gate");

    let rows = repo.list_stages(&[ws]).await.expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].gates, "[\"purpose\",\"leak\"]");
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

// ── ingested-document bindings ───────────────────────────────────────────────

fn binding(
    ws: Uuid,
    project: Option<Uuid>,
    node_id: &str,
    path: &str,
    type_key: Option<&str>,
    state: &str,
) -> document_binding::Model {
    let now = OffsetDateTime::now_utc();
    document_binding::Model {
        id: binding_row_id(ws, project, node_id),
        tenant_id: ws,
        project_id: project,
        node_id: node_id.to_string(),
        path: path.to_string(),
        type_key: type_key.map(str::to_string),
        state: state.to_string(),
        confidence: type_key.map(|_| 0.76),
        source: type_key.map(|_| "heuristic".to_string()),
        candidates: "[]".to_string(),
        conforms: type_key.map(|_| false),
        validation: "{}".to_string(),
        content_sha: "sha".to_string(),
        created_at: now,
        updated_at: now,
    }
}

/// `m0007` carries the nullable columns an undetermined binding needs, and the
/// `REAL` confidence. Asserted by writing through them rather than by reading
/// DDL, the way the tombstone column is.
#[tokio::test]
async fn a_binding_round_trips_including_the_columns_that_may_be_null() {
    let repo = repo().await;
    let ws = tenant();
    repo.upsert_bindings(&[
        binding(
            ws,
            None,
            "node-a",
            "docs/adr/0001.md",
            Some("adr"),
            "detected",
        ),
        binding(ws, None, "node-b", "README.md", None, "unknown"),
    ])
    .await
    .expect("insert");

    let (rows, total) = repo
        .list_bindings(ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .expect("list");
    assert_eq!(total, 2);
    let undetermined = rows
        .iter()
        .find(|r| r.node_id == "node-b")
        .expect("the undetermined one");
    assert_eq!(undetermined.type_key, None);
    assert_eq!(undetermined.confidence, None);
    assert_eq!(undetermined.conforms, None);
    let detected = rows
        .iter()
        .find(|r| r.node_id == "node-a")
        .expect("the detected one");
    assert_eq!(detected.confidence, Some(0.76));
    assert_eq!(detected.source.as_deref(), Some("heuristic"));
}

/// Re-classifying the same file has to update one row. The id is uuid5 of
/// `(tenant, project, node)` precisely so a second run cannot append a second
/// opinion about the same file.
#[tokio::test]
async fn re_classifying_the_same_file_updates_one_row() {
    let repo = repo().await;
    let ws = tenant();
    repo.upsert_binding(binding(
        ws,
        None,
        "node-a",
        "docs/thing.md",
        None,
        "unknown",
    ))
    .await
    .expect("first run");
    repo.upsert_binding(binding(
        ws,
        None,
        "node-a",
        "docs/thing.md",
        Some("prd"),
        "detected",
    ))
    .await
    .expect("second run");

    let (rows, total) = repo
        .list_bindings(ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .expect("list");
    assert_eq!(total, 1, "one file, one binding");
    assert_eq!(rows[0].type_key.as_deref(), Some("prd"));
    assert_eq!(rows[0].state, "detected");
}

/// The effective set for a project: its own bindings plus the workspace-level
/// ones it inherits — and nothing belonging to a sibling project.
#[tokio::test]
async fn a_project_sees_its_own_bindings_and_the_inherited_ones() {
    let repo = repo().await;
    let ws = tenant();
    let (project, sibling) = (Uuid::new_v4(), Uuid::new_v4());
    repo.upsert_bindings(&[
        binding(
            ws,
            None,
            "node-ws",
            "docs/shared.md",
            Some("prd"),
            "detected",
        ),
        binding(ws, Some(project), "node-p", "docs/mine.md", None, "unknown"),
        binding(
            ws,
            Some(sibling),
            "node-s",
            "docs/theirs.md",
            None,
            "unknown",
        ),
    ])
    .await
    .expect("insert");

    let (rows, total) = repo
        .list_bindings(ws, DocScope::Effective(project), 0, None)
        .await
        .expect("effective");
    assert_eq!(total, 2);
    let paths: Vec<&str> = rows.iter().map(|r| r.path.as_str()).collect();
    assert!(paths.contains(&"docs/shared.md"), "{paths:?}");
    assert!(paths.contains(&"docs/mine.md"), "{paths:?}");
    assert!(!paths.contains(&"docs/theirs.md"), "{paths:?}");

    let (ws_only, ws_total) = repo
        .list_bindings(ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .expect("workspace level");
    assert_eq!(
        ws_total, 1,
        "a project's own binding is not workspace-level"
    );
    assert_eq!(ws_only[0].path, "docs/shared.md");
}

/// The same graph node bound at workspace and at project level is two rows, not
/// a collision — the project id is part of the identity.
#[tokio::test]
async fn the_same_node_at_two_levels_is_two_bindings() {
    let repo = repo().await;
    let ws = tenant();
    let project = Uuid::new_v4();
    repo.upsert_bindings(&[
        binding(ws, None, "node-a", "docs/thing.md", Some("prd"), "detected"),
        binding(
            ws,
            Some(project),
            "node-a",
            "docs/thing.md",
            Some("design"),
            "manual",
        ),
    ])
    .await
    .expect("insert");

    let (rows, total) = repo
        .list_bindings(ws, DocScope::Effective(project), 0, None)
        .await
        .expect("effective");
    assert_eq!(total, 2);
    assert_ne!(rows[0].id, rows[1].id);
}

/// The state vocabulary is a CHECK constraint, not a convention. A row written
/// by a future build with a state this one does not know must be refused here,
/// where it is cheap, rather than read back as an unparseable binding.
#[tokio::test]
async fn a_state_outside_the_vocabulary_is_refused_by_the_database() {
    let repo = repo().await;
    let ws = tenant();
    let refused = repo
        .upsert_binding(binding(
            ws,
            None,
            "node-a",
            "docs/thing.md",
            None,
            "somewhat_sure",
        ))
        .await;
    assert!(refused.is_err(), "the CHECK constraint is real");
}

#[tokio::test]
async fn forgetting_a_binding_leaves_the_others_alone() {
    let repo = repo().await;
    let ws = tenant();
    repo.upsert_bindings(&[
        binding(ws, None, "node-a", "a.md", None, "unknown"),
        binding(ws, None, "node-b", "b.md", None, "unknown"),
    ])
    .await
    .expect("insert");

    let gone = repo
        .delete_binding(ws, binding_row_id(ws, None, "node-a"))
        .await
        .expect("delete");
    assert!(gone);

    let (rows, total) = repo
        .list_bindings(ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .expect("list");
    assert_eq!(total, 1);
    assert_eq!(rows[0].node_id, "node-b");
}
