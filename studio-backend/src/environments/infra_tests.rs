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
        public_url: Some("https://id.shop.example".into()),
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
        ingress: None,
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
        ingress: None,
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
        ingress: None,
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
        ingress: None,
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
    assert_eq!(
        values["OIDC_ISSUER"],
        "https://id.shop.example/realms/product"
    );
    assert_eq!(values["KEYCLOAK_ADMIN_PASSWORD"], "s3cret");
    assert!(provided_values(&keycloak(), None, "shop-dev", &BTreeMap::new()).is_err());
    let installs = installs(None, &[keycloak(), postgres()], None);
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
        "shop-dev",
        &secrets(),
        Some("studio-registry"),
        None,
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
        "shop-dev",
        &[("POSTGRES_PASSWORD".to_owned(), "p".to_owned())].into(),
        None,
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
fn a_build_that_kept_no_services_runs_the_records() {
    let records = [keycloak()];
    let none = BuiltInfra {
        build: "b1".into(),
        services: Vec::new(),
    };
    assert_eq!(built_services(&none, &records), records.to_vec());
    let locked = BuiltInfra {
        build: "b2".into(),
        services: locked_services(&resolved("quay.io/keycloak/keycloak:26.0.8@sha256:fff"))
            .unwrap(),
    };
    assert_eq!(
        built_services(&locked, &records),
        from_lock(&locked.services, &records)
    );
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

/* ── files, arguments and the address people reach (ADR-0064, amended) ── */

const REALM: &str = r#"{"realm":"product","clients":[{"clientId":"product-api","secret":"{secret.KC_BOOTSTRAP_ADMIN_PASSWORD}","attributes":{}},{"clientId":"product-portal","redirectUris":["https://shop.example/*"],"rootUrl":"{public_url}"}],"note":"{not a template}"}"#;

fn with_realm() -> InfraService {
    let mut s = keycloak();
    s.files = [(
        "/opt/keycloak/data/import/product.json".to_owned(),
        REALM.to_owned(),
    )]
    .into();
    s.args = vec!["--import-realm".into()];
    s
}

fn chart_file(files: &[(String, String)], name: &str) -> String {
    files
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, f)| f.clone())
        .unwrap_or_else(|| panic!("no {name}"))
}

