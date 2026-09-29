use super::*;

fn item(number: u64, title: &str) -> RoadmapItem {
    RoadmapItem {
        title: title.to_string(),
        url: Some(format!("https://github.com/o/r/issues/{number}")),
        number: Some(number),
        ..RoadmapItem::default()
    }
}

fn gears(names: &[&str]) -> Vec<(String, Vec<String>, Option<u64>)> {
    names
        .iter()
        .map(|n| {
            (
                format!("cf-gears-{n}"),
                gear_words(&format!("cf-gears-{n}")),
                None,
            )
        })
        .collect()
}

fn matched(
    gears: &[(String, Vec<String>, Option<u64>)],
    items: &[RoadmapItem],
) -> BTreeMap<String, u64> {
    match_items(gears, items)
        .into_iter()
        .map(|(g, (ix, _))| (g, items[ix].number.unwrap()))
        .collect()
}

#[test]
fn a_title_loses_its_domain_prefix_and_its_parentheticals() {
    assert_eq!(
        title_words("GENAI - MiniChat (simple chat for Azure/OpenAI)"),
        vec!["minichat"]
    );
    assert_eq!(
        title_words("CORE - Events Broker (p1)"),
        vec!["event", "broker"]
    );
    // Not a domain prefix: lower case.
    assert_eq!(title_words("setup - intro"), vec!["setup", "intro"]);
}

#[test]
fn gears_match_the_titles_people_gave_them() {
    let g = gears(&[
        "event-broker",
        "mini-chat",
        "model-registry",
        "quota-enforcement",
        "ledger",
        "timescaledb-usage-collector-plugin",
        "usage-collector",
    ]);
    let items = vec![
        item(1, "CORE - Events Broker"),
        item(2, "GENAI - MiniChat (simple chat for Azure/OpenAI)"),
        item(3, "GENAI - Models Registry"),
        item(4, "OSS - Quota Enforcer (p1)"),
        item(5, "BSS - Billing Ledger"),
        item(6, "CORE - Usage Collector plugin for TimeScale DB"),
        item(7, "CORE - Usage Collector"),
    ];
    let m = matched(&g, &items);
    assert_eq!(m["cf-gears-event-broker"], 1);
    assert_eq!(m["cf-gears-mini-chat"], 2);
    assert_eq!(m["cf-gears-model-registry"], 3);
    assert_eq!(m["cf-gears-quota-enforcement"], 4);
    assert_eq!(m["cf-gears-ledger"], 5);
    assert_eq!(m["cf-gears-timescaledb-usage-collector-plugin"], 6);
    assert_eq!(m["cf-gears-usage-collector"], 7);
}

#[test]
fn a_tie_is_left_for_a_person() {
    // Two items fit one gear equally.
    let g = gears(&["api-gateway"]);
    let items = vec![
        item(1, "CORE - Outbound API Gateway (p1)"),
        item(2, "CORE - Inbound API Gateway (p1)"),
    ];
    assert!(matched(&g, &items).is_empty());
    // One item fits two gears equally.
    let g = gears(&["authn-resolver", "authz-resolver"]);
    let items = vec![item(3, "CORE - Auth Resolver (p1)")];
    assert!(matched(&g, &items).is_empty());
}

#[test]
fn a_plugin_is_not_its_host_and_a_mention_is_not_a_match() {
    let g = gears(&["credstore", "gear-orchestrator"]);
    let items = vec![
        item(1, "CORE - CredStore Plugin for Vault/OpenBao"),
        item(2, "CORE - Data Fabric Connectors Orchestrator"),
    ];
    assert!(matched(&g, &items).is_empty());
}

#[test]
fn a_pinned_item_wins_and_is_nobody_elses() {
    let mut g = gears(&["credstore", "event-broker"]);
    // No title names `credstore`; a person does.
    g[0].2 = pinned_number("https://github.com/o/r/issues/9");
    let items = vec![
        item(9, "CORE - Credentials Store (p1)"),
        item(1, "CORE - Events Broker"),
    ];
    let m = match_items(&g, &items);
    assert_eq!(m["cf-gears-credstore"], (0, MatchedBy::Hand));
    assert_eq!(m["cf-gears-event-broker"], (1, MatchedBy::Title));

    // Pinned to event-broker's natural match: event-broker must let it go.
    let mut g = gears(&["credstore", "event-broker"]);
    g[0].2 = Some(1);
    let m = matched(&g, &items);
    assert_eq!(m.get("cf-gears-credstore"), Some(&1));
    assert_eq!(m.get("cf-gears-event-broker"), None);
}

