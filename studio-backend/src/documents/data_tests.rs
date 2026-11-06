//! The gear's records kept as domain objects: the move out of the tables,
//! upserts that keep what the tables kept, long fields, cascades and pages.
//!
//! The model is the real one, in memory; the tables are the real Postgres of
//! [`super::repo_tests`].

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use serde_json::json;
use time::{Duration, OffsetDateTime};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::data::DocumentsData;
use super::entity::{analysis, document, document_binding};
use super::repo::{DocScope, analysis_row_id, binding_row_id};
use crate::domain_model::port::{DomainObjects, in_memory};

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(1))
        .subject_tenant_id(Uuid::from_u128(1))
        .token_scopes(vec!["*".to_string()])
        .build()
        .expect("test security context")
}

struct Rig {
    data: DocumentsData,
    repo: Arc<super::repo::DocumentsRepo>,
    port: Arc<dyn DomainObjects>,
    ws: Uuid,
}

async fn rig() -> Rig {
    let repo = Arc::new(super::repo_tests::repo().await);
    let port = in_memory();
    Rig {
        data: DocumentsData::with_port(Arc::clone(&repo), Arc::clone(&port)),
        repo,
        port,
        ws: Uuid::new_v4(),
    }
}

fn at(seconds: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_790_000_000).unwrap() + Duration::seconds(seconds)
}

fn doc(
    ws: Uuid,
    project: Option<Uuid>,
    title: &str,
    content: &str,
    updated: i64,
) -> document::Model {
    document::Model {
        id: Uuid::new_v4(),
        tenant_id: ws,
        project_id: project,
        type_key: "prd".to_string(),
        title: title.to_string(),
        content: content.to_string(),
        status: 0,
        conforms: false,
        validation: "{}".to_string(),
        capabilities: "[]".to_string(),
        requirements: "[]".to_string(),
        inferred_capabilities: "[]".to_string(),
        created_by: "someone".to_string(),
        created_at: at(0),
        updated_at: at(updated),
    }
}

fn binding(ws: Uuid, node: &str, path: &str, created: i64) -> document_binding::Model {
    document_binding::Model {
        id: binding_row_id(ws, None, node),
        tenant_id: ws,
        project_id: None,
        node_id: node.to_string(),
        path: path.to_string(),
        type_key: Some("prd".to_string()),
        state: "detected".to_string(),
        confidence: Some(0.5),
        source: Some("heuristic".to_string()),
        candidates: "[]".to_string(),
        conforms: Some(false),
        validation: "{}".to_string(),
        capabilities: "[]".to_string(),
        requirements: "[]".to_string(),
        inferred_capabilities: "[]".to_string(),
        content_sha: "sha".to_string(),
        created_at: at(created),
        updated_at: at(created),
    }
}

fn verdict(ws: Uuid, binding_id: Uuid, detector: &str) -> analysis::Model {
    analysis::Model {
        id: analysis_row_id(binding_id, detector),
        tenant_id: ws,
        document_id: None,
        binding_id: Some(binding_id),
        detector: detector.to_string(),
        state: "passed".to_string(),
        task_id: None,
        summary: String::new(),
        created_at: at(0),
        updated_at: at(0),
    }
}

