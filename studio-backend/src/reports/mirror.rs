//! A roadmap plan's units, teams, people and memberships, mirrored into the
//! domain model, so the rest of Studio sees the organization's teams.
//!
//! The plan is the source of truth for now and the model is its mirror
//! (`acquisition: mirrored`). That is deliberate, and temporary:
//! - the migration plan keeps a screen that two people edit off the model
//!   until graph-storage reports a version on read (step 7). The plan has a
//!   revision of its own, so here there is one writer, the plan's save;
//! - a graph key that is deleted cannot be written again, so whatever leaves
//!   the plan is retired (`valid_to`, `status`), never deleted.
//!
//! When step 7 lands, the model becomes the source and the plan's team and
//! people sections a view of it (`docs/design/studio-reports.md`).
//!
//! What maps to what:
//! - a unit is an `org-unit` (`business_unit`);
//! - a team is a `team`, with its unit as `org_unit_ref` -- a field the
//!   model does not declare yet, so it is reported, not refused;
//! - a person is a `person` keyed by their GitHub login, shared by every
//!   report that names them, and never retired by one;
//! - a person in a team is a `membership` (`scope_kind: team`) whose
//!   `allocation` is the plan's power.
//!
//! Only what changed is written, so publishing an unchanged plan again costs
//! a read per type.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};
use toolkit_security::SecurityContext;

use super::plan_edit::Sections;
use super::roadmap::plan::normalize;
use crate::domain_model::port::{DomainObjects, StoredObject};

pub const UNIT: &str = "org-unit";
pub const TEAM: &str = "team";
pub const PERSON: &str = "person";
pub const MEMBERSHIP: &str = "membership";

/// What a publish did.
#[derive(Debug, Clone, Default, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct MirrorSummaryDto {
    /// Objects created or changed.
    pub written: u32,
    pub unchanged: u32,
    /// Units, teams and memberships no longer in the plan, retired.
    pub retired: u32,
    /// What could not be mirrored, and why: a person whose team is not one.
    pub skipped: Vec<String>,
}

/// The tag every object a report mirrors carries, so a publish finds its own
/// and leaves everybody else's alone.
pub fn source(report: &str) -> String {
    format!("studio-reports/{report}")
}

fn key_of(v: &Value) -> Option<&str> {
    v.get("mirror_key").and_then(Value::as_str)
}

/// Whether writing `desired` would change `existing`: any field it sets that
/// the stored object does not hold the same.
fn differs(desired: &Value, existing: &Value) -> bool {
    desired.as_object().is_some_and(|m| {
        m.iter()
            .any(|(k, v)| existing.get(k).unwrap_or(&Value::Null) != v)
    })
}

/// A field set to `null` when absent, so a value taken away is taken away.
fn opt<T: Into<Value>>(v: Option<T>) -> Value {
    v.map_or(Value::Null, Into::into)
}

struct Publisher<'a> {
    objects: &'a dyn DomainObjects,
    ctx: &'a SecurityContext,
    summary: MirrorSummaryDto,
}

impl Publisher<'_> {
    /// Write the object unless it already says this; answer its id.
    async fn put(
        &mut self,
        entity: &str,
        key: &str,
        payload: Value,
        existing: Option<&StoredObject>,
    ) -> anyhow::Result<String> {
        if let Some(e) = existing
            && !differs(&payload, &e.payload)
        {
            self.summary.unchanged += 1;
            return Ok(e.instance_id.clone());
        }
        let id = self.objects.upsert(self.ctx, entity, key, payload).await?;
        self.summary.written += 1;
        Ok(id)
    }
}

/// The objects of `entity` this report mirrored before, by key.
async fn mirrored(
    objects: &dyn DomainObjects,
    ctx: &SecurityContext,
    entity: &str,
    source: &str,
) -> anyhow::Result<BTreeMap<String, StoredObject>> {
    Ok(objects
        .list(ctx, entity)
        .await?
        .into_iter()
        .filter(|o| o.payload.get("mirrored_from").and_then(Value::as_str) == Some(source))
        .filter_map(|o| Some((key_of(&o.payload)?.to_string(), o)))
        .collect())
}