#[test]
fn a_pin_reads_a_url_a_hash_or_a_number() {
    assert_eq!(
        pinned_number("https://github.com/o/r/issues/2542"),
        Some(2542)
    );
    assert_eq!(
        pinned_number("https://github.com/o/r/issues/2542/"),
        Some(2542)
    );
    assert_eq!(pinned_number("#77"), Some(77));
    assert_eq!(pinned_number("77"), Some(77));
    assert_eq!(pinned_number("none"), None);
}

#[test]
fn a_priority_names_its_consumers_by_the_fields_letters() {
    assert_eq!(
        priority_letters("Prio (A.C.V.Ag)"),
        Some(vec!["A".into(), "C".into(), "V".into(), "Ag".into()])
    );
    assert_eq!(priority_letters("Priority"), None);
    assert_eq!(priority_letters("Effort (m*d)"), None);
    assert_eq!(parse_priority("2 (1.3.3)"), Some((2, vec![1, 3, 3])));
    assert_eq!(parse_priority("P1"), Some((1, vec![])));
    assert_eq!(parse_priority("soon"), None);
}

fn board() -> Roadmap {
    let pct = |extra: &[&str]| {
        let mut o = vec!["Todo".to_string()];
        o.extend(["10%", "20%", "50%", "80%"].map(String::from));
        o.push("Done".into());
        o.extend(extra.iter().map(|s| s.to_string()));
        o
    };
    let mut selects = BTreeMap::new();
    selects.insert(
        "Status".into(),
        [
            "Todo",
            "In Design",
            "In Dev",
            "Dev Done",
            "In QA",
            "In Prod",
        ]
        .map(String::from)
        .to_vec(),
    );
    selects.insert("Design".into(), pct(&["N/A"]));
    selects.insert("Implementation".into(), pct(&[]));
    selects.insert(
        "Commitment".into(),
        vec!["COMMITMENT".into(), "not commitment".into()],
    );
    Roadmap {
        title: "BACKEND ROADMAP".into(),
        url: "https://github.com/orgs/o/projects/48".into(),
        // Board order, not alphabetical: Implementation before Design here, to
        // prove the axes follow the board.
        select_order: ["Status", "Implementation", "Design", "Commitment"]
            .map(String::from)
            .to_vec(),
        selects,
        items: Vec::new(),
    }
}

fn source() -> RoadmapSource {
    RoadmapSource {
        tenant: Uuid::nil(),
        connection_id: None,
        owner: "o".into(),
        number: 48,
        consumers: [("A", "Acronis"), ("C", "Constructor"), ("V", "Virtuozzo")]
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .into_iter()
            .collect(),
        fields: RoadmapFields::default(),
    }
}

fn planned(stage: &str, due: Option<&str>, commitment: &str, prio: &str) -> RoadmapItem {
    let mut i = item(10, "CORE - Events Broker");
    i.assignees = vec!["someone".into()];
    i.milestone = Some(Milestone {
        title: due.map_or("Backlog".into(), |d| d[2..7].replace('-', ".")),
        due: due.map(str::to_string),
    });
    for (k, v) in [
        ("Status", stage),
        ("Commitment", commitment),
        ("Prio (A.C.V.Ag)", prio),
        ("Design", "Done"),
        ("Implementation", "80%"),
    ] {
        i.fields.insert(k.into(), FieldValue::Text(v.into()));
    }
    i.fields
        .insert("Estimated Efforts m*d".into(), FieldValue::Number(40.0));
    i
}

fn brief<'a>(f: &'a Map<String, Value>, key: &str) -> &'a str {
    f[key]["b"].as_str().unwrap()
}

