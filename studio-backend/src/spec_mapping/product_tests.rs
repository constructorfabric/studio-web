use super::*;
use crate::spec_mapping::plan::{BuildState, Candidate, Composability, Provider, Step};
use uuid::Uuid;

fn source(path: &str, inferred: bool) -> CapabilitySource {
    CapabilitySource {
        kind: "file".into(),
        id: Uuid::new_v4(),
        label: path.into(),
        revision: "sha1".into(),
        node_id: None,
        inferred,
        because: if inferred {
            vec!["5.1 Upload a file".into()]
        } else {
            Vec::new()
        },
        terms: Vec::new(),
        requirements: if inferred { 3 } else { 0 },
        confirmed: true,
    }
}

fn need(key: &str, sources: Vec<CapabilitySource>) -> DeclaredCapability {
    DeclaredCapability {
        key: key.into(),
        sources,
    }
}

fn candidate(name: &str) -> Candidate {
    Candidate {
        name: name.into(),
        kind: "gear".into(),
        step: Step::Contract,
        contracts: Vec::new(),
        passage: None,
        cites: None,
        declared: false,
        score: 0,
        why: Vec::new(),
        built: BuildState::Built,
        composable: Composability::Runs,
        composable_why: None,
        version: None,
        decision: None,
        tier: "platform".into(),
        maturity: None,
    }
}

fn row(capability: &str, gears: &[&str], nonfunctional: bool) -> PlanRow {
    PlanRow {
        capability: capability.into(),
        candidates: gears.iter().map(|g| candidate(g)).collect(),
        gap: gears.is_empty(),
        unbuilt: false,
        nonfunctional,
        providers: gears
            .iter()
            .map(|g| Provider {
                name: (*g).into(),
                strong: true,
                maturity: None,
            })
            .collect(),
    }
}

fn confirmed(capability: &str, gear: &str, changed: bool) -> PastDecision {
    PastDecision {
        capability: capability.into(),
        gear: gear.into(),
        decision: "confirmed".into(),
        gear_version: None,
        document_changed: changed,
    }
}

fn code(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|n| (*n).to_owned()).collect()
}

#[test]
fn a_capability_no_gear_in_the_code_fills_is_missing_on_every_document_that_asks() {
    let needs = [need(
        "storage",
        vec![source("docs/PRD.md", true), source("docs/DESIGN.md", false)],
    )];
    let rows = [row("storage", &["file-storage", "blob-store"], false)];
    let found = findings(&needs, &rows, &code(&["authn"]), &[]);
    assert_eq!(found.len(), 1);
    let f = &found[0];
    assert_eq!(f.rule, MISSING);
    assert_eq!(f.severity, "high", "one document declares it outright");
    assert_eq!(f.sides.len(), 2);
    assert_eq!(
        f.sides[0].quote,
        "5.1 Upload a file (and 2 more requirements)"
    );
    assert_eq!(f.sides[1].quote, "front matter: capabilities");
    assert_eq!(f.candidates, ["file-storage", "blob-store"]);
    assert!(f.message.contains("`file-storage`"));
}

#[test]
fn a_capability_only_read_from_the_requirements_is_a_medium_finding() {
    let needs = [need("storage", vec![source("docs/PRD.md", true)])];
    let rows = [row("storage", &[], false)];
    let found = findings(&needs, &rows, &code(&[]), &[]);
    assert_eq!(found[0].severity, "medium");
    assert!(found[0].message.contains("Nothing in the catalogue"));
}

#[test]
fn a_filled_or_nonfunctional_capability_is_no_finding_whatever_the_spelling() {
    let needs = [
        need("storage", vec![source("docs/PRD.md", false)]),
        need("deploy", vec![source("docs/PRD.md", false)]),
    ];
    let rows = [
        row("storage", &["file-storage"], false),
        row("deploy", &[], true),
    ];
    assert!(findings(&needs, &rows, &code(&["file_storage"]), &[]).is_empty());
}