/// Mirror the plan's sections into the model, as of `now` (RFC 3339).
pub async fn publish(
    objects: &dyn DomainObjects,
    ctx: &SecurityContext,
    report: &str,
    plan: &Sections,
    now: &str,
) -> anyhow::Result<MirrorSummaryDto> {
    let src = source(report);
    let units_before = mirrored(objects, ctx, UNIT, &src).await?;
    let teams_before = mirrored(objects, ctx, TEAM, &src).await?;
    let members_before = mirrored(objects, ctx, MEMBERSHIP, &src).await?;
    // People are shared: found by key whoever wrote them.
    let people_before: BTreeMap<String, StoredObject> = objects
        .list(ctx, PERSON)
        .await?
        .into_iter()
        .filter_map(|o| Some((key_of(&o.payload)?.to_string(), o)))
        .collect();

    let mut p = Publisher {
        objects,
        ctx,
        summary: MirrorSummaryDto::default(),
    };
    let mut kept: BTreeSet<String> = BTreeSet::new();
    let common = |key: &str, title: &str| -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("mirror_key".into(), json!(key));
        m.insert("mirrored_from".into(), json!(src));
        m.insert("acquisition_mode".into(), json!("mirrored"));
        m.insert("title".into(), json!(title));
        m.insert("valid_to".into(), Value::Null);
        m
    };

    // Teams are found by tag or by name, the way the plan finds them.
    let mut team_ids: BTreeMap<String, String> = BTreeMap::new();
    for unit in &plan.units {
        let key = format!("{src}/unit/{}", normalize(&unit.name));
        let mut m = common(&key, &unit.name);
        m.insert("name".into(), json!(unit.name));
        m.insert("unit_kind".into(), json!("business_unit"));
        m.insert("status".into(), json!("active"));
        m.insert("color".into(), opt(unit.color.clone()));
        let unit_id = p
            .put(UNIT, &key, Value::Object(m), units_before.get(&key))
            .await?;
        kept.insert(key);
        for team in &unit.teams {
            let key = format!("{src}/team/{}", normalize(&team.tag));
            let mut m = common(&key, &team.name);
            m.insert("name".into(), json!(team.name));
            m.insert("slug".into(), json!(team.tag));
            m.insert("acquisition".into(), json!("mirrored"));
            m.insert("aliases".into(), json!([team.tag]));
            m.insert("org_unit_ref".into(), json!(unit_id));
            m.insert("color".into(), opt(team.color.clone()));
            m.insert("people".into(), opt(team.people));
            m.insert("power".into(), opt(team.power));
            let id = p
                .put(TEAM, &key, Value::Object(m), teams_before.get(&key))
                .await?;
            kept.insert(key);
            team_ids.insert(normalize(&team.tag), id.clone());
            team_ids.entry(normalize(&team.name)).or_insert(id);
        }
    }

    for person in &plan.people {
        let login = person.login.trim().to_lowercase();
        let key = format!("github:{login}");
        let name = person.alias.clone().unwrap_or_else(|| person.login.clone());
        let mut m = Map::new();
        m.insert("mirror_key".into(), json!(key));
        m.insert("acquisition_mode".into(), json!("mirrored"));
        m.insert("title".into(), json!(name));
        m.insert("display_name".into(), json!(name));
        m.insert("handles".into(), json!([{ "kind": "github", "id": login }]));
        m.insert(
            "emails".into(),
            json!(person.email.iter().collect::<Vec<_>>()),
        );
        m.insert("status".into(), json!("active"));
        let person_id = p
            .put(PERSON, &key, Value::Object(m), people_before.get(&key))
            .await?;

        let Some(team) = person.team.as_deref() else {
            continue;
        };
        let Some(team_id) = team_ids.get(&normalize(team)) else {
            p.summary
                .skipped
                .push(format!("{}: there is no team `{team}`", person.login));
            continue;
        };
        let key = format!("{src}/membership/{}/{login}", normalize(team));
        let before = members_before.get(&key);
        // Since when is the membership's own fact: kept from the first publish.
        let since = before
            .and_then(|b| b.payload.get("valid_from").cloned())
            .filter(|v| !v.is_null())
            .unwrap_or_else(|| json!(now));
        let mut m = common(&key, &format!("{name} in {team}"));
        m.insert("person_ref".into(), json!(person_id));
        m.insert("scope_kind".into(), json!("team"));
        m.insert("scope_ref".into(), json!(team_id));
        m.insert("acquisition".into(), json!("mirrored"));
        m.insert("valid_from".into(), since);
        m.insert("status".into(), json!("active"));
        m.insert("allocation".into(), opt(person.power));
        p.put(MEMBERSHIP, &key, Value::Object(m), before).await?;
        kept.insert(key);
    }

    // What left the plan is retired: a deleted key could never be written again.
    for (entity, before, status) in [
        (UNIT, &units_before, "inactive"),
        (TEAM, &teams_before, "inactive"),
        (MEMBERSHIP, &members_before, "deactivated"),
    ] {
        for (key, o) in before {
            let retired = o.payload.get("valid_to").is_some_and(|v| !v.is_null());
            if kept.contains(key) || retired {
                continue;
            }
            let mut payload = o.payload.clone();
            if let Some(m) = payload.as_object_mut() {
                m.insert("valid_to".into(), json!(now));
                m.insert("status".into(), json!(status));
            }
            p.objects.upsert(ctx, entity, key, payload).await?;
            p.summary.retired += 1;
        }
    }
    Ok(p.summary)
}

#[cfg(test)]
#[path = "mirror_tests.rs"]
mod tests;