#[test]
fn an_item_says_stage_eta_demand_and_owner() {
    let i = planned("In Dev", Some("2026-10-31"), "COMMITMENT", "2 (1.3.3)");
    let f = item_fields(&board(), &i, MatchedBy::Title, &source(), "2026-09-29");
    assert_eq!(brief(&f, "stage"), "In Dev");
    assert_eq!(f["stage"]["v"], "In Dev (3 of 6)");
    assert_eq!(f["milestone"]["u"], "2026-10-31");
    assert_eq!(f["milestone"]["s"], "good");
    assert_eq!(brief(&f, "commitment"), "committed");
    assert_eq!(
        brief(&f, "roadmap_progress"),
        "Implementation 80% · Design Done"
    );
    assert_eq!(
        brief(&f, "demand"),
        "Acronis P1 · Constructor P3 · Virtuozzo P3"
    );
    assert_eq!(f["demand"]["n"], 2);
    assert_eq!(brief(&f, "convergence"), "on track");
    assert_eq!(brief(&f, "roadmap_owner"), "@someone");
    assert_eq!(brief(&f, "effort"), "40");
    assert!(
        f["roadmap_item"]["v"]
            .as_str()
            .unwrap()
            .contains("matched by title")
    );
}

#[test]
fn a_missed_date_is_overdue_until_the_last_stage() {
    let late = planned("In Dev", Some("2026-04-30"), "COMMITMENT", "1 (1.1.1)");
    let f = item_fields(&board(), &late, MatchedBy::Title, &source(), "2026-09-29");
    assert_eq!(f["milestone"]["s"], "bad");
    assert_eq!(brief(&f, "convergence"), "at risk");
    assert!(
        f["convergence"]["v"]
            .as_str()
            .unwrap()
            .starts_with("overdue")
    );

    let shipped = planned("In Prod", Some("2026-04-30"), "COMMITMENT", "1 (1.1.1)");
    let f = item_fields(
        &board(),
        &shipped,
        MatchedBy::Title,
        &source(),
        "2026-09-29",
    );
    assert_eq!(f["milestone"]["s"], "good");
    assert_eq!(brief(&f, "convergence"), "delivered");
}

#[test]
fn a_closed_issue_is_shipped_but_a_stale_column_is_said() {
    let mut i = planned("In Dev", Some("2026-04-30"), "COMMITMENT", "1 (2.1.1)");
    i.closed = true;
    let f = item_fields(&board(), &i, MatchedBy::Title, &source(), "2026-09-29");
    // Not overdue: it shipped.
    assert_eq!(f["milestone"]["s"], "good");
    assert_eq!(brief(&f, "convergence"), "check");
    assert!(
        f["convergence"]["v"]
            .as_str()
            .unwrap()
            .contains("still says In Dev")
    );

    let mut i = planned("In Prod", Some("2026-04-30"), "COMMITMENT", "1 (2.1.1)");
    i.closed = true;
    let f = item_fields(&board(), &i, MatchedBy::Title, &source(), "2026-09-29");
    assert_eq!(brief(&f, "convergence"), "delivered");
}

#[test]
fn urgent_demand_without_a_dated_plan_is_a_risk() {
    let backlog = planned("Todo", None, "not commitment", "1 (2.1.1)");
    let f = item_fields(
        &board(),
        &backlog,
        MatchedBy::Title,
        &source(),
        "2026-09-29",
    );
    assert_eq!(f["milestone"]["s"], "watch");
    assert_eq!(brief(&f, "convergence"), "at risk");
    let why = f["convergence"]["v"].as_str().unwrap();
    assert!(why.contains("Constructor, Virtuozzo"), "{why}");

    let uncommitted = planned("In Dev", Some("2026-12-31"), "not commitment", "1 (1.3.3)");
    let f = item_fields(
        &board(),
        &uncommitted,
        MatchedBy::Title,
        &source(),
        "2026-09-29",
    );
    assert_eq!(brief(&f, "convergence"), "check");
}

#[test]
fn a_status_that_contradicts_its_progress_is_flagged() {
    // Todo on the board, 80% done in fact.
    let i = planned("Todo", Some("2026-12-31"), "COMMITMENT", "3 (3.3.3)");
    let f = item_fields(&board(), &i, MatchedBy::Title, &source(), "2026-09-29");
    assert_eq!(brief(&f, "convergence"), "check");

    // Dev Done on the board, implementation never started.
    let mut i = planned("Dev Done", Some("2026-12-31"), "COMMITMENT", "3 (3.3.3)");
    i.fields
        .insert("Implementation".into(), FieldValue::Text("Todo".into()));
    let f = item_fields(&board(), &i, MatchedBy::Title, &source(), "2026-09-29");
    assert_eq!(brief(&f, "convergence"), "check");
}

