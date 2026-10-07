//! A report's plan, edited in Studio a section at a time.
//!
//! The plan used to be a file the planning team kept next to their script and
//! Studio only read. It is the same document here -- `gears.yaml`'s shape,
//! kept as text on the report's source -- but its home can be Studio: the
//! Reports screen reads it in sections (lanes, teams, people, projects, needs)
//! and saves one section at a time.
//!
//! A save replaces one top-level key of the document and nothing else. Every
//! other key -- `board`, `roots`, `branches`, an inline `report:` definition,
//! whatever the team adds next -- is kept as it was, and so is the order of
//! the keys, which sets the order of the workbook's columns, lanes and People.
//! Inside a section an entry keeps the fields this screen does not edit: a
//! need written as `{ needed: Q3'26, note: … }` keeps its `note`.
//!
//! The text written back is `serde_yaml`'s, so a file's comments do not
//! survive the first edit; the export is that text, and the planning script
//! reads it the way it read the file.

use std::collections::{BTreeMap, BTreeSet};

use serde_yaml::{Mapping, Value};

use super::roadmap::plan::{hex, normalize};

// ── what the screen reads and writes ───────────────────────────────────────

/// The group lanes: their order and the names they are shown with.
#[derive(Debug, Clone, Default, PartialEq)]
#[toolkit_macros::api_dto(request, response)]
pub struct LanesDto {
    /// Group keys (`CORE`, `GENAI`, …) in the order the Roadmap sheet draws
    /// them; a group not listed comes after these.
    pub order: Vec<String>,
    pub labels: Vec<LaneLabelDto>,
}

#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(request, response)]
pub struct LaneLabelDto {
    pub group: String,
    pub label: String,
}

/// A unit (`Acronis`, `Constructor`, …) and its teams.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(request, response)]
pub struct UnitDto {
    pub name: String,
    /// Six hex digits.
    pub color: Option<String>,
    pub teams: Vec<TeamDto>,
}

#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(request, response)]
pub struct TeamDto {
    /// What a person's `team` names; unique across units.
    pub tag: String,
    pub name: String,
    pub color: Option<String>,
    /// Head count, when it is not the number of people listed.
    pub people: Option<f64>,
    /// How many people's worth of work the team does; its members' summed
    /// power when absent.
    pub power: Option<f64>,
}

/// One person the board's assignees are matched to, by GitHub login.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(request, response)]
pub struct PersonDto {
    pub login: String,
    pub alias: Option<String>,
    /// A team's tag (or name).
    pub team: Option<String>,
    /// A unit, for a person with no team.
    pub unit: Option<String>,
    /// The share of their time the plan counts on (1 = full time).
    pub power: Option<f64>,
    pub email: Option<String>,
}

/// A project that consumes gears: one column of the needs.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(request, response)]
pub struct ProjectDto {
    /// The key needs name it by (`studio_web`).
    pub key: String,
    pub name: String,
    /// The column header in the planning team's source sheet.
    pub source_header: Option<String>,
}

/// One gear's needs: when each project needs it.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(request, response)]
pub struct NeedDto {
    /// The gear's issue number on the board.
    pub number: String,
    pub title: Option<String>,
    pub gear: Option<String>,
    pub group: Option<String>,
    /// Per project, in the projects' order: `Q3'26`, `YES`, `no`, `?`.
    pub needs: Vec<NeedCellDto>,
}

#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(request, response)]
pub struct NeedCellDto {
    pub project: String,
    pub when: String,
}

/// The plan, in sections.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Sections {
    pub lanes: LanesDto,
    pub units: Vec<UnitDto>,
    pub no_unit_color: Option<String>,
    pub people: Vec<PersonDto>,
    pub projects: Vec<ProjectDto>,
    pub needs: Vec<NeedDto>,
}

