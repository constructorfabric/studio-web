use super::*;
use serde_json::json;

fn values(v: Value) -> Map<String, Value> {
    serde_json::from_value(v).unwrap()
}

fn planned(
    stage: &str,
    at: u32,
    due: Option<&str>,
    committed: bool,
    plan: (&str, &str, &str),
    demand: &[(&str, u64)],
) -> Map<String, Value> {
    let (brief, lamp, why) = plan;
    let milestone = match due {
        Some(d) => json!({ "b": format!("{}.{}", &d[2..4], &d[5..7]), "u": d }),
        None => json!({ "b": "Backlog" }),
    };
    values(json!({
        "stage": { "b": stage, "v": format!("{stage} ({at} of 6)") },
        "milestone": milestone,
        "commitment": { "b": if committed { "committed" } else { "not committed" } },
        "convergence": { "b": brief, "s": lamp, "v": why },
        "demand": { "b": "", "parts": demand.iter().map(|(c, p)| json!({ "consumer": c, "priority": p })).collect::<Vec<_>>() },
        "roadmap_item": { "b": format!("#1 {stage}"), "l": "https://github.com/o/r/issues/1" },
        "roadmap_owner": { "b": "@someone" },
        "effort": { "b": "40" },
    }))
}

#[test]
fn the_report_lists_what_the_board_plans_and_counts_the_rest() {
    let broker = planned(
        "In Dev",
        3,
        Some("2026-10-31"),
        true,
        ("on track", "good", "on track"),
        &[("Acronis", 1), ("Virtuozzo", 3)],
    );
    let files = planned(
        "In Dev",
        3,
        Some("2026-07-31"),
        true,
        ("at risk", "bad", "overdue: due 2026-07-31 and still In Dev"),
        &[("Acronis", 1)],
    );
    let approval = planned(
        "Todo",
        1,
        None,
        false,
        (
            "at risk",
            "bad",
            "P1 for Constructor, but no dated milestone",
        ),
        &[("Constructor", 1)],
    );
    let shipped = planned(
        "In Prod",
        6,
        Some("2026-04-30"),
        true,
        ("delivered", "good", "delivered"),
        &[("Acronis", 2)],
    );
    let lone = values(json!({ "description": { "b": "not on the board" } }));
    let all = [
        ComponentValues {
            name: "cf-gears-event-broker",
            category: "core",
            values: &broker,
        },
        ComponentValues {
            name: "cf-gears-file-storage",
            category: "core",
            values: &files,
        },
        ComponentValues {
            name: "cf-gears-approval-service",
            category: "",
            values: &approval,
        },
        ComponentValues {
            name: "cf-gears-account-management",
            category: "oss",
            values: &shipped,
        },
        ComponentValues {
            name: "cf-gears-lonely",
            category: "",
            values: &lone,
        },
    ];
    let r = build(&all, &[]);

    assert_eq!(r.total, 4);
    assert_eq!(r.not_on_board, 1);
    // Soonest due first, undated last.
    let order: Vec<&str> = r.items.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(
        order,
        [
            "cf-gears-account-management",
            "cf-gears-file-storage",
            "cf-gears-event-broker",
            "cf-gears-approval-service"
        ]
    );
    let broker_row = &r.items[2];
    assert_eq!(broker_row.assignees.as_deref(), Some("@someone"));
    assert_eq!(broker_row.effort_md, Some(40.0));
    assert_eq!(broker_row.category.as_deref(), Some("core"));
    assert_eq!(r.items[3].category, None);

    let s = &r.summary;
    // Pipeline order, not alphabetical.
    let stages: Vec<(&str, u32)> = s
        .by_stage
        .iter()
        .map(|c| (c.label.as_str(), c.count))
        .collect();
    assert_eq!(stages, [("Todo", 1), ("In Dev", 2), ("In Prod", 1)]);
    // Dated by due date, then undated.
    let ms: Vec<(&str, u32, u32, u32)> = s
        .by_milestone
        .iter()
        .map(|m| (m.milestone.as_str(), m.total, m.committed, m.at_risk))
        .collect();
    assert_eq!(
        ms,
        [
            ("26.04", 1, 1, 0),
            ("26.07", 1, 1, 1),
            ("26.10", 1, 1, 0),
            ("Backlog", 1, 0, 1)
        ]
    );
    let acronis = s
        .by_consumer
        .iter()
        .find(|c| c.consumer == "Acronis")
        .unwrap();
    assert_eq!(
        (acronis.p1, acronis.p2, acronis.p3, acronis.p1_not_on_track),
        (2, 1, 0, 1)
    );
    let constructor = s
        .by_consumer
        .iter()
        .find(|c| c.consumer == "Constructor")
        .unwrap();
    assert_eq!((constructor.p1, constructor.p1_not_on_track), (1, 1));
    let plans: Vec<(&str, u32)> = s
        .by_plan
        .iter()
        .map(|c| (c.label.as_str(), c.count))
        .collect();
    assert_eq!(plans, [("at risk", 2), ("delivered", 1), ("on track", 1)]);
    assert_eq!(s.overdue, ["cf-gears-file-storage"]);
}

