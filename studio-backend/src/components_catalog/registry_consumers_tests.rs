//! The consumer graph and the platform's taking of a contribution (ADR-0041
//! P4, ADR-0042 §4), over [`plan`].

use super::*;
use crate::components_catalog::gts;
use crate::components_catalog::project_gears::LocalGear;
use crate::components_catalog::registry::{
    Contribution, Plan, RepoRead, STATE_PUBLISHED, STATE_REGISTERED, plan,
};

const ORG: Uuid = Uuid::from_u128(0x0a6);
/// Declares `ledger`.
const P1: Uuid = Uuid::from_u128(0x101);
/// Uses `ledger` by a Cargo dependency.
const P2: Uuid = Uuid::from_u128(0x102);
/// Uses `ledger` by its product's picks.
const P3: Uuid = Uuid::from_u128(0x103);

fn gear(name: &str) -> LocalGear {
    LocalGear {
        name: name.into(),
        kind: "gear".into(),
        path: format!("gears/{name}"),
        declared_in: format!("gears/{name}/gear.toml"),
        repo: "acme/app".into(),
        description: None,
        category: None,
        capabilities: Vec::new(),
        runtime: Vec::new(),
        built: true,
        doc: None,
    }
}

fn read(project: Uuid, print: &str, gears: Vec<LocalGear>, deps: &[&str]) -> RepoRead {
    RepoRead {
        project_id: project,
        project_name: format!("project {}", project.as_u128()),
        repo: format!("acme/p{}", project.as_u128()),
        repo_key: format!("k{}", project.as_u128()),
        git_ref: "main".into(),
        fingerprint: print.into(),
        gears,
        cargo_deps: deps.iter().map(|d| (*d).to_owned()).collect(),
        ..RepoRead::default()
    }
}