/// One section, as a save sends it.
#[derive(Debug, Clone)]
pub enum Section {
    Lanes(LanesDto),
    Units {
        units: Vec<UnitDto>,
        no_unit_color: Option<String>,
    },
    People(Vec<PersonDto>),
    Projects(Vec<ProjectDto>),
    Needs(Vec<NeedDto>),
}

// ── reading ────────────────────────────────────────────────────────────────

fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(if *b { "True" } else { "False" }.to_string()),
        _ => None,
    }
}

fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn field(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(text)
}

fn entries(v: Option<&Value>) -> Vec<(String, &Value)> {
    v.and_then(Value::as_mapping)
        .map(|m| m.iter().filter_map(|(k, v)| Some((text(k)?, v))).collect())
        .unwrap_or_default()
}

/// The plan's sections, in the document's order. A section the document
/// does not have is empty.
pub fn read(doc: &Value) -> Sections {
    let lanes = doc.get("swimlanes");
    let lanes = LanesDto {
        order: lanes
            .and_then(|l| l.get("order"))
            .and_then(Value::as_sequence)
            .map(|a| a.iter().filter_map(text).collect())
            .unwrap_or_default(),
        labels: entries(lanes.and_then(|l| l.get("labels")))
            .into_iter()
            .filter_map(|(group, v)| {
                Some(LaneLabelDto {
                    group,
                    label: text(v)?,
                })
            })
            .collect(),
    };
    let units = entries(doc.get("units"))
        .into_iter()
        .map(|(name, u)| UnitDto {
            name,
            color: field(u, "color"),
            teams: u
                .get("teams")
                .and_then(Value::as_sequence)
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(|t| {
                    if t.is_mapping() {
                        Some(TeamDto {
                            tag: field(t, "tag")?,
                            name: field(t, "name").unwrap_or_default(),
                            color: field(t, "color"),
                            people: t.get("people").and_then(number),
                            power: t.get("power").and_then(number),
                        })
                    } else {
                        let name = text(t)?;
                        Some(TeamDto {
                            tag: name.clone(),
                            name,
                            color: None,
                            people: None,
                            power: None,
                        })
                    }
                })
                .collect(),
        })
        .collect();
    let people = entries(doc.get("users"))
        .into_iter()
        .map(|(login, u)| PersonDto {
            login,
            alias: field(u, "alias"),
            team: field(u, "team"),
            unit: field(u, "unit"),
            power: u.get("power").and_then(number),
            email: field(u, "email"),
        })
        .collect();
    let projects = entries(doc.get("gear_projects"))
        .into_iter()
        .map(|(key, p)| ProjectDto {
            name: field(p, "name").unwrap_or_else(|| key.clone()),
            source_header: field(p, "source_header"),
            key,
        })
        .collect();
    let needs = entries(doc.get("gear_project_dependencies"))
        .into_iter()
        .map(|(number, d)| NeedDto {
            title: field(d, "title"),
            gear: field(d, "gear"),
            group: field(d, "group"),
            needs: entries(d.get("projects"))
                .into_iter()
                .filter_map(|(project, v)| {
                    let when = if v.is_mapping() {
                        v.get("needed").and_then(text)
                    } else {
                        text(v)
                    }?;
                    Some(NeedCellDto { project, when })
                })
                .collect(),
            number,
        })
        .collect();
    Sections {
        lanes,
        units,
        no_unit_color: field(doc, "no_unit_color"),
        people,
        projects,
        needs,
    }
}

// ── writing ────────────────────────────────────────────────────────────────

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}

/// `n` as YAML: an integer when it is one, so `power: 1` stays `1`.
fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        Value::Number((n as i64).into())
    } else {
        Value::Number(n.into())
    }
}

/// Set `k` to `v`, or remove it when there is nothing to say; an existing key
/// keeps its place.
fn put(m: &mut Mapping, k: &str, v: Option<Value>) {
    match v {
        Some(v) => {
            m.insert(s(k), v);
        }
        None => {
            m.remove(k);
        }
    }
}

fn trimmed(v: &Option<String>) -> Option<Value> {
    v.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(s)
}

