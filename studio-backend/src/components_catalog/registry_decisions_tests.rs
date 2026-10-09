//! The registry's lifecycle moves (ADR-0041 P2): the transition table, what
//! each decision requires and sets, merging, and the decisions recorded.

use std::sync::Arc;

use super::*;
use crate::catalog_graph::MemorySink;
use crate::components_catalog::project_gears::LocalGear;
use crate::components_catalog::registry::{RepoRead, STATES, Walk, plan};

const ORG: Uuid = Uuid::from_u128(0x0a6);
const P1: Uuid = Uuid::from_u128(0x101);

fn entry(name: &str, state: &str) -> EntryRecord {
    EntryRecord {
        organization_id: ORG,
        name: name.into(),
        kind: "gear".into(),
        state: state.into(),
        description: None,
        category: None,
        owner: None,
        capabilities: Vec::new(),
        aliases: Vec::new(),
        merged_into: None,
        replaced_by: None,
        version: None,
        orphaned: false,
        first_seen: None,
        last_seen: None,
        fingerprint: None,
        ..EntryRecord::default()
    }
}

fn input(action: &str) -> DecisionInput {
    DecisionInput {
        action: action.into(),
        ..DecisionInput::default()
    }
}

fn ada() -> Owner {
    Owner {
        kind: "person".into(),
        id: Some("ada-id".into()),
        name: "Ada".into(),
    }
}

fn nobody(_: &str) -> Option<(String, EntryRecord)> {
    None
}

/// Every action from every state: the allowed moves land where the table
/// says, and every other one is refused.
#[test]
fn the_transition_table_allows_exactly_the_lifecycle_moves() {
    let allowed: &[(&str, &str, &str)] = &[
        ("register", "candidate", "registered"),
        ("register", "declared", "registered"),
        ("reject", "candidate", "rejected"),
        ("reject", "declared", "rejected"),
        ("deprecate", "registered", "deprecated"),
        ("deprecate", "published", "deprecated"),
        ("restore", "rejected", "declared"),
        ("restore", "deprecated", "registered"),
        ("publish", "registered", "registered"),
        ("mark_published", "registered", "published"),
        ("merge", "candidate", "merged"),
        ("merge", "declared", "merged"),
        ("merge", "registered", "merged"),
        ("merge", "published", "merged"),
        ("merge", "rejected", "merged"),
        ("merge", "deprecated", "merged"),
    ];
    let mut checked = 0;
    for action in ACTIONS {
        let a = Action::parse(action).unwrap();
        assert_eq!(a.as_str(), action);
        for from in STATES {
            let got = transition(a, from, true);
            let want = if action == "edit" {
                Some(from)
            } else {
                allowed
                    .iter()
                    .find(|(x, f, _)| *x == action && *f == from)
                    .map(|(_, _, t)| *t)
            };
            assert_eq!(got, want, "{action} from {from}");
            checked += 1;
        }
    }
    assert_eq!(checked, ACTIONS.len() * STATES.len());
    // A rejection with nothing declaring it any more goes back to candidate.
    assert_eq!(
        transition(Action::Restore, STATE_REJECTED, false),
        Some(STATE_CANDIDATE)
    );
    assert_eq!(Action::parse("Promote"), None);
}

#[test]
fn every_refused_move_is_illegal_and_names_the_state() {
    for action in ACTIONS.into_iter().filter(|a| *a != "edit") {
        let a = Action::parse(action).unwrap();
        for from in STATES {
            if transition(a, from, true).is_some() {
                continue;
            }
            let mut req = input(action);
            req.owner = Some(ada());
            req.reason = Some("because".into());
            req.merge_into = Some("other".into());
            let err = apply(&entry("x", from), true, &req, &nobody).unwrap_err();
            assert_eq!(
                err,
                DecisionError::Illegal {
                    action: action.into(),
                    from: from.into()
                },
                "{action} from {from}"
            );
        }
    }
    assert_eq!(
        apply(&entry("x", "declared"), true, &input("promote"), &nobody).unwrap_err(),
        DecisionError::UnknownAction("promote".into())
    );
}

