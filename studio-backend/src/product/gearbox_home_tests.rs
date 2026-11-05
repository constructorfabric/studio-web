//! The project's home repository in the server's check (ADR-0060 §2, §5, §6).

use super::*;
use serde_json::json;

fn catalogue(gears: &[(&str, &str)]) -> EngineCatalogue {
    let mut map = serde_json::Map::new();
    for (id, source) in gears {
        map.insert(
            (*id).into(),
            json!({ "id": id, "package": {"crate_name": format!("cf-{id}")}, "source": source }),
        );
    }
    serde_json::from_value(json!({ "gears": map })).expect("fixture parses")
}

#[test]
fn the_home_repository_takes_the_place_of_its_roots_in_the_corpus() {
    let corpus = catalogue(&[
        ("api-gateway", "gears-rust"),
        ("studio-documents", "studio-backend"),
    ]);
    let home = catalogue(&[
        ("studio-documents", "studio-web"),
        ("studio-tasks", "studio-web"),
        ("api-gateway", "studio-web"),
    ]);
    let inside: BTreeSet<String> = ["studio-backend".to_owned()].into();
    let merged = with_home(&corpus, &home, "studio-web", &inside);
    let source = |id: &str| merged.gears[id].source.clone().unwrap();
    assert_eq!(
        source("studio-documents"),
        "studio-web",
        "the home's, not its root's"
    );
    assert_eq!(source("studio-tasks"), "studio-web");
    assert_eq!(
        source("api-gateway"),
        "gears-rust",
        "a platform root keeps its gear"
    );
}

