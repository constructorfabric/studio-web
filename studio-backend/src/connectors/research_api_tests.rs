use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::{Value, json};

use super::*;

const ACCOUNT: &str = "/api/platform-account/v1";
const DAV: &str = "/api/platform-storage/desks/d1/dav/project/";

/// A fake Research: the account API, a desk's WebDAV and the build logs, on
/// one origin as on a stand. What it was sent, and the state it keeps.
struct Fake {
    /// The token it accepts.
    token: String,
    auth: Vec<String>,
    calls: Vec<String>,
    desks: Vec<Value>,
    /// Whether the project may have more than one desk.
    multi_desk: bool,
    desk_status: String,
    folders: BTreeSet<String>,
    files: BTreeMap<String, Vec<u8>>,
    removed: Vec<String>,
    /// Image id -> (name, dockerfile, polls before it ends).
    images: BTreeMap<String, (String, String, u32)>,
    image_ends: &'static str,
    apps: Vec<Value>,
    /// Service id -> service.
    services: BTreeMap<String, Value>,
    bodies: Vec<(String, Value)>,
}

impl Default for Fake {
    fn default() -> Self {
        Self {
            token: "t0ken".into(),
            auth: Vec::new(),
            calls: Vec::new(),
            desks: Vec::new(),
            multi_desk: true,
            desk_status: "not_started".into(),
            folders: BTreeSet::new(),
            files: BTreeMap::new(),
            removed: Vec::new(),
            images: BTreeMap::new(),
            image_ends: "done",
            apps: Vec::new(),
            services: BTreeMap::new(),
            bodies: Vec::new(),
        }
    }
}

type Shared = Arc<Mutex<Fake>>;

fn refusal(msg: &str) -> Response {
    (
        StatusCode::MISDIRECTED_REQUEST,
        Json(json!({ "detail": { "msg": msg, "error_code": 4001 } })),
    )
        .into_response()
}

fn service(id: &str, name: &str, status: &str, link: Option<&str>) -> Value {
    json!({ "id": id, "name": name, "image_id": "i", "hardware_configuration_id": "h",
            "volumes": [], "ports": [], "environment_variables": [], "status": status, "link": link })
}

