use super::*;
use crate::reports::roadmap::plan::{Plan, parse};

/// A made-up plan in `gears.yaml`'s shape: keys in an order no sort gives,
/// a key this screen does not edit (`branches`), a need written as a
/// mapping, and a gear number written twice (the planning file has one).
const PLAN: &str = "\
board: example/7
swimlanes:
  order: [CORE, GENAI]
  labels: { CORE: Core Modules, GENAI: Generative AI }
units:
  Northwind:
    color: 1F3864
    teams:
      - { tag: nw_core, name: Northwind Core, color: 1F3864, people: 3, power: 2.5 }
  Contoso:
    color: 1E5631
    teams:
      - { tag: co_web, name: Contoso Web }
users:
  zed-example: { alias: Zed E, team: nw_core, power: 0.5, email: zed@example.com, note: keep me }
  amy-example: { alias: Amy E, team: co_web, power: 1 }
branches:
  - { repo: frontx, branch: develop }
gear_projects:
  web: { name: Web, source_header: Web v1 }
  api: { name: API }
gear_project_dependencies:
  '20':
    title: CORE - Ledger
    group: CORE
    projects: { web: Q3'26, api: { needed: 'no', why: not yet } }
  '10':
    title: CORE - Queue
    projects: { web: 'YES' }
  '10':
    title: CORE - Queue (p2)
    projects: { web: '?' }
";

fn doc() -> Value {
    parse(PLAN).expect("the fixture parses")
}

fn keys(v: &Value) -> Vec<String> {
    v.as_mapping()
        .unwrap()
        .keys()
        .filter_map(|k| k.as_str().map(str::to_string))
        .collect()
}

#[test]
fn the_sections_are_read_in_the_documents_order() {
    let s = read(&doc());
    assert_eq!(s.lanes.order, vec!["CORE", "GENAI"]);
    assert_eq!(
        s.units.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(),
        vec!["Northwind", "Contoso"]
    );
    assert_eq!(s.units[0].teams[0].power, Some(2.5));
    assert_eq!(
        s.people
            .iter()
            .map(|p| p.login.as_str())
            .collect::<Vec<_>>(),
        vec!["zed-example", "amy-example"]
    );
    assert_eq!(s.projects[0].source_header.as_deref(), Some("Web v1"));
    // The repeated number keeps its first place and its last value.
    assert_eq!(
        s.needs
            .iter()
            .map(|n| n.number.as_str())
            .collect::<Vec<_>>(),
        vec!["20", "10"]
    );
    assert_eq!(s.needs[1].title.as_deref(), Some("CORE - Queue (p2)"));
    // A need written as a mapping reads as its `needed`.
    assert_eq!(s.needs[0].needs[1].when, "no");
}

#[test]
fn a_save_replaces_one_section_and_keeps_every_other_key_in_place() {
    let mut d = doc();
    let before = keys(&d);
    let mut people = read(&d).people;
    people.reverse();
    people[0].power = Some(0.75);
    people.push(PersonDto {
        login: "new-example".into(),
        alias: Some("New E".into()),
        team: Some("Contoso Web".into()),
        unit: None,
        power: None,
        email: None,
    });
    apply(&mut d, Section::People(people)).unwrap();
    validate(&d).unwrap();
    assert_eq!(keys(&d), before, "the top-level order is the file's");
    assert_eq!(d["branches"], doc()["branches"], "an unedited key is kept");
    let users = &d["users"];
    assert_eq!(
        keys(users),
        vec!["amy-example", "zed-example", "new-example"],
        "people are in the order the screen sent"
    );
    assert_eq!(users["amy-example"]["power"], Value::Number(0.75.into()));
    // A field the screen does not edit stays with its person.
    assert_eq!(
        users["zed-example"]["note"],
        Value::String("keep me".into())
    );
    // And the plan the workbook draws reads the edit.
    let plan = Plan::from_value(&d);
    assert_eq!(plan.user_power("amy-example"), 0.75);
    assert_eq!(plan.user_team_tag("new-example"), "co_web");
}

#[test]
fn a_need_keeps_what_it_said_beside_the_date_and_an_empty_cell_is_none() {
    let mut d = doc();
    let mut needs = read(&d).needs;
    needs[0].needs[1].when = "Q1'27".into();
    needs[0].needs[0].when = "  ".into();
    apply(&mut d, Section::Needs(needs)).unwrap();
    validate(&d).unwrap();
    let cells = &d["gear_project_dependencies"]["20"]["projects"];
    assert!(cells.get("web").is_none(), "an emptied cell is gone");
    assert_eq!(cells["api"]["needed"], Value::String("Q1'27".into()));
    assert_eq!(cells["api"]["why"], Value::String("not yet".into()));
    let plan = Plan::from_value(&d);
    assert_eq!(plan.need(Some(20), "api").as_deref(), Some("Q1'27"));
}

#[test]
fn a_plan_that_does_not_hold_together_is_refused_with_every_reason() {
    let mut d = doc();
    // Contoso's only team goes, while a person is still in it.
    let mut s = read(&d);
    s.units.retain(|u| u.name != "Contoso");
    s.units[0].color = Some("blue".into());
    apply(
        &mut d,
        Section::Units {
            units: s.units,
            no_unit_color: None,
        },
    )
    .unwrap();
    let err = validate(&d).unwrap_err();
    assert!(
        err.contains("amy-example: there is no team `co_web`"),
        "{err}"
    );
    assert!(err.contains("is not a colour"), "{err}");

    let mut d = doc();
    let mut projects = read(&d).projects;
    projects.retain(|p| p.key != "api");
    apply(&mut d, Section::Projects(projects)).unwrap();
    let err = validate(&d).unwrap_err();
    assert!(err.contains("names project `api`"), "{err}");

    let mut d = doc();
    let mut units = read(&d).units;
    let twice = units[0].teams[0].clone();
    units[1].teams.push(twice);
    apply(
        &mut d,
        Section::Units {
            units,
            no_unit_color: None,
        },
    )
    .unwrap();
    assert!(validate(&d).unwrap_err().contains("is in both"));
}

/// The planning script reads the export with PyYAML, where a bare `no` is
/// false and a bare `20` is a number. The text has to keep them strings.
#[test]
fn the_written_plan_reads_back_the_same_and_keeps_its_strings_quoted() {
    let d = doc();
    let text = to_text(&d).unwrap();
    for word in ["'no'", "'?'", "'20'", "'10'"] {
        assert!(
            text.contains(word) || text.contains(&word.replace('\'', "\"")),
            "{word} is quoted in:\n{text}"
        );
    }
    assert!(text.contains("needed: 'no'"), "{text}");
    let back = parse(&text).unwrap();
    assert_eq!(read(&back), read(&d));
    assert_eq!(keys(&back), keys(&d));

    // A real boolean is not a string and stays bare.
    let mut flagged = d.clone();
    flagged.as_mapping_mut().unwrap().insert(
        Value::String("report".into()),
        parse("per_group: true").unwrap(),
    );
    let text = to_text(&flagged).unwrap();
    assert!(text.contains("per_group: true"), "{text}");
}

#[test]
fn an_empty_plan_takes_a_first_section() {
    let mut d = Value::Mapping(Mapping::new());
    apply(
        &mut d,
        Section::Projects(vec![ProjectDto {
            key: "web".into(),
            name: "Web".into(),
            source_header: None,
        }]),
    )
    .unwrap();
    validate(&d).unwrap();
    assert_eq!(read(&d).projects.len(), 1);
    assert!(apply(&mut Value::Null, Section::People(Vec::new())).is_err());
}
