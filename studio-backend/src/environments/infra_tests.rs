use super::*;

fn keycloak() -> InfraService {
    InfraService {
        passport: InfraPassport {
            name: "keycloak".into(),
            version: Some("26.0.7".into()),
            image: Some("quay.io/keycloak/keycloak:26.0.7".into()),
            ports: [("http".to_owned(), 8080), ("management".to_owned(), 9000)].into(),
            health: Some("/health/ready".into()),
            args: vec!["start-dev".into()],
            config: [("KC_HEALTH_ENABLED".to_owned(), "true".to_owned())].into(),
            secrets: vec!["KC_BOOTSTRAP_ADMIN_PASSWORD".into()],
            provides: [
                (
                    "oidc.issuer".to_owned(),
                    "{public_url}/realms/product".to_owned(),
                ),
                (
                    "keycloak.admin_password".to_owned(),
                    "{secret.KC_BOOTSTRAP_ADMIN_PASSWORD}".to_owned(),
                ),
            ]
            .into(),
            ..Default::default()
        },
        image: Some("registry.example/acme/shop/mirror/keycloak@sha256:abc".into()),
        ..Default::default()
    }
}

fn postgres() -> InfraService {
    InfraService {
        passport: InfraPassport {
            name: "postgresql".into(),
            image: Some("pgvector/pgvector:pg18".into()),
            ports: [("postgres".to_owned(), 5432)].into(),
            secrets: vec!["POSTGRES_PASSWORD".into()],
            provides: [("postgres".to_owned(), "{host}:{port.postgres}".to_owned())].into(),
            stateful: true,
            data_path: Some("/var/lib/postgresql/data".into()),
            ..Default::default()
        },
        image: Some("registry.example/acme/shop/mirror/postgresql@sha256:def".into()),
        ..Default::default()
    }
}

fn secrets() -> BTreeMap<String, String> {
    [(
        "KC_BOOTSTRAP_ADMIN_PASSWORD".to_owned(),
        "s3cret".to_owned(),
    )]
    .into()
}

fn under_shop(r: &str) -> Result<(), String> {
    if r.contains("/acme/shop/") {
        Ok(())
    } else {
        Err(format!("'{r}' is not under the project's path"))
    }
}

#[test]
fn a_dev_environment_runs_infra_with_the_product() {
    let shared = InfraPlacement {
        placement: Placement::Shared,
        shared: vec![],
    };
    let e = check_placement(Some(shared.clone()), true).unwrap_err();
    assert!(e.contains("dev environment"), "{e}");
    assert_eq!(
        check_placement(Some(shared.clone()), false).unwrap(),
        Some(shared)
    );
    assert_eq!(
        check_placement(Some(InfraPlacement::default()), true).unwrap(),
        None
    );
}

#[test]
fn a_shared_place_is_checked() {
    let twice = InfraPlacement {
        placement: Placement::Shared,
        shared: vec![
            SharedService {
                service: "keycloak".into(),
                namespace: None,
                provides: BTreeMap::new(),
            };
            2
        ],
    };
    assert!(
        check_placement(Some(twice), false)
            .unwrap_err()
            .contains("twice")
    );
    let bad_key = InfraPlacement {
        placement: Placement::Shared,
        shared: vec![SharedService {
            service: "keycloak".into(),
            namespace: None,
            provides: [("OIDC".to_owned(), "x".to_owned())].into(),
        }],
    };
    assert!(check_placement(Some(bad_key), false).is_err());
}

#[test]
fn services_are_checked_against_their_passports() {
    assert!(checked_services(vec![keycloak(), postgres()]).is_ok());
    let mut twice = keycloak();
    twice.passport.name = "postgresql".into();
    twice.passport.provides = [("postgres".to_owned(), "{host}".to_owned())].into();
    let e = checked_services(vec![postgres(), twice]).unwrap_err();
    assert!(e.contains("twice") || e.contains("both provide"), "{e}");

    let mut undeclared = keycloak();
    undeclared
        .passport
        .provides
        .insert("x.y".into(), "{secret.NOPE}".into());
    let e = checked_services(vec![undeclared]).unwrap_err();
    assert!(e.contains("does not declare"), "{e}");

    let mut braces = keycloak();
    braces
        .passport
        .config
        .insert("KC_X".into(), "{{ .Values }}".into());
    assert!(checked_services(vec![braces]).is_err());

    let mut values_without_chart = keycloak();
    values_without_chart.chart_values = Some(json!({}));
    assert!(checked_services(vec![values_without_chart]).is_err());

    let mut chart_without_version = keycloak();
    chart_without_version.chart_ref =
        Some("oci://registry.example/acme/shop/mirror/charts/keycloak".into());
    assert!(checked_services(vec![chart_without_version]).is_err());
}

