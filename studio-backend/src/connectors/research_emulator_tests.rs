//! Studio's own Research client against the Research emulator
//! (`studio-backend research-emulator`): the sign-in, an access key, a build
//! and a deploy, end to end, and not one request the restricted gateway in
//! front of a real stand would refuse.

use std::time::Duration;

use futures_util::future::BoxFuture;

use super::super::oauth::{OAuthClient, Pkce};
use super::*;
use crate::research_emulator::{Timings, spawn_for_tests};

const CALLBACK: &str = "https://studio.example/connections/oauth/callback";

const FAST: Pace = Pace {
    poll: Duration::from_millis(5),
    desk_for: Duration::from_secs(10),
    build_for: Duration::from_secs(10),
    start_for: Duration::from_secs(10),
    settle: Duration::ZERO,
    ready_for: Duration::ZERO,
};

fn instant() -> Timings {
    Timings {
        desk: Duration::ZERO,
        build: Duration::ZERO,
        start: Duration::ZERO,
    }
}

fn quiet<'a>(_: String) -> BoxFuture<'a, ()> {
    Box::pin(async {})
}

fn never() -> bool {
    false
}

/// Sign in the way a member does (Studio's authorize URL, the emulator's
/// form, Studio's code exchange), then make the access key Studio keeps.
async fn signed_in(url: &str) -> ResearchApi {
    let oauth = OAuthClient {
        authorize_url: format!("{url}/idp/connect/authorize"),
        token_url: format!("{url}/idp/connect/token"),
        client_id: "constructor-studio".into(),
        client_secret: "s3cret".into(),
        scope: "openid profile user platform".into(),
        redirect_uris: vec![CALLBACK.into()],
    };
    let pkce = Pkce::new();
    let authorize = oauth.authorize("st-9", &pkce, CALLBACK).unwrap();

    // The browser: the sign-in page, then its form.
    let browser = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let page = browser.get(&authorize).send().await.unwrap();
    assert_eq!(page.status(), 200);
    let mut form: Vec<(String, String)> = reqwest::Url::parse(&authorize)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    form.push(("email".into(), "ann@example.com".into()));
    form.push(("first_name".into(), "Ann".into()));
    form.push(("last_name".into(), "Lee".into()));
    let back = browser
        .post(&oauth.authorize_url)
        .form(&form)
        .send()
        .await
        .unwrap();
    let to = reqwest::Url::parse(back.headers()["location"].to_str().unwrap()).unwrap();
    let code = to
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .unwrap();

    let api_url = format!("{url}/api/platform-account/v1");
    let tokens = oauth
        .exchange_code(&reqwest::Client::new(), &code, &pkce.verifier, CALLBACK)
        .await
        .unwrap();
    let made = ResearchApi::new(reqwest::Client::new(), &api_url, tokens.access_token)
        .create_access_key("studio", "2099-01-01T00:00:00Z")
        .await
        .unwrap();
    ResearchApi::new(reqwest::Client::new(), &api_url, made.key)
}

fn tree(dockerfile: &str) -> std::path::PathBuf {
    let work = std::env::temp_dir().join(format!("research-emu-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(work.join("repo/src")).unwrap();
    std::fs::write(work.join("repo/Dockerfile.studio-api"), dockerfile).unwrap();
    std::fs::write(work.join("repo/src/main.rs"), "fn main() {}\n").unwrap();
    work
}

fn api_image() -> [ImageBuild; 1] {
    [ImageBuild {
        key: "api".into(),
        name: "gbx-api".into(),
        dockerfile: "repo/Dockerfile.studio-api".into(),
    }]
}

#[tokio::test]
async fn studio_signs_in_builds_and_deploys_on_the_emulator() {
    let (url, emu) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await;

    let me = api.me().await.unwrap();
    assert_eq!(me.display_name().as_deref(), Some("Ann Lee"));
    let projects = api.projects().await.unwrap();
    assert_eq!(projects.len(), 1);
    let p = &projects[0].id;
    let hardware = api.hardware(p).await.unwrap();
    let small = smallest(&hardware).unwrap().clone();
    assert!(!small.gpu);

    let work = tree("FROM rust:1.97\nRUN cargo build --release\nCMD [\"api\"]\n");
    let built = api
        .build_in_desk(p, &work, "research-b1", &api_image(), FAST, &quiet, &never)
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(&work);
    assert_eq!(built.len(), 1);
    assert_eq!(built[0].id.len(), 32, "an id as Research makes one");

    let body = |value: &str| ServiceBody {
        name: "api".into(),
        image_id: built[0].id.clone(),
        hardware_configuration_id: small.id.clone(),
        volumes: vec![],
        ports: vec![PortBody {
            number: 8080,
            expose_to_internet: true,
        }],
        environment_variables: vec![EnvBody {
            name: "MODE".into(),
            value: value.into(),
        }],
    };
    let app = api
        .put_application(p, "env-dev", &[body("one")], FAST, &quiet)
        .await
        .unwrap();
    let links = app.links();
    assert_eq!(links.len(), 1);
    assert!(links[0].starts_with(&format!("{url}/_apps/")), "{links:?}");
    let page = reqwest::get(&links[0]).await.unwrap().text().await.unwrap();
    assert!(page.contains("MODE") && page.contains("running"), "{page}");

    // A second deploy changes the service in place and restarts it.
    let again = api
        .put_application(p, "env-dev", &[body("two")], FAST, &quiet)
        .await
        .unwrap();
    assert_eq!(again.id, app.id);
    assert_eq!(again.services.len(), 1);
    assert_eq!(again.services[0].status, "running");

    api.delete_application(&app.id).await.unwrap();
    assert!(api.application_named(p, "env-dev").await.unwrap().is_none());

    assert!(
        emu.off_list_calls().is_empty(),
        "Studio called something the gateway would refuse: {:?}",
        emu.off_list_calls()
    );
}

#[tokio::test]
async fn a_failed_build_on_the_emulator_shows_the_last_lines_of_its_log() {
    let (url, _) = spawn_for_tests(instant()).await;
    let api = signed_in(&url).await;
    let p = api.projects().await.unwrap()[0].id.clone();

    let work = tree("FROM rust:1.97\n# research-emulator: fail\nRUN cargo build\n");
    let e = api
        .build_in_desk(
            p.as_str(),
            &work,
            "research-b2",
            &api_image(),
            FAST,
            &quiet,
            &never,
        )
        .await
        .unwrap_err()
        .to_string();
    let _ = std::fs::remove_dir_all(&work);
    assert!(e.contains("could not build image gbx-api"), "{e}");
    assert!(e.contains("STEP 1/2: FROM rust:1.97"), "{e}");
    assert!(e.contains("research-emulator: fail"), "{e}");
}