#[test]
fn files_are_checked_paths_size_and_templates() {
    assert!(checked_services(vec![with_realm()]).is_ok());
    for bad in [
        "relative/realm.json",
        "/opt/../etc/passwd",
        "/opt//x",
        "/opt/./x",
        "/",
        "/opt/x/",
    ] {
        let mut s = keycloak();
        s.files = [(bad.to_owned(), "x".to_owned())].into();
        let e = checked_services(vec![s]).unwrap_err();
        assert!(e.contains("absolute path"), "{bad}: {e}");
    }
    let mut big = keycloak();
    big.files = [("/a".to_owned(), "x".repeat(MAX_FILES_BYTES))].into();
    let e = checked_services(vec![big]).unwrap_err();
    assert!(e.contains("bytes together"), "{e}");

    let mut undeclared = keycloak();
    undeclared.files = [("/a".to_owned(), r#"{"s":"{secret.NOPE}"}"#.to_owned())].into();
    let e = checked_services(vec![undeclared]).unwrap_err();
    assert!(
        e.contains("{secret.NOPE}") && e.contains("does not declare"),
        "{e}"
    );

    let mut braces = keycloak();
    braces.args = vec!["--x={{ .Values }}".into()];
    assert!(checked_services(vec![braces]).is_err());

    let mut not_an_address = keycloak();
    not_an_address.public_url = Some("https://not a host".into());
    assert!(checked_services(vec![not_an_address]).is_err());
}

#[test]
fn a_files_template_names_are_filled_and_its_own_braces_kept() {
    let filled = files(&with_realm(), "shop-dev", &secrets()).unwrap();
    let realm = &filled["/opt/keycloak/data/import/product.json"];
    assert!(realm.contains(r#""secret":"s3cret""#), "{realm}");
    assert!(
        realm.contains(r#""rootUrl":"https://id.shop.example""#),
        "{realm}"
    );
    assert!(realm.contains(r#""attributes":{}"#), "{realm}");
    assert!(realm.contains(r#""note":"{not a template}""#), "{realm}");
    serde_json::from_str::<Value>(realm).expect("still JSON");
    assert!(files(&with_realm(), "shop-dev", &BTreeMap::new()).is_err());
}

#[test]
fn a_generated_chart_mounts_the_files_read_only_and_restarts_on_a_change() {
    let chart = |s: &InfraService| {
        generated_chart(
            s,
            "registry.example/acme/shop/mirror/keycloak@sha256:abc",
            "shop-dev",
            &secrets(),
            None,
            None,
        )
        .unwrap()
    };
    let files = chart(&with_realm());
    // A file that says a secret is kept in a Secret, base64.
    let holder = chart_file(&files, "templates/files.yaml");
    assert!(holder.contains("kind: Secret"), "{holder}");
    assert!(holder.contains("name: keycloak-files"), "{holder}");
    assert!(!holder.contains("s3cret"), "{holder}");
    let workload = chart_file(&files, "templates/workload.yaml");
    assert!(
        workload.contains("mountPath: /opt/keycloak/data/import/product.json"),
        "{workload}"
    );
    assert!(workload.contains("subPath: file-0"), "{workload}");
    assert!(workload.contains("readOnly: true"), "{workload}");
    assert!(
        workload.contains("secretName: keycloak-files"),
        "{workload}"
    );
    assert!(workload.contains(FILES_HASH_ANNOTATION), "{workload}");
    // The passport's arguments, then the project's.
    let start = workload.find("start-dev").unwrap();
    let import = workload.find("--import-realm").unwrap();
    assert!(start < import, "{workload}");
    assert!(!files.iter().any(|(_, f)| f.contains("{{")));

    // Without a secret, a ConfigMap; another text, another hash.
    let mut plain = keycloak();
    plain.files = [("/etc/x.conf".to_owned(), "a = {host}".to_owned())].into();
    let files = chart(&plain);
    let holder = chart_file(&files, "templates/files.yaml");
    assert!(holder.contains("kind: ConfigMap"), "{holder}");
    assert!(holder.contains("binaryData"), "{holder}");
    let hash = |w: &str| {
        w.lines()
            .find(|l| l.contains(FILES_HASH_ANNOTATION))
            .unwrap()
            .to_owned()
    };
    let before = hash(&chart_file(&files, "templates/workload.yaml"));
    plain.files = [("/etc/x.conf".to_owned(), "a = b".to_owned())].into();
    let after = hash(&chart_file(&chart(&plain), "templates/workload.yaml"));
    assert_ne!(before, after);
    // No files: neither the object nor the annotation.
    let bare = chart(&keycloak());
    assert!(!bare.iter().any(|(n, _)| n == "templates/files.yaml"));
    assert!(!chart_file(&bare, "templates/workload.yaml").contains(FILES_HASH_ANNOTATION));
}

#[test]
fn a_public_url_is_routed_by_an_ingress_as_the_environment_asks() {
    let settings = InfraIngress {
        class: Some("nginx".into()),
        tls_secret: Some("shop-tls".into()),
        annotations: [(
            "cert-manager.io/cluster-issuer".to_owned(),
            "letsencrypt".to_owned(),
        )]
        .into(),
    };
    let mut s = keycloak();
    s.public_url = Some("https://id.shop.example/auth".into());
    let files = generated_chart(
        &s,
        "img@sha256:abc",
        "shop-dev",
        &secrets(),
        None,
        Some(&settings),
    )
    .unwrap();
    let v: Value = serde_yaml::from_str(&chart_file(&files, "templates/ingress.yaml")).unwrap();
    assert_eq!(v["kind"], "Ingress");
    assert_eq!(v["spec"]["ingressClassName"], "nginx");
    assert_eq!(v["spec"]["rules"][0]["host"], "id.shop.example");
    let path = &v["spec"]["rules"][0]["http"]["paths"][0];
    assert_eq!(path["path"], "/auth");
    assert_eq!(path["backend"]["service"]["name"], "keycloak");
    assert_eq!(path["backend"]["service"]["port"]["number"], 8080);
    assert_eq!(v["spec"]["tls"][0]["secretName"], "shop-tls");
    assert_eq!(v["spec"]["tls"][0]["hosts"][0], "id.shop.example");
    assert_eq!(
        v["metadata"]["annotations"]["cert-manager.io/cluster-issuer"],
        "letsencrypt"
    );

    // An http address, no settings: a plain rule at `/`.
    s.public_url = Some("http://id.shop.example".into());
    let files = generated_chart(
        &s,
        "img@sha256:abc",
        "shop-dev",
        &secrets(),
        None,
        Some(&InfraIngress::default()),
    )
    .unwrap();
    let v: Value = serde_yaml::from_str(&chart_file(&files, "templates/ingress.yaml")).unwrap();
    assert_eq!(v["spec"]["rules"][0]["http"]["paths"][0]["path"], "/");
    assert!(v["spec"].get("tls").is_none());
    assert!(v["spec"].get("ingressClassName").is_none());
}

#[test]
fn installs_route_a_generated_services_public_url_with_the_preview_class_by_default() {
    let mut no_url = keycloak();
    no_url.passport.name = "other".into();
    no_url.passport.provides.clear();
    no_url.public_url = None;
    let list = installs(None, &[keycloak(), postgres(), no_url], Some("nginx"));
    assert_eq!(
        list[0].ingress.as_ref().and_then(|i| i.class.as_deref()),
        Some("nginx")
    );
    assert_eq!(list[1].ingress, None, "the database step routes nothing");
    assert_eq!(list[2].ingress, None, "no address, nothing to route");
    let own = InfraPlacement {
        ingress: Some(InfraIngress {
            class: Some("traefik".into()),
            ..Default::default()
        }),
        ..Default::default()
    };
    let list = installs(Some(&own), &[keycloak()], Some("nginx"));
    assert_eq!(
        list[0].ingress.as_ref().and_then(|i| i.class.as_deref()),
        Some("traefik")
    );
}

#[test]
fn the_ingress_settings_are_checked() {
    let with = |i: InfraIngress| {
        check_placement(
            Some(InfraPlacement {
                ingress: Some(i),
                ..Default::default()
            }),
            true,
        )
    };
    assert!(
        with(InfraIngress {
            class: Some("not a class".into()),
            ..Default::default()
        })
        .is_err()
    );
    assert!(
        with(InfraIngress {
            annotations: [("a".to_owned(), "x\ny".to_owned())].into(),
            ..Default::default()
        })
        .is_err()
    );
    // Blank settings are none.
    assert_eq!(
        with(InfraIngress {
            class: Some(" ".into()),
            ..Default::default()
        })
        .unwrap(),
        None
    );
}

#[test]
fn a_public_url_template_without_an_address_refuses_the_deploy() {
    let mut s = keycloak();
    s.public_url = None;
    let item = &plan(None, std::slice::from_ref(&s), under_shop)[0];
    let (code, why) = item.refusal.clone().expect("refused");
    assert_eq!(code, PUBLIC_URL_MISSING);
    assert!(why.contains("oidc.issuer"), "{why}");
    assert!(why.contains("public_url"), "{why}");
    assert_eq!(item.route, None);
    // The run refuses the same, never the cluster's own address.
    let e = provided_values(&s, None, "shop-dev", &secrets()).unwrap_err();
    assert!(e.contains(PUBLIC_URL_MISSING), "{e}");

    // A ready chart is refused the same; a shared place gives its own values.
    let mut chart = s.clone();
    chart.chart_ref = Some("oci://registry.example/acme/shop/mirror/charts/keycloak".into());
    chart.chart_version = Some("24.4.0".into());
    let item = &plan(None, &[chart], under_shop)[0];
    assert_eq!(item.refusal.as_ref().unwrap().0, PUBLIC_URL_MISSING);
    let place = InfraPlacement {
        placement: Placement::Shared,
        shared: vec![SharedService {
            service: "keycloak".into(),
            namespace: None,
            provides: BTreeMap::new(),
        }],
        ingress: None,
    };
    assert_eq!(
        plan(Some(&place), std::slice::from_ref(&s), under_shop)[0].refusal,
        None
    );

    // A file that says {public_url} needs one too, even when no capability does.
    let mut file_only = s;
    file_only.passport.provides.remove("oidc.issuer");
    file_only.files = [("/a".to_owned(), "{public_url}".to_owned())].into();
    let (code, why) = plan(None, &[file_only], under_shop)[0]
        .refusal
        .clone()
        .unwrap();
    assert_eq!(code, PUBLIC_URL_MISSING);
    assert!(why.contains("/a"), "{why}");
}

#[test]
fn the_plan_shows_the_route_and_what_a_ready_chart_does_not_apply() {
    let item = &plan(None, &[with_realm()], under_shop)[0];
    assert_eq!(item.refusal, None);
    assert_eq!(item.route.as_deref(), Some("https://id.shop.example"));
    assert!(item.notes.is_empty());
    let mut chart = with_realm();
    chart.chart_ref = Some("oci://registry.example/acme/shop/mirror/charts/keycloak".into());
    chart.chart_version = Some("24.4.0".into());
    let item = &plan(None, &[chart], under_shop)[0];
    assert_eq!(item.route, None);
    assert_eq!(item.notes.len(), 1);
    assert!(
        item.notes[0].contains("files and extra arguments are not applied"),
        "{:?}",
        item.notes
    );
}

#[test]
fn the_lock_keeps_the_records_files_and_arguments() {
    let locked = locked_services(&resolved("quay.io/keycloak/keycloak:26.0.7@sha256:abc")).unwrap();
    let services = from_lock(&locked, &[with_realm()]);
    assert_eq!(services[0].args, vec!["--import-realm"]);
    assert!(
        services[0]
            .files
            .contains_key("/opt/keycloak/data/import/product.json")
    );
}

#[test]
fn an_issuer_that_is_not_https_refuses_the_deploy() {
    let mut s = keycloak();
    s.public_url = Some("http://id.shop.example".into());
    let item = &plan(None, std::slice::from_ref(&s), under_shop)[0];
    let (code, why) = item.refusal.clone().expect("refused");
    assert_eq!(code, ISSUER_NOT_HTTPS);
    assert!(
        why.contains("http://id.shop.example/realms/product"),
        "{why}"
    );
    assert!(why.contains("oidc-authn-plugin"), "{why}");
    // https passes; a service that gives no issuer is not asked.
    assert_eq!(plan(None, &[keycloak()], under_shop)[0].refusal, None);
    let mut other = postgres();
    other.passport.provides = [("x.url".to_owned(), "{public_url}".to_owned())].into();
    other.passport.ports = [("http".to_owned(), 80)].into();
    other.passport.stateful = false;
    other.public_url = Some("http://x.shop.example".into());
    assert_eq!(plan(None, &[other], under_shop)[0].refusal, None);
    // A shared place's issuer is checked the same.
    let place = InfraPlacement {
        placement: Placement::Shared,
        shared: vec![SharedService {
            service: "keycloak".into(),
            namespace: None,
            provides: [(
                "oidc.issuer".to_owned(),
                "http://id.acme.example/realms/shop".to_owned(),
            )]
            .into(),
        }],
        ingress: None,
    };
    let item = &plan(Some(&place), &[keycloak()], under_shop)[0];
    assert_eq!(item.refusal.as_ref().unwrap().0, ISSUER_NOT_HTTPS);
}

#[test]
fn an_issuer_only_this_machine_reaches_is_a_warning() {
    for host in [
        "id.localtest.me",
        "localhost",
        "keycloak.local",
        "id.127.0.0.1.nip.io",
    ] {
        let mut s = keycloak();
        s.public_url = Some(format!("https://{host}"));
        let item = &plan(None, std::slice::from_ref(&s), under_shop)[0];
        assert_eq!(item.refusal, None, "{host}: a warning, not a refusal");
        assert_eq!(item.warnings.len(), 1, "{host}");
        let (code, why) = &item.warnings[0];
        assert_eq!(*code, ISSUER_UNREACHABLE);
        assert!(why.contains(host), "{why}");
        assert!(why.contains("client_credentials"), "{why}");
        let installs = installs(None, std::slice::from_ref(&s), None);
        assert_eq!(
            issuer_warnings(&installs[0].service, installs[0].install, None).len(),
            1
        );
    }
    assert!(plan(None, &[keycloak()], under_shop)[0].warnings.is_empty());
    assert!(!local_only_host("id.shop.example"));
    assert!(!local_only_host("localhost.example.com"));
}
