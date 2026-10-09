//! The candidate detectors (ADR-0041 P3), on synthetic trees laid out like
//! studio-backend.

use super::*;

/// A tree listing: every path with a sha of its own name, so a test can move
/// one file's sha by renaming nothing.
fn tree(paths: &[&str]) -> Vec<(String, String)> {
    paths
        .iter()
        .map(|p| ((*p).to_string(), format!("sha-{p}")))
        .collect()
}

fn texts(files: &[(&str, &str)]) -> HashMap<String, String> {
    files
        .iter()
        .map(|(p, b)| ((*p).to_string(), (*b).to_string()))
        .collect()
}

fn declared(name: &str, path: &str) -> LocalGear {
    LocalGear {
        name: name.into(),
        kind: "gear".into(),
        description: None,
        category: None,
        path: path.into(),
        declared_in: format!("{path}/mod.rs"),
        repo: "acme/app".into(),
        capabilities: Vec::new(),
        runtime: Vec::new(),
        built: true,
        doc: None,
    }
}

fn signals_of(c: &Candidate) -> Vec<&str> {
    c.evidence.iter().map(|e| e.signal.as_str()).collect()
}

const DOCUMENTS: [&str; 5] = [
    "studio-backend/src/documents/mod.rs",
    "studio-backend/src/documents/rest.rs",
    "studio-backend/src/documents/repo.rs",
    "studio-backend/src/documents/migrations.rs",
    "studio-backend/src/documents/port.rs",
];

#[test]
fn a_module_with_rest_persistence_and_a_port_but_no_attribute_is_a_candidate() {
    let files = tree(&DOCUMENTS);
    let bodies = texts(&[(
        "studio-backend/src/documents/mod.rs",
        "//! Documents and their versions.\npub mod rest;\n",
    )]);
    let found = detect(&files, &bodies, &[]);
    assert_eq!(found.len(), 1, "{found:?}");
    let c = &found[0];
    assert_eq!(c.name, "documents");
    assert_eq!(c.path, "studio-backend/src/documents");
    assert_eq!(c.main_file, "studio-backend/src/documents/mod.rs");
    assert!(!c.crate_unit);
    assert_eq!(
        c.description.as_deref(),
        Some("Documents and their versions.")
    );
    assert_eq!(signals_of(c), ["rest", "persistence", "boundary"]);
    assert_eq!(c.score, W_REST + W_PERSISTENCE + W_BOUNDARY_ONE);
    assert_eq!(c.evidence[0].detail, "own REST surface: rest.rs");
    assert_eq!(
        c.evidence[1].detail,
        "owns persistence: migrations.rs, repo.rs"
    );
    assert_eq!(c.evidence[2].detail, "exposes a boundary: port");
}

#[test]
fn a_declared_gear_and_everything_inside_it_is_no_candidate() {
    let mut paths = DOCUMENTS.to_vec();
    paths.extend([
        "studio-backend/src/documents/storage/mod.rs",
        "studio-backend/src/documents/storage/rest.rs",
        "studio-backend/src/documents/storage/repo.rs",
    ]);
    let files = tree(&paths);
    let gears = [declared("studio-documents", "studio-backend/src/documents")];
    assert!(detect(&files, &HashMap::new(), &gears).is_empty());
    // A gear at the repository root covers the whole repository.
    assert!(detect(&files, &HashMap::new(), &[declared("app", "")]).is_empty());
    // A gear declared in `foo.rs` covers the module directory beside it.
    let beside = tree(&[
        "src/billing.rs",
        "src/billing/rest.rs",
        "src/billing/repo.rs",
    ]);
    assert_eq!(detect(&beside, &HashMap::new(), &[]).len(), 1);
    let gear = LocalGear {
        path: "src/billing.rs".into(),
        ..declared("billing", "src/billing")
    };
    assert!(detect(&beside, &HashMap::new(), &[gear]).is_empty());
}

#[test]
fn tests_target_and_vendored_trees_are_skipped() {
    let files = tree(&[
        "target/debug/build/x/src/foo/mod.rs",
        "target/debug/build/x/src/foo/rest.rs",
        "target/debug/build/x/src/foo/repo.rs",
        "studio-backend/tests/src/fixture/mod.rs",
        "studio-backend/tests/src/fixture/rest.rs",
        "studio-backend/tests/src/fixture/repo.rs",
        "vendor/src/lib/mod.rs",
        "vendor/src/lib/rest.rs",
        "vendor/src/lib/repo.rs",
    ]);
    assert!(detect(&files, &HashMap::new(), &[]).is_empty());
}

