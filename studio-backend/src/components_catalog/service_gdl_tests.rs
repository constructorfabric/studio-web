use super::*;

const FULL: &str = r#"
# The IDE a project's session runs.
gdl_version = "1.6"

service(
    name = "studio-theia",
    version = "1.4.0",
    description = "The IDE a project's session runs",
    image = "ghcr.io/constructorfabric/studio-theia",
    dockerfile = "Dockerfile",
    context = "..",
    ports = {"http": 3000, "debug": "9229"},
    health = "/healthz",
    env = {"STUDIO_API_URL": "gateway.url"},
    requires = ["studio-session", "account-management", "studio-session"],
    provides = ["ide"],
    docs = ["README.md", "../docs/design/theia.md"],
)
"#;

#[test]
fn a_full_passport_reads() {
    let s = read(FULL).unwrap();
    assert_eq!(s.name, "studio-theia");
    assert_eq!(s.version.as_deref(), Some("1.4.0"));
    assert_eq!(
        s.image.as_deref(),
        Some("ghcr.io/constructorfabric/studio-theia")
    );
    assert_eq!(s.context.as_deref(), Some(".."));
    assert_eq!(s.ports["http"], 3000);
    assert_eq!(s.ports["debug"], 9229);
    assert_eq!(s.health.as_deref(), Some("/healthz"));
    assert_eq!(s.env["STUDIO_API_URL"], "gateway.url");
    assert_eq!(s.requires, vec!["account-management", "studio-session"]);
    assert_eq!(s.provides, vec!["ide"]);
    assert_eq!(s.docs.len(), 2);
}

#[test]
fn only_the_name_is_required() {
    let s = read("gdl_version = \"1.6\"\nservice(name = \"x\")\n").unwrap();
    assert_eq!(
        s,
        ServicePassport {
            name: "x".into(),
            ..Default::default()
        }
    );
    let e = read("gdl_version = \"1.6\"\nservice(version = \"1\")\n").unwrap_err();
    assert!(e.contains("must name itself"), "{e}");
}

#[test]
fn a_wrong_fact_is_refused_by_name() {
    for (arg, says) in [
        ("image = \"ghcr.io/x/y:1.0\"", "tag or a digest"),
        ("ports = {\"http\": 0}", "not a port"),
        ("ports = {\"http\": 70000}", "not a port"),
        ("env = {\"lower\": \"x\"}", "variable name"),
        ("health = \"healthz\"", "not a route"),
        ("requires = [\"Not_An_Id\"]", "not an id"),
        ("dockerfile = \"/abs\"", "absolute"),
        ("tags = [\"x\"]", "has no argument `tags`"),
    ] {
        let src = format!("gdl_version = \"1.6\"\nservice(name = \"x\", {arg})\n");
        let e = read(&src).unwrap_err();
        assert!(e.contains(says), "{arg}: {e}");
    }
}

/// Every `service.gdl` in this repository reads.
#[test]
fn this_repositorys_service_passports_read() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut read_any = 0;
    for dir in ["theia", "keycloak", "studio-backend/docker/graph-postgres"] {
        let Ok(body) = std::fs::read_to_string(root.join(dir).join(FILE)) else {
            continue;
        };
        let s = read(&body).unwrap_or_else(|e| panic!("{dir}/{FILE}: {e}"));
        if let Some(dockerfile) = &s.dockerfile {
            let path = super::gdl_literal::resolve(dir, dockerfile).unwrap();
            assert!(root.join(&path).exists(), "{dir}: {path} does not exist");
        }
        for doc in &s.docs {
            let path = super::gdl_literal::resolve(dir, doc).unwrap();
            assert!(root.join(&path).exists(), "{dir}: {path} does not exist");
        }
        read_any += 1;
    }
    assert!(read_any > 0);
}

const KEYCLOAK: &str = r#"
gdl_version = "1.6"