#[tokio::test]
async fn what_the_tables_held_moves_on_the_first_touch_and_only_then() {
    let r = rig().await;
    r.repo
        .upsert_binding(binding(r.ws, "n-a", "docs/a.md", 0))
        .await
        .unwrap();
    r.repo
        .upsert_binding(binding(r.ws, "n-b", "docs/b.md", 0))
        .await
        .unwrap();

    let (rows, total) = r
        .data
        .list_bindings(&ctx(), r.ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .unwrap();
    assert_eq!(total, 2);
    let paths: Vec<&str> = rows.iter().map(|b| b.path.as_str()).collect();
    assert_eq!(
        paths,
        ["docs/a.md", "docs/b.md"],
        "in path order, as the table answered"
    );
    let (left, _) = r
        .repo
        .list_bindings(r.ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .unwrap();
    assert!(
        left.is_empty(),
        "the tables' copies are dropped once the model holds them"
    );

    // The model answers now: a row the table gains later is not read.
    r.repo
        .upsert_binding(binding(r.ws, "n-c", "docs/c.md", 0))
        .await
        .unwrap();
    let (_, total) = r
        .data
        .list_bindings(&ctx(), r.ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .unwrap();
    assert_eq!(total, 2);
}

#[tokio::test]
async fn an_upsert_changes_what_the_table_would_and_keeps_the_rest() {
    let r = rig().await;
    r.data
        .upsert_binding(&ctx(), binding(r.ws, "n-a", "docs/a.md", 10))
        .await
        .unwrap();
    let mut again = binding(r.ws, "n-a", "docs/renamed.md", 99);
    again.state = "confirmed".to_string();
    r.data.upsert_binding(&ctx(), again.clone()).await.unwrap();

    let got = r
        .data
        .get_binding(&ctx(), r.ws, again.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got.path, "docs/renamed.md");
    assert_eq!(got.state, "confirmed");
    assert_eq!(got.updated_at, at(99));
    assert_eq!(
        got.created_at,
        at(10),
        "a re-classified file keeps the date it appeared"
    );
}

#[tokio::test]
async fn a_long_document_is_kept_in_pieces_and_read_back_whole() {
    let r = rig().await;
    let long: String = "Требование: система хранит документы. ".repeat(6_000);
    assert!(long.len() > 200 * 1024);
    let d = doc(r.ws, None, "Long", &long, 1);
    r.data.upsert_doc(&ctx(), d.clone()).await.unwrap();

    let (stored, _) = r
        .port
        .query(&ctx(), json!({"type": "studio-document", "where": {"id": {"_eq": format!("studio-document:{}", d.id)}}}))
        .await
        .unwrap();
    assert!(
        stored[0].payload["content"].get("$chunks").is_some(),
        "{}",
        stored[0].payload
    );

    let got = r.data.get_doc(&ctx(), r.ws, d.id).await.unwrap().unwrap();
    assert_eq!(got.content, long);

    // Shorter again: the old pieces are not read into it.
    let mut short = d.clone();
    short.content = "short".to_string();
    r.data.upsert_doc(&ctx(), short).await.unwrap();
    let got = r.data.get_doc(&ctx(), r.ws, d.id).await.unwrap().unwrap();
    assert_eq!(got.content, "short");
}

#[tokio::test]
async fn deleting_a_binding_takes_its_verdicts() {
    let r = rig().await;
    let a = binding(r.ws, "n-a", "docs/a.md", 0);
    let b = binding(r.ws, "n-b", "docs/b.md", 0);
    r.data
        .upsert_bindings(&ctx(), &[a.clone(), b.clone()])
        .await
        .unwrap();
    r.data
        .upsert_analysis(&ctx(), verdict(r.ws, a.id, "purpose"))
        .await
        .unwrap();
    r.data
        .upsert_analysis(&ctx(), verdict(r.ws, b.id, "purpose"))
        .await
        .unwrap();

    assert_eq!(
        r.data
            .delete_bindings(&ctx(), r.ws, &[a.id, Uuid::new_v4()])
            .await
            .unwrap(),
        1
    );
    assert!(
        r.data
            .list_binding_analyses(&ctx(), r.ws, &[a.id])
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        r.data
            .list_binding_analyses(&ctx(), r.ws, &[b.id])
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        !r.data.delete_binding(&ctx(), r.ws, a.id).await.unwrap(),
        "already gone"
    );
}

#[tokio::test]
async fn documents_page_newest_first_within_their_scope() {
    let r = rig().await;
    let project = Uuid::new_v4();
    let other = Uuid::new_v4();
    let old = doc(r.ws, None, "old", "x", 1);
    let mid = doc(r.ws, Some(project), "mid", "x", 2);
    let new = doc(r.ws, None, "new", "x", 3);
    let elsewhere = doc(r.ws, Some(other), "elsewhere", "x", 4);
    for d in [&old, &mid, &new, &elsewhere] {
        r.data.upsert_doc(&ctx(), d.clone()).await.unwrap();
    }

    let (page, total) = r
        .data
        .list_docs(&ctx(), r.ws, DocScope::Effective(project), 1, Some(1))
        .await
        .unwrap();
    assert_eq!(
        total, 3,
        "the workspace's and this project's, not another's"
    );
    assert_eq!(
        page.iter().map(|d| d.title.as_str()).collect::<Vec<_>>(),
        ["mid"]
    );

    let (all, _) = r
        .data
        .list_docs(&ctx(), r.ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .unwrap();
    assert_eq!(
        all.iter().map(|d| d.title.as_str()).collect::<Vec<_>>(),
        ["new", "old"]
    );

    assert!(r.data.delete_doc(&ctx(), r.ws, old.id).await.unwrap());
    assert!(!r.data.delete_doc(&ctx(), r.ws, old.id).await.unwrap());
    let found = r
        .data
        .existing_doc_ids(&ctx(), r.ws, &[old.id, new.id])
        .await
        .unwrap();
    assert_eq!(found.into_iter().collect::<Vec<_>>(), [new.id]);
}

#[tokio::test]
async fn a_gear_record_is_refused_to_the_generic_object_writes() {
    let r = rig().await;
    let d = doc(r.ws, None, "Kept", "x", 1);
    r.data.upsert_doc(&ctx(), d.clone()).await.unwrap();

    let forged = r
        .port
        .upsert(
            &ctx(),
            "studio-document",
            "forged",
            json!({"title": "Forged"}),
        )
        .await
        .unwrap_err();
    assert!(
        forged.to_string().contains("kept by studio-documents"),
        "{forged}"
    );
    let (stored, _) = r
        .port
        .query(
            &ctx(),
            json!({"type": "studio-document", "where": {"title": {"_eq": "Kept"}}}),
        )
        .await
        .unwrap();
    let removed = r
        .port
        .delete(&ctx(), &stored[0].instance_id)
        .await
        .unwrap_err();
    assert!(removed.to_string().contains("kept by"), "{removed}");
    assert!(r.data.get_doc(&ctx(), r.ws, d.id).await.unwrap().is_some());
}

#[tokio::test]
async fn switching_back_to_tables_moves_the_rows_back_and_out_of_the_model() {
    let r = rig().await;
    let d = doc(r.ws, None, "Round trip", "body", 5);
    r.data.upsert_doc(&ctx(), d.clone()).await.unwrap();
    r.data
        .upsert_binding(&ctx(), binding(r.ws, "n-r", "docs/r.md", 0))
        .await
        .unwrap();

    let tables = DocumentsData::back_to_tables_with(
        std::sync::Arc::clone(&r.repo),
        std::sync::Arc::clone(&r.port),
    );
    let (docs, total) = tables
        .list_docs(&ctx(), r.ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .unwrap();
    assert_eq!(total, 1);
    assert_eq!(docs[0].title, "Round trip");
    let (bindings, _) = r
        .repo
        .list_bindings(r.ws, DocScope::WorkspaceLevel, 0, None)
        .await
        .unwrap();
    assert_eq!(
        bindings.len(),
        1,
        "every table came back, not only the one asked about"
    );
    let (left, _) = r
        .port
        .query(
            &ctx(),
            json!({"type": "studio-document", "where": {"tenant_id": {"_eq": r.ws}}}),
        )
        .await
        .unwrap();
    assert!(left.is_empty(), "the model keeps no copy");
}
