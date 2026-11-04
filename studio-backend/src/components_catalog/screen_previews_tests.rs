//! What a build may hand in as a screen's picture, and which pictures are
//! kept and in which order they are read back.

use std::sync::Arc;

use uuid::Uuid;

use super::*;
use crate::catalog_graph::MemorySink;

/// A 1x1 PNG.
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

fn preview(commit: &str, route: &str, order: u32) -> NewScreenPreview {
    NewScreenPreview {
        component: "@constructor-studio/projects-mfe".into(),
        version: Some("0.1.0".into()),
        commit: commit.into(),
        route: route.into(),
        label: Some("Projects".into()),
        order,
        image: format!("data:image/png;base64,{PNG}"),
        width: Some(1280),
        height: Some(800),
    }
}

fn ctx(tenant: u128) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xca7))
        .subject_type("user")
        .subject_tenant_id(Uuid::from_u128(tenant))
        .build()
        .expect("security context")
}

fn service() -> CatalogService {
    CatalogService::new(Arc::new(MemorySink::tenant_scoped()), "k".to_string(), None)
}

#[test]
fn a_picture_a_build_took_is_accepted() {
    assert_eq!(validate(&preview("abc1234", "/projects", 0)), Ok(()));
}

#[test]
fn what_is_not_a_small_picture_of_a_route_is_refused() {
    let field = |p: NewScreenPreview| validate(&p).unwrap_err().field;
    let mut p = preview("abc1234", "/projects", 0);
    p.component = "  ".into();
    assert_eq!(field(p), "component");
    assert_eq!(field(preview("abc 123", "/projects", 0)), "commit");
    assert_eq!(field(preview("abc1234", "projects", 0)), "route");
    let mut p = preview("abc1234", "/projects", 0);
    p.image = format!("data:image/svg+xml;base64,{PNG}");
    assert_eq!(field(p), "image");
    let mut p = preview("abc1234", "/projects", 0);
    p.image = "https://example.com/a.png".into();
    assert_eq!(field(p), "image");
    let mut p = preview("abc1234", "/projects", 0);
    p.image = "data:image/png;base64,***".into();
    assert_eq!(field(p), "image");
    let mut p = preview("abc1234", "/projects", 0);
    p.image = format!(
        "data:image/png;base64,{}",
        "A".repeat((MAX_IMAGE_BYTES + 8) / 3 * 4)
    );
    assert_eq!(field(p), "image");
}

#[tokio::test]
async fn pictures_are_read_back_newest_build_first_in_the_builds_order() {
    let svc = service();
    let c = ctx(1);
    svc.save_screen_preview(&c, &preview("old", "/projects/b", 1))
        .await
        .unwrap();
    svc.save_screen_preview(&c, &preview("new", "/projects/b", 1))
        .await
        .unwrap();
    svc.save_screen_preview(&c, &preview("new", "/projects/a", 0))
        .await
        .unwrap();
    let rows = svc
        .screen_previews(&c, "@constructor-studio/projects-mfe")
        .await
        .unwrap();
    let seen: Vec<(&str, &str)> = rows
        .iter()
        .map(|r| (text(r, "commit"), text(r, "route")))
        .collect();
    assert_eq!(
        seen,
        [
            ("new", "/projects/a"),
            ("new", "/projects/b"),
            ("old", "/projects/b")
        ]
    );
    assert!(text(&rows[0], "image").starts_with("data:image/png;base64,"));
}

#[tokio::test]
async fn the_same_screen_of_the_same_build_replaces_its_picture() {
    let svc = service();
    let c = ctx(1);
    svc.save_screen_preview(&c, &preview("abc", "/projects", 0))
        .await
        .unwrap();
    svc.save_screen_preview(&c, &preview("abc", "/projects", 0))
        .await
        .unwrap();
    let rows = svc
        .screen_previews(&c, "@constructor-studio/projects-mfe")
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
}

#[test]
fn only_the_newest_builds_are_kept() {
    let row = |commit: &str, at: &str| {
        json!({
            "component": "m", "commit": commit, "route": "/r", "image": "x", "captured_at": at,
        })
    };
    let rows = vec![
        row("a", "2026-01-01T00:00:00Z"),
        row("b", "2026-01-02T00:00:00Z"),
        row("c", "2026-01-03T00:00:00Z"),
        row("d", "2026-01-04T00:00:00Z"),
    ];
    assert_eq!(
        stale(&rows),
        [gts::screen_preview_instance_id("m", "a", "/r")]
    );
}

#[tokio::test]
async fn another_organization_does_not_see_the_pictures() {
    let svc = service();
    svc.save_screen_preview(&ctx(1), &preview("abc", "/projects", 0))
        .await
        .unwrap();
    let theirs = svc
        .screen_previews(&ctx(2), "@constructor-studio/projects-mfe")
        .await
        .unwrap();
    assert!(theirs.is_empty());
}