#[test]
fn registering_needs_an_owner_and_sets_what_it_is_given() {
    let e = entry("billing", STATE_DECLARED);
    let err = apply(&e, true, &input("register"), &nobody).unwrap_err();
    assert!(
        matches!(err, DecisionError::Invalid { field: "owner", .. }),
        "{err:?}"
    );

    let mut bad = input("register");
    bad.owner = Some(Owner {
        kind: "robot".into(),
        id: None,
        name: "R2".into(),
    });
    assert!(matches!(
        apply(&e, true, &bad, &nobody).unwrap_err(),
        DecisionError::Invalid {
            field: "owner.kind",
            ..
        }
    ));

    let mut req = input("register");
    req.owner = Some(Owner {
        kind: " Team ".into(),
        id: None,
        name: " Payments ".into(),
    });
    req.kind = Some("plugin".into());
    req.category = Some("payments".into());
    req.capabilities = Some(vec![
        "billing".into(),
        " Billing ".into(),
        "".into(),
        "invoices".into(),
    ]);
    let applied = apply(&e, true, &req, &nobody).unwrap();
    assert_eq!(applied.from, STATE_DECLARED);
    assert_eq!(applied.to, STATE_REGISTERED);
    assert_eq!(applied.entry.state, STATE_REGISTERED);
    let owner = applied.entry.owner.as_ref().unwrap();
    assert_eq!(
        (owner.kind.as_str(), owner.name.as_str()),
        ("team", "Payments")
    );
    assert_eq!(applied.entry.kind, "plugin");
    assert_eq!(applied.entry.category.as_deref(), Some("payments"));
    assert_eq!(applied.entry.capabilities, vec!["billing", "invoices"]);
    assert_eq!(applied.details["owner"]["name"], "Payments");
}

#[test]
fn rejecting_needs_a_reason() {
    let e = entry("util", STATE_CANDIDATE);
    let mut req = input("reject");
    req.reason = Some("   ".into());
    assert!(matches!(
        apply(&e, false, &req, &nobody).unwrap_err(),
        DecisionError::Invalid {
            field: "reason",
            ..
        }
    ));
    req.reason = Some("a helper module, not a gear".into());
    assert_eq!(apply(&e, false, &req, &nobody).unwrap().to, STATE_REJECTED);
}

#[test]
fn deprecating_names_an_existing_replacement_and_restoring_clears_it() {
    let e = entry("old-billing", STATE_REGISTERED);
    let others = [
        ("id-new".to_string(), entry("new-billing", STATE_REGISTERED)),
        ("id-gone".to_string(), entry("gone", STATE_MERGED)),
    ];
    let lookup = |n: &str| {
        others
            .iter()
            .find(|(_, e)| e.name.eq_ignore_ascii_case(n))
            .cloned()
    };
    let mut req = input("deprecate");
    req.replaced_by = Some("nope".into());
    assert!(matches!(
        apply(&e, true, &req, &lookup).unwrap_err(),
        DecisionError::UnknownEntry {
            field: "replaced_by",
            ..
        }
    ));
    req.replaced_by = Some("gone".into());
    assert!(
        apply(&e, true, &req, &lookup).is_err(),
        "a merged entry is no replacement"
    );
    req.replaced_by = Some("NEW-BILLING".into());
    let deprecated = apply(&e, true, &req, &lookup).unwrap();
    assert_eq!(deprecated.entry.state, STATE_DEPRECATED);
    assert_eq!(deprecated.entry.replaced_by.as_deref(), Some("new-billing"));
    // Deprecated with no replacement is allowed too.
    assert_eq!(
        apply(&e, true, &input("deprecate"), &lookup)
            .unwrap()
            .entry
            .replaced_by,
        None
    );

    let restored = apply(&deprecated.entry, true, &input("restore"), &lookup).unwrap();
    assert_eq!(restored.entry.state, STATE_REGISTERED);
    assert_eq!(restored.entry.replaced_by, None);
}

#[test]
fn marking_published_records_the_version() {
    let mut req = input("mark_published");
    req.version = Some(" 0.3.0 ".into());
    let applied = apply(&entry("a", STATE_REGISTERED), true, &req, &nobody).unwrap();
    assert_eq!(applied.entry.state, STATE_PUBLISHED);
    assert_eq!(applied.entry.version.as_deref(), Some("0.3.0"));
}

