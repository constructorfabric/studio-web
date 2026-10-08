//! The roadmap report: every gear the roadmap board plans, one row each, and
//! the summary a planning meeting reads first.
//!
//! A row is a gear on the board -- a `roadmap_item` node -- not a catalogued
//! component: most of what a plan is about has no code yet, and a report of
//! only the gears already written would miss exactly the ones a consumer is
//! waiting for. Where a component implements the gear, the row carries what
//! the repository says too (lifecycle, last release, grade).
//!
//! It is what the platform team's `back_roadmap` spreadsheet answered --
//! stage, date, commitment, progress, who needs it, whether the plan holds --
//! built from the catalogue instead of a script over the board, so it carries
//! the repository's side too (lifecycle, last release, grade). The server
//! assembles it; a client renders it or writes it to a workbook (the Roadmap
//! and Summary sheets). Pure: the handler hands in the resolved values.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::components_catalog::sdk::{ReferenceReadinessDto, readiness_of};

/// One gear on the board.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapRowDto {
    /// The component that implements it (`cf-gears-event-broker`), or the
    /// board's title for a gear with no code yet.
    pub name: String,
    /// The board's title for it (`CORE - Events Broker`).
    pub title: String,
    /// The issue number; null for a draft.
    pub number: Option<u64>,
    /// The title's `DOMAIN - ` prefix (`CORE`), or `Ungrouped`.
    pub group: String,
    /// Every catalogued component it is the plan of; empty when none is.
    pub components: Vec<String>,
    /// The issue is closed.
    pub closed: bool,
    /// On a root's sub-issues but not on the board itself.
    pub off_board: bool,
    pub category: Option<String>,
    /// Stage, milestone, commitment, plan, demand, progress, lifecycle, last
    /// release, grade -- the same block the components reference carries.
    pub readiness: ReferenceReadinessDto,
    /// The board item's assignees (`@a, @b`).
    pub assignees: Option<String>,
    /// The effort estimate, person-days (`Estimated Efforts m*d`).
    pub effort_md: Option<f64>,
    /// What is left of it: the estimate times what the implementation axis
    /// has not reached; zero for a finished gear.
    pub remaining_md: Option<f64>,
    /// The board item's title (`#2890 CORE - Events Broker`).
    pub roadmap_title: Option<String>,
}

/// One progress axis averaged over a group.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapAxisAverageDto {
    pub label: String,
    /// Mean percentage over the gears that answer the axis; null when none does.
    pub average: Option<u32>,
}

/// One group of gears (`CORE`, `BSS`): the platform team's Summary sheet row.
#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapGroupDto {
    pub group: String,
    pub total: u32,
    /// Gears whose implementation axis is at 100%.
    pub done: u32,
    /// Gears some catalogued component implements.
    pub in_code: u32,
    /// Each progress axis, averaged, in board order.
    pub axes: Vec<RoadmapAxisAverageDto>,
    /// Gears with an effort estimate.
    pub estimated: u32,
    /// The estimates summed, person-days.
    pub effort_md: f64,
    /// What is left of them, person-days.
    pub remaining_md: f64,
}

/// A label and how many rows carry it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapCountDto {
    pub label: String,
    pub count: u32,
}

/// One milestone: how much is due in it, how much of that is committed, and
/// how much is at risk.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapMilestoneDto {
    pub milestone: String,
    /// `YYYY-MM-DD`; null for an undated milestone such as `Backlog`.
    pub due: Option<String>,
    pub total: u32,
    pub committed: u32,
    pub at_risk: u32,
}

/// One consumer: what it asked for, by priority, and how much of its P1
/// demand the plan does not meet.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapConsumerDto {
    pub consumer: String,
    pub p1: u32,
    pub p2: u32,
    pub p3: u32,
    /// P1 rows whose plan is `at risk` or `check`.
    pub p1_not_on_track: u32,
}

#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapSummaryDto {
    /// By the title's domain prefix, in order of size.
    pub by_group: Vec<RoadmapGroupDto>,
    /// In pipeline order (`Todo` … `In Prod`).
    pub by_stage: Vec<RoadmapCountDto>,
    /// Dated milestones by due date, then undated ones.
    pub by_milestone: Vec<RoadmapMilestoneDto>,
    pub by_consumer: Vec<RoadmapConsumerDto>,
    /// `on track`, `check`, `at risk`, `delivered`, `unplanned`.
    pub by_plan: Vec<RoadmapCountDto>,
    /// Names of the rows whose milestone passed before their last stage.
    pub overdue: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
#[toolkit_macros::api_dto(response)]
pub struct RoadmapReportDto {
    /// The gears the boards plan, soonest due first.
    pub items: Vec<RoadmapRowDto>,
    pub total: u32,
    /// Of them, the ones no catalogued component implements yet.
    pub not_in_code: u32,
    /// Catalogued components no board gear points to -- unplanned, or not
    /// matched; a person pins those through the component's `roadmap_item`.
    pub not_on_board: u32,
    pub summary: RoadmapSummaryDto,
}