#[test]
fn a_confirmed_gear_the_code_does_not_use_says_more_than_missing() {
    let needs = [need("storage", vec![source("docs/PRD.md", false)])];
    let rows = [row("storage", &["file-storage", "blob-store"], false)];

    let none = findings(
        &needs,
        &rows,
        &code(&[]),
        &[confirmed("storage", "file-storage", false)],
    );
    assert_eq!(none.len(), 1, "no second finding saying it is missing");
    assert_eq!(none[0].rule, DECIDED_NOT_BUILT);
    assert_eq!(none[0].gear.as_deref(), Some("file-storage"));

    let other = findings(
        &needs,
        &rows,
        &code(&["blob-store"]),
        &[confirmed("storage", "file-storage", false)],
    );
    assert_eq!(other.len(), 1);
    assert_eq!(other[0].candidates, ["blob-store"]);
    assert!(other[0].message.contains("out of date"));
}

#[test]
fn only_the_newest_decision_counts_and_a_changed_document_suspends_it() {
    let needs = [need("storage", vec![source("docs/PRD.md", false)])];
    let rows = [row("storage", &["file-storage", "blob-store"], false)];
    let in_code = code(&["blob-store"]);
    let rejected_later = PastDecision {
        decision: "rejected".into(),
        ..confirmed("storage", "file-storage", false)
    };
    let newest_first = [rejected_later, confirmed("storage", "file-storage", false)];
    assert!(findings(&needs, &rows, &in_code, &newest_first).is_empty());
    let changed = [confirmed("storage", "file-storage", true)];
    assert!(findings(&needs, &rows, &in_code, &changed).is_empty());
}

#[test]
fn a_fingerprint_follows_the_capability_and_gear_not_the_documents() {
    let rows = [row("storage", &[], false)];
    let a = findings(
        &[need("storage", vec![source("a.md", true)])],
        &rows,
        &code(&[]),
        &[],
    );
    let b = findings(
        &[need("storage", vec![source("b.md", false)])],
        &rows,
        &code(&[]),
        &[],
    );
    assert_eq!(a[0].fingerprint, b[0].fingerprint);
}

/// `row`, with each gear at the maturity given.
fn row_at(capability: &str, gears: &[(&str, &str)]) -> PlanRow {
    let names: Vec<&str> = gears.iter().map(|(g, _)| *g).collect();
    let mut r = row(capability, &names, false);
    for (c, (_, m)) in r.candidates.iter_mut().zip(gears) {
        c.maturity = Some((*m).into());
    }
    for (p, (_, m)) in r.providers.iter_mut().zip(gears) {
        p.maturity = Some((*m).into());
    }
    r
}

#[test]
fn a_capability_filled_only_by_immature_gears_says_so_and_names_what_is_further_along() {
    let needs = [need("storage", vec![source("docs/PRD.md", false)])];
    let rows = [row_at(
        "storage",
        &[("file-storage", "experimental"), ("blob-store", "stable")],
    )];
    let found = findings(&needs, &rows, &code(&["file_storage"]), &[]);
    assert_eq!(found.len(), 1);
    let f = &found[0];
    assert_eq!(f.rule, IMMATURE);
    assert_eq!(f.severity, "medium");
    assert_eq!(f.gear.as_deref(), Some("file-storage"));
    assert_eq!(f.candidates, ["blob-store"]);
    assert!(
        f.message.contains("`file-storage` is experimental"),
        "{}",
        f.message
    );
}

#[test]
fn one_ready_gear_among_the_fillers_or_an_unknown_maturity_is_no_immature_finding() {
    let needs = [need("storage", vec![source("docs/PRD.md", false)])];
    let both = [row_at(
        "storage",
        &[("file-storage", "design"), ("blob-store", "preview")],
    )];
    assert!(findings(&needs, &both, &code(&["file-storage", "blob-store"]), &[]).is_empty());
    let unknown = [row("storage", &["file-storage"], false)];
    assert!(findings(&needs, &unknown, &code(&["file-storage"]), &[]).is_empty());
}
