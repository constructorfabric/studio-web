use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post, put};
use axum::{Json, Router};

use super::*;

/// What the fake integration service was sent.
#[derive(Default)]
struct Seen {
    auth: Vec<String>,
    build_body: Vec<u8>,
    application: Option<serde_json::Value>,
}

type Shared = Arc<Mutex<Seen>>;

fn bearer(h: &HeaderMap) -> String {
    h.get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned()
}

/// A fake integration service on a free port; its root and what it saw.
async fn serve() -> (String, Shared) {
    let seen: Shared = Arc::default();
    let app = Router::new()
        .route(
            "/projects",
            get(|State(s): State<Shared>, h: HeaderMap| async move {
                s.lock().unwrap().auth.push(bearer(&h));
                Json(serde_json::json!({ "items": [{ "id": "p1", "name": "ML team" }] }))
            }),
        )
        .route(
            "/projects/{p}/hardware",
            get(|Path(p): Path<String>| async move {
                if p != "p 1" {
                    return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "code": "project_not_found", "message": "no such project" })));
                }
                (StatusCode::OK, Json(serde_json::json!({ "items": [{ "id": "gpu-a10", "name": "A10", "trial": true }] })))
            }),
        )
        .route(
            "/projects/{p}/builds",
            post(|State(s): State<Shared>, body: Bytes| async move {
                s.lock().unwrap().build_body = body.to_vec();
                Json(serde_json::json!({ "id": "b-7" }))
            }),
        )
        .route(
            "/builds/{b}",
            get(|| async {
                Json(serde_json::json!({
                    "state": "succeeded",
                    "images": [{ "app": "api-gateway", "reference": "registry.research/p1/gbx-api-gateway:sha-1", "digest": "sha256:ab" }],
                }))
            }),
        )
        .route(
            "/projects/{p}/applications/{name}",
            put(|State(s): State<Shared>, Json(app): Json<serde_json::Value>| async move {
                s.lock().unwrap().application = Some(app);
                Json(serde_json::json!({ "revision": "r3" }))
            })
            .get(|| async {
                Json(serde_json::json!({
                    "revision": "r3",
                    "services": [
                        { "name": "api-gateway", "state": "running", "public_urls": ["https://shop.research.example"] },
                        { "name": "postgres", "state": "running" },
                    ],
                }))
            })
            .delete(|| async { (StatusCode::UNAUTHORIZED, "") }),
        )
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let root = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (root, seen)
}

fn api(root: &str) -> ResearchApi {
    ResearchApi::new(reqwest::Client::new(), &format!("{root}/"), "t0ken".into())
}

#[tokio::test]
async fn projects_and_hardware_are_read_with_the_members_token() {
    let (root, seen) = serve().await;
    let api = api(&root);
    assert_eq!(
        api.projects().await.unwrap(),
        [Project {
            id: "p1".into(),
            name: "ML team".into()
        }]
    );
    assert_eq!(seen.lock().unwrap().auth, ["Bearer t0ken"]);
    let hw = api.hardware("p 1").await.unwrap();
    assert!(hw[0].trial, "a project name is escaped into the path");

    let e = api.hardware("other").await.unwrap_err().to_string();
    assert_eq!(
        e,
        "Constructor Research refused the hardware: no such project (project_not_found)"
    );
}

#[tokio::test]
async fn a_build_sends_the_images_and_the_archive_and_is_read_back() {
    let (root, seen) = serve().await;
    let api = api(&root);
    let images = [BuildImage {
        app: "api-gateway".into(),
        name: "gbx-api-gateway".into(),
        dockerfile: "repo/.gearbox/out/docker/api-gateway/Dockerfile".into(),
        context: ".".into(),
    }];
    let id = api
        .start_build("p1", &images, b"GZIPPED".to_vec())
        .await
        .unwrap();
    assert_eq!(id, "b-7");
    let body = String::from_utf8_lossy(&seen.lock().unwrap().build_body).into_owned();
    assert!(body.contains("name=\"manifest\""), "{body}");
    assert!(
        body.contains("\"dockerfile\":\"repo/.gearbox/out/docker/api-gateway/Dockerfile\""),
        "{body}"
    );
    assert!(
        body.contains("name=\"context\"; filename=\"context.tar.gz\""),
        "{body}"
    );
    assert!(body.contains("GZIPPED"));

    let state = api.build("b-7").await.unwrap();
    assert_eq!(state.state, "succeeded");
    assert_eq!(
        state.images[0].reference,
        "registry.research/p1/gbx-api-gateway:sha-1"
    );
}

#[tokio::test]
async fn an_application_is_put_whole_and_its_addresses_read_back() {
    let (root, seen) = serve().await;
    let api = api(&root);
    let app = serde_json::json!({ "services": [{
        "name": "api-gateway",
        "image": "registry.research/p1/gbx-api-gateway:sha-1",
        "ports": [{ "name": "rest", "port": 8087, "public": true }],
        "replicas": 1,
        "hardware": "gpu-a10",
    }] });
    assert_eq!(
        api.put_application("p1", "shop-dev", &app)
            .await
            .unwrap()
            .as_deref(),
        Some("r3")
    );
    let sent = seen.lock().unwrap().application.clone().unwrap();
    assert_eq!(sent["services"][0]["hardware"], "gpu-a10");

    let state = api.application("p1", "shop-dev").await.unwrap();
    assert!(state.running());
    assert!(state.failed().is_none());
    assert_eq!(state.public_urls(), ["https://shop.research.example"]);

    let e = api
        .delete_application("p1", "shop-dev", false)
        .await
        .unwrap_err()
        .to_string();
    assert!(e.contains("sign in to it again"), "{e}");
}