#[test]
fn a_shipped_board_item_without_a_release_is_flagged() {
    let i = planned("In Prod", Some("2026-04-30"), "COMMITMENT", "3 (3.3.3)");
    let mut f = item_fields(&board(), &i, MatchedBy::Title, &source(), "2026-09-29");
    assert_eq!(brief(&f, "convergence"), "delivered");
    check_release(&mut f, Some("in development"));
    assert_eq!(brief(&f, "convergence"), "check");
    assert!(
        f["convergence"]["v"]
            .as_str()
            .unwrap()
            .contains("shows it in development")
    );

    // Released, or not yet at the last stage: nothing to say.
    let mut f = item_fields(&board(), &i, MatchedBy::Title, &source(), "2026-09-29");
    check_release(&mut f, Some("in qa"));
    assert_eq!(brief(&f, "convergence"), "delivered");
    let dev = planned("In Dev", Some("2026-12-31"), "COMMITMENT", "3 (3.3.3)");
    let mut f = item_fields(&board(), &dev, MatchedBy::Title, &source(), "2026-09-29");
    check_release(&mut f, Some("in development"));
    assert_eq!(brief(&f, "convergence"), "on track");
}

#[test]
fn a_letter_without_a_name_is_shown_as_the_letter() {
    let mut s = source();
    s.consumers.clear();
    let i = planned("In Dev", Some("2026-10-31"), "COMMITMENT", "2 (1.3.3)");
    let f = item_fields(&board(), &i, MatchedBy::Hand, &s, "2026-09-29");
    assert_eq!(brief(&f, "demand"), "A P1 · C P3 · V P3");
    assert!(
        f["roadmap_item"]["v"]
            .as_str()
            .unwrap()
            .contains("set by hand")
    );
}

#[test]
fn a_graphql_page_folds_into_the_board() {
    let page = json!({
        "title": "BACKEND ROADMAP",
        "url": "https://github.com/orgs/o/projects/48",
        "fields": { "nodes": [
            {},
            { "name": "Status", "options": [{"name": "Todo"}, {"name": "In Prod"}] }
        ]},
        "items": {
            "pageInfo": { "hasNextPage": true, "endCursor": "abc" },
            "nodes": [
                {
                    "isArchived": false,
                    "content": {
                        "__typename": "Issue", "number": 7, "title": "CORE - Events Broker",
                        "url": "https://github.com/o/r/issues/7", "state": "OPEN",
                        "assignees": { "nodes": [{ "login": "zed" }] },
                        "milestone": { "title": "26.10", "dueOn": "2026-10-31T00:00:00Z" }
                    },
                    "fieldValues": { "nodes": [
                        { "__typename": "ProjectV2ItemFieldSingleSelectValue", "name": "Todo", "field": { "name": "Status" } },
                        { "__typename": "ProjectV2ItemFieldNumberValue", "number": 12.5, "field": { "name": "Effort" } },
                        { "__typename": "ProjectV2ItemFieldRepositoryValue", "field": { "name": "Repository" } }
                    ]}
                },
                { "isArchived": true, "content": { "title": "gone" }, "fieldValues": { "nodes": [] } }
            ]
        }
    });
    let mut b = Roadmap::default();
    assert_eq!(read_page(&page, &mut b), Some("abc".to_string()));
    assert_eq!(b.selects["Status"], vec!["Todo", "In Prod"]);
    assert_eq!(b.select_order, vec!["Status"]);
    assert_eq!(b.items.len(), 1);
    let i = &b.items[0];
    assert_eq!(i.number, Some(7));
    assert_eq!(i.assignees, vec!["zed"]);
    assert_eq!(
        i.milestone,
        Some(Milestone {
            title: "26.10".into(),
            due: Some("2026-10-31".into())
        })
    );
    assert_eq!(i.fields["Status"], FieldValue::Text("Todo".into()));
    assert_eq!(i.fields["Effort"], FieldValue::Number(12.5));
    assert!(!i.fields.contains_key("Repository"));
}

#[test]
fn a_source_round_trips_with_only_the_required_parts() {
    let s: RoadmapSource = serde_json::from_value(json!({
        "tenant": Uuid::nil(), "owner": "o", "number": 48
    }))
    .unwrap();
    assert!(s.consumers.is_empty());
    assert_eq!(s.fields.stage(), "Status");
    assert_eq!(s.fields.commitment(), "Commitment");
}
