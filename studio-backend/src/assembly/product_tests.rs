//! `product.gdl` at the repository root is Studio as a Gearbox product. The
//! engine writes it (`scripts/product-gdl.mjs`) from the gears this binary
//! links; this keeps the two from drifting apart, the way `gts-types` and
//! `api-contract` keep their snapshots.

use std::collections::BTreeSet;

/// Every gear id a product description names: `use_gear("…")` and
/// `plugin("…")`. A line scan, enough for the file the engine writes.
fn named(gdl: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for marker in ["use_gear(\"", "plugin(\""] {
        let mut rest = gdl;
        while let Some(at) = rest.find(marker) {
            rest = &rest[at + marker.len()..];
            if let Some(end) = rest.find('"') {
                out.insert(rest[..end].to_owned());
            }
        }
    }
    out
}

#[test]
fn a_product_description_names_its_gears_and_plugins() {
    let gdl = r#"gears = [
        use_gear("credstore", source = "gears-rust", plugins = [plugin("static-credstore-plugin"), plugin("studio-credstore-pg")]),
        use_gear("studio-documents", source = "studio-backend"),
    ]"#;
    let want: BTreeSet<String> = [
        "credstore",
        "static-credstore-plugin",
        "studio-credstore-pg",
        "studio-documents",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert_eq!(named(gdl), want);
}

// The file is written for the default build; `theia-bridge` links one gear
// more (studio-theia), which the product does not name.
#[cfg(not(feature = "theia-bridge"))]
#[test]
fn product_gdl_names_what_this_binary_links() {
    // Linked, and named by no product: the toolkit's runtime, which every
    // assembly has and gears-rust gives no description.
    const RUNTIME: &[&str] = &["gear-orchestrator"];
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../product.gdl");
    let gdl = std::fs::read_to_string(&path).expect("product.gdl at the repository root");
    let linked: BTreeSet<String> = super::linked()
        .expect("the gear registry")
        .into_iter()
        .map(|g| g.name)
        .filter(|name| !RUNTIME.contains(&name.as_str()))
        .collect();
    let in_file = named(&gdl);
    let missing: Vec<&String> = linked.difference(&in_file).collect();
    let extra: Vec<&String> = in_file.difference(&linked).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "{} does not name what this binary links.\n  linked, not named: {missing:?}\n  named, not linked: {extra:?}\n\
         Regenerate it: studio-backend gears > gears.json && \
         node scripts/product-gdl.mjs --gears gears.json --gears-rust ../gears-rust",
        path.display()
    );
}