#[test]
fn a_unit_needs_a_structural_signal_and_the_threshold() {
    // Docs and consumers alone are not a gear.
    let files = tree(&[
        "src/util/mod.rs",
        "src/util/README.md",
        "src/a/mod.rs",
        "src/b/mod.rs",
        "src/c/mod.rs",
    ]);
    let bodies = texts(&[
        ("src/a/mod.rs", "use crate::util::x;"),
        ("src/b/mod.rs", "use crate::util::y;"),
        ("src/c/mod.rs", "use crate::util;"),
    ]);
    assert!(detect(&files, &bodies, &[]).is_empty());

    // REST alone (3) is under the threshold until a copy lifts it.
    let thin = tree(&["src/hooks/mod.rs", "src/hooks/rest.rs"]);
    let found = detect(&thin, &HashMap::new(), &[]);
    assert_eq!(found.len(), 1, "kept for the copy signal");
    let mut reads = vec![RepoRead {
        project_id: Uuid::from_u128(1),
        project_name: "one".into(),
        repo_key: "k1".into(),
        candidates: found,
        ..RepoRead::default()
    }];
    apply_copies(&mut reads, &[]);
    assert!(
        reads[0].candidates.is_empty(),
        "3 < {CANDIDATE_THRESHOLD}: dropped"
    );
}

#[test]
fn consumers_are_counted_in_the_files_read_only() {
    let files = tree(&[
        "src/billing/mod.rs",
        "src/billing/rest.rs",
        "src/billing/README.md",
        "src/orders/mod.rs",
        "src/invoices/mod.rs",
        "src/billing_tests/mod.rs",
    ]);
    let bodies = texts(&[
        ("src/orders/mod.rs", "use crate::billing::port::Billing;\n"),
        (
            "src/invoices/mod.rs",
            "fn f() { crate::billing::charge(); }\n",
        ),
        // Another module whose name only starts with `billing`.
        ("src/billing_tests/mod.rs", "use crate::billing_tests;\n"),
        // Inside the module itself: not a consumer.
        ("src/billing/mod.rs", "use crate::billing::rest;\n"),
    ]);
    let found = detect(&files, &bodies, &[]);
    let billing = found.iter().find(|c| c.name == "billing").unwrap();
    let consumers = billing
        .evidence
        .iter()
        .find(|e| e.signal == SIGNAL_CONSUMERS)
        .unwrap();
    assert_eq!(consumers.detail, "used by 2 modules");
    assert_eq!(consumers.weight, 2);
    assert_eq!(billing.score, W_REST + W_DOCS + 2);
}

#[test]
fn a_crate_is_named_by_its_package_and_used_by_the_manifests_that_depend_on_it() {
    let files = tree(&[
        "Cargo.toml",
        "crates/ledger_core/Cargo.toml",
        "crates/ledger_core/src/lib.rs",
        "crates/ledger_core/src/gts.rs",
        "crates/ledger_core/src/sdk.rs",
        "crates/ledger_core/src/port.rs",
        "crates/ledger_core/migrations/0001_init.sql",
        "crates/app/Cargo.toml",
        "crates/app/src/lib.rs",
    ]);
    let bodies = texts(&[
        (
            "Cargo.toml",
            "[workspace]\nmembers = [\"crates/*\"]\n[workspace.dependencies]\nledger-core = { path = \"crates/ledger_core\" }\n",
        ),
        (
            "crates/ledger_core/Cargo.toml",
            "[package]\nname = \"ledger-core\"\n",
        ),
        (
            "crates/ledger_core/src/lib.rs",
            "//! The ledger.\npub fn routes() { let _ = Router::new(); }\n",
        ),
        (
            "crates/app/Cargo.toml",
            "[package]\nname = \"app\"\n[dependencies]\nledger-core.workspace = true\n",
        ),
    ]);
    let found = detect(&files, &bodies, &[]);
    let ledger = found.iter().find(|c| c.name == "ledger-core").unwrap();
    assert!(ledger.crate_unit);
    assert_eq!(ledger.path, "crates/ledger_core");
    assert_eq!(ledger.description.as_deref(), Some("The ledger."));
    let detail = |s: &str| {
        ledger
            .evidence
            .iter()
            .find(|e| e.signal == s)
            .map(|e| e.detail.clone())
    };
    assert_eq!(
        detail(SIGNAL_REST).as_deref(),
        Some("own REST surface: Router::new in lib.rs")
    );
    assert_eq!(
        detail(SIGNAL_PERSISTENCE).as_deref(),
        Some("owns persistence: migrations/")
    );
    assert_eq!(
        detail(SIGNAL_TYPES).as_deref(),
        Some("owns its types: gts.rs")
    );
    assert_eq!(
        detail(SIGNAL_BOUNDARY).as_deref(),
        Some("exposes a boundary: port and sdk")
    );
    // The virtual workspace lists it; only `app` uses it.
    assert_eq!(detail(SIGNAL_CONSUMERS).as_deref(), Some("used by 1 crate"));
    // The root crate is the repository itself, never a candidate.
    assert!(found.iter().all(|c| !c.path.is_empty()));
}