/// Publishing keeps the entry `registered` and records the contribution it
/// opened; without one it is refused, so no request can claim a pull request.
#[test]
fn publishing_records_the_contribution_and_keeps_the_state() {
    let refused = apply(
        &entry("a", STATE_REGISTERED),
        true,
        &input("publish"),
        &nobody,
    );
    assert!(matches!(
        refused,
        Err(DecisionError::Invalid {
            field: "action",
            ..
        })
    ));
    let mut req = input("publish");
    req.contribution = Some(crate::components_catalog::registry::Contribution {
        repo: "cf/gears-rust".into(),
        branch: "contribute/acme/a".into(),
        pr_url: Some("https://github.com/cf/gears-rust/pull/9".into()),
        path: "gears/a".into(),
        files: 3,
        at: "2026-10-09T10:00:00Z".into(),
        by: "ada-id".into(),
        by_name: None,
    });
    let applied = apply(&entry("a", STATE_REGISTERED), true, &req, &nobody).unwrap();
    assert_eq!(applied.entry.state, STATE_REGISTERED);
    assert_eq!(applied.to, STATE_REGISTERED);
    assert_eq!(
        applied
            .entry
            .contribution
            .as_ref()
            .and_then(|c| c.pr_url.as_deref()),
        Some("https://github.com/cf/gears-rust/pull/9")
    );
    assert_eq!(
        applied.details["contribution"]["branch"],
        "contribute/acme/a"
    );
}

#[test]
fn an_edit_changes_fields_and_never_the_state() {
    for state in STATES {
        let mut req = input("edit");
        req.description = Some("what it does".into());
        let applied = apply(&entry("a", state), true, &req, &nobody).unwrap();
        assert_eq!(applied.entry.state, state);
        assert_eq!((applied.from.as_str(), applied.to.as_str()), (state, state));
        assert_eq!(applied.entry.description.as_deref(), Some("what it does"));
    }
    assert!(matches!(
        apply(&entry("a", STATE_DECLARED), true, &input("edit"), &nobody).unwrap_err(),
        DecisionError::Invalid { .. }
    ));
}

#[test]
fn a_merge_folds_the_name_and_its_aliases_into_a_live_target() {
    let mut source = entry("billing-v1", STATE_DECLARED);
    source.aliases = vec!["billing-legacy".into()];
    let mut target = entry("billing", STATE_REGISTERED);
    target.aliases = vec!["Billing-Legacy".into()];
    target.orphaned = true;
    let others = [
        ("id-t".to_string(), target),
        ("id-m".to_string(), entry("merged-one", STATE_MERGED)),
    ];
    let lookup = |n: &str| {
        others
            .iter()
            .find(|(_, e)| e.name.eq_ignore_ascii_case(n))
            .cloned()
    };
    assert!(matches!(
        apply(&source, true, &input("merge"), &lookup).unwrap_err(),
        DecisionError::Invalid {
            field: "merge_into",
            ..
        }
    ));
    let mut req = input("merge");
    req.merge_into = Some("billing-v1".into());
    assert!(
        apply(&source, true, &req, &|_| Some((
            "self".into(),
            entry("billing-v1", STATE_DECLARED)
        )))
        .is_err(),
        "not into itself"
    );
    req.merge_into = Some("merged-one".into());
    assert!(
        apply(&source, true, &req, &lookup).is_err(),
        "not into a merged entry"
    );

    req.merge_into = Some("billing".into());
    let applied = apply(&source, true, &req, &lookup).unwrap();
    assert_eq!(applied.entry.state, STATE_MERGED);
    assert_eq!(applied.entry.merged_into.as_deref(), Some("billing"));
    assert!(applied.entry.aliases.is_empty());
    assert!(
        !applied.entry.orphaned,
        "a merged entry is not one no repository declares any more"
    );
    let (id, into) = applied.target.unwrap();
    assert_eq!(id, "id-t");
    assert_eq!(into.state, STATE_REGISTERED, "the target keeps its state");
    assert_eq!(into.aliases, vec!["Billing-Legacy", "billing-v1"]);
    assert!(
        !into.orphaned,
        "it holds the merged entry's occurrences now"
    );
}