/// One component's resolved values, with its name and category.
pub struct ComponentValues<'a> {
    pub name: &'a str,
    pub category: &'a str,
    pub values: &'a Map<String, Value>,
}

fn brief(values: &Map<String, Value>, key: &str) -> Option<String> {
    values
        .get(key)
        .filter(|v| !v.is_null())
        .and_then(|v| v.get("b").or_else(|| v.get("v")))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The repository's side of a gear: what its implementing component says
/// that the board cannot.
const CODE_KEYS: [&str; 4] = ["lifecycle", "lastrelease", "consumers", "grade"];

fn number_of(values: &Map<String, Value>, key: &str) -> Option<f64> {
    let v = values.get(key).filter(|v| !v.is_null())?;
    v.get("n")
        .and_then(Value::as_f64)
        .or_else(|| brief(values, key)?.trim().parse().ok())
}

/// A gear with no stored row yet on a board, or a board read before gears
/// were stored: the old shape, one row per catalogued component that
/// carries a plan. Kept so a report is never empty between a deploy and the
/// first sync after it.
fn component_rows(components: &[ComponentValues<'_>]) -> Vec<RoadmapRowDto> {
    components
        .iter()
        .filter(|c| c.values.get("roadmap_item").is_some_and(|v| !v.is_null()))
        .filter_map(|c| {
            let readiness = readiness_of(c.values)?;
            let title = brief(c.values, "roadmap_item").unwrap_or_else(|| c.name.to_string());
            Some(row(
                c.name.to_string(),
                title.clone(),
                None,
                crate::components_catalog::sdk::group_of(
                    title.split_once(' ').map_or(&title[..], |(_, t)| t),
                ),
                vec![c.name.to_string()],
                false,
                false,
                (!c.category.is_empty()).then(|| c.category.to_string()),
                readiness,
                c.values,
            ))
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn row(
    name: String,
    title: String,
    number: Option<u64>,
    group: String,
    components: Vec<String>,
    closed: bool,
    off_board: bool,
    category: Option<String>,
    readiness: ReferenceReadinessDto,
    values: &Map<String, Value>,
) -> RoadmapRowDto {
    let effort_md = number_of(values, "effort");
    let implemented = readiness.progress.last().and_then(|a| a.pct);
    let finished = implemented == Some(100);
    let remaining_md = effort_md.map(|e| {
        if finished {
            0.0
        } else {
            e * (1.0 - f64::from(implemented.unwrap_or(0)) / 100.0)
        }
    });
    RoadmapRowDto {
        name,
        title,
        number,
        group,
        components,
        closed,
        off_board,
        category,
        readiness,
        assignees: brief(values, "roadmap_owner"),
        effort_md,
        remaining_md,
        roadmap_title: brief(values, "roadmap_item"),
    }
}

/// Assemble the report: a row per stored board gear, with the repository's
/// side from the first component that implements it.
pub fn build(components: &[ComponentValues<'_>], planned: &[Value]) -> RoadmapReportDto {
    let by_name: BTreeMap<&str, &ComponentValues<'_>> =
        components.iter().map(|c| (c.name, c)).collect();
    let mut items: Vec<RoadmapRowDto> = Vec::new();
    let mut pointed_at: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for node in planned {
        let text = |k: &str| {
            node.get(k)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let names: Vec<String> = node
            .get("components")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let mut values: Map<String, Value> = node
            .get("auto")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let code = names.iter().find_map(|n| by_name.get(n.as_str()).copied());
        if let Some(code) = code {
            for key in CODE_KEYS {
                if let Some(v) = code.values.get(key) {
                    values.insert(key.to_string(), v.clone());
                }
            }
        }
        pointed_at.extend(names.iter().cloned());
        let Some(readiness) = readiness_of(&values) else {
            continue;
        };
        let title = text("title");
        items.push(row(
            names.first().cloned().unwrap_or_else(|| title.clone()),
            title,
            node.get("number").and_then(Value::as_u64),
            text("group"),
            names,
            node.get("closed").and_then(Value::as_bool).unwrap_or(false),
            node.get("off_board")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            code.map(|c| c.category.to_string())
                .filter(|c| !c.is_empty()),
            readiness,
            &values,
        ));
    }
    if planned.is_empty() {
        items = component_rows(components);
        pointed_at = items.iter().flat_map(|r| r.components.clone()).collect();
    }
    // Soonest due first; undated after dated; then by group and title.
    items.sort_by(|a, b| {
        let key = |r: &RoadmapRowDto| {
            (
                r.readiness.due.is_none(),
                r.readiness.due.clone(),
                r.group.clone(),
                r.title.clone(),
            )
        };
        key(a).cmp(&key(b))
    });
    let not_on_board = components
        .iter()
        .filter(|c| !pointed_at.contains(c.name))
        .count();
    let summary = summarize(&items);
    RoadmapReportDto {
        total: count(items.len()),
        not_in_code: count(items.iter().filter(|r| r.components.is_empty()).count()),
        not_on_board: count(not_on_board),
        summary,
        items,
    }
}

/// The Summary sheet: per group, what is done, how far each axis is, and how
/// much work is estimated and left.
fn groups(items: &[RoadmapRowDto]) -> Vec<RoadmapGroupDto> {
    let mut by: BTreeMap<String, Vec<&RoadmapRowDto>> = BTreeMap::new();
    for r in items {
        by.entry(r.group.clone()).or_default().push(r);
    }
    let mut out: Vec<RoadmapGroupDto> = by
        .into_iter()
        .map(|(group, rows)| {
            let mut labels: Vec<String> = Vec::new();
            for r in &rows {
                for a in &r.readiness.progress {
                    if !labels.contains(&a.label) {
                        labels.push(a.label.clone());
                    }
                }
            }
            let axes = labels
                .into_iter()
                .map(|label| {
                    let pcts: Vec<u32> = rows
                        .iter()
                        .filter_map(|r| r.readiness.progress.iter().find(|a| a.label == label)?.pct)
                        .collect();
                    let average = (!pcts.is_empty())
                        .then(|| pcts.iter().sum::<u32>() / count(pcts.len()).max(1));
                    RoadmapAxisAverageDto { label, average }
                })
                .collect();
            RoadmapGroupDto {
                total: count(rows.len()),
                done: count(
                    rows.iter()
                        .filter(|r| r.readiness.progress.last().and_then(|a| a.pct) == Some(100))
                        .count(),
                ),
                in_code: count(rows.iter().filter(|r| !r.components.is_empty()).count()),
                axes,
                estimated: count(rows.iter().filter(|r| r.effort_md.is_some()).count()),
                effort_md: rows.iter().filter_map(|r| r.effort_md).sum(),
                remaining_md: rows.iter().filter_map(|r| r.remaining_md).sum(),
                group,
            }
        })
        .collect();
    out.sort_by(|a, b| b.total.cmp(&a.total).then(a.group.cmp(&b.group)));
    out
}

fn not_on_track(r: &ReferenceReadinessDto) -> bool {
    matches!(r.plan_lamp.as_deref(), Some("bad" | "watch"))
}

fn summarize(items: &[RoadmapRowDto]) -> RoadmapSummaryDto {
    // Stages in pipeline order: by position, then by name for a stage the
    // board did not place.
    let mut stages: BTreeMap<(u32, String), usize> = BTreeMap::new();
    // Dated milestones by due date, then undated ones.
    let mut milestones: BTreeMap<(bool, Option<String>, String), RoadmapMilestoneDto> =
        BTreeMap::new();
    let mut consumers: BTreeMap<String, RoadmapConsumerDto> = BTreeMap::new();
    let mut plans: BTreeMap<String, usize> = BTreeMap::new();
    let mut overdue: Vec<String> = Vec::new();

    for row in items {
        let r = &row.readiness;
        if let Some(stage) = &r.stage {
            *stages
                .entry((r.stage_at.unwrap_or(u32::MAX), stage.clone()))
                .or_default() += 1;
        }
        if let Some(m) = &r.milestone {
            let e = milestones
                .entry((r.due.is_none(), r.due.clone(), m.clone()))
                .or_insert_with(|| RoadmapMilestoneDto {
                    milestone: m.clone(),
                    due: r.due.clone(),
                    total: 0,
                    committed: 0,
                    at_risk: 0,
                });
            e.total += 1;
            if r.committed == Some(true) {
                e.committed += 1;
            }
            if r.plan.as_deref() == Some("at risk") {
                e.at_risk += 1;
            }
        }
        for d in &r.demand {
            let e = consumers
                .entry(d.consumer.clone())
                .or_insert_with(|| RoadmapConsumerDto {
                    consumer: d.consumer.clone(),
                    p1: 0,
                    p2: 0,
                    p3: 0,
                    p1_not_on_track: 0,
                });
            match d.priority {
                1 => {
                    e.p1 += 1;
                    if not_on_track(r) {
                        e.p1_not_on_track += 1;
                    }
                }
                2 => e.p2 += 1,
                _ => e.p3 += 1,
            }
        }
        if let Some(p) = &r.plan {
            *plans.entry(p.clone()).or_default() += 1;
        }
        if r.plan_reasons.iter().any(|x| x.starts_with("overdue")) {
            overdue.push(row.name.clone());
        }
    }

    RoadmapSummaryDto {
        by_group: groups(items),
        by_stage: stages
            .into_iter()
            .map(|((_, label), n)| RoadmapCountDto {
                label,
                count: count(n),
            })
            .collect(),
        by_milestone: milestones.into_values().collect(),
        by_consumer: consumers.into_values().collect(),
        by_plan: plans
            .into_iter()
            .map(|(label, n)| RoadmapCountDto {
                label,
                count: count(n),
            })
            .collect(),
        overdue,
    }
}

#[cfg(test)]
#[path = "summary_tests.rs"]
mod tests;
