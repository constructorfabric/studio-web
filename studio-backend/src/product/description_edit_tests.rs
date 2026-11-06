//! A save keeps what the latest revision says (Studioweb revisions 11 -> 12).

use super::*;
use crate::product::gearbox::{
    Composition, FrontendPick, GearUse, SourcePin, render_product_gdl_from,
};
use serde_json::json;

const PATH: &str = "products/studioweb/product.gdl";
const REPO: &str = "AndrejK666/studio-web";

/// Revision 11 of "Studioweb", as the IDE left it: gear configuration,
/// gears-rust pinned to a fork, the project's own repository as one source
/// its frontend names, and comments.
const LATEST: &str = r#"gdl_version = "1.5"

# Studioweb: the product, hand-tuned in the IDE.

product(
    id = "studioweb",
    name = "Studioweb",
    version = "0.1.0",
    sources = [source(id = "gears-rust", at = git(url = "https://github.com/AndrejK666/gears-rust.git", rev = "fd2be28b0000000000000000000000000000beef")),
               source(id = "studio-web", at = path("../.."))],
    profiles = [
        embedded(id = "dev", development = True),
        kubernetes(id = "stage", discovery = "static", namespace = "studioweb-stage"),
        kubernetes(id = "prod", discovery = "static", namespace = "studioweb"),
    ],
    default_profile = "dev",
    frontend = frontx_product(
        source = "studio-web",
        shell = path("studio-frontend"),
        mfes = [
            frontx_mfe(package = path("studio-frontend/src-app/mfe_packages/kits-mfe"), source = "studio-web"),
        ],
        entry_points = {"Portal": "/"},
    ),
    gears = [
        # Sign-in comes first: the bootstrap admin is created here.
        use_gear("account-management", source = "gears-rust", config = {"bootstrap": {"admin": "admin@studio"}}),
        use_gear("api-gateway", source = "gears-rust", config = {"rate_limit_zones": {"api": 100}}),
        use_gear("authn-resolver", source = "gears-rust", config = {"vendor": "keycloak"}),  # keep in step with the IdP
        use_gear("file-storage", source = "gears-rust", config = {"sidecar_base_url": "http://files:8080"}),
        use_gear("studio-documents", source = "studio-web"),
    ],
)
"#;

fn uses(ids: &[&str]) -> Composition {
    Composition {
        gears: ids
            .iter()
            .map(|id| GearUse {
                id: (*id).to_owned(),
                plugins: vec![],
            })
            .collect(),
        ..Composition::default()
    }
}

/// What the Product page's save renders from the picks record: the
/// platform corpus at its commit, no configuration the record lacks, and
/// the frontend's repository as a source of its own (the home repository
/// is not one of the save's pins).
fn rendered(
    ids: &[&str],
    config: &BTreeMap<String, serde_json::Map<String, serde_json::Value>>,
) -> String {
    let sources = [SourcePin {
        id: "gears-rust",
        url: "https://github.com/MikeFalcon77/gears-rust.git",
        rev: Some("c14f0fb5000000000000000000000000000cafe0"),
        within: None,
    }];
    let gear_source: BTreeMap<String, String> = ids
        .iter()
        .map(|id| {
            let s = if id.starts_with("studio-") {
                "studio-web"
            } else {
                "gears-rust"
            };
            ((*id).to_owned(), s.to_owned())
        })
        .collect();
    let pick: FrontendPick = serde_json::from_value(json!({
        "shell": {"repo": REPO, "path": "studio-frontend"},
        "mfes": [{"repo": REPO, "path": "studio-frontend/src-app/mfe_packages/kits-mfe"}],
    }))
    .unwrap();
    render_product_gdl_from(
        "studioweb",
        PATH,
        "Studioweb",
        &uses(ids),
        &sources,
        &gear_source,
        config,
        Some((&pick, Some(REPO))),
    )
}

const PICKS: [&str; 5] = [
    "account-management",
    "api-gateway",
    "authn-resolver",
    "file-storage",
    "studio-documents",
];

fn change<'a>(
    removed: &'a BTreeSet<String>,
    config_changed: &'a BTreeSet<String>,
    frontend: FrontendChange,
) -> Change<'a> {
    Change {
        removed,
        config_changed,
        frontend,
        product_path: PATH,
        repo: Some(REPO),
    }
}

/// What revision 11 says that revision 12 lost.
const KEPT: [&str; 8] = [
    r#"config = {"bootstrap": {"admin": "admin@studio"}}"#,
    r#"config = {"rate_limit_zones": {"api": 100}}"#,
    r#"config = {"vendor": "keycloak"}"#,
    r#"config = {"sidecar_base_url": "http://files:8080"}"#,
    r#"git(url = "https://github.com/AndrejK666/gears-rust.git", rev = "fd2be28b0000000000000000000000000000beef")"#,
    "# Studioweb: the product, hand-tuned in the IDE.",
    "# Sign-in comes first: the bootstrap admin is created here.",
    "# keep in step with the IdP",
];