fn gear(name: &str, path: &str) -> LocalGear {
    LocalGear {
        name: name.into(),
        kind: "gear".into(),
        description: None,
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

fn walk_of(now: &str, print: &str, gears: Vec<LocalGear>) -> Walk {
    Walk {
        org: ORG,
        now: now.into(),
        reads: vec![RepoRead {
            project_id: P1,
            project_name: "app".into(),
            repo: "acme/app".into(),
            repo_key: "k1".into(),
            git_ref: "main".into(),
            commit: None,
            fingerprint: print.into(),
            gears,
            ..RepoRead::default()
        }],
        resolved: [(P1, "k1".to_string())].into_iter().collect(),
        projects_resolved: [P1].into_iter().collect(),
        in_scope: Some([P1].into_iter().collect()),
        ..Walk::default()
    }
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xca7))
        .subject_type("user")
        .subject_tenant_id(ORG)
        .build()
        .expect("security context")
}

fn service() -> CatalogService {
    CatalogService::new(Arc::new(MemorySink::default()), "k".to_string(), None)
}

async fn walked(svc: &CatalogService, ctx: &SecurityContext, w: &Walk) {
    let org = ORG.to_string();
    let entries = registry::records::<EntryRecord>(
        svc.sink
            .list(ctx, Some(gts::REGISTRY_ENTRY_TYPE))
            .await
            .unwrap(),
    );
    let occurrences = registry::records::<OccurrenceRecord>(
        svc.sink
            .list(ctx, Some(gts::OCCURRENCE_TYPE))
            .await
            .unwrap(),
    );
    let reads = registry::records::<registry::ReadRecord>(
        svc.sink
            .list(ctx, Some(gts::REGISTRY_READ_TYPE))
            .await
            .unwrap(),
    );
    let p = plan(w, &entries, &occurrences, &reads);
    svc.sink.upsert(ctx, &p.upsert, &p.edges).await.unwrap();
    for id in &p.retire {
        svc.sink.delete(ctx, id).await.unwrap();
    }
    let _ = org;
}

fn by() -> Decider {
    Decider {
        id: "person-ada".into(),
        name: Some("Ada".into()),
    }
}

#[tokio::test]
async fn a_decision_is_recorded_with_who_when_and_why_newest_first() {
    let svc = service();
    let ctx = ctx();
    walked(
        &svc,
        &ctx,
        &walk_of("t1", "f1", vec![gear("billing", "billing")]),
    )
    .await;

    let mut reg = input("register");
    reg.owner = Some(ada());
    let (after, decisions) = svc
        .decide_registry(&ctx, "BILLING", &reg, &by())
        .await
        .unwrap();
    assert_eq!(after.entry.state, STATE_REGISTERED);
    assert_eq!(decisions.len(), 1);
    assert_eq!(decisions[0].by, "person-ada");
    assert_eq!(decisions[0].action, "register");
    assert_eq!(
        (decisions[0].from.as_str(), decisions[0].to.as_str()),
        ("declared", "registered")
    );

    let mut dep = input("deprecate");
    dep.reason = Some("superseded".into());
    let (after, decisions) = svc
        .decide_registry(&ctx, "billing", &dep, &by())
        .await
        .unwrap();
    assert_eq!(after.entry.state, STATE_DEPRECATED);
    assert_eq!(decisions.len(), 2);
    assert_eq!(decisions[0].action, "deprecate", "newest first");
    assert_eq!(decisions[0].reason.as_deref(), Some("superseded"));

    // An illegal move writes nothing.
    let refused = svc
        .decide_registry(&ctx, "billing", &input("publish"), &by())
        .await
        .unwrap_err();
    assert!(matches!(
        refused,
        DecideFailure::Refused(DecisionError::Illegal { .. })
    ));
    let missing = svc
        .decide_registry(&ctx, "nope", &input("publish"), &by())
        .await
        .unwrap_err();
    assert!(matches!(
        missing,
        DecideFailure::Refused(DecisionError::NotFound(_))
    ));
    let (_, decisions) = svc
        .registry_entry_with_decisions(&ctx, "billing")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(decisions.len(), 2);

    // A walk never moves what a person decided.
    walked(
        &svc,
        &ctx,
        &walk_of("t2", "f2", vec![gear("billing", "billing")]),
    )
    .await;
    let e = svc.registry_entry(&ctx, "billing").await.unwrap().unwrap();
    assert_eq!(e.entry.state, STATE_DEPRECATED);
    assert_eq!(e.entry.owner.as_ref().map(|o| o.name.as_str()), Some("Ada"));
}