service(
    name = "keycloak",
    kind = "infra",
    version = "26.0.7",
    image = "quay.io/keycloak/keycloak:26.0.7",
    args = ["start-dev"],
    ports = {"http": 8080, "management": 9000},
    health = "/health/ready",
    config = {"KC_HEALTH_ENABLED": "true", "KC_BOOTSTRAP_ADMIN_USERNAME": "admin"},
    secrets = ["KC_BOOTSTRAP_ADMIN_PASSWORD"],
    provides = {
        "oidc.issuer": "{public_url}/realms/product",
        "keycloak.admin_url": "http://{host}:{port.http}",
        "keycloak.admin_password": "{secret.KC_BOOTSTRAP_ADMIN_PASSWORD}",
    },
    chart = "oci://registry-1.docker.io/bitnamicharts/keycloak",
    chart_version = "24.4.0",
)
"#;

#[test]
fn an_infra_passport_reads_with_its_image_tag_and_provides() {
    let s = read(KEYCLOAK).unwrap();
    assert_eq!(s.image.as_deref(), Some("quay.io/keycloak/keycloak:26.0.7"));
    let i = s.infra.unwrap();
    assert_eq!(i.args, vec!["start-dev"]);
    assert_eq!(i.secrets, vec!["KC_BOOTSTRAP_ADMIN_PASSWORD"]);
    assert_eq!(i.provides["oidc.issuer"], "{public_url}/realms/product");
    assert_eq!(s.provides.len(), 3);
    assert_eq!(i.chart_version.as_deref(), Some("24.4.0"));
    assert!(!i.stateful);
}

#[test]
fn an_infra_passport_is_refused_where_its_facts_disagree() {
    for (args, says) in [
        (
            "image = \"x:1\", dockerfile = \"Dockerfile\"",
            "never built",
        ),
        ("ports = {\"http\": 80}", "names its `image`"),
        (
            "image = \"x:1\", provides = {\"a.b\": \"{port.web}\"}",
            "does not declare",
        ),
        (
            "image = \"x:1\", provides = {\"a.b\": \"{nope}\"}",
            "a template knows",
        ),
        ("image = \"x:1\", stateful = True", "data_path"),
        ("image = \"x:1\", storage = \"10Gi\"", "stateful = True"),
        (
            "image = \"x:1\", chart_version = \"1\"",
            "goes with the `chart`",
        ),
        (
            "image = \"x:1\", config = {\"P\": \"1\"}, secrets = [\"P\"]",
            "both in `config`",
        ),
        (
            "image = \"x:1\", provides = {\"Bad\": \"x\"}",
            "capability key",
        ),
    ] {
        let src =
            format!("gdl_version = \"1.6\"\nservice(name = \"x\", kind = \"infra\", {args})\n");
        let e = read(&src).unwrap_err();
        assert!(e.contains(says), "{args}: {e}");
    }
}

#[test]
fn infra_arguments_are_refused_on_an_own_service() {
    let e = read("gdl_version = \"1.6\"\nservice(name = \"x\", secrets = [\"A\"])\n").unwrap_err();
    assert!(e.contains("goes with kind = \"infra\""), "{e}");
    let e = read("gdl_version = \"1.6\"\nservice(name = \"x\", kind = \"db\")\n").unwrap_err();
    assert!(e.contains("not a kind"), "{e}");
}

#[test]
fn a_capability_is_read_as_a_variable() {
    assert_eq!(variable("oidc.issuer"), "OIDC_ISSUER");
    assert_eq!(variable("database.url"), "DATABASE_URL");
    assert_eq!(
        template_refs("postgres://u:{secret.P}@{host}:{port.pg}/x").unwrap(),
        vec![
            TemplateRef::Secret("P".into()),
            TemplateRef::Host,
            TemplateRef::Port("pg".into())
        ]
    );
    assert!(template_refs("{host").is_err());
    assert!(template_refs("host}").is_err());
}

/// The infra passports this repository carries read.
#[test]
fn this_repositorys_infra_passports_read() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    for dir in ["infra/postgresql", "infra/keycloak"] {
        let body = std::fs::read_to_string(root.join(dir).join(FILE))
            .unwrap_or_else(|e| panic!("{dir}/{FILE}: {e}"));
        let s = read(&body).unwrap_or_else(|e| panic!("{dir}/{FILE}: {e}"));
        assert!(s.infra.is_some(), "{dir} is an infra service");
    }
}