/// The mapping an entry already had, so the fields this screen does not edit
/// stay; a new entry starts empty.
fn existing(section: Option<&Value>, key: &str) -> Mapping {
    section
        .and_then(Value::as_mapping)
        .and_then(|m| m.get(key))
        .and_then(Value::as_mapping)
        .cloned()
        .unwrap_or_default()
}

/// The document with one section replaced. The document must be a mapping.
pub fn apply(doc: &mut Value, section: Section) -> Result<(), String> {
    let old = doc.clone();
    let root = doc
        .as_mapping_mut()
        .ok_or("the plan is not a mapping, so it has no sections")?;
    match section {
        Section::Lanes(l) => {
            let mut m = old
                .get("swimlanes")
                .and_then(Value::as_mapping)
                .cloned()
                .unwrap_or_default();
            put(
                &mut m,
                "order",
                Some(Value::Sequence(
                    l.order.iter().map(|g| s(g.trim())).collect(),
                )),
            );
            let mut labels = Mapping::new();
            for x in &l.labels {
                labels.insert(s(x.group.trim()), s(x.label.trim()));
            }
            put(&mut m, "labels", Some(Value::Mapping(labels)));
            root.insert(s("swimlanes"), Value::Mapping(m));
        }
        Section::Units {
            units,
            no_unit_color,
        } => {
            let mut out = Mapping::new();
            for u in &units {
                let mut m = existing(old.get("units"), u.name.trim());
                put(&mut m, "color", trimmed(&u.color));
                let teams = u
                    .teams
                    .iter()
                    .map(|t| {
                        // A team entry is found by its tag in the old list.
                        let mut tm = old
                            .get("units")
                            .and_then(|us| us.get(u.name.trim()))
                            .and_then(|o| o.get("teams"))
                            .and_then(Value::as_sequence)
                            .and_then(|ts| {
                                ts.iter().find(|x| {
                                    x.get("tag").and_then(text).as_deref() == Some(t.tag.trim())
                                })
                            })
                            .and_then(Value::as_mapping)
                            .cloned()
                            .unwrap_or_default();
                        put(&mut tm, "tag", Some(s(t.tag.trim())));
                        put(&mut tm, "name", Some(s(t.name.trim())));
                        put(&mut tm, "color", trimmed(&t.color));
                        put(&mut tm, "people", t.people.map(num));
                        put(&mut tm, "power", t.power.map(num));
                        Value::Mapping(tm)
                    })
                    .collect();
                put(&mut m, "teams", Some(Value::Sequence(teams)));
                out.insert(s(u.name.trim()), Value::Mapping(m));
            }
            root.insert(s("units"), Value::Mapping(out));
            match trimmed(&no_unit_color) {
                Some(c) => {
                    root.insert(s("no_unit_color"), c);
                }
                None => {
                    root.remove("no_unit_color");
                }
            }
        }
        Section::People(people) => {
            let mut out = Mapping::new();
            for p in &people {
                let mut m = existing(old.get("users"), p.login.trim());
                put(&mut m, "alias", trimmed(&p.alias));
                put(&mut m, "team", trimmed(&p.team));
                put(&mut m, "unit", trimmed(&p.unit));
                put(&mut m, "email", trimmed(&p.email));
                put(&mut m, "power", p.power.map(num));
                out.insert(s(p.login.trim()), Value::Mapping(m));
            }
            root.insert(s("users"), Value::Mapping(out));
        }
        Section::Projects(projects) => {
            let mut out = Mapping::new();
            for p in &projects {
                let mut m = existing(old.get("gear_projects"), p.key.trim());
                put(&mut m, "name", Some(s(p.name.trim())));
                put(&mut m, "source_header", trimmed(&p.source_header));
                out.insert(s(p.key.trim()), Value::Mapping(m));
            }
            root.insert(s("gear_projects"), Value::Mapping(out));
        }
        Section::Needs(needs) => {
            let mut out = Mapping::new();
            for n in &needs {
                let key = n.number.trim();
                let mut m = existing(old.get("gear_project_dependencies"), key);
                put(&mut m, "title", trimmed(&n.title));
                put(&mut m, "gear", trimmed(&n.gear));
                put(&mut m, "group", trimmed(&n.group));
                let prev = m.get("projects").and_then(Value::as_mapping).cloned();
                let mut cells = Mapping::new();
                for c in &n.needs {
                    let when = c.when.trim();
                    if when.is_empty() {
                        continue;
                    }
                    // A need written as a mapping keeps its other fields.
                    let v = match prev.as_ref().and_then(|p| p.get(c.project.trim())) {
                        Some(Value::Mapping(pm)) => {
                            let mut pm = pm.clone();
                            pm.insert(s("needed"), s(when));
                            Value::Mapping(pm)
                        }
                        _ => s(when),
                    };
                    cells.insert(s(c.project.trim()), v);
                }
                put(&mut m, "projects", Some(Value::Mapping(cells)));
                out.insert(s(key), Value::Mapping(m));
            }
            root.insert(s("gear_project_dependencies"), Value::Mapping(out));
        }
    }
    Ok(())
}

