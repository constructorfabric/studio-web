//! Candidates in the registry's rules (ADR-0041 P3): found, declared,
//! rejected and proposed again, over [`plan`].

use super::*;
use crate::components_catalog::candidates::{Candidate, Evidence};

const ORG: Uuid = Uuid::from_u128(0x0a6);
const P1: Uuid = Uuid::from_u128(0x101);
const P2: Uuid = Uuid::from_u128(0x102);
const TENANT: Uuid = Uuid::from_u128(0x7e);

fn candidate(name: &str, path: &str, print: &str) -> Candidate {
    Candidate {
        name: name.into(),
        path: path.into(),
        main_file: format!("{path}/mod.rs"),
        crate_unit: false,
        description: Some(format!("{name} module")),
        evidence: vec![
            Evidence {
                signal: "rest".into(),
                detail: "own REST surface: rest.rs".into(),
                weight: 3,
            },
            Evidence {
                signal: "persistence".into(),
                detail: "owns persistence: repo.rs".into(),
                weight: 3,
            },
        ],
        score: 6,
        fingerprint: print.into(),
    }
}

fn declared(name: &str, path: &str) -> LocalGear {
    LocalGear {
        name: name.into(),
        kind: "gear".into(),
        description: Some("declared now".into()),
        category: None,
        path: path.into(),
        declared_in: format!("{path}/gear.toml"),
        repo: "acme/app".into(),
        capabilities: Vec::new(),
        runtime: Vec::new(),
        built: true,
        doc: None,
    }
}

fn read(project: Uuid, print: &str, gears: Vec<LocalGear>, candidates: Vec<Candidate>) -> RepoRead {
    RepoRead {
        project_id: project,
        organization: false,
        project_name: format!("project {}", project.as_u128()),
        repo: "acme/app".into(),
        repo_key: format!("k{}", project.as_u128()),
        git_ref: "main".into(),
        commit: Some("c0ffee".into()),
        fingerprint: print.into(),
        gears,
        candidates,
        tenant: Some(TENANT),
        connection_id: None,
        cargo_deps: Vec::new(),
    }
}

fn walk(now: &str, reads: Vec<RepoRead>) -> Walk {
    let resolved: BTreeSet<(Uuid, String)> = reads
        .iter()
        .map(|r| (r.project_id, r.repo_key.clone()))
        .collect();
    Walk {
        org: ORG,
        now: now.into(),
        projects_resolved: resolved.iter().map(|(p, _)| *p).collect(),
        in_scope: None,
        resolved,
        reads,
        ..Walk::default()
    }
}

#[derive(Default)]
struct Store {
    entries: Vec<(String, EntryRecord)>,
    occurrences: Vec<(String, OccurrenceRecord)>,
    reads: Vec<(String, ReadRecord)>,
}

impl Store {
    fn run(&mut self, walk: &Walk) -> Plan {
        let plan = plan(walk, &self.entries, &self.occurrences, &self.reads);
        for id in &plan.retire {
            self.occurrences.retain(|(i, _)| i != id);
            self.reads.retain(|(i, _)| i != id);
        }
        for node in &plan.upsert {
            let id = node.instance_id.clone();
            match node.type_id {
                gts::REGISTRY_ENTRY_TYPE => {
                    self.entries.retain(|(i, _)| *i != id);
                    self.entries
                        .push((id, serde_json::from_value(node.value.clone()).unwrap()));
                }
                gts::OCCURRENCE_TYPE => {
                    self.occurrences.retain(|(i, _)| *i != id);
                    self.occurrences
                        .push((id, serde_json::from_value(node.value.clone()).unwrap()));
                }
                _ => {
                    self.reads.retain(|(i, _)| *i != id);
                    self.reads
                        .push((id, serde_json::from_value(node.value.clone()).unwrap()));
                }
            }
        }
        plan
    }

