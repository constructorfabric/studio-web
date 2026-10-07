use std::sync::Mutex;

use async_trait::async_trait;

use super::*;
use crate::reports::plan_edit::{PersonDto, TeamDto, UnitDto};

/// A domain model in memory: objects by (entity, key), ids as the key itself.
#[derive(Default)]
struct Model {
    objects: Mutex<BTreeMap<(String, String), Value>>,
    writes: Mutex<u32>,
}

#[async_trait]
impl DomainObjects for Model {
    async fn upsert(
        &self,
        _ctx: &SecurityContext,
        entity: &str,
        key: &str,
        payload: Value,
    ) -> anyhow::Result<String> {
        *self.writes.lock().unwrap() += 1;
        self.objects
            .lock()
            .unwrap()
            .insert((entity.to_string(), key.to_string()), payload);
        Ok(format!("id:{key}"))
    }

    async fn list(
        &self,
        _ctx: &SecurityContext,
        entity: &str,
    ) -> anyhow::Result<Vec<StoredObject>> {
        Ok(self
            .objects
            .lock()
            .unwrap()
            .iter()
            .filter(|((e, _), _)| e == entity)
            .map(|((_, k), v)| StoredObject {
                instance_id: format!("id:{k}"),
                payload: v.clone(),
            })
            .collect())
    }
}

impl Model {
    fn get(&self, entity: &str, key: &str) -> Option<Value> {
        self.objects
            .lock()
            .unwrap()
            .get(&(entity.to_string(), key.to_string()))
            .cloned()
    }
    fn writes(&self) -> u32 {
        *self.writes.lock().unwrap()
    }
}

fn ctx() -> SecurityContext {
    crate::reports::test_ctx(0x7e4a47)
}

fn person(login: &str, team: Option<&str>, power: Option<f64>) -> PersonDto {
    PersonDto {
        login: login.into(),
        alias: None,
        team: team.map(str::to_string),
        unit: None,
        power,
        email: None,
    }
}

fn plan() -> Sections {
    Sections {
        units: vec![UnitDto {
            name: "Northwind".into(),
            color: Some("1F3864".into()),
            teams: vec![
                TeamDto {
                    tag: "nw_core".into(),
                    name: "Northwind Core".into(),
                    color: None,
                    people: None,
                    power: None,
                },
                TeamDto {
                    tag: "nw_web".into(),
                    name: "Northwind Web".into(),
                    color: None,
                    people: None,
                    power: None,
                },
            ],
        }],
        people: vec![
            person("Zed-Example", Some("nw_core"), Some(0.5)),
            // A team named by its name, as the plan allows.
            person("amy-example", Some("Northwind Web"), Some(1.0)),
            person("lost-example", Some("nobody"), None),
        ],
        ..Sections::default()
    }
}

const SRC: &str = "studio-reports/roadmap";

#[tokio::test]
async fn the_plan_becomes_units_teams_people_and_memberships() {
    let m = Model::default();
    let s = publish(&m, &ctx(), "roadmap", &plan(), "2026-10-07T10:00:00Z")
        .await
        .unwrap();
    // 1 unit, 2 teams, 3 people, 2 memberships.
    assert_eq!((s.written, s.unchanged, s.retired), (8, 0, 0));
    assert_eq!(s.skipped, vec!["lost-example: there is no team `nobody`"]);

    let team = m.get(TEAM, &format!("{SRC}/team/nwcore")).expect("team");
    assert_eq!(
        team["org_unit_ref"],
        json!(format!("id:{SRC}/unit/northwind"))
    );
    assert_eq!(team["acquisition"], json!("mirrored"));
    let zed = m
        .get(PERSON, "github:zed-example")
        .expect("person, by lower-cased login");
    assert_eq!(
        zed["handles"],
        json!([{ "kind": "github", "id": "zed-example" }])
    );
    let member = m
        .get(MEMBERSHIP, &format!("{SRC}/membership/nwcore/zed-example"))
        .expect("membership");
    assert_eq!(member["person_ref"], json!("id:github:zed-example"));
    assert_eq!(member["scope_ref"], json!(format!("id:{SRC}/team/nwcore")));
    assert_eq!(member["allocation"], json!(0.5));
    assert_eq!(member["valid_from"], json!("2026-10-07T10:00:00Z"));
    assert!(
        m.get(
            MEMBERSHIP,
            &format!("{SRC}/membership/northwindweb/amy-example")
        )
        .is_some(),
        "a team found by its name"
    );
}

#[tokio::test]
async fn publishing_again_writes_only_what_changed() {
    let m = Model::default();
    publish(&m, &ctx(), "roadmap", &plan(), "2026-10-07T10:00:00Z")
        .await
        .unwrap();
    let before = m.writes();
    let s = publish(&m, &ctx(), "roadmap", &plan(), "2026-10-08T10:00:00Z")
        .await
        .unwrap();
    assert_eq!((s.written, s.retired), (0, 0));
    assert_eq!(m.writes(), before, "nothing written for an unchanged plan");

    let mut changed = plan();
    changed.people[0].power = Some(0.8);
    let s = publish(&m, &ctx(), "roadmap", &changed, "2026-10-09T10:00:00Z")
        .await
        .unwrap();
    assert_eq!(s.written, 1);
    let member = m
        .get(MEMBERSHIP, &format!("{SRC}/membership/nwcore/zed-example"))
        .unwrap();
    assert_eq!(member["allocation"], json!(0.8));
    assert_eq!(
        member["valid_from"],
        json!("2026-10-07T10:00:00Z"),
        "the membership keeps when it began"
    );
}

#[tokio::test]
async fn what_leaves_the_plan_is_retired_and_comes_back_when_it_returns() {
    let m = Model::default();
    publish(&m, &ctx(), "roadmap", &plan(), "2026-10-07T10:00:00Z")
        .await
        .unwrap();
    let mut smaller = plan();
    smaller.units[0].teams.pop();
    smaller.people.retain(|p| p.login != "amy-example");
    let s = publish(&m, &ctx(), "roadmap", &smaller, "2026-10-08T10:00:00Z")
        .await
        .unwrap();
    assert_eq!(s.retired, 2, "the team and its membership");
    let web = m.get(TEAM, &format!("{SRC}/team/nwweb")).unwrap();
    assert_eq!(web["valid_to"], json!("2026-10-08T10:00:00Z"));
    assert_eq!(web["status"], json!("inactive"));
    assert!(
        m.get(PERSON, "github:amy-example")
            .unwrap()
            .get("valid_to")
            .is_none(),
        "a person is shared and never retired by one report"
    );
    // Retired once is retired; and back in the plan, it is live again.
    let s = publish(&m, &ctx(), "roadmap", &smaller, "2026-10-09T10:00:00Z")
        .await
        .unwrap();
    assert_eq!(s.retired, 0);
    publish(&m, &ctx(), "roadmap", &plan(), "2026-10-10T10:00:00Z")
        .await
        .unwrap();
    assert_eq!(
        m.get(TEAM, &format!("{SRC}/team/nwweb")).unwrap()["valid_to"],
        Value::Null
    );
}

#[tokio::test]
async fn another_reports_objects_are_left_alone() {
    let m = Model::default();
    publish(&m, &ctx(), "other", &plan(), "2026-10-07T10:00:00Z")
        .await
        .unwrap();
    let s = publish(
        &m,
        &ctx(),
        "roadmap",
        &Sections::default(),
        "2026-10-08T10:00:00Z",
    )
    .await
    .unwrap();
    assert_eq!(s.retired, 0);
}