#[test]
fn the_home_repository_is_one_source_and_its_frontend_names_it() {
    let composition = Composition {
        gears: vec![
            GearUse {
                id: "api-gateway".into(),
                plugins: vec![],
            },
            GearUse {
                id: "studio-documents".into(),
                plugins: vec![],
            },
        ],
        ..Composition::default()
    };
    let sources = [
        SourcePin {
            id: "gears-rust",
            url: "https://github.com/acme/gears-rust.git",
            rev: Some("75f5d9eaffe1a78552e004dfed0aab14cbb266d7"),
            within: None,
        },
        SourcePin {
            id: "studio-web",
            url: "https://github.com/AndrejK666/studio-web.git",
            rev: None,
            within: Some(""),
        },
    ];
    let gear_source: BTreeMap<String, String> = [
        ("api-gateway".to_owned(), "gears-rust".to_owned()),
        ("studio-documents".to_owned(), "studio-web".to_owned()),
    ]
    .into();
    let pick: FrontendPick = serde_json::from_value(json!({
        "shell": {"repo": "AndrejK666/studio-web", "path": "studio-frontend"},
        "mfes": [{"repo": "AndrejK666/studio-web", "path": "studio-frontend/src-app/mfe_packages/kits-mfe"}],
    }))
    .unwrap();
    let gdl = render_product_gdl_from(
        "studioweb",
        "products/studioweb/product.gdl",
        "Studioweb",
        &composition,
        &sources,
        &gear_source,
        &BTreeMap::new(),
        Some((&pick, Some("AndrejK666/studio-web"))),
    );
    assert!(
        gdl.contains(r#"source(id = "studio-web", at = path("../.."))"#),
        "{gdl}"
    );
    assert!(
        !gdl.contains("frontx-studio-web"),
        "no second source: {gdl}"
    );
    assert!(
        gdl.contains(
            r#"source = "studio-web",
        shell = path("studio-frontend")"#
        ),
        "{gdl}"
    );
    assert!(gdl.contains(r#"use_gear("studio-documents", source = "studio-web")"#));
    let declared = crate::product::sources_lock::sources(&gdl);
    assert!(
        crate::product::sources_lock::duplicates(
            &declared,
            "products/studioweb/product.gdl",
            Some("https://github.com/AndrejK666/studio-web.git")
        )
        .is_empty(),
        "what Studio writes passes its own rule"
    );
}

#[test]
fn a_dev_environment_checks_the_profile_as_a_development_one() {
    let gdl = "product(\n    id = \"prod\",\n    profiles = [\n        embedded(id = \"dev\", development = True),\n        kubernetes(id = \"prod\", discovery = \"static\", database = postgres(host = \"pg\")),\n    ],\n)";
    let out = development_profile(gdl, "prod");
    assert!(
        out.contains("kubernetes(id = \"prod\", development = True, discovery"),
        "the profile, not the product named like it: {out}"
    );
    assert!(out.starts_with("product(\n    id = \"prod\",\n"));
    assert_eq!(development_profile(&out, "prod"), out, "once");
    assert_eq!(development_profile(gdl, "dev"), gdl, "already marked");
    assert_eq!(development_profile(gdl, "local"), gdl, "no such profile");
}

#[cfg(unix)]
#[test]
fn the_check_sees_the_home_checkout_whole_with_the_description_in_its_copy() {
    let scratch = std::env::temp_dir().join(format!("studio-overlay-{}", uuid::Uuid::new_v4()));
    let home = scratch.join("home");
    std::fs::create_dir_all(home.join("studio-backend/gears/x")).unwrap();
    std::fs::create_dir_all(home.join("products/studioweb")).unwrap();
    std::fs::create_dir_all(home.join(".git")).unwrap();
    std::fs::write(home.join("studio-backend/gears/x/gear.gdl"), "gear()").unwrap();
    std::fs::write(home.join("products/studioweb/product.gdl"), "old").unwrap();
    std::fs::write(home.join("products/studioweb/notes.md"), "n").unwrap();
    let out = scratch.join("studioweb");
    overlay(&home, &out, &["products", "studioweb"]).unwrap();
    assert!(out.join("studio-backend/gears/x/gear.gdl").is_file());
    assert!(!out.join(".git").exists());
    assert!(out.join("products/studioweb/notes.md").is_file());
    // The description is written into the copy, never into the checkout.
    let file = out.join("products/studioweb/product.gdl");
    assert!(file.is_symlink());
    std::fs::remove_file(&file).unwrap();
    std::fs::write(&file, "new").unwrap();
    assert_eq!(
        std::fs::read_to_string(home.join("products/studioweb/product.gdl")).unwrap(),
        "old"
    );
    assert!(inside_home(&home.join("studio-backend"), &home));
    assert!(!inside_home(&scratch, &home));
    std::fs::remove_dir_all(&scratch).unwrap();
}

#[test]
fn a_package_goes_where_its_passport_says() {
    let pick: FrontendPick = serde_json::from_value(json!({
        "shell": {"repo": "AndrejK666/studio-web", "path": "studio-frontend"},
        "mfes": [
            {"repo": "AndrejK666/studio-web", "path": "studio-frontend/src-app/mfe_packages/kits-mfe", "requires": ["studio-tasks"]},
            {"repo": "AndrejK666/studio-web", "path": "studio-frontend/src-app/mfe_packages/shared", "requires": ["studio-tasks"]},
            {"repo": "acme/widgets", "path": "packages/charts"},
            {"repo": "acme/widgets", "path": "packages/unknown"},
        ],
        "libraries": [{"repo": "acme/widgets", "path": "packages/screens"}],
    }))
    .unwrap();
    let out = classify_pick(&pick, |p| match p.path.rsplit('/').next() {
        Some("kits-mfe") => Some(FrontxPassport::Mfe),
        Some("shared") => Some(FrontxPassport::Library),
        Some("charts") => Some(FrontxPassport::Undeclared { mfe_json: false }),
        Some("screens") => Some(FrontxPassport::Mfe),
        _ => None,
    });
    let mfes: Vec<&str> = out.mfes.iter().map(|m| m.place.path.as_str()).collect();
    assert_eq!(
        mfes,
        [
            "studio-frontend/src-app/mfe_packages/kits-mfe",
            "packages/unknown",
            "packages/screens"
        ],
        "a library is no micro-frontend; one not read stays as picked"
    );
    assert_eq!(out.mfes[0].requires, ["studio-tasks"]);
    let libs: Vec<&str> = out.libraries.iter().map(|l| l.path.as_str()).collect();
    assert_eq!(
        libs,
        ["packages/charts"],
        "the shell's own library is left out"
    );
}

#[test]
fn a_passport_is_read_off_disk() {
    let scratch = std::env::temp_dir().join(format!("studio-passport-{}", uuid::Uuid::new_v4()));
    let at = |name: &str| scratch.join(name);
    for (name, gdl, mfe_json) in [
        (
            "shared",
            Some("gdl_version = \"1.5\"\n# mfe(requires = [])\nlibrary()\n"),
            false,
        ),
        (
            "kits",
            Some("gdl_version = \"1.5\"\nmfe(requires = [\"studio-tasks\"])\n"),
            true,
        ),
        ("bare", None, true),
        ("none", None, false),
    ] {
        std::fs::create_dir_all(at(name)).unwrap();
        if let Some(gdl) = gdl {
            std::fs::write(at(name).join("frontx.gdl"), gdl).unwrap();
        }
        if mfe_json {
            std::fs::write(at(name).join("mfe.json"), "{}").unwrap();
        }
    }
    assert_eq!(
        FrontxPassport::read(&at("shared")),
        Some(FrontxPassport::Library)
    );
    assert_eq!(FrontxPassport::read(&at("kits")), Some(FrontxPassport::Mfe));
    assert_eq!(
        FrontxPassport::read(&at("bare")),
        Some(FrontxPassport::Undeclared { mfe_json: true })
    );
    assert_eq!(
        FrontxPassport::read(&at("none")),
        Some(FrontxPassport::Undeclared { mfe_json: false })
    );
    assert_eq!(FrontxPassport::read(&at("missing")), None);
    std::fs::remove_dir_all(&scratch).unwrap();
}