#[test]
fn at_most_the_cap_highest_first() {
    let mut paths: Vec<String> = Vec::new();
    for i in 0..(MAX_CANDIDATES + 5) {
        paths.push(format!("src/m{i:02}/mod.rs"));
        paths.push(format!("src/m{i:02}/rest.rs"));
        paths.push(format!("src/m{i:02}/repo.rs"));
    }
    // One stronger than the rest.
    paths.push("src/m34/port.rs".into());
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    let found = detect(&tree(&refs), &HashMap::new(), &[]);
    assert_eq!(found.len(), MAX_CANDIDATES);
    assert_eq!(found[0].name, "m34");
}

#[test]
fn the_copy_signal_names_the_other_projects_and_lifts_the_score() {
    let thin = || {
        detect(
            &tree(&["src/hooks/mod.rs", "src/hooks/rest.rs"]),
            &HashMap::new(),
            &[],
        )
    };
    let p1 = Uuid::from_u128(1);
    let p2 = Uuid::from_u128(2);
    let p3 = Uuid::from_u128(3);
    let mut reads = vec![
        RepoRead {
            project_id: p1,
            project_name: "studio".into(),
            repo_key: "k1".into(),
            candidates: thin(),
            ..RepoRead::default()
        },
        RepoRead {
            project_id: p2,
            project_name: "insight".into(),
            repo_key: "k2".into(),
            candidates: thin(),
            ..RepoRead::default()
        },
    ];
    // A third project, not read again, declares `Hooks` already.
    let stored = vec![(
        "o".to_string(),
        OccurrenceRecord {
            entry: "Hooks".into(),
            project_id: Some(p3),
            project_name: Some("billing".into()),
            repo_key: "k3".into(),
            ..OccurrenceRecord::default()
        },
    )];
    apply_copies(&mut reads, &stored);
    let c = &reads[0].candidates[0];
    let copied = c
        .evidence
        .iter()
        .find(|e| e.signal == SIGNAL_COPIED)
        .unwrap();
    assert_eq!(copied.detail, "copied in billing, insight");
    assert_eq!(c.score, W_REST + W_COPIED);
    assert_eq!(
        reads[1].candidates[0].evidence.last().unwrap().detail,
        "copied in billing, studio"
    );
    // Applied twice, counted once.
    apply_copies(&mut reads, &stored);
    assert_eq!(reads[0].candidates[0].score, W_REST + W_COPIED);
}

#[test]
fn a_units_fingerprint_moves_with_its_own_files_only() {
    let base = tree(&DOCUMENTS);
    let print = |files: &[(String, String)]| {
        unit_fingerprint(
            "studio-backend/src/documents",
            "studio-backend/src/documents/mod.rs",
            files,
        )
    };
    let before = print(&base);
    // Another module changed: not this one's business.
    let mut other = base.clone();
    other.push(("studio-backend/src/tasks/mod.rs".into(), "x".into()));
    assert_eq!(print(&other), before);
    // Its mod.rs changed.
    let mut edited = base.clone();
    edited[0].1 = "new".into();
    assert_ne!(print(&edited), before);
    // A signal file came: it counts by path.
    let mut added = base.clone();
    added.push(("studio-backend/src/documents/sdk.rs".into(), "s".into()));
    assert_ne!(print(&added), before);
    // A signal file edited: by path only, so no move.
    let mut rest_edited = base;
    rest_edited[1].1 = "new".into();
    assert_eq!(print(&rest_edited), before);
}