#[test]
fn the_plan_says_how_each_service_comes_and_what_stops_it() {
    let mut chart = keycloak();
    chart.chart_ref = Some("oci://registry.example/acme/shop/mirror/charts/keycloak".into());
    chart.chart_version = Some("24.4.0".into());
    let mut not_imported = keycloak();
    not_imported.passport.name = "other".into();
    not_imported.image = None;
    let plan = plan(None, &[postgres(), chart, not_imported], under_shop);
    assert_eq!(plan[0].install, Install::Database);
    assert_eq!(plan[0].refusal, None);
    assert_eq!(plan[1].install, Install::Chart);
    assert_eq!(
        plan[1].chart.as_deref(),
        Some("oci://registry.example/acme/shop/mirror/charts/keycloak:24.4.0")
    );
    assert_eq!(plan[2].install, Install::Generated);
    assert_eq!(
        plan[2].refusal.as_ref().unwrap().0,
        "INFRA_IMAGE_NOT_IMPORTED"
    );
    assert!(
        plan[1]
            .provides
            .contains(&("oidc.issuer".to_owned(), "OIDC_ISSUER".to_owned()))
    );
}

#[test]
fn an_image_outside_the_projects_path_is_refused() {
    let mut s = keycloak();
    s.image = Some("quay.io/keycloak/keycloak:26.0.7".into());
    let p = plan(None, &[s], under_shop);
    assert_eq!(
        p[0].refusal.as_ref().unwrap().0,
        "IMAGE_NOT_IN_PROJECT_PATH"
    );
}