    fn entry(&self, name: &str) -> &EntryRecord {
        &self
            .entries
            .iter()
            .find(|(_, e)| e.name == name)
            .unwrap_or_else(|| panic!("no entry {name}"))
            .1
    }

    fn set_state(&mut self, name: &str, state: &str) {
        for (_, e) in &mut self.entries {
            if e.name == name {
                e.state = state.into();
            }
        }
    }
}

#[test]
fn a_candidate_found_anew_is_proposed_with_its_score_and_evidence() {
    let mut store = Store::default();
    let plan = store.run(&walk(
        "t1",
        vec![read(
            P1,
            "f1",
            Vec::new(),
            vec![candidate("documents", "src/documents", "m1")],
        )],
    ));
    assert_eq!(plan.created, 1);
    assert_eq!(plan.candidates_found, 1);
    let e = store.entry("documents");
    assert_eq!(e.state, STATE_CANDIDATE);
    assert_eq!(e.score, Some(6));
    assert_eq!(e.evidence.len(), 2);
    assert_eq!(e.candidate_fingerprints, ["m1"]);
    assert_eq!(e.description.as_deref(), Some("documents module"));
    let (_, occ) = &store.occurrences[0];
    assert_eq!(occ.declared_in, DETECTED);
    assert!(occ.detected());
    assert_eq!(occ.declared_file, "src/documents/mod.rs");
    assert_eq!(occ.score, Some(6));
    assert_eq!(occ.module_fingerprint.as_deref(), Some("m1"));
    assert_eq!(occ.tenant, Some(TENANT), "where Declare it writes");
}

#[test]
fn a_candidate_found_declared_becomes_declared_under_any_spelling() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![read(
            P1,
            "f1",
            Vec::new(),
            vec![candidate("spec-mapping", "src/spec_mapping", "m1")],
        )],
    ));
    // The Declare it pull request merged: discovery names the directory.
    let plan = store.run(&walk(
        "t2",
        vec![read(
            P1,
            "f2",
            vec![declared("spec_mapping", "src/spec_mapping")],
            Vec::new(),
        )],
    ));
    assert_eq!(plan.created, 0, "the same entry, not a second one");
    assert_eq!(plan.declared_from_candidates, 1);
    assert_eq!(store.entries.len(), 1);
    let e = store.entry("spec-mapping");
    assert_eq!(e.state, STATE_DECLARED);
    assert_eq!(e.score, None);
    assert!(e.evidence.is_empty());
    assert_eq!(e.description.as_deref(), Some("declared now"));
    assert_eq!(store.occurrences.len(), 1);
    assert_eq!(store.occurrences[0].1.declared_in, "gear.toml");
}

#[test]
fn a_declared_entry_found_as_a_candidate_elsewhere_stays_declared() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![
            read(
                P1,
                "f1",
                vec![declared("billing", "src/billing")],
                Vec::new(),
            ),
            read(
                P2,
                "g1",
                Vec::new(),
                vec![candidate("billing", "src/billing", "m2")],
            ),
        ],
    ));
    let e = store.entry("billing");
    assert_eq!(e.state, STATE_DECLARED);
    assert_eq!(e.score, None);
    assert_eq!(store.occurrences.len(), 2);
}

#[test]
fn a_rejected_candidate_returns_only_when_its_code_changes() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![read(
            P1,
            "f1",
            Vec::new(),
            vec![candidate("hooks", "src/hooks", "m1")],
        )],
    ));
    store.set_state("hooks", STATE_REJECTED);

    // Read again (the repository moved elsewhere), the module unchanged.
    let plan = store.run(&walk(
        "t2",
        vec![read(
            P1,
            "f2",
            Vec::new(),
            vec![candidate("hooks", "src/hooks", "m1")],
        )],
    ));
    assert_eq!(plan.reproposed, 0);
    assert_eq!(store.entry("hooks").state, STATE_REJECTED);
    assert_eq!(
        store.entry("hooks").candidate_fingerprints,
        ["m1"],
        "frozen"
    );

    // The module's own files changed.
    let mut moved = candidate("hooks", "src/hooks", "m2");
    moved.score = 8;
    let plan = store.run(&walk("t3", vec![read(P1, "f3", Vec::new(), vec![moved])]));
    assert_eq!(plan.reproposed, 1);
    let e = store.entry("hooks");
    assert_eq!(e.state, STATE_CANDIDATE);
    assert_eq!(e.score, Some(8));
    assert_eq!(e.candidate_fingerprints, ["m2"]);
}