/// Whether the plan holds together: every name a section uses is defined
/// once, by the section that defines it. Asked of the whole document after a
/// save, so removing a team that people are still in is refused, not drawn.
pub fn validate(doc: &Value) -> Result<(), String> {
    let p = read(doc);
    let mut problems: Vec<String> = Vec::new();
    let colour = |what: &str, c: &Option<String>, problems: &mut Vec<String>| {
        if let Some(c) = c
            && hex(c, "") != c.trim().trim_start_matches('#').to_ascii_uppercase()
        {
            problems.push(format!("{what}: `{c}` is not a colour (six hex digits)"));
        }
    };
    let blank = |v: &str| v.trim().is_empty();

    let mut groups = BTreeSet::new();
    for g in &p.lanes.order {
        if blank(g) {
            problems.push("lanes: a lane with no group".into());
        } else if !groups.insert(g.trim().to_uppercase()) {
            problems.push(format!("lanes: `{g}` is listed twice"));
        }
    }

    let mut tags: BTreeMap<String, String> = BTreeMap::new();
    let mut unit_names = BTreeSet::new();
    for u in &p.units {
        if blank(&u.name) {
            problems.push("units: a unit with no name".into());
        }
        unit_names.insert(normalize(&u.name));
        colour(&format!("unit {}", u.name), &u.color, &mut problems);
        for t in &u.teams {
            if blank(&t.tag) || blank(&t.name) {
                problems.push(format!("unit {}: a team needs a tag and a name", u.name));
                continue;
            }
            if let Some(other) = tags.insert(normalize(&t.tag), u.name.clone()) {
                problems.push(format!(
                    "team `{}` is in both {other} and {}",
                    t.tag, u.name
                ));
            }
            tags.entry(normalize(&t.name))
                .or_insert_with(|| u.name.clone());
            colour(&format!("team {}", t.tag), &t.color, &mut problems);
            for (what, v) in [("people", t.people), ("power", t.power)] {
                if v.is_some_and(|v| v < 0.0 || !v.is_finite()) {
                    problems.push(format!("team {}: {what} cannot be negative", t.tag));
                }
            }
        }
    }
    colour("no_unit_color", &p.no_unit_color, &mut problems);

    let mut logins = BTreeSet::new();
    for person in &p.people {
        if blank(&person.login) {
            problems.push("people: a person with no GitHub login".into());
            continue;
        }
        if !logins.insert(person.login.trim().to_lowercase()) {
            problems.push(format!("people: `{}` is listed twice", person.login));
        }
        if let Some(t) = person.team.as_deref()
            && !tags.contains_key(&normalize(t))
        {
            problems.push(format!("{}: there is no team `{t}`", person.login));
        }
        if let Some(u) = person.unit.as_deref()
            && !unit_names.contains(&normalize(u))
        {
            problems.push(format!("{}: there is no unit `{u}`", person.login));
        }
        if person.power.is_some_and(|v| v < 0.0 || !v.is_finite()) {
            problems.push(format!("{}: power cannot be negative", person.login));
        }
    }

    let mut keys = BTreeSet::new();
    for pr in &p.projects {
        if blank(&pr.key) || blank(&pr.name) {
            problems.push("projects: a project needs a key and a name".into());
        } else if !keys.insert(pr.key.trim().to_string()) {
            problems.push(format!("projects: `{}` is listed twice", pr.key));
        }
    }

    let mut numbers = BTreeSet::new();
    for n in &p.needs {
        let num = n.number.trim();
        if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
            problems.push(format!("needs: `{}` is not an issue number", n.number));
        } else if !numbers.insert(num.to_string()) {
            problems.push(format!("needs: gear #{num} is listed twice"));
        }
        for c in &n.needs {
            if !keys.contains(c.project.trim()) {
                problems.push(format!(
                    "needs: gear #{num} names project `{}`, which is not in the projects",
                    c.project
                ));
            }
        }
    }

    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