#[tokio::test]
async fn a_merge_repoints_occurrences_and_a_later_walk_puts_the_alias_on_the_target() {
    let svc = service();
    let ctx = ctx();
    walked(
        &svc,
        &ctx,
        &walk_of(
            "t1",
            "f1",
            vec![
                gear("billing", "billing"),
                gear("billing-v1", "legacy/billing"),
            ],
        ),
    )
    .await;
    let mut req = input("merge");
    req.merge_into = Some("billing".into());
    let (source, decisions) = svc
        .decide_registry(&ctx, "billing-v1", &req, &by())
        .await
        .unwrap();
    assert_eq!(source.entry.state, STATE_MERGED);
    assert_eq!(source.entry.merged_into.as_deref(), Some("billing"));
    assert!(source.occurrences.is_empty(), "its occurrences moved");
    assert!(!source.entry.orphaned, "merged, not orphaned");
    assert_eq!(decisions[0].details["merge_into"], "billing");

    let (target, target_decisions) = svc
        .registry_entry_with_decisions(&ctx, "billing")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(target.entry.aliases, vec!["billing-v1"]);
    assert_eq!(target.occurrences.len(), 2);
    assert!(target.occurrences.iter().all(|o| o.entry == "billing"));
    assert_eq!(target_decisions[0].details["merged_from"], "billing-v1");

    // The repository is read again and still declares `billing-v1`: the
    // finding lands on the target, the merged entry stays empty and merged.
    walked(
        &svc,
        &ctx,
        &walk_of(
            "t2",
            "f2",
            vec![
                gear("billing", "billing"),
                gear("billing-v1", "legacy/billing"),
            ],
        ),
    )
    .await;
    let all = svc.registry_entries(&ctx).await.unwrap();
    assert_eq!(all.len(), 2, "no entry is made for the alias");
    let source = all.iter().find(|e| e.entry.name == "billing-v1").unwrap();
    assert_eq!(source.entry.state, STATE_MERGED);
    assert!(source.occurrences.is_empty());
    assert!(
        !source.entry.orphaned,
        "the walk does not count a merged entry as orphaned"
    );
    assert!(all.iter().all(|e| !e.entry.orphaned));
    let target = all.iter().find(|e| e.entry.name == "billing").unwrap();
    assert_eq!(target.occurrences.len(), 2);
    assert!(
        target
            .occurrences
            .iter()
            .any(|o| o.path == "legacy/billing" && o.entry == "billing")
    );
    // Merged twice is refused.
    assert!(
        svc.decide_registry(&ctx, "billing-v1", &req, &by())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn the_project_plan_offers_a_deprecated_gear_and_not_a_rejected_one() {
    let svc = service();
    let ctx = ctx();
    walked(
        &svc,
        &ctx,
        &walk_of(
            "t1",
            "f1",
            vec![
                gear("keep", "keep"),
                gear("old", "old"),
                gear("scratch", "scratch"),
            ],
        ),
    )
    .await;
    let mut reg = input("register");
    reg.owner = Some(ada());
    svc.decide_registry(&ctx, "old", &reg, &by()).await.unwrap();
    let mut dep = input("deprecate");
    dep.replaced_by = Some("keep".into());
    svc.decide_registry(&ctx, "old", &dep, &by()).await.unwrap();
    let mut rej = input("reject");
    rej.reason = Some("helpers".into());
    svc.decide_registry(&ctx, "scratch", &rej, &by())
        .await
        .unwrap();

    let entries = svc.registry_entries(&ctx).await.unwrap();
    let (nodes, _) = crate::components_catalog::port::project_gears_of(&entries, P1);
    let mut names: Vec<&str> = nodes.iter().filter_map(|n| n["name"].as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["keep", "old"]);
    let old = entries.iter().find(|e| e.entry.name == "old").unwrap();
    assert_eq!(old.entry.replaced_by.as_deref(), Some("keep"));
}

#[test]
fn the_plan_puts_an_alias_finding_on_the_target_entry() {
    let org = ORG.to_string();
    let target_id = gts::registry_entry_instance_id(&org, "billing");
    let source_id = gts::registry_entry_instance_id(&org, "billing-v1");
    let mut target = entry("billing", STATE_REGISTERED);
    target.aliases = vec!["Billing-V1".into()];
    let mut source = entry("billing-v1", STATE_MERGED);
    source.merged_into = Some("billing".into());
    let entries = vec![(target_id.clone(), target), (source_id.clone(), source)];
    let p = plan(
        &walk_of("t1", "f1", vec![gear("billing-v1", "legacy/billing")]),
        &entries,
        &[],
        &[],
    );
    assert_eq!(p.created, 0, "an alias is not a new entry");
    assert_eq!(p.edges.len(), 1);
    assert_eq!(p.edges[0].from, target_id);
    let occ: Vec<OccurrenceRecord> = p
        .upsert
        .iter()
        .filter(|n| n.type_id == gts::OCCURRENCE_TYPE)
        .map(|n| serde_json::from_value(n.value.clone()).unwrap())
        .collect();
    assert_eq!(occ.len(), 1);
    assert_eq!(occ[0].entry, "billing");
    assert_eq!(occ[0].entry_id, target_id);
}

#[test]
fn repointing_moves_only_the_merged_entrys_occurrences() {
    let occ = |entry_id: &str, path: &str| OccurrenceRecord {
        organization_id: ORG,
        entry: "x".into(),
        entry_id: entry_id.into(),
        project_id: Some(P1),
        project_name: None,
        repo: "acme/app".into(),
        repo_key: "k1".into(),
        git_ref: None,
        path: path.into(),
        commit: None,
        declared_in: "gear.toml".into(),
        declared_file: format!("{path}/gear.toml"),
        kind: "gear".into(),
        description: None,
        category: None,
        capabilities: Vec::new(),
        runtime: Vec::new(),
        built: false,
        doc_path: None,
        doc_text: None,
        fingerprint: "f".into(),
        seen_at: "t".into(),
        ..OccurrenceRecord::default()
    };
    let stored = vec![
        ("o1".to_string(), occ("src", "a")),
        ("o2".to_string(), occ("other", "b")),
    ];
    let (nodes, edges, retire) = repoint("src", "dst", "billing", &stored);
    assert_eq!(nodes.len(), 1);
    assert_eq!(retire, vec!["o1"]);
    assert_eq!(edges[0].from, "dst");
    let moved: OccurrenceRecord = serde_json::from_value(nodes[0].value.clone()).unwrap();
    assert_eq!(
        (moved.entry.as_str(), moved.entry_id.as_str()),
        ("billing", "dst")
    );
    assert_eq!(
        nodes[0].instance_id,
        gts::occurrence_instance_id("dst", &P1.to_string(), "acme/app", "a")
    );
}

#[test]
fn an_owner_written_as_a_bare_name_reads_as_a_team() {
    let mut value = serde_json::to_value(entry("a", STATE_REGISTERED)).unwrap();
    value["owner"] = json!("Platform");
    let e: EntryRecord = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(
        e.owner,
        Some(Owner {
            kind: "team".into(),
            id: None,
            name: "Platform".into()
        })
    );
    value["owner"] = Value::Null;
    assert_eq!(
        serde_json::from_value::<EntryRecord>(value).unwrap().owner,
        None
    );
}

#[test]
fn decisions_order_by_time_not_by_text() {
    let d = |at: &str| DecisionRecord {
        organization_id: ORG,
        entry: "a".into(),
        entry_id: "e".into(),
        action: "edit".into(),
        from: "declared".into(),
        to: "declared".into(),
        by: "p".into(),
        by_name: None,
        at: at.into(),
        reason: None,
        details: Value::Null,
    };
    let sorted = newest_first(vec![
        d("2026-10-09T12:00:05Z"),
        d("2026-10-09T12:00:05.5Z"),
        d("2026-10-09T11:59:59Z"),
    ]);
    let ats: Vec<&str> = sorted.iter().map(|d| d.at.as_str()).collect();
    assert_eq!(
        ats,
        [
            "2026-10-09T12:00:05.5Z",
            "2026-10-09T12:00:05Z",
            "2026-10-09T11:59:59Z"
        ]
    );
}