#[test]
fn a_shared_place_installs_nothing_and_must_name_the_service() {
    let place = InfraPlacement {
        placement: Placement::Shared,
        shared: vec![SharedService {
            service: "keycloak".into(),
            namespace: Some("identity".into()),
            provides: [(
                "oidc.issuer".to_owned(),
                "https://id.acme.example/realms/shop".to_owned(),
            )]
            .into(),
        }],
    };
    let p = plan(Some(&place), &[keycloak(), postgres()], under_shop);
    assert_eq!(p[0].install, Install::Shared);
    assert_eq!(p[0].refusal, None);
    assert_eq!(p[0].image, None);
    assert_eq!(
        p[1].refusal.as_ref().unwrap().0,
        "INFRA_NOT_IN_SHARED_PLACE"
    );
    let values = provided_values(
        &keycloak(),
        place.shared.first(),
        "shop-prod",
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(values["OIDC_ISSUER"], "https://id.acme.example/realms/shop");
}

#[test]
fn provided_values_are_filled_for_the_namespace() {
    let values = provided_values(&keycloak(), None, "shop-dev", &secrets()).unwrap();
    assert_eq!(values["OIDC_ISSUER"], "http://keycloak:8080/realms/product");
    assert_eq!(values["KEYCLOAK_ADMIN_PASSWORD"], "s3cret");
    let mut public = keycloak();
    public.public_url = Some("https://id.shop.example".into());
    let values = provided_values(&public, None, "shop-dev", &secrets()).unwrap();
    assert_eq!(
        values["OIDC_ISSUER"],
        "https://id.shop.example/realms/product"
    );
    assert!(provided_values(&keycloak(), None, "shop-dev", &BTreeMap::new()).is_err());
    let installs = installs(None, &[keycloak(), postgres()]);
    // The database step wires the gears to their server itself.
    assert_eq!(
        produced_variables(&installs),
        vec!["KEYCLOAK_ADMIN_PASSWORD", "OIDC_ISSUER"]
    );
    assert_eq!(
        database_image(&installs).as_deref(),
        Some("registry.example/acme/shop/mirror/postgresql@sha256:def")
    );
}

/// The issuer a product's own Keycloak provides is not Studio's: the
/// platform-IdP check passes (ADR-0062 §9, ADR-0064 §2).
#[test]
fn the_products_own_keycloak_passes_the_platform_idp_check() {
    let values = provided_values(&keycloak(), None, "shop-dev", &secrets()).unwrap();
    let rendered = format!(
        "oidc:\n  issuer: {}\n  clientId: shop-web\n",
        values["OIDC_ISSUER"]
    );
    assert_eq!(
        super::super::preflight::platform_idp_refusal(
            &rendered,
            Some("https://id.example.com/realms/studio")
        ),
        None
    );
}

#[test]
fn a_generated_chart_is_the_manifests_the_passport_describes() {
    let files = generated_chart(
        &keycloak(),
        "registry.example/acme/shop/mirror/keycloak@sha256:abc",
        &secrets(),
        Some("studio-registry"),
    )
    .unwrap();
    let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(
        names,
        [
            "Chart.yaml",
            "templates/secret.yaml",
            "templates/service.yaml",
            "templates/workload.yaml"
        ]
    );
    let workload = &files[3].1;
    assert!(workload.contains("kind: Deployment"), "{workload}");
    assert!(workload.contains("path: /health/ready"), "{workload}");
    assert!(workload.contains("port: management"), "{workload}");
    assert!(workload.contains("studio-registry"), "{workload}");
    assert!(workload.contains("start-dev"), "{workload}");
    assert!(!files[1].1.contains("s3cret"), "the secret is base64");
    assert!(!files.iter().any(|(_, f)| f.contains("{{")));

    let pg = generated_chart(
        &postgres(),
        "registry.example/acme/shop/mirror/postgresql@sha256:def",
        &[("POSTGRES_PASSWORD".to_owned(), "p".to_owned())].into(),
        None,
    )
    .unwrap();
    let workload = &pg.last().unwrap().1;
    assert!(workload.contains("kind: StatefulSet"), "{workload}");
    assert!(workload.contains("storage: 10Gi"), "{workload}");
    assert!(workload.contains("tcpSocket"), "{workload}");
    assert!(
        workload.contains("mountPath: /var/lib/postgresql/data"),
        "{workload}"
    );
}

#[test]
fn a_ready_charts_values_are_filled_and_named_as_the_service() {
    let mut s = keycloak();
    s.chart_ref = Some("oci://registry.example/acme/shop/mirror/charts/keycloak".into());
    s.chart_version = Some("24.4.0".into());
    s.chart_values =
        Some(json!({ "auth": { "adminPassword": "{secret.KC_BOOTSTRAP_ADMIN_PASSWORD}" } }));
    let v = chart_values(&s, "shop-dev", &secrets()).unwrap();
    assert_eq!(v["auth"]["adminPassword"], "s3cret");
    assert_eq!(v["fullnameOverride"], "keycloak");
}

#[test]
fn a_services_own_secret_is_kept_under_its_name() {
    assert_eq!(
        secret_key("keycloak", "KC_BOOTSTRAP_ADMIN_PASSWORD"),
        "INFRA_KEYCLOAK_KC_BOOTSTRAP_ADMIN_PASSWORD"
    );
}

/* ── a build's lock (ADR-0065) ── */

/// What `gearbox resolve --format json` says of a product with Keycloak.
fn resolved(image: &str) -> Value {
    json!({
        "id": "shop",
        "infra": {
            "services": [{
                "name": "keycloak", "source": "studio-web",
                "gdl_path": "infra/keycloak/service.gdl", "passport_hash": "b3",
                "passport": {
                    "name": "keycloak", "kind": "infra", "version": "26.0.7",
                    "description": "Keycloak: the product's own OIDC identity provider",
                    "image": "quay.io/keycloak/keycloak:26.0.7",
                    "ports": {"http": 8080, "management": 9000},
                    "config": {"KC_HEALTH_ENABLED": "true"},
                    "secrets": ["KC_BOOTSTRAP_ADMIN_PASSWORD"],
                    "provides": {"oidc.issuer": "{public_url}/realms/product"},
                    "env": {}, "requires": [], "docs": []
                },
                "image": {"reference": image, "digest": image.rsplit_once('@').map(|(_, d)| d)},
                "config": {"KC_HEALTH_ENABLED": "false", "KC_PROXY_HEADERS": "xforwarded"},
                "overridden": ["KC_HEALTH_ENABLED", "KC_PROXY_HEADERS"]
            }],
            "capabilities": {
                "oidc.issuer": {"service": "keycloak", "env": "OIDC_ISSUER", "template": "{public_url}/realms/product"}
            },
            "needs": []
        }
    })
}

#[test]
fn a_product_without_infra_locks_no_services() {
    assert!(
        locked_services(&json!({ "id": "shop" }))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_lock_gives_each_service_its_passport_without_its_description() {
    let list = locked_services(&resolved("quay.io/keycloak/keycloak:26.0.7@sha256:abc")).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "keycloak");
    assert_eq!(list[0].passport.ports["http"], 8080);
    assert_eq!(list[0].passport.description, None);
    assert_eq!(
        list[0].image.as_ref().unwrap().digest.as_deref(),
        Some("sha256:abc")
    );
}

#[test]
fn a_deploy_runs_the_locks_configuration_with_the_environments_copy() {
    let locked = locked_services(&resolved("quay.io/keycloak/keycloak:26.0.7@sha256:abc")).unwrap();
    let mut record = keycloak();
    record.passport.config.clear();
    record.public_url = Some("https://shop.example".into());
    let services = from_lock(&locked, &[record]);
    assert_eq!(services.len(), 1);
    let s = &services[0];
    assert_eq!(s.passport.config["KC_HEALTH_ENABLED"], "false");
    assert_eq!(s.passport.config["KC_PROXY_HEADERS"], "xforwarded");
    assert_eq!(
        s.passport.image.as_deref(),
        Some("quay.io/keycloak/keycloak:26.0.7@sha256:abc")
    );
    assert_eq!(
        s.image.as_deref(),
        Some("registry.example/acme/shop/mirror/keycloak@sha256:abc")
    );
    assert_eq!(s.public_url.as_deref(), Some("https://shop.example"));
}

#[test]
fn a_copy_of_another_digest_is_no_copy_of_the_locked_image() {
    let locked = locked_services(&resolved("quay.io/keycloak/keycloak:26.0.8@sha256:fff")).unwrap();
    let services = from_lock(&locked, &[keycloak()]);
    assert_eq!(services[0].image, None);
    let item = &plan(None, &services, |_| Ok(()))[0];
    let (code, why) = item.refusal.clone().unwrap();
    assert_eq!(code, "INFRA_IMAGE_NOT_IMPORTED");
    assert!(why.contains("keycloak:26.0.8@sha256:fff"), "{why}");
}

#[test]
fn a_service_the_lock_names_without_a_record_has_nothing_imported() {
    let locked = locked_services(&resolved("quay.io/keycloak/keycloak:26.0.7")).unwrap();
    let services = from_lock(&locked, &[postgres()]);
    assert_eq!(services.len(), 1);
    assert_eq!(services[0].image, None);
}

#[test]
fn a_project_keeps_the_newest_builds_infra_first_and_a_bounded_few() {
    let mut kept = Vec::new();
    for n in 0..=MAX_LOCKED_BUILDS {
        keep_built(&mut kept, &format!("b{n}"), Vec::new());
    }
    keep_built(&mut kept, "b3", Vec::new());
    assert_eq!(kept.len(), MAX_LOCKED_BUILDS);
    assert_eq!(kept[0].build, "b3");
    assert_eq!(kept.iter().filter(|b| b.build == "b3").count(), 1);
}

#[test]
fn a_copy_without_the_locked_digest_is_no_copy() {
    let locked = locked_services(&resolved("quay.io/keycloak/keycloak:26.0.7@sha256:abc")).unwrap();
    let mut record = keycloak();
    record.image = Some("registry.example/acme/shop/mirror/keycloak:26.0.7".into());
    assert_eq!(from_lock(&locked, &[record])[0].image, None);
}

#[test]
fn without_a_digest_the_lock_is_copied_by_its_tag() {
    let locked = locked_services(&resolved("quay.io/keycloak/keycloak:26.0.8")).unwrap();
    let mut record = keycloak();
    record.image = Some("registry.example:5000/acme/shop/mirror/keycloak:26.0.7@sha256:abc".into());
    assert_eq!(
        from_lock(&locked, std::slice::from_ref(&record))[0].image,
        None
    );
    record.image = Some("registry.example:5000/acme/shop/mirror/keycloak:26.0.8@sha256:abc".into());
    assert_eq!(
        from_lock(&locked, std::slice::from_ref(&record))[0].image,
        record.image
    );
}