fn walk(now: &str, reads: Vec<RepoRead>, projects: &[Uuid]) -> Walk {
    Walk {
        org: ORG,
        now: now.into(),
        reads,
        resolved: projects
            .iter()
            .map(|p| (*p, format!("k{}", p.as_u128())))
            .collect(),
        projects_resolved: projects.iter().copied().collect(),
        in_scope: Some(projects.iter().copied().collect()),
        project_names: projects
            .iter()
            .map(|p| (*p, format!("project {}", p.as_u128())))
            .collect(),
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
                gts::REGISTRY_READ_TYPE => {
                    self.reads.retain(|(i, _)| *i != id);
                    self.reads
                        .push((id, serde_json::from_value(node.value.clone()).unwrap()));
                }
                other => panic!("a walk wrote {other}"),
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

    fn entry_mut(&mut self, name: &str) -> &mut EntryRecord {
        &mut self
            .entries
            .iter_mut()
            .find(|(_, e)| e.name == name)
            .unwrap_or_else(|| panic!("no entry {name}"))
            .1
    }
}

fn consumers(store: &Store, name: &str) -> Vec<(Uuid, Vec<String>)> {
    store
        .entry(name)
        .consumers
        .iter()
        .map(|c| (c.project_id, c.via.clone()))
        .collect()
}

#[test]
fn a_crate_or_a_pick_names_a_component_bare_or_as_a_gear_crate() {
    assert!(names_component("ledger", "ledger"));
    assert!(names_component("cf-gears-ledger", "ledger"));
    assert!(names_component("cf_gears_ledger", "Ledger"));
    assert!(names_component("ledger", "cf-gears-ledger"));
    assert!(names_component("spec_mapping", "spec-mapping"));
    assert!(!names_component("ledger-sdk", "ledger"));
    assert!(!names_component("cf-gears-billing", "ledger"));
    assert!(!names_component("", "ledger"));
}

/// Cargo and product both make a consumer; the project that declares the
/// component is not one; a skipped repository keeps its consumers and a
/// repository read again replaces them.
#[test]
fn consumers_come_from_cargo_and_product_and_survive_a_skip() {
    let mut store = Store::default();
    let mut w = walk(
        "t1",
        vec![
            read(P1, "f1", vec![gear("ledger")], &["ledger", "serde"]),
            read(P2, "f2", Vec::new(), &["cf-gears-ledger", "tokio"]),
            read(P3, "f3", Vec::new(), &[]),
        ],
        &[P1, P2, P3],
    );
    w.product_picks.insert(P3, vec!["cf-gears-ledger".into()]);
    w.product_picks.insert(P2, vec!["ledger".into()]);
    store.run(&w);
    assert_eq!(
        consumers(&store, "ledger"),
        vec![
            (P2, vec!["cargo".to_owned(), "product".to_owned()]),
            (P3, vec!["product".to_owned()]),
        ],
        "P1 declares it, so it is no consumer"
    );
    assert_eq!(
        store.entry("ledger").consumers[0].project_name,
        "project 258"
    );

    // Nothing moved: every repository is skipped, and the picks are carried.
    let mut skip = walk("t2", Vec::new(), &[P1, P2, P3]);
    skip.product_picks = w.product_picks.clone();
    store.run(&skip);
    assert_eq!(consumers(&store, "ledger").len(), 2, "kept across a skip");

    // P2 is read again and no longer depends on it: replaced.
    let mut reread = walk(
        "t3",
        vec![read(P2, "f2b", Vec::new(), &["tokio"])],
        &[P1, P2, P3],
    );
    reread
        .product_picks
        .insert(P3, vec!["cf-gears-ledger".into()]);
    store.run(&reread);
    assert_eq!(
        consumers(&store, "ledger"),
        vec![(P3, vec!["product".to_owned()])]
    );

    // A project out of scope is no consumer any more.
    let mut gone = walk("t4", Vec::new(), &[P1, P2]);
    gone.product_picks
        .insert(P3, vec!["cf-gears-ledger".into()]);
    store.run(&gone);
    assert!(consumers(&store, "ledger").is_empty());
}

fn platform(names: &[(&str, Option<&str>)]) -> BTreeMap<String, Option<String>> {
    let nodes: Vec<GtsNode> = names
        .iter()
        .map(|(n, v)| gts::GtsNode {
            type_id: gts::GEAR_TYPE,
            instance_id: (*n).to_owned(),
            value: serde_json::json!({ "name": n, "newest_version": v }),
        })
        .collect();
    platform_components(&nodes)
}

#[test]
fn the_platforms_components_are_read_by_every_name_they_go_by() {
    let nodes = vec![gts::GtsNode {
        type_id: gts::GEAR_TYPE,
        instance_id: "x".into(),
        value: serde_json::json!({
            "name": "cf-gears-ledger",
            "newest_version": "0.4.1",
            "crate_names": ["cf-gears-ledger", "cf-gears-ledger-sdk"],
            "repo_path": "gears/bss/ledger-core",
        }),
    }];
    let p = platform_components(&nodes);
    for key in ["cf-gears-ledger", "ledger", "ledger-sdk", "ledger-core"] {
        assert_eq!(p.get(key), Some(&Some("0.4.1".to_owned())), "{key}");
    }
    let entry = EntryRecord {
        name: "Ledger".into(),
        ..EntryRecord::default()
    };
    assert_eq!(platform_version(&p, &entry), Some(Some("0.4.1".to_owned())));
    let other = EntryRecord {
        name: "billing".into(),
        aliases: vec!["ledger_core".into()],
        ..EntryRecord::default()
    };
    assert!(platform_version(&p, &other).is_some(), "by an alias");
    let none = EntryRecord {
        name: "billing".into(),
        ..EntryRecord::default()
    };
    assert_eq!(platform_version(&p, &none), None);
}

/// A contributed entry becomes `published` when the platform's catalogue
/// has it, with the platform's version; one never contributed does not, and
/// an unreadable platform publishes nothing.
#[test]
fn a_contribution_the_platform_took_is_published_by_the_walk() {
    let mut store = Store::default();
    store.run(&walk(
        "t1",
        vec![read(P1, "f1", vec![gear("ledger"), gear("billing")], &[])],
        &[P1],
    ));
    for name in ["ledger", "billing"] {
        store.entry_mut(name).state = STATE_REGISTERED.into();
    }
    store.entry_mut("ledger").contribution = Some(Contribution {
        repo: "cf/gears-rust".into(),
        branch: "contribute/acme/ledger".into(),
        ..Contribution::default()
    });

    // The platform's tier unread: nothing moves.
    let unread = store.run(&walk("t2", Vec::new(), &[P1]));
    assert!(unread.published.is_empty());
    assert_eq!(store.entry("ledger").state, STATE_REGISTERED);

    let mut seen = walk("t3", Vec::new(), &[P1]);
    seen.platform = Some(platform(&[
        ("cf-gears-ledger", Some("0.1.0")),
        ("cf-gears-billing", Some("2.0.0")),
    ]));
    let plan = store.run(&seen);
    assert_eq!(plan.published.len(), 1);
    assert_eq!(plan.published[0].1, "ledger");
    assert_eq!(plan.published[0].2.as_deref(), Some("0.1.0"));
    assert_eq!(store.entry("ledger").state, STATE_PUBLISHED);
    assert_eq!(store.entry("ledger").version.as_deref(), Some("0.1.0"));
    assert_eq!(
        store.entry("billing").state,
        STATE_REGISTERED,
        "never contributed: the platform's own same-named gear is not this one"
    );

    // A later release is recorded on the published entry; no second decision.
    let mut later = walk("t4", Vec::new(), &[P1]);
    later.platform = Some(platform(&[("cf-gears-ledger", Some("0.2.0"))]));
    let plan = store.run(&later);
    assert!(plan.published.is_empty());
    assert_eq!(store.entry("ledger").version.as_deref(), Some("0.2.0"));
}