/// The document as text, for the snapshot and the export.
///
/// `serde_yaml` writes YAML 1.2, where a bare `no` is a string. The planning
/// script reads the export with PyYAML, which is YAML 1.1: there `no`, `yes`,
/// `on`, `off` and `~` are booleans and null, and a need of `no` would read as
/// `False`. So a plain scalar that YAML 1.1 reads as anything but a string is
/// quoted on the way out. Only strings are: a real `true` (an inline report
/// definition's `per_group: true`) stays a boolean.
pub fn to_text(doc: &Value) -> Result<String, String> {
    let mut marked = doc.clone();
    let mut words: Vec<String> = Vec::new();
    mark(&mut marked, &mut words);
    let mut text = serde_yaml::to_string(&marked)
        .map_err(|e| format!("the plan could not be written: {e}"))?;
    // The trailing `__` keeps `…_1__` from matching inside `…_10__`.
    for (i, w) in words.iter().enumerate() {
        text = text.replace(&marker(i), &format!("'{w}'"));
    }
    Ok(text)
}

fn marker(i: usize) -> String {
    format!("__studio_plan_yaml11_{i}__")
}

/// Every string YAML 1.1 would misread, keys included, swapped for a marker
/// `serde_yaml` writes bare.
fn mark(v: &mut Value, words: &mut Vec<String>) {
    let swap = |s: &str, words: &mut Vec<String>| -> Option<Value> {
        yaml11_special(s).then(|| {
            words.push(s.to_string());
            Value::String(marker(words.len() - 1))
        })
    };
    match v {
        Value::String(s) => {
            if let Some(m) = swap(s, words) {
                *v = m;
            }
        }
        Value::Sequence(items) => items.iter_mut().for_each(|x| mark(x, words)),
        Value::Mapping(m) => {
            let old = std::mem::take(m);
            for (mut k, mut val) in old {
                if let Value::String(s) = &k
                    && let Some(mk) = swap(s, words)
                {
                    k = mk;
                }
                mark(&mut val, words);
                m.insert(k, val);
            }
        }
        Value::Tagged(t) => mark(&mut t.value, words),
        _ => {}
    }
}

/// Words YAML 1.1 reads as a boolean or null when they stand bare.
fn yaml11_special(v: &str) -> bool {
    matches!(
        v,
        "y" | "Y"
            | "yes"
            | "Yes"
            | "YES"
            | "n"
            | "N"
            | "no"
            | "No"
            | "NO"
            | "on"
            | "On"
            | "ON"
            | "off"
            | "Off"
            | "OFF"
            | "true"
            | "True"
            | "TRUE"
            | "false"
            | "False"
            | "FALSE"
            | "null"
            | "Null"
            | "NULL"
            | "~"
    )
}

#[cfg(test)]
#[path = "plan_edit_tests.rs"]
mod tests;
