use super::*;
use crate::documents::spec_model::requirements::requirements;

const PRD: &str = "\
# PRD

- **ID**: `cpt-app-fr-export`

The system exports reports.

- **ID**: `cpt-app-fr-import`

The system imports reports; see also `cpt-app-fr-export`.
";

const DESIGN: &str = "\
# Design

Implements `cpt-app-fr-export`.
";

fn doc<'a>(path: &'a str, text: &'a str) -> SourceDoc<'a> {
    SourceDoc {
        path,
        text,
        doc_type: None,
    }
}

#[test]
fn a_requirement_is_traced_to_documents_code_and_tests_by_its_id() {
    let docs = [doc("prd.md", PRD), doc("design.md", DESIGN)];
    let reqs = requirements(&docs);
    let files = vec![
        (
            "src/export.rs".to_string(),
            "// cpt-app-fr-export\nfn export() {}\n".to_string(),
        ),
        (
            "src/export_tests.rs".to_string(),
            "#[test]\n// covers cpt-app-fr-export\nfn t() {}\n".to_string(),
        ),
        (
            "web/export.test.ts".to_string(),
            "it('cpt-app-fr-export-draft is another id', () => {})".to_string(),
        ),
        ("README.md".to_string(), "cpt-app-fr-export".to_string()),
    ];
    let traced = trace(&reqs, &docs, &files);
    let export = traced
        .iter()
        .find(|t| t.requirement.id == "cpt-app-fr-export")
        .expect("export");
    let paths = |c: &[Cited]| c.iter().map(|x| x.path.clone()).collect::<Vec<_>>();
    assert_eq!(paths(&export.documents), ["prd.md", "design.md"]);
    assert_eq!(
        export.documents[0].line, 9,
        "the mention, not the definition"
    );
    assert_eq!(paths(&export.code), ["src/export.rs"]);
    assert_eq!(paths(&export.tests), ["src/export_tests.rs"]);
    assert_eq!(export.tests[0].line, 2);
    let import = traced
        .iter()
        .find(|t| t.requirement.id == "cpt-app-fr-import")
        .expect("import");
    assert!(import.documents.is_empty() && import.code.is_empty() && import.tests.is_empty());
}

#[test]
fn tests_are_told_from_code_by_their_path() {
    for p in [
        "src/a_test.rs",
        "pkg/x_test.go",
        "tests/api.rs",
        "web/__tests__/a.tsx",
        "web/a.spec.ts",
        "py/test_x.py",
        "src/test/java/FooTest.java",
    ] {
        assert!(is_test_path(p), "{p}");
    }
    for p in ["src/lib.rs", "web/latest.ts", "contest/main.go"] {
        assert!(!is_test_path(p), "{p}");
    }
}

#[test]
fn one_pass_finds_the_same_places_as_reading_each_requirement_alone() {
    let docs = [doc("prd.md", PRD), doc("design.md", DESIGN)];
    let reqs = requirements(&docs);
    let files: Vec<(String, String)> = (0..50)
        .map(|i| {
            (
                format!("src/m{i}.rs"),
                format!(
                    "fn f() {{}}\n// CPT-APP-FR-EXPORT{}\n",
                    if i == 7 { "" } else { "-x" }
                ),
            )
        })
        .collect();
    let traced = trace(&reqs, &docs, &files);
    let export = traced
        .iter()
        .find(|t| t.requirement.id == "cpt-app-fr-export")
        .expect("export");
    assert_eq!(
        export.code,
        [Cited {
            path: "src/m7.rs".into(),
            line: 2
        }],
        "case aside, a whole token only"
    );
    assert_eq!(
        export.documents[0].line, 9,
        "the mention after its own definition"
    );
}