#[test]
fn a_rejected_declared_entry_is_never_proposed_again() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![read(P1, "f1", vec![declared("old", "src/old")], Vec::new())],
    ));
    store.set_state("old", STATE_REJECTED);
    // Its declaration is gone and a detector finds the module.
    store.run(&walk(
        "t2",
        vec![read(
            P1,
            "f2",
            Vec::new(),
            vec![candidate("old", "src/old", "m1")],
        )],
    ));
    assert_eq!(store.entry("old").state, STATE_REJECTED);
}

#[test]
fn a_project_candidate_is_offered_to_spec_mapping_and_a_declaration_wins() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![read(
            P1,
            "f1",
            vec![declared("billing", "src/billing")],
            vec![
                candidate("documents", "src/documents", "m1"),
                candidate("billing", "src/legacy/billing", "m2"),
            ],
        )],
    ));
    let entries = join(
        store.entries.clone(),
        store.occurrences.iter().map(|(_, o)| o.clone()).collect(),
    );
    let (nodes, _) = crate::components_catalog::port::project_gears_of(&entries, P1);
    let path = |name: &str| {
        nodes
            .iter()
            .find(|n| n["name"] == name)
            .map(|n| n["path"].as_str().unwrap_or_default().to_owned())
    };
    assert_eq!(path("documents").as_deref(), Some("src/documents"));
    assert_eq!(
        path("billing").as_deref(),
        Some("src/billing"),
        "declared first"
    );
    assert!(nodes.iter().all(|n| n["origin"] == "project"));
}

/// "Copied in" is evidence about other occurrences: when one of them goes
/// (its project excluded), the occurrences left -- not read again -- and the
/// candidate entry stop saying it.
#[test]
fn copy_evidence_goes_with_the_occurrence_it_was_about() {
    let mut store = Store::default();
    let mut reads = vec![
        read(
            P1,
            "f1",
            Vec::new(),
            vec![candidate("hooks", "src/hooks", "m1")],
        ),
        read(
            P2,
            "f2",
            Vec::new(),
            vec![candidate("hooks", "src/hooks", "m1")],
        ),
    ];
    crate::components_catalog::candidates::apply_copies(&mut reads, &[]);
    store.run(&walk("t1", reads));
    let copied = |evidence: &[Evidence]| {
        evidence
            .iter()
            .any(|e| e.signal == crate::components_catalog::candidates::SIGNAL_COPIED)
    };
    let e = store.entry("hooks");
    assert!(copied(&e.evidence), "{:?}", e.evidence);
    assert_eq!(e.score, Some(8));

    // P2 is excluded; P1 is resolved but unchanged, so not read again.
    let mut w = walk("t2", Vec::new());
    w.in_scope = Some([P1].into_iter().collect());
    w.projects_resolved = [P1].into_iter().collect();
    w.resolved = [(P1, "k257".to_string())].into_iter().collect();
    let plan = store.run(&w);
    assert_eq!(plan.occurrences_removed, 1);
    assert_eq!(store.occurrences.len(), 1);
    let (_, occ) = &store.occurrences[0];
    assert_eq!(occ.project_id, Some(P1));
    assert!(!copied(&occ.evidence), "{:?}", occ.evidence);
    assert_eq!(occ.score, Some(6));
    let e = store.entry("hooks");
    assert!(!copied(&e.evidence), "{:?}", e.evidence);
    assert_eq!(e.score, Some(6));
}