#[test]
fn signal_files_move_the_repository_fingerprint_by_presence() {
    use super::project_gears::fingerprint;
    let base = tree(&["src/a/mod.rs"]);
    let mut with_rest = base.clone();
    with_rest.push(("src/a/rest.rs".into(), "1".into()));
    assert_ne!(fingerprint(&base), fingerprint(&with_rest));
    let mut rest_edited = with_rest.clone();
    rest_edited[1].1 = "2".into();
    assert_eq!(fingerprint(&with_rest), fingerprint(&rest_edited));
    // An ordinary source file is still nothing discovery reads.
    let mut other = base.clone();
    other.push(("src/a/helpers.rs".into(), "1".into()));
    assert_eq!(fingerprint(&base), fingerprint(&other));
}

#[test]
fn names_fold_to_kebab_case() {
    assert_eq!(kebab("spec_mapping"), "spec-mapping");
    assert_eq!(kebab("Spec Mapping"), "spec-mapping");
    assert_eq!(kebab("studio-tasks"), "studio-tasks");
    assert_eq!(kebab("__x__"), "x");
}

/// Two projects reading one repository hold one copy of the code: the same
/// reader key is never "another project".
#[test]
fn the_same_repository_in_another_project_is_not_a_copy() {
    let thin = || {
        detect(
            &tree(&["src/hooks/mod.rs", "src/hooks/rest.rs"]),
            &HashMap::new(),
            &[],
        )
    };
    let mut reads = vec![
        RepoRead {
            project_id: Uuid::from_u128(1),
            project_name: "studio".into(),
            repo_key: "k-shared".into(),
            candidates: thin(),
            ..RepoRead::default()
        },
        RepoRead {
            project_id: Uuid::from_u128(2),
            project_name: "studio-fork".into(),
            repo_key: "k-shared".into(),
            candidates: thin(),
            ..RepoRead::default()
        },
    ];
    // And a stored occurrence of the same repository, not read again.
    let stored = vec![(
        "o".to_string(),
        OccurrenceRecord {
            entry: "hooks".into(),
            project_id: Some(Uuid::from_u128(3)),
            project_name: Some("studio-mirror".into()),
            repo_key: "k-shared".into(),
            ..OccurrenceRecord::default()
        },
    )];
    let before = thin()[0].score;
    apply_copies(&mut reads, &stored);
    for r in &reads {
        for c in &r.candidates {
            assert!(
                c.evidence.iter().all(|e| e.signal != SIGNAL_COPIED),
                "{:?}",
                c.evidence
            );
            assert_eq!(c.score, before);
        }
    }
}

/// What the registry keeps after a walk settles the copy signal: an
/// occurrence gone takes its copy evidence with it, and only the copy
/// signal's weight moves the score.
#[test]
fn copy_evidence_is_settled_from_the_occurrences_kept() {
    let p1 = Uuid::from_u128(1);
    let p2 = Uuid::from_u128(2);
    let detected = |project: Uuid, name: &str, key: &str, evidence: Vec<Evidence>, score: u32| {
        OccurrenceRecord {
            entry: "hooks".into(),
            entry_id: "e-hooks".into(),
            project_id: Some(project),
            project_name: Some(name.into()),
            repo_key: key.into(),
            declared_in: "detected".into(),
            evidence,
            score: Some(score),
            ..OccurrenceRecord::default()
        }
    };
    let rest = Evidence::new("rest", "own REST surface: rest.rs".into(), 3);
    let stale = Evidence::new(SIGNAL_COPIED, "copied in insight".into(), W_COPIED);
    // Insight's occurrence was retired: studio's still says it was copied.
    let studio = detected(p1, "studio", "k1", vec![rest.clone(), stale.clone()], 7);
    let changed = refreshed_copies(&[&studio], |o| o.project_id);
    assert_eq!(changed.len(), 1);
    let (i, evidence, score) = &changed[0];
    assert_eq!(*i, 0);
    assert_eq!(evidence, &vec![rest.clone()]);
    assert_eq!(*score, 5, "the detector's other signals keep their score");

    // With insight's occurrence there, nothing changes.
    let insight = detected(
        p2,
        "insight",
        "k2",
        vec![
            rest.clone(),
            Evidence::new(SIGNAL_COPIED, "copied in studio".into(), W_COPIED),
        ],
        5,
    );
    assert!(refreshed_copies(&[&studio, &insight], |o| o.project_id).is_empty());

    // A copy found since -- another project, another repository -- is said.
    let bare = detected(p1, "studio", "k1", vec![rest.clone()], 3);
    let changed = refreshed_copies(&[&bare, &insight], |o| o.project_id);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].1.last().unwrap().detail, "copied in insight");
    assert_eq!(changed[0].2, 3 + W_COPIED);
}