#[test]
fn the_rendered_text_alone_is_what_stripped_revision_12() {
    let mut picks = PICKS.to_vec();
    picks.push("file-parser");
    let text = rendered(&picks, &BTreeMap::new());
    for kept in KEPT {
        assert!(
            !text.contains(kept),
            "the render has {kept}, so it is no reproduction"
        );
    }
    assert!(text.contains("MikeFalcon77/gears-rust"));
    assert!(
        text.contains("frontx-studio-web"),
        "a second source for the repository"
    );
}

#[test]
fn a_save_that_only_adds_a_gear_keeps_config_the_forked_source_and_comments() {
    let mut picks = PICKS.to_vec();
    picks.push("file-parser");
    let none = BTreeSet::new();
    let merged = onto_latest(
        LATEST,
        &rendered(&picks, &BTreeMap::new()),
        &change(&none, &none, FrontendChange::Write),
    )
    .expect("a gear added is an edit");
    for kept in KEPT {
        assert!(merged.contains(kept), "lost {kept}:\n{merged}");
    }
    assert!(
        !merged.contains("MikeFalcon77"),
        "the fork stays the source:\n{merged}"
    );
    assert!(
        !merged.contains("frontx-studio-web"),
        "one repository, one source:\n{merged}"
    );
    assert!(
        merged.contains(r#"kubernetes(id = "stage""#),
        "profiles as written"
    );
    // Exactly one line more: the new gear, after the last one.
    assert!(
        merged.contains(
            "        use_gear(\"studio-documents\", source = \"studio-web\"),\n        \
             use_gear(\"file-parser\", source = \"gears-rust\"),\n    ],"
        ),
        "{merged}"
    );
    assert_eq!(
        merged.lines().count(),
        LATEST.lines().count() + 1,
        "{merged}"
    );
    // Saving the same picks again changes nothing.
    let again = onto_latest(
        &merged,
        &rendered(&picks, &BTreeMap::new()),
        &change(&none, &none, FrontendChange::Write),
    )
    .unwrap();
    assert_eq!(again, merged);
}

#[test]
fn a_gear_taken_out_goes_and_one_the_engine_does_not_see_stays() {
    // `authn-resolver` taken out of the picks; `studio-documents` still
    // picked, but the engine did not describe it this time.
    let removed: BTreeSet<String> = ["cf-authn-resolver".to_owned()].into();
    let none = BTreeSet::new();
    let text = rendered(
        &["account-management", "api-gateway", "file-storage"],
        &BTreeMap::new(),
    );
    let merged = onto_latest(
        LATEST,
        &text,
        &change(&removed, &none, FrontendChange::Keep),
    )
    .unwrap();
    assert!(!merged.contains("authn-resolver"), "{merged}");
    assert!(
        !merged.contains("keep in step with the IdP"),
        "its comment with it"
    );
    assert!(merged.contains(r#"use_gear("studio-documents", source = "studio-web")"#));
    assert_eq!(
        merged.lines().count(),
        LATEST.lines().count() - 1,
        "{merged}"
    );
}

#[test]
fn only_the_configuration_the_caller_changed_is_written() {
    let mut config = BTreeMap::new();
    config.insert(
        "api-gateway".to_owned(),
        json!({"rate_limit_zones": {"api": 500}})
            .as_object()
            .unwrap()
            .clone(),
    );
    let changed: BTreeSet<String> = ["api-gateway".to_owned()].into();
    let none = BTreeSet::new();
    let merged = onto_latest(
        LATEST,
        &rendered(&PICKS, &config),
        &change(&none, &changed, FrontendChange::Keep),
    )
    .unwrap();
    assert!(
        merged.contains(r#"config = {"rate_limit_zones": {"api": 500}}"#),
        "{merged}"
    );
    assert!(
        merged.contains(r#"config = {"vendor": "keycloak"}"#),
        "the rest as written"
    );
    // Taken out: the entry loses its `config` only.
    let merged = onto_latest(
        LATEST,
        &rendered(&PICKS, &BTreeMap::new()),
        &change(&none, &changed, FrontendChange::Keep),
    )
    .unwrap();
    assert!(
        merged.contains(r#"use_gear("api-gateway", source = "gears-rust"),"#),
        "{merged}"
    );
}

#[test]
fn a_gear_from_a_new_repository_declares_it_once() {
    let none = BTreeSet::new();
    let sources = [
        SourcePin {
            id: "gears-rust",
            url: "https://github.com/MikeFalcon77/gears-rust.git",
            rev: Some("c14f"),
            within: None,
        },
        SourcePin {
            id: "gears-extra",
            url: "https://github.com/acme/gears-extra.git",
            rev: Some("abcd"),
            within: None,
        },
    ];
    let gear_source: BTreeMap<String, String> =
        [("search".to_owned(), "gears-extra".to_owned())].into();
    let mut ids = PICKS.to_vec();
    ids.push("search");
    let text = render_product_gdl_from(
        "studioweb",
        PATH,
        "Studioweb",
        &uses(&ids),
        &sources,
        &gear_source,
        &BTreeMap::new(),
        None,
    );
    let merged = onto_latest(LATEST, &text, &change(&none, &none, FrontendChange::Keep)).unwrap();
    assert!(
        merged.contains(r#"use_gear("search", source = "gears-extra")"#),
        "{merged}"
    );
    assert_eq!(
        merged.matches(r#"source(id = "gears-extra""#).count(),
        1,
        "{merged}"
    );
    assert!(merged.contains("AndrejK666/gears-rust"), "{merged}");
    // The frontend the record keeps is left as written.
    assert!(merged.contains("frontend = frontx_product("));
}

#[test]
fn a_cleared_frontend_goes_and_a_new_one_is_written_once() {
    let none = BTreeSet::new();
    let merged = onto_latest(
        LATEST,
        &rendered(&PICKS, &BTreeMap::new()),
        &change(&none, &none, FrontendChange::Remove),
    )
    .unwrap();
    assert!(!merged.contains("frontx_product("), "{merged}");
    assert!(merged.contains(r#"use_gear("studio-documents""#));
    // And back: written before `gears`, naming the source declared.
    let back = onto_latest(
        &merged,
        &rendered(&PICKS, &BTreeMap::new()),
        &change(&none, &none, FrontendChange::Write),
    )
    .unwrap();
    assert!(
        back.contains("    frontend = frontx_product(\n        source = \"studio-web\""),
        "{back}"
    );
    assert!(!back.contains("frontx-studio-web"), "{back}");
    assert!(back.find("frontend =").unwrap() < back.find("gears = [").unwrap());
}

#[test]
fn a_description_that_cannot_be_edited_is_refused_not_replaced() {
    let none = BTreeSet::new();
    let text = rendered(&PICKS, &BTreeMap::new());
    let gears = "GEARS = [use_gear(\"api-gateway\", source = \"gears-rust\")]\n\
                 product(id = \"studioweb\", sources = [], gears = GEARS)\n";
    let refused = onto_latest(gears, &text, &change(&none, &none, FrontendChange::Keep))
        .expect_err("`gears` is not a literal list");
    assert!(refused.to_string().contains("`gears`"), "{refused}");
    let refused = onto_latest(
        "# nothing but a comment\n",
        &text,
        &change(&none, &none, FrontendChange::Keep),
    )
    .expect_err("no product");
    assert!(refused.to_string().contains("product(...)"), "{refused}");
}

#[test]
fn the_scanner_skips_strings_and_comments() {
    let d = Doc::new("product(a = \"x, ) # y\", # b, c)\n  b = [1, (2, 3)],\n)");
    let p = d.product().unwrap();
    let args = d.args(&p);
    assert_eq!(args.len(), 2, "{args:?}");
    assert_eq!(d.slice(args[0].value), "\"x, ) # y\"");
    assert_eq!(d.items(d.list(args[1].value).unwrap()).len(), 2);
}

#[test]
fn each_gears_configuration_is_read_as_json() {
    let text = r#"
product(
    id = "studioweb",
    gears = [
        use_gear("mini-chat", source = "gears-rust",
                 config = {"client_credentials": {"client_id": "mini-chat", # the realm's client
                                                   "client_secret": "${MINI_CHAT_CLIENT_SECRET}"},
                           "limits": [1, 2.5], "on": True, "off": None}),
        use_gear("authn-resolver", plugins = [plugin("oidc-authn-plugin", config = {"jwt": {"issuer": 'https://id.example/realms/shop'}})]),
        use_gear("api-gateway"),
    ],
)
"#;
    let configs = gear_configs(text);
    assert_eq!(
        configs["mini-chat"],
        json!({
            "client_credentials": {"client_id": "mini-chat", "client_secret": "${MINI_CHAT_CLIENT_SECRET}"},
            "limits": [1, 2.5], "on": true, "off": null
        })
    );
    assert_eq!(
        configs["oidc-authn-plugin"]["jwt"]["issuer"],
        "https://id.example/realms/shop"
    );
    assert!(!configs.contains_key("api-gateway"));
    assert!(gear_configs("# no product\n").is_empty());
}