async fn handle(
    State(s): State<Shared>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut f = s.lock().unwrap();
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let path = uri.path().to_owned();
    f.auth.push(auth.clone());
    f.calls.push(format!("{method} {path}"));
    if auth != format!("Bearer {}", f.token) {
        return (StatusCode::UNAUTHORIZED, "").into_response();
    }
    let json_body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);

    if let Some(rel) = path.strip_prefix(DAV) {
        let rel = rel.trim_end_matches('/').to_owned();
        return match method.as_str() {
            "MKCOL" => {
                if f.folders.insert(rel) {
                    StatusCode::CREATED.into_response()
                } else {
                    StatusCode::METHOD_NOT_ALLOWED.into_response()
                }
            }
            "PUT" => {
                f.files.insert(rel, body.to_vec());
                StatusCode::CREATED.into_response()
            }
            "GET" => match f.files.get(&rel) {
                Some(b) => b.clone().into_response(),
                None => StatusCode::NOT_FOUND.into_response(),
            },
            "DELETE" => {
                f.removed.push(rel.clone());
                f.files.retain(|k, _| !k.starts_with(&rel));
                StatusCode::NO_CONTENT.into_response()
            }
            _ => StatusCode::BAD_REQUEST.into_response(),
        };
    }
    if path.starts_with("/api/platform-keeper/image-builds/") {
        return "event: log\ndata: Step 3/7 : RUN cargo build\ndata: error[E0425]: cannot find value `x`\n\n"
            .into_response();
    }
    let Some(route) = path.strip_prefix(ACCOUNT) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let parts: Vec<&str> = route.trim_start_matches('/').split('/').collect();
    match (method.as_str(), parts.as_slice()) {
        ("GET", ["auth", "session"]) => Json(json!({
            "id": "u-1", "email": "ann@example.com", "first_name": "Ann", "last_name": "Lee", "status": "active"
        }))
        .into_response(),
        ("GET", ["projects"]) => Json(json!({ "total": 1, "results": [{
            "id": "p1", "name": "ML team", "archived": false, "multi_desk": true
        }] }))
        .into_response(),
        ("GET", ["projects", p, "hardware-configurations"]) => {
            if *p != "p%201" && *p != "p 1" {
                return refusal("Project not found");
            }
            Json(json!({ "total": 3, "results": [
                { "id": "gpu-a10", "name": "A10", "cpu_count": 8.0, "ram_gb": 32, "available_for_trial": true,
                  "gpu": { "name": "A10", "vram_gb": 24, "amount": 1 }, "availability": { "status": "high", "total": 4, "used": 0 } },
                { "id": "cpu-s", "name": "CPU S", "cpu_count": 2.0, "ram_gb": 4, "available_for_trial": false, "gpu": null },
                { "id": "old", "name": "Old", "cpu_count": 1.0, "ram_gb": 2, "available_for_trial": false, "gpu": null, "removed": true },
            ] }))
            .into_response()
        }
        ("GET", ["projects", _, "desks"]) => {
            Json(json!({ "total": f.desks.len(), "results": f.desks })).into_response()
        }
        ("POST", ["projects", _, "desks"]) => {
            if !f.multi_desk && !f.desks.is_empty() {
                return refusal("Multi-desk is disabled for this project");
            }
            let desk = json!({ "id": "d1", "name": json_body["name"], "filesystem": { "status": "not_started" } });
            f.desks.push(desk.clone());
            Json(desk).into_response()
        }
        ("GET", ["desks", d]) => {
            Json(json!({ "id": d, "name": "studio", "filesystem": { "status": f.desk_status } }))
                .into_response()
        }
        ("POST", ["desks", d, "filesystem"]) => {
            // It takes one more look to come up.
            f.desk_status = "starting".into();
            let next = json!({ "id": d, "name": "studio", "filesystem": { "status": "starting" } });
            f.desk_status = "running".into();
            Json(next).into_response()
        }
        ("DELETE", ["desks", _, "filesystem"]) => {
            f.desk_status = "not_started".into();
            Json(json!({})).into_response()
        }
        ("POST", ["desks", _, "images"]) => {
            let id = format!("img-{}", f.images.len() + 1);
            let name = json_body["name"].as_str().unwrap_or_default().to_owned();
            let dockerfile = json_body["dockerfile"].as_str().unwrap_or_default().to_owned();
            f.images.insert(id.clone(), (name.clone(), dockerfile, 2));
            Json(json!({ "id": id, "name": name, "build_status": "not_started" })).into_response()
        }
        ("GET", ["images", id]) => {
            let ends = f.image_ends;
            let Some(img) = f.images.get_mut(*id) else {
                return refusal("Image not found");
            };
            img.2 = img.2.saturating_sub(1);
            let status = if img.2 == 0 { ends } else { "in_progress" };
            Json(json!({ "id": id, "name": img.0, "build_status": status })).into_response()
        }
        ("GET", ["projects", _, "applications"]) => {
            let apps: Vec<Value> = f
                .apps
                .iter()
                .map(|a| {
                    let mut a = a.clone();
                    let ids: Vec<String> = a["service_ids"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect();
                    a["services"] = ids.iter().filter_map(|i| f.services.get(i).cloned()).collect();
                    a
                })
                .collect();
            Json(json!({ "total": apps.len(), "results": apps })).into_response()
        }
        ("POST", ["projects", _, "applications"]) => {
            let app = json!({ "id": "a-new", "name": json_body["name"], "project_id": "p1",
                              "created_at": "2026-10-29T00:00:00Z", "services": [], "service_ids": [] });
            f.apps.push(app.clone());
            Json(app).into_response()
        }
        ("GET", ["applications", a]) => {
            let Some(app) = f.apps.iter().find(|x| x["id"] == *a).cloned() else {
                return refusal("Application not found");
            };
            let services: Vec<Value> = f.services.values().cloned().collect();
            Json(json!({ "id": app["id"], "name": app["name"], "services": services })).into_response()
        }
        ("DELETE", ["applications", _]) => StatusCode::NO_CONTENT.into_response(),
        ("POST", ["applications", _, "services"]) => {
            if json_body["image_id"].as_str().unwrap_or_default().is_empty() {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(json!({ "detail": [{ "loc": ["body", "image_id"], "msg": "Field required" }] })),
                )
                    .into_response();
            }
            let name = json_body["name"].as_str().unwrap_or_default().to_owned();
            let id = format!("s-{name}");
            f.bodies.push((format!("POST {name}"), json_body.clone()));
            f.services.insert(id.clone(), service(&id, &name, "stopped", Some(&format!("https://{id}.apps.example"))));
            Json(f.services[&id].clone()).into_response()
        }
        ("PATCH", ["applications", _, "services", sid]) => {
            f.bodies.push((format!("PATCH {sid}"), json_body.clone()));
            Json(f.services.get(*sid).cloned().unwrap_or(Value::Null)).into_response()
        }
        ("GET", ["services", sid]) => match f.services.get(*sid) {
            Some(s) => {
                let s = s.clone();
                // A service started is running at the next look.
                if s["status"] == "starting" {
                    f.services.get_mut(*sid).unwrap()["status"] = json!("running");
                }
                Json(s).into_response()
            }
            None => refusal("Service not found"),
        },
        ("POST", ["services", sid, verb]) if *verb == "start" || *verb == "restart" => {
            let Some(s) = f.services.get_mut(*sid) else {
                return refusal("Service not found");
            };
            s["status"] = json!("starting");
            Json(s.clone()).into_response()
        }
        ("DELETE", ["services", sid]) => {
            f.services.remove(*sid);
            StatusCode::NO_CONTENT.into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// A fake Research on a free port; the connection's address and its state.
async fn serve(fake: Fake) -> (String, Shared) {
    let shared: Shared = Arc::new(Mutex::new(fake));
    let app = Router::new().fallback(handle).with_state(shared.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("{origin}{ACCOUNT}/"), shared)
}

fn api(url: &str) -> ResearchApi {
    ResearchApi::new(reqwest::Client::new(), url, "t0ken".into())
}

const FAST: Pace = Pace {
    poll: Duration::from_millis(1),
    desk_for: Duration::from_secs(5),
    build_for: Duration::from_secs(5),
    start_for: Duration::from_secs(5),
};

fn quiet<'a>(_: String) -> BoxFuture<'a, ()> {
    Box::pin(async {})
}

fn token_is(t: &'static str) -> Renew {
    Arc::new(move || -> BoxFuture<'static, anyhow::Result<String>> {
        Box::pin(async move { Ok(t.to_owned()) })
    })
}

fn never() -> bool {
    false
}

#[test]
fn the_services_beside_the_account_api_are_found_on_its_origin() {
    let (account, base) = roots("https://stand.example/api/platform-account/v1/");
    assert_eq!(account, "https://stand.example/api/platform-account/v1");
    assert_eq!(base, "https://stand.example");
    let (account, _) = roots("https://stand.example/api/platform-account");
    assert_eq!(account, "https://stand.example/api/platform-account/v1");
    let (_, base) = roots("http://127.0.0.1:9/other/v1");
    assert_eq!(base, "http://127.0.0.1:9");
}

#[tokio::test]
async fn who_projects_and_hardware_are_read_with_the_members_token() {
    let (url, seen) = serve(Fake::default()).await;
    let api = api(&url);
    let me = api.me().await.unwrap();
    assert_eq!(me.id, "u-1");
    assert_eq!(me.display_name().as_deref(), Some("Ann Lee"));
    assert_eq!(
        api.projects().await.unwrap(),
        [Project {
            id: "p1".into(),
            name: "ML team".into()
        }]
    );
    assert!(
        seen.lock()
            .unwrap()
            .auth
            .iter()
            .all(|a| a == "Bearer t0ken")
    );

    let hw = api.hardware("p 1").await.unwrap();
    let ids: Vec<_> = hw.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(
        ids,
        ["gpu-a10", "cpu-s"],
        "a removed configuration is not offered"
    );
    assert!(hw[0].trial && hw[0].gpu);
    assert_eq!(smallest(&hw).unwrap().id, "cpu-s");
    assert!(
        seen.lock().unwrap().calls.contains(&format!(
            "GET {ACCOUNT}/projects/p%201/hardware-configurations"
        )),
        "a project id is escaped into the path"
    );

    let e = api.hardware("other").await.unwrap_err().to_string();
    assert_eq!(
        e,
        "Constructor Research refused the hardware: Project not found"
    );
}

#[tokio::test]
async fn a_refused_token_is_renewed_once_and_then_the_member_signs_in_again() {
    let (url, seen) = serve(Fake {
        token: "fresh".into(),
        ..Fake::default()
    })
    .await;

    let e = api(&url).projects().await.unwrap_err().to_string();
    assert_eq!(e, SIGN_IN_AGAIN);

    let renewed = api(&url).renewing(token_is("fresh"));
    assert_eq!(renewed.projects().await.unwrap()[0].id, "p1");
    assert_eq!(
        seen.lock().unwrap().auth[1..],
        ["Bearer t0ken", "Bearer fresh"]
    );

    let stale = api(&url).renewing(token_is("stale"));
    let e = stale.projects().await.unwrap_err().to_string();
    assert_eq!(e, SIGN_IN_AGAIN, "renewed once, not forever");
}

#[tokio::test]
async fn a_build_starts_a_desk_uploads_the_tree_builds_each_image_and_stops_the_desk() {
    let (url, seen) = serve(Fake::default()).await;
    seen.lock().unwrap().files.insert(
        ".git/info/exclude".into(),
        b"# git ls-files --others\n".to_vec(),
    );
    let work = std::env::temp_dir().join(format!("research-api-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(work.join("repo/src")).unwrap();
    std::fs::create_dir_all(work.join("repo/.git")).unwrap();
    std::fs::create_dir_all(work.join("repo/target/debug")).unwrap();
    std::fs::write(work.join("repo/Dockerfile.studio-api"), "FROM scratch\n").unwrap();
    std::fs::write(work.join("repo/src/main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(work.join("repo/.git/HEAD"), "ref: x\n").unwrap();
    std::fs::write(work.join("repo/target/debug/big"), "x").unwrap();

    let images = [ImageBuild {
        key: "api".into(),
        name: "gbx-api".into(),
        dockerfile: "repo/Dockerfile.studio-api".into(),
    }];
    let built = api(&url)
        .build_in_desk("p1", &work, "research-b1", &images, FAST, &quiet, &never)
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(&work);
    assert_eq!(
        built,
        [Built {
            key: "api".into(),
            name: "gbx-api".into(),
            id: "img-1".into()
        }]
    );

    let f = seen.lock().unwrap();
    assert_eq!(
        f.desks[0]["name"], STUDIO_DESK,
        "Studio builds in a desk of its own"
    );
    let calls = |c: &str| f.calls.iter().filter(|x| x.as_str() == c).count();
    assert_eq!(calls(&format!("POST {ACCOUNT}/desks/d1/filesystem")), 1);
    assert_eq!(
        calls(&format!("DELETE {ACCOUNT}/desks/d1/filesystem")),
        1,
        "the desk Studio started is stopped"
    );
    assert!(f.folders.contains("studio-build/research-b1/repo/src"));
    assert!(
        !f.folders
            .iter()
            .any(|d| d.contains(".git") || d.contains("target"))
    );
    assert_eq!(
        f.images["img-1"].1, "studio-build/research-b1/repo/Dockerfile.studio-api",
        "the Dockerfile is named by its path in the project folder"
    );
    assert_eq!(
        f.removed,
        ["studio-build/research-b1", "studio-build/research-b1"],
        "cleared before the upload, removed after the build"
    );
    assert!(
        String::from_utf8_lossy(&f.files[".git/info/exclude"]).ends_with("\n/studio-build/\n"),
        "the build folder is kept out of the project's git"
    );
    assert!(
        f.calls
            .iter()
            .any(|c| c == &format!("PUT {DAV}studio-build/research-b1/repo/src/main.rs")),
        "{:?}",
        f.calls
    );
}

#[tokio::test]
async fn a_failed_image_says_which_and_its_last_log_lines() {
    let (url, seen) = serve(Fake {
        image_ends: "error",
        desk_status: "running".into(),
        multi_desk: false,
        desks: vec![json!({ "id": "d1", "name": "main", "filesystem": { "status": "running" } })],
        ..Fake::default()
    })
    .await;
    // One desk per project: creating Studio's own is refused.
    let work = std::env::temp_dir().join(format!("research-api-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(work.join("Dockerfile"), "FROM scratch\n").unwrap();
    let images = [ImageBuild {
        key: "api".into(),
        name: "gbx-api".into(),
        dockerfile: "Dockerfile".into(),
    }];
    let e = api(&url)
        .build_in_desk("p1", &work, "b2", &images, FAST, &quiet, &never)
        .await
        .unwrap_err()
        .to_string();
    let _ = std::fs::remove_dir_all(&work);
    assert!(
        e.starts_with("Constructor Research could not build image gbx-api (Dockerfile):\n"),
        "{e}"
    );
    assert!(e.ends_with("error[E0425]: cannot find value `x`"), "{e}");
    let f = seen.lock().unwrap();
    assert!(
        !f.calls
            .iter()
            .any(|c| c.ends_with("/desks/d1/filesystem") && c.starts_with("DELETE")),
        "a desk that was already running is left running"
    );
}

#[tokio::test]
async fn an_application_is_reconciled_service_by_service() {
    let mut fake = Fake::default();
    fake.apps.push(json!({ "id": "a1", "name": "shop-dev", "project_id": "p1",
                           "created_at": "2026-10-29T00:00:00Z", "service_ids": ["s-web", "s-old"] }));
    fake.services.insert(
        "s-web".into(),
        service(
            "s-web",
            "web",
            "running",
            Some("https://s-web.apps.example"),
        ),
    );
    fake.services
        .insert("s-old".into(), service("s-old", "old", "running", None));
    let (url, seen) = serve(fake).await;

    let body = |name: &str| ServiceBody {
        name: name.into(),
        image_id: "img-1".into(),
        hardware_configuration_id: "cpu-s".into(),
        volumes: vec![VolumeBody {
            name: "data".into(),
            mount_point: "/data".into(),
            size_gb: 10,
        }],
        ports: vec![PortBody {
            number: 8087,
            expose_to_internet: name == "web",
        }],
        environment_variables: vec![EnvBody {
            name: "MODE".into(),
            value: "live".into(),
        }],
    };
    let app = api(&url)
        .put_application("p1", "shop-dev", &[body("web"), body("db")], FAST, &quiet)
        .await
        .unwrap();
    let mut links = app.links();
    links.sort();
    assert_eq!(
        links,
        ["https://s-db.apps.example", "https://s-web.apps.example"]
    );

    let f = seen.lock().unwrap();
    let sent: Vec<&str> = f.bodies.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(sent, ["PATCH s-web", "POST db"]);
    assert_eq!(
        f.bodies[1].1["ports"],
        json!([{ "number": 8087, "expose_to_internet": false }])
    );
    assert_eq!(f.bodies[1].1["volumes"][0]["size_gb"], 10);
    assert!(
        f.calls
            .contains(&format!("POST {ACCOUNT}/services/s-web/restart"))
    );
    assert!(
        f.calls
            .contains(&format!("POST {ACCOUNT}/services/s-db/start"))
    );
    assert!(
        f.calls
            .contains(&format!("DELETE {ACCOUNT}/services/s-old")),
        "a service the product dropped goes"
    );
    assert!(!f.services.contains_key("s-old"));
}

#[tokio::test]
async fn a_new_application_is_created_and_a_body_research_rejects_is_named() {
    let (url, _) = serve(Fake::default()).await;
    let bad = ServiceBody {
        name: "web".into(),
        image_id: String::new(),
        hardware_configuration_id: "cpu-s".into(),
        volumes: vec![],
        ports: vec![],
        environment_variables: vec![],
    };
    let e = api(&url)
        .put_application("p1", "shop-dev", &[bad], FAST, &quiet)
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(
        e,
        "Constructor Research refused creating service web: body.image_id: Field required"
    );
}