#[test]
fn an_empty_catalogue_is_an_empty_report() {
    let r = build(&[], &[]);
    assert_eq!((r.total, r.not_on_board), (0, 0));
    assert!(r.summary.by_stage.is_empty() && r.summary.overdue.is_empty());
}

fn gear(title: &str, components: &[&str], auto: Value) -> Value {
    json!({
        "title": title,
        "name": title,
        "group": crate::components_catalog::sdk::group_of(title),
        "number": 1,
        "closed": false,
        "off_board": false,
        "components": components,
        "auto": auto,
    })
}

#[test]
fn the_rows_are_the_boards_gears_with_the_code_side_where_there_is_code() {
    let axes = |spec: &str, imp: &str, ipct: Option<u32>| {
        json!({ "b": "", "parts": [
            { "label": "Design", "value": spec, "pct": 100 },
            { "label": "Implemenation", "value": imp, "pct": ipct }
        ]})
    };
    let written = gear(
        "CORE - Events Broker",
        &["cf-gears-event-broker"],
        json!({
            "stage": { "b": "In Dev", "v": "In Dev (3 of 6)" },
            "milestone": { "b": "26.10", "u": "2026-10-31" },
            "effort": { "b": "40" },
            "roadmap_progress": axes("Done", "50%", Some(50)),
            "roadmap_item": { "b": "#1 CORE - Events Broker", "l": "https://x/1" },
        }),
    );
    let planned = gear(
        "CORE - Audit",
        &[],
        json!({
            "stage": { "b": "Todo", "v": "Todo (1 of 6)" },
            "effort": { "b": "20" },
            "roadmap_progress": axes("Done", "Todo", Some(0)),
            "roadmap_item": { "b": "#2 CORE - Audit", "l": "https://x/2" },
        }),
    );
    let shipped = gear(
        "BSS - Ledger",
        &["cf-gears-bss-ledger"],
        json!({
            "stage": { "b": "In Prod", "v": "In Prod (6 of 6)" },
            "milestone": { "b": "26.04", "u": "2026-04-30" },
            "effort": { "b": "10" },
            "roadmap_progress": axes("Done", "Done", Some(100)),
            "roadmap_item": { "b": "#3 BSS - Ledger", "l": "https://x/3" },
        }),
    );
    let broker = values(json!({
        "lifecycle": { "b": "in development" },
        "grade": { "b": "C" },
        "stage": { "b": "should not leak from the component" },
    }));
    let lonely = values(json!({ "description": { "b": "no plan" } }));
    let all = [
        ComponentValues {
            name: "cf-gears-event-broker",
            category: "core",
            values: &broker,
        },
        ComponentValues {
            name: "cf-gears-lonely",
            category: "",
            values: &lonely,
        },
    ];
    let r = build(&all, &[written, planned, shipped]);

    assert_eq!(r.total, 3);
    assert_eq!(r.not_in_code, 1);
    // `lonely` is the only component no gear points to; bss-ledger is named
    // by a gear even though it is not in this component list.
    assert_eq!(r.not_on_board, 1);

    let broker_row = r
        .items
        .iter()
        .find(|i| i.title == "CORE - Events Broker")
        .unwrap();
    assert_eq!(broker_row.name, "cf-gears-event-broker");
    assert_eq!(broker_row.components, ["cf-gears-event-broker"]);
    assert_eq!(broker_row.readiness.grade.as_deref(), Some("C"));
    assert_eq!(
        broker_row.readiness.lifecycle.as_deref(),
        Some("in development")
    );
    assert_eq!(broker_row.readiness.stage.as_deref(), Some("In Dev"));
    assert_eq!(broker_row.category.as_deref(), Some("core"));
    assert_eq!(
        (broker_row.effort_md, broker_row.remaining_md),
        (Some(40.0), Some(20.0))
    );

    let audit = r.items.iter().find(|i| i.title == "CORE - Audit").unwrap();
    assert_eq!(audit.name, "CORE - Audit");
    assert!(audit.components.is_empty());
    assert_eq!(audit.remaining_md, Some(20.0));
    let ledger = r.items.iter().find(|i| i.title == "BSS - Ledger").unwrap();
    assert_eq!(ledger.remaining_md, Some(0.0));

    let g = &r.summary.by_group;
    assert_eq!(g[0].group, "CORE");
    assert_eq!(
        (g[0].total, g[0].done, g[0].in_code, g[0].estimated),
        (2, 0, 1, 2)
    );
    assert_eq!((g[0].effort_md, g[0].remaining_md), (60.0, 40.0));
    let averages: Vec<(&str, Option<u32>)> = g[0]
        .axes
        .iter()
        .map(|a| (a.label.as_str(), a.average))
        .collect();
    assert_eq!(
        averages,
        [("Design", Some(100)), ("Implemenation", Some(25))]
    );
    assert_eq!((g[1].group.as_str(), g[1].done), ("BSS", 1));
}
