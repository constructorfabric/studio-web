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
