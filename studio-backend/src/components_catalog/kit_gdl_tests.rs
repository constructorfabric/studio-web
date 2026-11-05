use super::*;

#[test]
fn a_full_kit_passport_reads() {
    let k = read(
        r#"gdl_version = "1.6"
kit(
    name = "sdlc",
    title = "Software Delivery Lifecycle",
    version = "1.4.0",
    description = "Product-to-code traceability",
    publisher = "Constructor Fabric",
    visibility = "public",
    manifest = ".cf-studio-kit.toml",
    kinds = ["PRD", "ADR"],
    docs = ["README.md"],
)
"#,
    )
    .unwrap();
    assert_eq!(k.name, "sdlc");
    assert_eq!(k.title.as_deref(), Some("Software Delivery Lifecycle"));
    assert_eq!(k.manifest.as_deref(), Some(".cf-studio-kit.toml"));
    assert_eq!(k.kinds, vec!["PRD", "ADR"]);
    assert_eq!(k.docs, vec!["README.md"]);
}

#[test]
fn a_kit_names_itself_by_its_slug() {
    assert!(read("gdl_version = \"1.6\"\nkit(name = \"Not A Slug\")\n").is_err());
    assert!(
        read("gdl_version = \"1.6\"\nkit(title = \"x\")\n")
            .unwrap_err()
            .contains("must name itself")
    );
    assert!(read("gdl_version = \"1.6\"\nkit(name = \"x\", visibility = \"open\")\n").is_err());
    assert!(read("gdl_version = \"1.6\"\nservice(name = \"x\")\n").is_err());
}
